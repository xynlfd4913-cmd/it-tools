(() => {
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const yuan = (value) => new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY" }).format((value || 0) / 100);
  const business = { data: null, tab: "orders", query: "", stage: "", activeOrderId: "", saving: false };
  const dialog = $("#businessDialog");
  const form = $("#businessForm");
  const partnerName = (id) => business.data.partners.find((p) => p.id === id)?.name || "自主接单 / 自行制作";
  function error(message) { const box = $("#businessError"); box.textContent = message; box.hidden = !message; }
  async function request(path, body) {
    const response = await fetch(`/api/business${path}`, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "经营数据读取失败");
    return data;
  }
  async function load() {
    try { business.data = await request(""); error(""); render(); } catch (e) { error(e.message); }
  }
  function show(view) {
    location.hash = view === "business" ? "business" : "studio";
    $("#businessWorkspace").hidden = view !== "business";
    $("#studioWorkspace").hidden = view === "business";
    document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
    if (view === "business") load();
  }
  function button(action, id, title) {
    if (action === "csv" || action === "partner-csv") return `<a class="small-button" href="/api/business/${id ? `partner.csv?id=${encodeURIComponent(id)}` : "orders.csv"}" download>${title}</a>`;
    return `<button type="button" class="small-button" data-action="${action}" data-id="${esc(id)}">${title}</button>`;
  }
  function render() {
    if (!business.data) return;
    const { totals, orders, partners } = business.data;
    $("#businessStats").innerHTML = [
      ["净收款", totals.collectedCents, "累计到账减累计退款"], ["待收尾款", totals.receivableCents, "非取消订单的报价差额"],
      ["您的预计留存", totals.ownerMarginCents, "已收款扣成本、报酬和佣金"], ["可结推广佣金", totals.payableCents, "已交付、足额到账且不亏损"],
      ["待追回佣金", totals.recoverableCents, "退款后多付给推广伙伴的金额"], ["进行中订单", orders.filter((o) => !["delivered", "cancelled"].includes(o.stage)).length, `${partners.filter((p) => p.status === "active").length} 位合作伙伴`],
    ].map(([title, value, note], i) => `<div class="business-stat"><span>${title}</span><strong class="${value < 0 ? "business-negative" : ""}">${i === 5 ? value : yuan(value)}</strong><small>${note}</small></div>`).join("");
    document.querySelectorAll("[data-business-tab]").forEach((b) => b.classList.toggle("active", b.dataset.businessTab === business.tab));
    if (business.tab === "orders") renderOrders();
    if (business.tab === "partners") renderPartners();
    if (business.tab === "offers") renderOffers();
    if (business.tab === "activity") renderActivity();
    renderActiveOrder();
  }
  function orderCard(order) {
    const money = order.money;
    const overdue = order.dueDate && order.dueDate < business.data.today && !["delivered", "cancelled"].includes(order.stage);
    return `<article class="business-card"><div class="business-card-head"><div><small>${esc(order.number)}</small><h2>${esc(order.client)}</h2></div><span class="badge">${esc(business.data.stages[order.stage])}</span></div>
      <p><strong>${esc(order.product)}</strong> · ${order.duration} 秒<br>${esc(order.brief)}</p><small>推广：${esc(partnerName(order.referralId))}<br>制作：${esc(partnerName(order.producerId))}<br>交付：${esc(order.dueDate || "待约定")}${overdue ? " · 已逾期" : ""}</small>
      <div class="business-metrics"><div><small>报价 / 净收款</small><strong>${yuan(order.quoteCents)} / ${yuan(money.collectedCents)}</strong></div><div><small>您的预计留存</small><strong class="${money.ownerMarginCents < 0 ? "business-negative" : ""}">${yuan(money.ownerMarginCents)}</strong></div><div><small>归属佣金 / 已付</small><strong>${yuan(money.commissionCents)} / ${yuan(money.paidCommissionCents)}</strong></div><div><small>成本与制作报酬</small><strong>${yuan(order.apiCostCents + order.productionFeeCents)}</strong></div></div>
      ${money.recoverableCents ? `<p class="business-negative">退款后待追回佣金 ${yuan(money.recoverableCents)}</p>` : ""}${money.ownerMarginCents < 0 ? '<p class="business-negative">按已收款测算留存为负，请核对尾款与成本。</p>' : ""}
      ${order.deliveryUrl ? `<a href="${esc(order.deliveryUrl)}" target="_blank" rel="noopener noreferrer">查看交付链接</a>` : ""}
      <div class="business-actions">${button("order", order.id, "编辑 / 回款")}${!["cancelled", "delivered"].includes(order.stage) ? button("produce", order.id, "进入视频制作") : ""}${button("brief", order.id, "复制制作任务单")}${money.settlementReady ? button("payment", order.id, "记录已付佣金") : ""}${money.recoverableCents ? button("recovery", order.id, "记录佣金追回") : ""}</div></article>`;
  }
  function renderOrderCards() {
    const { query, stage, data } = business;
    const list = data.orders.filter((o) => (!stage || o.stage === stage) && `${o.client} ${o.product} ${o.number} ${partnerName(o.referralId)}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    $("#businessOrderCards").innerHTML = list.length ? list.map(orderCard).join("") : `<div class="business-empty business-full"><h2>${data.orders.length ? "没有匹配的订单" : "先记录第一位客户"}</h2><p>从客户需求开始，记录推广来源、报价、定金和交付负责人。</p>${button("order", "", "记录客户 / 订单")}</div>`;
  }
  function renderOrders() {
    const overdue = business.data.orders.filter((o) => o.dueDate && o.dueDate < business.data.today && !["cancelled", "delivered"].includes(o.stage)).length;
    $("#businessContent").innerHTML = `${overdue ? `<p class="business-alert">有 ${overdue} 单已超过约定交付日期，请先跟进。</p>` : ""}<div class="business-subhead"><input id="businessSearch" type="search" aria-label="搜索客户、产品或推广伙伴" placeholder="搜索客户、产品或推广伙伴" value="${esc(business.query)}"><select id="businessStageFilter" aria-label="筛选订单阶段"><option value="">全部阶段</option>${Object.entries(business.data.stages).map(([value, name]) => `<option value="${value}" ${business.stage === value ? "selected" : ""}>${name}</option>`).join("")}</select>${button("csv", "", "导出订单表")}</div><div id="businessOrderCards" class="business-cards"></div>`;
    renderOrderCards();
  }
  function renderPartners() {
    $("#businessContent").innerHTML = `<div class="business-subhead"><p class="business-muted">推广伙伴负责带来真实客户；制作伙伴按订单协作。只记录直接推荐订单。</p>${button("partner", "", "新增合作伙伴")}</div><div class="business-cards">${business.data.partners.length ? business.data.partners.map((p) => {
      const attributed = business.data.orders.filter((o) => o.referralId === p.id);
      const production = business.data.orders.filter((o) => o.producerId === p.id);
      return `<article class="business-card"><div class="business-card-head"><h2>${esc(p.name)}</h2><span class="badge">${esc(business.data.roles[p.role])} · ${p.status === "active" ? "合作中" : "已暂停"}</span></div><small>推广编号 ${esc(p.code)}</small><p>${esc(p.contact || "尚未记录联系方式")}<br>默认推广佣金 ${p.commissionBps / 100}%</p><div class="business-metrics"><div><small>推荐 / 制作订单</small><strong>${attributed.length} / ${production.length}</strong></div><div><small>已付净佣金</small><strong>${yuan(attributed.reduce((sum, o) => sum + o.money.paidCommissionCents, 0))}</strong></div></div><p>${esc(p.notes)}</p><div class="business-actions">${button("partner", p.id, "编辑伙伴")}${button("promotion", p.id, "复制专属推广包")}${button("partner-csv", p.id, "导出伙伴对账单")}</div></article>`;
    }).join("") : '<div class="business-empty business-full"><h2>先找到能带来客户的伙伴</h2><p>可从认识的门店、设计师、内容创作者或交付协作者开始，逐单记录合作结果。</p></div>'}</div>`;
  }
  function renderOffers() {
    const settings = business.data.settings;
    $("#businessContent").innerHTML = `<div class="business-two-col"><article class="business-card"><h2>对外服务与承接方式</h2><p><strong>${esc(settings.studioName)}</strong><br>${esc(settings.contact || "请先填写您的收款 / 咨询联系渠道")}</p><p>${esc(settings.offerText)}</p><ol class="business-rule"><li>伙伴领取专属编号与推广包，介绍有真实需求的客户。</li><li>由您确认需求、报价和修改边界，客户向您付款。</li><li>制作伙伴按任务单交付，您负责验收与客户关系。</li><li>按净收款计算直接推荐佣金，交付、足额回款且不亏损后结算。</li><li>不按招募人数奖励，不收加入费，不承诺保底收入。</li></ol><div class="business-actions">${button("settings", "", "编辑服务与联系渠道")}${button("promotion", "", "复制通用推广包")}</div></article><article class="business-card"><h2>每单留存测算</h2><p class="business-muted">以下为可编辑的测算示例，不是市场报价或收入承诺。以实际回款、成本和合作约定为准。</p><div class="business-fields">${field("calcPrice", "预计净收款（元）", "399", "number")}${field("calcCost", "接口与其他成本（元）", "90", "number")}${field("calcProducer", "制作伙伴报酬（元）", "60", "number")}${field("calcRate", "推广佣金（%）", "10", "number")}</div><div id="businessCalcOutput" class="business-calc-output" aria-live="polite"></div><small>留存 = 净收款 − 接口及其他成本 − 制作报酬 − 直接推荐佣金。制作报酬单独记账，勿重复计入其他成本。</small></article></div>`;
    calculate();
  }
  function calculate() {
    try {
      const price = moneyInput($("#calcPrice").value), cost = moneyInput($("#calcCost").value), producer = moneyInput($("#calcProducer").value), rate = moneyInput($("#calcRate").value);
      if (rate > 10000) throw new Error("佣金不能超过100%");
      const retained = price - cost - producer - Math.round(price * rate / 10000);
      $("#businessCalcOutput").textContent = `您的预计留存 ${yuan(retained)}`;
      $("#businessCalcOutput").classList.toggle("business-negative", retained < 0);
    } catch (e) { $("#businessCalcOutput").textContent = e.message; }
  }
  function renderActivity() {
    const ledger = business.data.orders.flatMap((o) => o.settlements.map((s) => `<tr><td>${esc(s.recordedAt.slice(0, 19).replace("T", " "))} UTC</td><td>${esc(o.number)}</td><td>${esc(partnerName(o.referralId))}</td><td>${s.kind === "recovery" ? "追回" : "支付"} ${yuan(Math.abs(s.amountCents))}</td><td>${esc(s.reference)}</td></tr>`));
    $("#businessContent").innerHTML = `<div class="business-subhead"><p class="business-muted">结算按钮只登记已经发生的线下支付或追回，不会自动转账。</p><a class="small-button" href="/api/business/export" download="business-backup.json">下载完整经营备份</a></div><article class="business-card"><h2>推广佣金流水</h2><div class="business-table-scroll"><table class="business-ledger"><thead><tr><th>记录时间</th><th>订单</th><th>推广伙伴</th><th>金额</th><th>凭据 / 备注</th></tr></thead><tbody>${ledger.join("") || '<tr><td colspan="5">暂无支付或追回记录</td></tr>'}</tbody></table></div></article><article class="business-card" style="margin-top:16px"><h2>最近经营操作</h2>${business.data.activity.slice(0, 30).map((item) => `<p><small>${esc(item.at.slice(0, 19).replace("T", " "))} UTC</small> · ${esc(({ partner: "伙伴记录", order: "订单记录", settings: "服务设置", settlement: "结算记录" })[item.action])} · ${esc(item.subject)}</p>`).join("") || '<p class="business-muted">新建订单或伙伴后，将在这里保留记录。</p>'}</article>`;
  }
  function field(name, label, value = "", type = "text", extra = "") {
    return `<label>${label}<input name="${name}" id="${name}" type="${type}" value="${esc(value)}" ${type === "number" ? 'min="0" step="0.01" max="1000000"' : 'maxlength="200"'} ${extra}></label>`;
  }
  function select(name, label, items, value) { return `<label>${label}<select name="${name}">${items.map(([id, title]) => `<option value="${esc(id)}" ${id === String(value) ? "selected" : ""}>${esc(title)}</option>`).join("")}</select></label>`; }
  function area(name, label, value = "", max = 3000) { return `<label class="business-full">${label}<textarea name="${name}" rows="3" maxlength="${max}" required>${esc(value)}</textarea></label>`; }
  function openForm(title, action, id, html) {
    if (!business.data) return;
    $("#businessDialogTitle").textContent = title;
    form.dataset.action = action; form.dataset.id = id || ""; form.dataset.revision = business.data.revision;
    form.innerHTML = `<div class="business-fields">${html}</div><p id="businessFormError" class="business-negative" role="alert"></p><div class="business-actions"><button type="button" class="secondary-button" data-close-business>取消</button><button type="submit" class="primary-button">保存记录</button></div>`;
    dialog.showModal();
  }
  function partnerForm(id) {
    const p = business.data.partners.find((item) => item.id === id) || { name: "", contact: "", role: "referral", status: "active", commissionBps: 1000, notes: "" };
    openForm(id ? "编辑合作伙伴" : "新增合作伙伴", "partner", id, `${field("name", "伙伴名称", p.name, "text", "required maxlength=60")}${field("contact", "联系方式（微信 / 电话等）", p.contact)}${select("role", "合作角色", Object.entries(business.data.roles), p.role)}${select("status", "合作状态", [["active", "合作中"], ["paused", "暂停合作"]], p.status)}${field("commissionRate", "默认推广佣金（%）", p.commissionBps / 100, "number", "required")}${area("notes", "合作约定（角色、报酬与边界）", p.notes, 2000).replace(" required", "")}`);
  }
  function orderForm(id) {
    const o = business.data.orders.find((item) => item.id === id) || { client: "", contact: "", product: "", brief: "", stage: "lead", duration: 15, referralId: "", producerId: "", dueDate: "", quoteCents: 0, receivedCents: 0, refundCents: 0, apiCostCents: 0, productionFeeCents: 0, commissionBps: 1000, deliveryUrl: "", notes: "" };
    const available = (role, current) => [["", role === "production" ? "自行制作" : "自主接单"], ...business.data.partners.filter((p) => p.id === current || (p.status === "active" && (p.role === role || p.role === "both"))).map((p) => [p.id, `${p.name} · ${p.code}`])];
    const financialFields = [["quoteCents", "订单报价（元）"], ["receivedCents", "累计实际收款（元）"], ["refundCents", "累计退款（元）"], ["apiCostCents", "接口与其他实际成本（元）"], ["productionFeeCents", "制作伙伴约定报酬（元）"]].map(([key, label]) => field(key, label, (o[key] / 100).toFixed(2), "number", "required")).join("");
    openForm(id ? `订单 ${o.number}` : "记录客户 / 订单", "order", id, `${field("client", "客户名称", o.client, "text", "required maxlength=100")}${field("contact", "客户联系方式", o.contact)}${field("product", "产品 / 项目名称", o.product, "text", "required maxlength=150")}${select("stage", "订单阶段", Object.entries(business.data.stages), o.stage)}${select("duration", "视频时长", [5, 8, 10, 15, 30].map((v) => [String(v), `${v} 秒`]), o.duration)}${field("dueDate", "约定交付日期", o.dueDate, "date")}${select("referralId", "直接推广伙伴", available("referral", o.referralId), o.referralId)}${select("producerId", "制作伙伴", available("production", o.producerId), o.producerId)}${area("brief", "客户需求（平台、素材、风格、修改次数与验收标准）", o.brief)}${financialFields}${field("commissionRate", "本单推广佣金（%）", o.commissionBps / 100, "number", "required")}${field("deliveryUrl", "成片 / 交付链接", o.deliveryUrl, "url", "maxlength=2000")}<p class="business-muted business-full">先到账再制作。交付后、足额收款且扣除成本不亏损，才开放佣金结算。制作伙伴报酬单列，勿重复算入其他成本。已有结算后，推广归属与比例锁定。</p>${area("notes", "订单备注", o.notes, 2000).replace(" required", "")}`);
  }
  function settlementForm(id, kind) {
    const order = business.data.orders.find((o) => o.id === id);
    const amount = kind === "recovery" ? order.money.recoverableCents : order.money.payableCents;
    openForm(kind === "recovery" ? "登记已追回佣金" : "登记已支付佣金", "settlement", id, `<p class="business-full">${esc(order.number)} · ${esc(partnerName(order.referralId))}<br>仅记录已经完成的线下支付 / 追回，本按钮不会转账。</p><input type="hidden" name="kind" value="${kind}">${field("amountCents", "本次金额（元）", (amount / 100).toFixed(2), "number", "required")}${field("reference", "支付 / 追回凭据或备注", "", "text", "required")}`);
  }
  function moneyInput(value) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) throw new Error("金额和比例请填写非负数，最多两位小数");
    const [whole, decimal = ""] = String(value).split(".");
    const result = Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
    if (!Number.isSafeInteger(result) || result > 100_000_000) throw new Error("金额超出有效范围");
    return result;
  }
  async function save(event) {
    event.preventDefault(); if (business.saving) return;
    business.saving = true;
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.revision = Number(form.dataset.revision); body.id = form.dataset.id;
      if ("commissionRate" in body) { body.commissionBps = moneyInput(body.commissionRate); delete body.commissionRate; }
      if ("duration" in body) body.duration = Number(body.duration);
      for (const field of ["quoteCents", "receivedCents", "refundCents", "apiCostCents", "productionFeeCents", "amountCents"]) if (field in body) body[field] = moneyInput(body[field]);
      business.data = await request(`/${form.dataset.action}`, body);
      dialog.close(); render(); error("");
    } catch (e) { $("#businessFormError").textContent = e.message; }
    finally { business.saving = false; submit.disabled = false; }
  }
  async function copy(value) {
    try { await navigator.clipboard.writeText(value); toast("已复制，可按您的渠道发送给合作伙伴"); }
    catch { openForm("请手动复制", "copy", "", area("copyText", "内容", value, 15000)); form.querySelector('[type="submit"]').hidden = true; }
  }
  function promotion(id) {
    const s = business.data.settings, p = business.data.partners.find((item) => item.id === id);
    return `${s.studioName} · 商品短视频制作\n${s.offerText}\n\n客户需求单：\n客户称呼与联系渠道：\n产品与参考图：\n发布平台与目标客户：\n成片时长：15秒 / 30秒（视模型支持）\n风格与参考作品：\n预算与期望交付时间：\n${p ? `直接推荐编号：${p.code}\n合作伙伴：${p.name}\n` : ""}\n${s.contact ? `承接联系：${s.contact}` : "请与工作室核定报价和承接渠道后再推广。"}\n\n合作约定：先确认需求与报价，再向工作室支付定金。${p && p.role !== "production" ? `直接推荐佣金按约定净收款的${p.commissionBps / 100}%测算，最终以订单约定为准；` : ""}交付、足额回款且订单不亏损后结算。退款会相应冲减佣金。不收加入费，不按招募人数奖励。未经核实的效果、收入与商品功效不作承诺。`;
  }
  function taskBrief(id) {
    const o = business.data.orders.find((item) => item.id === id);
    return `制作任务单 ${o.number}\n产品：${o.product}\n负责人：${partnerName(o.producerId)}\n时长：${o.duration}秒\n交付日期：${o.dueDate || "待约定"}\n需求与验收标准：${o.brief}\n${o.producerId ? `约定制作报酬：${yuan(o.productionFeeCents)}\n` : ""}交付链接：${o.deliveryUrl || "待提供"}\n备注：${o.notes}\n请勿直接调用未授权的收费接口；商品与人物素材须先由工作室确认。`;
  }
  async function produce(id) {
    const order = business.data.orders.find((o) => o.id === id);
    if (order.money.collectedCents <= 0) return error("请先在订单中记录实际到账定金，再进入制作，避免垫付接口成本。");
    if (!window.prepareBusinessOrder(order)) return;
    business.activeOrderId = id; renderActiveOrder(); show("studio");
  }
  function renderActiveOrder() {
    const order = business.data?.orders.find((o) => o.id === business.activeOrderId);
    $("#businessOrderContext").hidden = !order;
    if (order) $("#businessOrderLabel").textContent = `${order.number} · ${order.client} · ${order.duration}秒`;
  }
  async function attachVideo() {
    const video = window.currentBusinessVideo();
    if (!video || !business.activeOrderId) return toast("请先完成当前订单的视频生成，再写回真实成片链接");
    try {
      const fresh = await request("");
      const order = fresh.orders.find((o) => o.id === business.activeOrderId);
      if (!order || order.stage === "cancelled") throw new Error("订单不存在或已取消");
      if (video.duration !== order.duration) throw new Error("成片提交时长与订单约定不同，请先核对订单时长或重新制作");
      business.data = await request("/order", { ...order, stage: order.stage === "delivered" ? "delivered" : "review", deliveryUrl: video.url, revision: fresh.revision });
      toast("成片已写回订单，客户验收后再标记已交付");
    } catch (e) { toast(e.message); }
  }
  $("#businessContent").addEventListener("click", async (event) => {
    const target = event.target.closest("[data-action]"); if (!target || !business.data) return;
    const { action, id } = target.dataset;
    if (action === "order") orderForm(id);
    if (action === "partner") partnerForm(id);
    if (["payment", "recovery"].includes(action)) settlementForm(id, action);
    if (action === "promotion") copy(promotion(id));
    if (action === "brief") copy(taskBrief(id));
    if (action === "produce") produce(id);
    if (action === "settings") {
      const s = business.data.settings;
      openForm("编辑服务与联系渠道", "settings", "", `${field("studioName", "工作室名称", s.studioName, "text", "required")}${field("contact", "咨询与承接渠道", s.contact)}${area("offerText", "服务内容、交付范围与修改边界", s.offerText)}`);
    }
  });
  $("#businessContent").addEventListener("input", (event) => {
    if (event.target.id === "businessSearch") { business.query = event.target.value; renderOrderCards(); }
    if (event.target.id.startsWith("calc")) calculate();
  });
  $("#businessContent").addEventListener("change", (event) => {
    if (event.target.id === "businessStageFilter") { business.stage = event.target.value; renderOrderCards(); }
  });
  form.addEventListener("change", (event) => {
    if (event.target.name === "referralId") {
      const p = business.data.partners.find((item) => item.id === event.target.value);
      form.elements.commissionRate.value = (p?.commissionBps || 0) / 100;
    }
  });
  form.addEventListener("submit", save);
  dialog.addEventListener("click", (event) => { if (event.target.closest("[data-close-business]")) dialog.close(); });
  $("#closeBusinessDialog").addEventListener("click", () => dialog.close());
  $("#newBusinessOrder").addEventListener("click", () => { if (business.data) orderForm(""); });
  $("#refreshBusiness").addEventListener("click", load);
  $("#returnToBusiness").addEventListener("click", () => show("business"));
  $("#attachBusinessVideo").addEventListener("click", attachVideo);
  document.querySelectorAll("[data-business-tab]").forEach((b) => b.addEventListener("click", () => { business.tab = b.dataset.businessTab; render(); }));
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  window.clearBusinessOrder = () => { business.activeOrderId = ""; renderActiveOrder(); };
  if (location.hash === "#business") show("business");
})();
