const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const STAGES = { lead: "待沟通", quoted: "已报价", producing: "制作中", review: "待验收", delivered: "已交付", cancelled: "已取消" };
const ROLES = { referral: "推广伙伴", production: "制作伙伴", both: "推广与制作" };
class BusinessError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function fail(message, status) { throw new BusinessError(message, status); }
function text(value, label, max = 200, required = false) {
  if (typeof value !== "string") fail(`${label}必须是文字`);
  const result = value.trim();
  if ((required && !result) || result.length > max) fail(`${label}${required ? "不能为空，且" : ""}最多 ${max} 字`);
  return result;
}
function cents(value, label, max = 100_000_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(`${label}必须是有效的非负金额`);
  return value;
}
function date(value) {
  if (!value) return "";
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail("交付日期无效");
  return value;
}
function deliveryUrl(value) {
  const result = text(value, "交付链接", 2000);
  if (!result) return "";
  let url;
  try { url = new URL(result); } catch { fail("交付链接须为完整的 http/https 地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail("交付链接须为不含账号密码的 http/https 地址");
  return result;
}
function emptyData() {
  return { schemaVersion: 1, revision: 0, settings: { studioName: "时恩工作室", contact: "", offerText: "提供商品短视频策划、AI参考图与视频制作。先确认素材、时长、修改次数、交付日期与报价，再收款制作。" }, partners: [], orders: [], activity: [] };
}
function orderMoney(order) {
  const collectedCents = order.receivedCents - order.refundCents;
  const commissionCents = order.referralId ? Math.round(collectedCents * order.commissionBps / 10000) : 0;
  const paidCommissionCents = order.settlements.reduce((sum, entry) => sum + entry.amountCents, 0);
  const balanceCents = commissionCents - paidCommissionCents;
  const ownerMarginCents = collectedCents - order.apiCostCents - order.productionFeeCents - commissionCents;
  const ownerCashCents = collectedCents - order.apiCostCents - order.productionFeeCents - paidCommissionCents;
  const settledReady = order.stage === "delivered" && order.quoteCents > 0 && collectedCents >= order.quoteCents && ownerMarginCents >= 0;
  return { collectedCents, commissionCents, paidCommissionCents, balanceCents, ownerMarginCents, ownerCashCents, settlementReady: settledReady && balanceCents > 0,
    payableCents: settledReady ? Math.max(0, balanceCents) : 0, recoverableCents: Math.max(0, -balanceCents), receivableCents: order.stage === "cancelled" ? 0 : Math.max(0, order.quoteCents - collectedCents) };
}
function snapshot(data) {
  const orders = data.orders.map((order) => ({ ...order, money: orderMoney(order) }));
  const totals = { collectedCents: 0, ownerMarginCents: 0, ownerCashCents: 0, payableCents: 0, recoverableCents: 0, receivableCents: 0 };
  for (const order of orders) for (const key of Object.keys(totals)) totals[key] += order.money[key];
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  return { ...data, orders, totals, stages: STAGES, roles: ROLES, today };
}
function csvReport(data, partnerId = "") {
  if (partnerId && !data.partners.some((p) => p.id === partnerId)) fail("合作伙伴不存在", 404);
  const rows = [["订单编号", "客户", "产品", "状态", "净收款（元）", "归属佣金（元）", "已付净佣金（元）", "待追回（元）", "约定制作报酬（元）", ...(!partnerId ? ["接口及其他成本（元）", "您的预计留存（元）"] : [])]];
  for (const o of snapshot(data).orders.filter((item) => !partnerId || item.referralId === partnerId || item.producerId === partnerId)) {
    const fee = !partnerId || o.producerId === partnerId ? o.productionFeeCents / 100 : "";
    if (partnerId && o.referralId !== partnerId) rows.push([o.number, o.client, o.product, STAGES[o.stage], "制作协作单", "", "", "", fee]);
    else rows.push([o.number, o.client, o.product, STAGES[o.stage], o.money.collectedCents / 100, o.money.commissionCents / 100, o.money.paidCommissionCents / 100, o.money.recoverableCents / 100, fee, ...(!partnerId ? [o.apiCostCents / 100, o.money.ownerMarginCents / 100] : [])]);
  }
  return "\ufeff" + rows.map((row) => row.map((value) => { let cell = String(value); if (/^\s*[=+\-@]/.test(cell)) cell = `'${cell}`; return `"${cell.replaceAll('"', '""')}"`; }).join(",")).join("\r\n");
}
function assertData(data) {
  if (!data || data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !data.settings || !Array.isArray(data.partners) || !Array.isArray(data.orders) || !Array.isArray(data.activity)) fail("经营数据文件格式无效，请从备份恢复；原文件未被覆盖", 503);
  for (const order of data.orders) {
    if (!Array.isArray(order.settlements) || !Object.hasOwn(STAGES, order.stage)) fail("经营订单数据损坏，请从备份恢复；原文件未被覆盖", 503);
    for (const field of ["quoteCents", "receivedCents", "refundCents", "apiCostCents", "productionFeeCents", "commissionBps"]) {
      if (!Number.isSafeInteger(order[field]) || order[field] < 0) fail("经营金额数据损坏，请从备份恢复；原文件未被覆盖", 503);
    }
    if (order.commissionBps > 10000 || order.refundCents > order.receivedCents || order.receivedCents - order.refundCents > order.quoteCents || order.settlements.some((entry) => !entry || !Number.isSafeInteger(entry.amountCents) || !["payment", "recovery"].includes(entry.kind) || (entry.kind === "payment" && entry.amountCents <= 0) || (entry.kind === "recovery" && entry.amountCents >= 0))) fail("经营流水数据损坏，请从备份恢复；原文件未被覆盖", 503);
  }
  if (data.partners.some((p) => !p || !Object.hasOwn(ROLES, p.role) || !["active", "paused"].includes(p.status) || !Number.isSafeInteger(p.commissionBps) || p.commissionBps < 0 || p.commissionBps > 10000)) fail("合作伙伴数据损坏，请从备份恢复；原文件未被覆盖", 503);
  return data;
}
function atomicWrite(filename, content) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, filename);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
function createBusinessStore(filename) {
  function read() {
    if (!fs.existsSync(filename)) return emptyData();
    let data;
    try { data = JSON.parse(fs.readFileSync(filename, "utf8")); } catch { fail("经营数据读取失败，请从备份恢复；原文件未被覆盖", 503); }
    return assertData(data);
  }
  function mutate(action, body) {
    const data = read();
    if (!Number.isSafeInteger(body.revision) || body.revision !== data.revision) fail("数据已被其他页面更新。请刷新后重试，避免覆盖新记录。", 409);
    const now = new Date().toISOString();
    let subject = "";
    if (action === "settings") {
      data.settings = { studioName: text(body.studioName, "工作室名称", 60, true), contact: text(body.contact, "联系渠道", 160), offerText: text(body.offerText, "服务说明", 3000, true) };
      subject = data.settings.studioName;
    } else if (action === "partner") {
      const existing = body.id ? data.partners.find((item) => item.id === body.id) : null;
      if (body.id && !existing) fail("合作伙伴不存在", 404);
      if (data.partners.length >= 1000 && !existing) fail("伙伴数量已达上限，请归档整理");
      const role = body.role;
      if (!Object.hasOwn(ROLES, role) || !["active", "paused"].includes(body.status)) fail("伙伴角色或状态无效");
      const name = text(body.name, "伙伴名称", 60, true);
      if (data.partners.some((item) => item.id !== existing?.id && item.name === name)) fail("已有同名伙伴，请用姓名或渠道区分");
      if (existing && data.orders.some((order) => (order.referralId === existing.id && role === "production") || (order.producerId === existing.id && role === "referral"))) fail("伙伴已有对应订单，不能移除正在使用的角色；可暂停合作");
      const partner = { id: existing?.id || crypto.randomUUID(), code: existing?.code || `P${crypto.randomBytes(4).toString("hex").toUpperCase()}`, name, role, status: body.status,
        contact: text(body.contact, "联系方式", 160), commissionBps: cents(body.commissionBps, "佣金比例", 10000), notes: text(body.notes, "合作约定", 2000), createdAt: existing?.createdAt || now, updatedAt: now };
      if (existing) data.partners[data.partners.indexOf(existing)] = partner; else data.partners.push(partner);
      subject = name;
    } else if (action === "order") {
      const existing = body.id ? data.orders.find((item) => item.id === body.id) : null;
      if (body.id && !existing) fail("订单不存在", 404);
      if (data.orders.length >= 10000 && !existing) fail("订单数量已达上限，请导出整理");
      const order = { id: existing?.id || crypto.randomUUID(), number: existing?.number || `UGC-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
        client: text(body.client, "客户名称", 100, true), contact: text(body.contact, "客户联系方式", 160), product: text(body.product, "产品名称", 150, true), brief: text(body.brief, "客户需求", 3000, true),
        stage: body.stage, duration: body.duration, referralId: text(body.referralId, "推广伙伴", 60), producerId: text(body.producerId, "制作伙伴", 60), dueDate: date(body.dueDate),
        quoteCents: cents(body.quoteCents, "报价"), receivedCents: cents(body.receivedCents, "累计收款"), refundCents: cents(body.refundCents, "累计退款"), apiCostCents: cents(body.apiCostCents, "制作及接口成本"), productionFeeCents: cents(body.productionFeeCents, "制作伙伴报酬"), commissionBps: cents(body.commissionBps, "佣金比例", 10000),
        deliveryUrl: deliveryUrl(body.deliveryUrl), notes: text(body.notes, "订单备注", 2000), settlements: existing?.settlements || [], createdAt: existing?.createdAt || now, updatedAt: now };
      if (!Object.hasOwn(STAGES, order.stage) || ![5, 8, 10, 15, 30].includes(order.duration)) fail("订单阶段或视频时长无效");
      for (const [field, disallowedRole] of [["referralId", "production"], ["producerId", "referral"]]) {
        if (!order[field]) continue;
        const partner = data.partners.find((item) => item.id === order[field]);
        if (!partner || partner.role === disallowedRole) fail("选择的伙伴不存在或角色不匹配");
        if (partner.status !== "active" && existing?.[field] !== partner.id) fail("该伙伴已暂停，不能分配新订单");
      }
      if (order.productionFeeCents && !order.producerId) fail("请先选择制作伙伴，再填写其报酬");
      if (order.refundCents > order.receivedCents || order.receivedCents - order.refundCents > order.quoteCents) fail("退款不能超过收款，净收款不能超过订单报价");
      if (["quoted", "producing", "review", "delivered"].includes(order.stage) && !order.quoteCents) fail("请先填写有效报价");
      if (["producing", "review", "delivered"].includes(order.stage) && order.receivedCents <= order.refundCents) fail("请先记录实际到账的定金或货款，再开始制作与交付");
      if (order.stage === "delivered" && !order.deliveryUrl) fail("交付前请填写可访问的成片或交付链接");
      if (order.stage === "cancelled" && order.receivedCents !== order.refundCents) fail("取消前请记录全额退款，避免漏记客户款项");
      if (existing?.settlements.length && (order.referralId !== existing.referralId || order.commissionBps !== existing.commissionBps)) fail("已有结算流水，推广归属和佣金比例已锁定；退款会自动计算应追回金额");
      if (existing) data.orders[data.orders.indexOf(existing)] = order; else data.orders.push(order);
      subject = order.number;
    } else if (action === "settlement") {
      const order = data.orders.find((item) => item.id === body.id);
      if (!order) fail("订单不存在", 404);
      if (!order.referralId) fail("该订单没有推广伙伴");
      const money = orderMoney(order);
      const recovery = body.kind === "recovery";
      if (!recovery && body.kind !== "payment") fail("结算类型无效");
      const limit = recovery ? money.recoverableCents : money.payableCents;
      if (!limit) fail(recovery ? "没有待追回佣金" : "需已交付、足额到账且扣除成本后不亏损，才能确认佣金支付");
      const amount = cents(body.amountCents, "本次结算金额");
      if (!amount || amount > limit) fail("结算金额不能为零或超过当前可结金额");
      order.settlements.push({ id: crypto.randomUUID(), kind: body.kind, amountCents: recovery ? -amount : amount, reference: text(body.reference, "支付或追回凭据", 200, true), recordedAt: now });
      order.updatedAt = now;
      subject = `${order.number} ${recovery ? "追回" : "支付"}`;
    } else fail("经营操作不存在", 404);
    const previous = read();
    data.revision += 1;
    data.activity.unshift({ id: crypto.randomUUID(), action, subject, at: now });
    data.activity = data.activity.slice(0, 500);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    if (fs.existsSync(filename)) atomicWrite(`${filename}.backup`, JSON.stringify(previous, null, 2));
    atomicWrite(filename, JSON.stringify(data, null, 2));
    return snapshot(data);
  }
  return { snapshot: () => snapshot(read()), export: () => read(), csv: (partnerId) => csvReport(read(), partnerId), mutate };
}

module.exports = { createBusinessStore, orderMoney, BusinessError };
