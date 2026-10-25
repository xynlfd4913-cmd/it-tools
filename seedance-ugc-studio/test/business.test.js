const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBusinessStore } = require("../business");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugc-business-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, "private", "business.json");
  const store = createBusinessStore(filename);
  const apply = (action, values) => store.mutate(action, { revision: store.snapshot().revision, ...values });
  const partner = apply("partner", { name: "测试推广伙伴", role: "both", status: "active", contact: "测试联系渠道", commissionBps: 1000, notes: "仅直接推荐真实订单" }).partners[0];
  const order = { client: "测试客户", contact: "测试微信", product: "原木柜短视频", brief: "30秒，9:16，修改一次，验收以商品外观和脚本为准", stage: "lead", duration: 30, referralId: partner.id, producerId: partner.id, dueDate: "2026-12-01", quoteCents: 10000, receivedCents: 0, refundCents: 0, apiCostCents: 2000, productionFeeCents: 1000, commissionBps: 1000, deliveryUrl: "", notes: "测试数据" };
  return { store, filename, apply, partner, order };
}

test("business data persists, keeps a prior revision backup and rejects stale writes", (t) => {
  const { store, filename, apply, order } = fixture(t);
  const revision = store.snapshot().revision;
  const result = apply("order", order);
  assert.equal(result.orders.length, 1);
  assert.equal(createBusinessStore(filename).snapshot().orders[0].client, "测试客户");
  assert.equal(JSON.parse(fs.readFileSync(`${filename}.backup`, "utf8")).revision, revision);
  assert.throws(() => store.mutate("order", { ...order, revision }), (e) => e.status === 409);
  assert.equal(store.snapshot().orders.length, 1);
});

test("deposits, delivery evidence and received revenue gate production and settlement", (t) => {
  const { store, apply, order } = fixture(t);
  assert.throws(() => apply("order", { ...order, stage: "producing" }), /到账/);
  assert.throws(() => apply("order", { ...order, stage: "delivered", receivedCents: 5000 }), /交付链接/);
  const created = apply("order", { ...order, stage: "producing", receivedCents: 5000 }).orders[0];
  const payment = { id: created.id, kind: "payment", amountCents: 500, reference: "转账流水测试" };
  assert.throws(() => apply("settlement", payment), /足额/);
  const partial = apply("order", { ...created, stage: "delivered", deliveryUrl: "https://example.com/final.mp4" }).orders[0];
  assert.equal(partial.money.payableCents, 0);
  assert.throws(() => apply("settlement", payment), /足额/);
  const full = apply("order", { ...partial, receivedCents: 10000 }).orders[0];
  assert.equal(full.money.ownerMarginCents, 6000);
  assert.equal(full.money.payableCents, 1000);
  assert.throws(() => apply("settlement", { ...payment, amountCents: 1001 }), /超过/);
  const paid = apply("settlement", { ...payment, amountCents: 1000 }).orders[0];
  assert.equal(paid.money.paidCommissionCents, 1000);
  assert.equal(paid.money.balanceCents, 0);
  assert.throws(() => apply("settlement", payment), /足额/);
  assert.equal(store.snapshot().orders[0].settlements.length, 1);
});

test("refunds recalculate commissions and recovery cannot exceed the overpayment", (t) => {
  const { apply, order } = fixture(t);
  let o = apply("order", { ...order, stage: "delivered", receivedCents: 10000, deliveryUrl: "https://example.com/final.mp4" }).orders[0];
  o = apply("settlement", { id: o.id, kind: "payment", amountCents: 1000, reference: "测试支付" }).orders[0];
  assert.throws(() => apply("order", { ...o, commissionBps: 2000 }), /锁定/);
  o = apply("order", { ...o, refundCents: 5000, quoteCents: 5000 }).orders[0];
  assert.equal(o.money.commissionCents, 500);
  assert.equal(o.money.recoverableCents, 500);
  assert.throws(() => apply("settlement", { id: o.id, kind: "recovery", amountCents: 501, reference: "测试" }), /超过/);
  o = apply("settlement", { id: o.id, kind: "recovery", amountCents: 500, reference: "已收到退回佣金" }).orders[0];
  assert.equal(o.money.recoverableCents, 0);
  assert.equal(o.money.paidCommissionCents, 500);
  assert.equal(o.money.ownerMarginCents, 1500);
});

test("invalid money, roles, links and cancellations cannot corrupt the ledger", (t) => {
  const { apply, order, partner } = fixture(t);
  for (const value of [-1, 1.5, "100", Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => apply("order", { ...order, receivedCents: value }), /金额/);
  assert.throws(() => apply("order", { ...order, refundCents: 1 }), /退款/);
  assert.throws(() => apply("order", { ...order, deliveryUrl: "javascript:alert(1)" }), /链接/);
  assert.throws(() => apply("order", { ...order, dueDate: "2026-02-30" }), /日期/);
  assert.throws(() => apply("order", { ...order, stage: "cancelled", receivedCents: 1000 }), /退款/);
  assert.throws(() => apply("order", { ...order, referralId: "missing" }), /角色/);
  assert.throws(() => apply("order", { ...order, stage: "toString" }), /阶段/);
  assert.throws(() => apply("partner", { ...partner, role: "constructor" }), /角色/);
  apply("partner", { ...partner, status: "paused" });
  assert.throws(() => apply("order", order), /暂停/);
});

test("loss-making orders do not unlock commission payments", (t) => {
  const { apply, order } = fixture(t);
  const o = apply("order", { ...order, stage: "delivered", receivedCents: 10000, apiCostCents: 10000, deliveryUrl: "https://example.com/final.mp4" }).orders[0];
  assert.equal(o.money.settlementReady, false);
  assert.ok(o.money.ownerMarginCents < 0);
  assert.throws(() => apply("settlement", { id: o.id, kind: "payment", amountCents: 100, reference: "测试" }), /亏损/);
});

test("corrupt business data fails closed without replacing the original file", (t) => {
  const { store, filename } = fixture(t);
  fs.writeFileSync(filename, '{"broken":');
  assert.throws(() => store.snapshot(), (e) => e.status === 503);
  assert.equal(fs.readFileSync(filename, "utf8"), '{"broken":');
});

test("CSV exports protect formulas and keep unrelated orders and owner margins out of partner reports", (t) => {
  const { store, apply, order, partner } = fixture(t);
  apply("order", { ...order, client: '=HYPERLINK("https://example.com")', receivedCents: 10000 });
  apply("order", { ...order, referralId: "", producerId: "", productionFeeCents: 0, client: "另一个来源的客户" });
  const report = store.csv(partner.id);
  assert.match(report, /'=HYPERLINK/);
  assert.doesNotMatch(report, /另一个来源的客户|您的预计留存|接口及其他成本/);
  const full = store.csv("");
  assert.match(full, /您的预计留存/);
  assert.match(full, /另一个来源的客户/);
  assert.throws(() => store.csv("unknown-partner"), (e) => e.status === 404);
});
