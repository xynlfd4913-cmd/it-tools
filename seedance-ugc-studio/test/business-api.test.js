const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugc-business-api-"));
process.env.BUSINESS_DATA_FILE = path.join(dir, "private-business.json");
const { startServer, server } = require("../server");

test("business HTTP API keeps records private and rejects cross-site writes", async (t) => {
  const instance = startServer(0, "127.0.0.1");
  if (!instance.listening) await new Promise((resolve) => instance.once("listening", resolve));
  const port = instance.address().port;
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const initial = await fetch(`${base}/api/business`);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).revision, 0);
  const crossOrigin = await fetch(`${base}/api/business`, { headers: { Origin: "https://untrusted.example" } });
  assert.equal(crossOrigin.status, 403);
  const rebound = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/business`, { headers: { Host: `untrusted.example:${port}` } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
  });
  assert.equal(rebound, 403);
  const badType = await fetch(`${base}/api/business/partner`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" });
  assert.equal(badType.status, 415);
  const crossSiteGeneration = await fetch(`${base}/api/seedance/create`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://untrusted.example" }, body: "{}" });
  assert.equal(crossSiteGeneration.status, 403);
  const badBody = await fetch(`${base}/api/business/partner`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" });
  assert.equal(badBody.status, 400);
  const body = { revision: 0, name: "中文测试伙伴", role: "referral", status: "active", contact: "本机联系资料", commissionBps: 1000, notes: "只记直接推荐" };
  const saved = await fetch(`${base}/api/business/partner`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  assert.equal(saved.status, 200);
  const snapshot = await saved.json();
  assert.equal(snapshot.partners[0].name, "中文测试伙伴");
  const stale = await fetch(`${base}/api/business/partner`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(stale.status, 409);
  const exported = await fetch(`${base}/api/business/export`);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  assert.equal((await exported.json()).partners[0].contact, "本机联系资料");
  const csv = await fetch(`${base}/api/business/orders.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /attachment/);
  assert.match(await csv.text(), /您的预计留存/);
  assert.equal((await fetch(`${base}/api/business/partner.csv`)).status, 400);
  assert.equal((await fetch(`${base}/api/business/partner.csv?id=unknown`)).status, 404);
  const staticAttempt = await fetch(`${base}/.runtime/business.json`);
  assert.doesNotMatch(await staticAttempt.text(), /本机联系资料/);
  const malformed = await fetch(`${base}/%E0%A4%A`);
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);

  const payload = Buffer.from(JSON.stringify({ revision: snapshot.revision, studioName: "时恩中文工作室", contact: "测试", offerText: "真实客户订单服务" }));
  const splitAt = payload.indexOf(Buffer.from("时恩")) + 1;
  const chunkResult = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/api/business/settings`, { method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    req.on("error", reject); req.write(payload.subarray(0, splitAt));
    setImmediate(() => req.end(payload.subarray(splitAt)));
  });
  assert.equal(chunkResult.status, 200);
  assert.equal(chunkResult.data.settings.studioName, "时恩中文工作室");
});
