const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  step: 1,
  imageDataUrl: "",
  analysis: null,
  selections: null,
  businessDuration: null,
  activeRequests: 0,
  lastVideoDuration: 0,
  plan: null,
  generatedCreatorUrls: JSON.parse(localStorage.getItem("seedance-generated-creator-urls-v2") || "[]"),
  generatedSceneUrls: JSON.parse(localStorage.getItem("seedance-generated-scene-urls-v2") || "[]"),
  lastVideoTaskId: localStorage.getItem("seedance-last-task-id") || "",
  activePlanTab: "overview",
  activeApiTab: "text",
  activePromptTarget: "",
  additionalReferences: [],
  pollTimer: null,
  taskClockTimer: null,
  polling: false,
  pollFailures: 0,
  finalizingPolls: 0,
  nextPollAt: 0,
  lastTaskSyncAt: 0,
  lastTaskSnapshot: null,
  lastVideoTaskStatus: localStorage.getItem("seedance-last-task-status") || "",
  lastVideoUrl: localStorage.getItem("seedance-last-video-url") || "",
  taskStartedAt: Number(localStorage.getItem("seedance-task-started-at") || 0),
  videoProviderCheck: null,
  serverProviders: { text: false, image: false, video: false },
  config: JSON.parse(localStorage.getItem("seedance-model-config") || "null") || {
    text: { enabled: false, baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4.1-mini" },
    image: {
      enabled: false,
      baseUrl: "https://yuncenai.com",
      apiKey: "",
      model: "gpt-image-2",
      endpoint: "/v1/images/generations",
      editEndpoint: "/v1/images/edits",
    },
    video: {
      enabled: false,
      baseUrl: "https://yuncenai.com",
      apiKey: "",
      model: "doubao-seedance-2.0",
      endpoint: "/api/v3/contents/generations/tasks",
      taskEndpoint: "/api/v3/contents/generations/tasks",
    },
  },
};

const stepMeta = {
  1: ["STEP 01 · PRODUCT INPUT", "上传一张产品图", "系统会读取包装与视觉线索，推荐市场、平台、口播语言和视频形式。"],
  2: ["STEP 02 · SMART TARGETING", "确认智能推荐", "根据产品证据调整六项制作参数，不会自动把未知市场当作美国。"],
  3: ["STEP 03 · DIRECTOR PLAN", "完整导演方案", "查看定位、达人、Hook、口播脚本、分镜和可直接粘贴的生成提示词。"],
  4: ["STEP 04 · LINKED GENERATION", "执行与成片", "商品原图、人物持品图和商品场景图将按固定顺序进入视频生成。"],
};

const selectionOptions = {
  market: ["跨境电商泛英语市场", "美国", "英国 / 欧洲", "中国大陆", "日本", "韩国", "东南亚", "拉丁美洲", "中东"],
  platform: ["TikTok / Instagram Reels", "YouTube Shorts", "Amazon", "抖音", "小红书", "淘宝", "Shopee / Lazada"],
  language: ["美式英文", "英式英文", "中文普通话", "粤语", "日文", "韩文", "泰文", "越南语", "印尼语", "西语", "葡语", "阿语"],
  format: ["真人口播 + 手部演示 + 体验反应", "旁白 + 产品特写", "手部演示", "开箱测评", "剧情对话", "前后对比", "混合形式"],
  creator: ["虚拟达人", "已有固定达人", "仅手部出镜", "无人物"],
  duration: ["15秒", "30秒", "10秒", "8秒", "5秒"],
};

const selectionLabels = {
  market: "投放国家 / 地区",
  platform: "发布平台",
  language: "口播语言",
  format: "声音 / 画面形式",
  creator: "达人方式",
  duration: "成片时长",
};

function normalizeVideoConfig() {
  const video = state.config.video;
  if (!video) return;
  if (!video.baseUrl || video.baseUrl.includes("api.seevio.ai")) video.baseUrl = "https://yuncenai.com";
  if (!video.model || video.model === "seedance-2-0") video.model = "doubao-seedance-2.0";
  if (!video.endpoint || video.endpoint === "/v1/videos/generations" || video.endpoint === "/videos") {
    video.endpoint = "/api/v3/contents/generations/tasks";
  }
  if (!video.taskEndpoint || video.taskEndpoint === "/v1/tasks") {
    video.taskEndpoint = "/api/v3/contents/generations/tasks";
  }
  localStorage.setItem("seedance-model-config", JSON.stringify(state.config));
}

function normalizeImageConfig() {
  const image = state.config.image;
  if (!image) return;
  if (!image.baseUrl || image.baseUrl.includes("api.openai.com")) image.baseUrl = "https://yuncenai.com";
  if (!image.model || image.model === "gpt-image-1") image.model = "gpt-image-2";
  if (!image.endpoint || image.endpoint === "/images/generations") image.endpoint = "/v1/images/generations";
  if (!image.editEndpoint) image.editEndpoint = "/v1/images/edits";
  localStorage.setItem("seedance-model-config", JSON.stringify(state.config));
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function setLoading(button, loading, text) {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = loading;
  button.classList.toggle("loading", loading);
  if (text) button.firstElementChild ? button.firstElementChild.textContent = text : button.textContent = text;
  if (!loading) button.firstElementChild ? button.firstElementChild.textContent = button.dataset.label : button.textContent = button.dataset.label;
}

async function post(url, body) {
  state.activeRequests += 1;
  try {
    const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  } finally { state.activeRequests -= 1; }
}

function goToStep(step) {
  state.step = step;
  $$(".step-panel").forEach((panel) => panel.classList.toggle("active", Number(panel.dataset.panel) === step));
  $$(".step-item").forEach((item) => {
    const itemStep = Number(item.dataset.step);
    item.classList.toggle("active", itemStep === step);
    item.classList.toggle("complete", itemStep < step);
  });
  const [eyebrow, title, desc] = stepMeta[step];
  $("#stepEyebrow").textContent = eyebrow;
  $("#stepTitle").textContent = title;
  $("#stepDesc").textContent = desc;
  $("#progressText").textContent = `${step} / 4`;
  $("#progressBar").style.width = `${step * 25}%`;
  if (step === 4) renderGenerationContext();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function clearGeneratedOutputs() {
  stopAutoPoll();
  state.generatedCreatorUrls = [];
  state.generatedSceneUrls = [];
  state.additionalReferences = [];
  renderReferenceTargets();
  state.lastVideoTaskId = "";
  state.lastVideoTaskStatus = "";
  state.lastVideoUrl = "";
  state.taskStartedAt = 0;
  state.lastTaskSnapshot = null;
  state.pollFailures = 0;
  state.finalizingPolls = 0;
  ["seedance-generated-image-urls", "seedance-generated-creator-urls", "seedance-generated-scene-urls", "seedance-generated-creator-urls-v2", "seedance-generated-scene-urls-v2", "seedance-last-task-id", "seedance-last-task-status", "seedance-last-video-url", "seedance-task-started-at"]
    .forEach((key) => localStorage.removeItem(key));
  if ($("#creatorResult")) $("#creatorResult").innerHTML = '<div class="result-empty">人物持品图将在这里显示</div>';
  if ($("#sceneResult")) $("#sceneResult").innerHTML = '<div class="result-empty">商品场景图将在这里显示</div>';
  if ($("#videoResult")) $("#videoResult").innerHTML = '<div class="result-empty">视频任务状态将在这里显示</div>';
  if ($("#seedanceImages")) $("#seedanceImages").value = "";
  if ($("#seedancePerson")) $("#seedancePerson").value = "";
  updateSeedanceAssetHint();
}

function clearPlanningState() {
  state.analysis = null;
  state.selections = null;
  state.plan = null;
  clearGeneratedOutputs();
}

function setImage(dataUrl) {
  if (state.activeRequests) return toast("正在处理当前项目，请等待请求结束后再更换商品素材");
  if (dataUrl !== state.imageDataUrl) clearPlanningState();
  state.imageDataUrl = dataUrl;
  $("#previewImage").src = dataUrl;
  $("#analysisThumb").src = dataUrl;
  $("#uploadZone").classList.toggle("has-image", Boolean(dataUrl));
  updateSeedanceAssetHint();
  renderGenerationContext();
}

function loadFile(file) {
  if (!file || !file.type.startsWith("image/")) return toast("请选择图片文件");
  if (file.size > 10 * 1024 * 1024) return toast("图片不能超过 10MB");
  const reader = new FileReader();
  reader.onload = () => setImage(reader.result);
  reader.readAsDataURL(file);
}

async function useDemo() {
  const response = await fetch("/assets/demo-product.png");
  const blob = await response.blob();
  const reader = new FileReader();
  reader.onload = () => {
    setImage(reader.result);
    $("#productName").value = "LUMA C Serum";
    $("#productDescription").value = "轻盈滴管精华，适合晨间护肤与妆前叠加。具体成分和功效数据待品牌方确认。";
    toast("已载入演示产品");
  };
  reader.readAsDataURL(blob);
}

function renderSelections() {
  const recommended = state.analysis.recommendations;
  $("#selectionGrid").innerHTML = Object.entries(selectionOptions).map(([key, options]) => {
    const current = state.selections?.[key] || recommended[key] || options[0];
    const merged = options.includes(current) ? options : [current, ...options];
    return `<div class="selection-card">
      <label for="select-${key}">${selectionLabels[key]}</label>
      <select id="select-${key}" data-selection="${key}">
        ${merged.map((option) => `<option ${option === current ? "selected" : ""}>${option}</option>`).join("")}
      </select>
      <small>${key === "duration" ? "30秒需使用支持长视频的模型，如 Seedance 2.5" : state.analysis?.mode === "demo" ? "本地草稿 · 请确认" : "AI 推荐 · 可修改"}</small>
    </div>`;
  }).join("");
}

async function analyzeProduct() {
  if (!state.imageDataUrl && !$("#productDescription").value.trim()) return toast("请上传产品图或填写产品描述");
  const button = $("#analyzeButton");
  setLoading(button, true, "正在识别产品");
  try {
    const analysis = await post("/api/analyze", {
      imageDataUrl: state.imageDataUrl,
      productName: $("#productName").value.trim(),
      description: $("#productDescription").value.trim(),
      config: state.config,
    });
    state.plan = null;
    clearGeneratedOutputs();
    state.analysis = analysis;
    state.selections = Object.fromEntries(Object.keys(selectionOptions).map((key) => [key, state.analysis.recommendations?.[key] || selectionOptions[key][0]]));
    if (state.businessDuration) state.selections.duration = `${state.businessDuration}秒`;
    const product = state.analysis.product;
    $("#detectedName").textContent = product.name || "未命名产品";
    $("#detectedSummary").textContent = product.summary || "";
    $("#confidenceValue").textContent = `${state.analysis.confidence || 0}%`;
    $("#marketReason").textContent = state.analysis.recommendations.marketReason || "根据产品证据进行市场推断。";
    renderSelections();
    goToStep(2);
    updateMode();
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
}

function getSelections() {
  const selections = Object.fromEntries($$("[data-selection]").map((select) => [select.dataset.selection, select.value]));
  state.selections = selections;
  return selections;
}

async function generatePlan() {
  const button = $("#planButton");
  setLoading(button, true, "正在编排方案");
  try {
    const selections = getSelections();
    const plan = await post("/api/plan", {
      analysis: state.analysis,
      selections,
      config: state.config,
    });
    clearGeneratedOutputs();
    state.plan = plan;
    $("#planTitle").textContent = state.plan.title;
    applyPlanToGeneration();
    renderPlan("overview");
    goToStep(3);
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
}

function renderPlan(tab) {
  state.activePlanTab = tab;
  $$(".plan-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  const plan = state.plan;
  const content = $("#planContent");
  if (tab === "overview") {
    const targeting = plan.targeting || state.selections || {};
    content.innerHTML = `<div class="targeting-strip">
      ${[targeting.market, targeting.platform, targeting.language, targeting.format, targeting.creator, targeting.duration].filter(Boolean).map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
    </div><div class="strategy-grid">
      <div class="strategy-box"><small>产品定位</small><p>${escapeHtml(plan.strategy.positioning)}</p></div>
      <div class="strategy-box"><small>核心受众</small><p>${escapeHtml(plan.strategy.audience)}</p></div>
      <div class="strategy-box"><small>创意角度</small><p>${escapeHtml(plan.strategy.angle)}</p></div>
    </div>
    <div class="creator-strip"><h3>虚拟达人设定</h3><p><strong>人物：</strong>${escapeHtml(plan.creator.profile)}</p><p><strong>画面：</strong>${escapeHtml(plan.creator.visual)}</p><p><strong>可信度：</strong>${escapeHtml(plan.creator.credibility)}</p></div>`;
  } else if (tab === "hooks") {
    content.innerHTML = `<ol class="hook-list">${plan.hooks.map((hook) => `<li>${escapeHtml(hook)}</li>`).join("")}</ol>`;
  } else if (tab === "script") {
    content.innerHTML = `<table class="script-table"><thead><tr><th>时间</th><th>画面</th><th>口播</th><th>字幕</th></tr></thead><tbody>${plan.script.map((row) => `<tr><td>${escapeHtml(row.time)}</td><td>${escapeHtml(row.visual)}</td><td>${escapeHtml(row.voice)}</td><td>${escapeHtml(row.caption)}</td></tr>`).join("")}</tbody></table>`;
  } else if (tab === "prompts") {
    content.innerHTML = `<div class="prompt-card"><h3>人物持品图提示词</h3><pre>${escapeHtml(plan.creatorPrompt || "")}</pre></div><div class="prompt-card"><h3>商品场景图提示词</h3><pre>${escapeHtml(plan.scenePrompt || plan.imagePrompt || "")}</pre></div><div class="prompt-card"><h3>Seedance / 即梦视频提示词</h3><pre>${escapeHtml(plan.videoPrompt)}</pre></div>`;
  } else {
    content.innerHTML = `<ul class="check-list">${plan.checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
  }
}

function applyPlanToGeneration() {
  if (!state.plan) return;
  $("#creatorPrompt").value = state.plan.creatorPrompt || "";
  $("#scenePrompt").value = state.plan.scenePrompt || state.plan.imagePrompt || "";
  $("#videoPrompt").value = state.plan.videoPrompt || "";
  const targeting = state.plan.targeting || state.selections || {};
  const duration = String(targeting.durationSeconds || Number.parseInt(targeting.duration, 10) || 15);
  if ($(`#seedanceDuration option[value="${duration}"]`)) $("#seedanceDuration").value = duration;
  if (targeting.ratio && $(`#seedanceRatio option[value="${targeting.ratio}"]`)) $("#seedanceRatio").value = targeting.ratio;
  $("#seedanceMode").value = state.imageDataUrl ? "reference-to-video" : "text-to-video";
  syncGeneratedAssetsToSeedance();
  renderGenerationContext();
}

function referencePreview(src, label, position, ready) {
  return `<div class="reference-item ${ready ? "ready" : "missing"}">
    <div class="reference-thumb">${src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}">` : `<span>${position}</span>`}</div>
    <div><small>图片 ${position}</small><strong>${escapeHtml(label)}</strong><p>${ready ? "已进入视频参考链" : "等待上级产出"}</p></div>
  </div>`;
}

function renderGenerationContext() {
  const container = $("#generationContext");
  if (!container) return;
  const imageReferenceSummary = $("#imageReferenceSummary");
  if (imageReferenceSummary) {
    imageReferenceSummary.textContent = state.imageDataUrl
      ? "人物持品图与商品场景图独立生成 · 两张图都由图片1商品原图编辑产生"
      : "缺少商品原图 · 请先完成商品分析与定向";
    imageReferenceSummary.classList.toggle("missing", !state.imageDataUrl);
  }
  renderVideoReferencePreview();
  if (!state.plan) {
    container.innerHTML = '<div class="result-empty">完成第二步和第三步后，定向、脚本与参考素材会在这里串联。</div>';
    return;
  }
  const targeting = state.plan.targeting || state.selections || {};
  const product = state.analysis?.product || {};
  const creatorUrl = state.generatedCreatorUrls[0] || "";
  const sceneUrl = state.generatedSceneUrls[0] || "";
  const script = Array.isArray(state.plan.script) ? state.plan.script : [];
  const targetRows = [
    ["市场", targeting.market], ["平台", targeting.platform], ["口播", targeting.language],
    ["形式", targeting.format], ["人物", targeting.creator], ["时长", targeting.duration],
  ].filter(([, value]) => value);
  container.innerHTML = `<div class="chain-product">
      ${state.imageDataUrl ? `<img src="${escapeHtml(state.imageDataUrl)}" alt="商品原图">` : ""}
      <div><small>步骤 1 · 商品事实</small><strong>${escapeHtml(product.name || "未命名商品")}</strong><p>${escapeHtml(product.summary || "")}</p></div>
    </div>
    <div class="chain-section"><h3>步骤 2 · 智能定向</h3><dl>${targetRows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></div>
    <div class="chain-section"><h3>参考素材顺序</h3>
      <div class="reference-list">
        ${referencePreview(state.imageDataUrl, "商品原图 · 锁定商品一致性", 1, Boolean(state.imageDataUrl))}
        ${referencePreview(creatorUrl, "人物持品图 · 锁定身份与持握关系", 2, Boolean(creatorUrl))}
        ${referencePreview(sceneUrl, "商品场景图 · 锁定环境与商品摆位", 3, Boolean(sceneUrl))}
      </div>
    </div>
    <div class="chain-section script-chain"><h3>步骤 3 · 分镜执行</h3>
      ${script.map((row, index) => `<div class="script-chain-row"><b>${index + 1}</b><span><small>${escapeHtml(row.time)}</small>${escapeHtml(row.visual)}</span></div>`).join("")}
    </div>`;
  const summary = $("#videoReferenceSummary");
  const [productReference, personReference, sceneReference] = seedanceReferenceImages();
  if (summary) {
    summary.textContent = productReference && personReference && sceneReference
      ? "严格三参考已就绪 · 图片1商品优先，图片2持握关系，图片3场景摆位"
      : `${productReference ? "图片1商品已就绪" : "缺少图片1商品"} · ${personReference ? "图片2人物持品已就绪" : "缺少图片2人物持品图"} · ${sceneReference ? "图片3商品场景已就绪" : "缺少图片3商品场景图"}`;
    summary.classList.toggle("missing", !(productReference && personReference && sceneReference));
  }
}

function copyPlan() {
  navigator.clipboard.writeText(JSON.stringify(state.plan, null, 2)).then(() => toast("完整方案已复制"));
}

function insertPromptReference(selectorId = "#promptReferenceSelector", promptId = "#videoPrompt") {
  const selector = $(selectorId);
  const prompt = $(promptId);
  const token = selector?.value || "";
  if (!token || !prompt) return;
  const start = Number.isInteger(prompt.selectionStart) ? prompt.selectionStart : prompt.value.length;
  const end = Number.isInteger(prompt.selectionEnd) ? prompt.selectionEnd : start;
  const before = prompt.value.slice(0, start);
  const after = prompt.value.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  prompt.value = `${before}${prefix}${token}${suffix}${after}`;
  const caret = before.length + prefix.length + token.length + suffix.length;
  prompt.focus();
  prompt.setSelectionRange(caret, caret);
  prompt.dispatchEvent(new Event("input", { bubbles: true }));
  toast(`已插入：${token}`);
}

function currentReferences(promptId = "#videoPrompt") {
  if (promptId === "#promptEditorText") promptId = state.activePromptTarget;
  if (promptId !== "#videoPrompt") return ReferenceBindings.imageReferences(state.imageDataUrl, state.additionalReferences);
  const [product, person, scene] = seedanceReferenceImages();
  return ReferenceBindings.videoReferences({
    generation_type: $("#seedanceMode").value,
    reference_policy: $("#seedanceMode").value === "reference-to-video" ? "product-interaction-scene-strict-v2" : "",
    product_image_url: product,
    person_image_url: person,
    scene_image_urls: [scene],
    image_urls: [scene || product].filter(Boolean),
    additional_references: $("#seedanceMode").value === "reference-to-video" ? state.additionalReferences : [],
  });
}

function renderReferenceSelectors() {
  for (const [selectorId, promptId] of [["#promptReferenceSelector", "#videoPrompt"], ["#editorReferenceSelector", "#promptEditorText"]]) {
    const selector = $(selectorId);
    const selected = selector.value;
    selector.innerHTML = currentReferences(promptId).map((reference) => `<option value="${escapeHtml(`@{${reference.name}}`)}" ${!reference.url ? "disabled" : ""}>@${escapeHtml(reference.name)} · 图片${reference.position}${reference.url ? "" : " · 缺少图片"}</option>`).join("");
    if ([...selector.options].some((option) => option.value === selected && !option.disabled)) selector.value = selected;
    else selector.value = [...selector.options].find((option) => !option.disabled)?.value || "";
  }
  renderReferenceBindingPreview();
}

function renderReferenceBindingPreview() {
  const references = currentReferences();
  $("#referenceBindingPreview").innerHTML = references.map((reference) => `<p class="${reference.url ? "" : "binding-error"}"><b>@${escapeHtml(reference.name || "未命名")}</b> → 图片${reference.position} · ${escapeHtml(reference.target || ReferenceBindings.roleLabels[reference.role])}${reference.url ? "" : " · 缺少图片"}</p>`).join("");
  try {
    ReferenceBindings.validateReferences(references);
    const compiled = ReferenceBindings.compilePrompt($("#videoPrompt").value, references);
    $("#compiledVideoPrompt").textContent = `${ReferenceBindings.bindingText(references)}\n${compiled.text}`.trim();
    $("#compiledVideoPrompt").classList.remove("binding-error");
  } catch (error) {
    $("#compiledVideoPrompt").textContent = error.message;
    $("#compiledVideoPrompt").classList.add("binding-error");
  }
}

function renderReferenceTargets() {
  $("#referenceTargetCount").textContent = `${state.additionalReferences.length} / 6`;
  $("#addReferenceTarget").disabled = state.additionalReferences.length >= 6;
  $("#referenceTargetList").innerHTML = state.additionalReferences.map((reference) => `<div class="reference-target" data-reference-id="${escapeHtml(reference.id)}">
    <div class="reference-target-head"><strong>@${escapeHtml(reference.name || "未命名")}</strong><button class="icon-button" type="button" data-remove-reference title="删除参考目标" aria-label="删除 ${escapeHtml(reference.name)}">×</button></div>
    <div class="control-grid"><label>名称<input data-reference-field="name" aria-label="参考目标名称" maxlength="24" value="${escapeHtml(reference.name)}"></label>
    <label>类型<select data-reference-field="role" aria-label="参考目标类型">${["person", "object", "scene"].map((role) => `<option value="${role}" ${reference.role === role ? "selected" : ""}>${ReferenceBindings.roleLabels[role]}</option>`).join("")}</select></label></div>
    <label>指定目标<input data-reference-field="target" aria-label="指定参考目标" maxlength="200" value="${escapeHtml(reference.target)}" placeholder="例如：左侧戴眼镜的人物 / 桌上的蓝色杯子"></label>
    <label>参考图片地址<input data-reference-field="url" aria-label="参考图片地址" value="${reference.url.startsWith("data:") ? "" : escapeHtml(reference.url)}" placeholder="${reference.url.startsWith("data:") ? "已上传本地图片" : "HTTPS URL / asset:// 地址"}"></label>
    <div class="reference-target-footer"><div class="reference-target-thumbnail">${reference.url && !reference.url.startsWith("asset:") ? `<img src="${escapeHtml(reference.url)}" alt="${escapeHtml(reference.name)}参考图">` : `<span>${reference.url ? "素材库图片" : "未选图片"}</span>`}</div><button class="small-button" type="button" data-upload-reference>上传图片</button><input type="file" accept="image/*" data-reference-file hidden></div>
  </div>`).join("");
  renderReferenceSelectors();
}

function bindReferenceMentions(textarea) {
  const wrapper = document.createElement("div");
  wrapper.className = "mention-editor";
  textarea.before(wrapper);
  wrapper.append(textarea);
  const menu = document.createElement("div");
  menu.className = "mention-menu";
  menu.setAttribute("role", "listbox");
  menu.id = `${textarea.id}-mentions`;
  menu.hidden = true;
  wrapper.append(menu);
  textarea.setAttribute("aria-controls", menu.id);
  textarea.setAttribute("aria-autocomplete", "list");
  let choices = [];
  let active = 0;
  let start = 0;
  const hide = () => { menu.hidden = true; textarea.removeAttribute("aria-activedescendant"); };
  const paint = () => {
    menu.innerHTML = choices.map((reference, index) => `<button type="button" role="option" id="${textarea.id}-mention-${index}" data-mention-index="${index}" aria-selected="${index === active}"><b>@${escapeHtml(reference.name)}</b><span>图片${reference.position} · ${escapeHtml(reference.target || ReferenceBindings.roleLabels[reference.role])}</span></button>`).join("");
    textarea.setAttribute("aria-activedescendant", `${textarea.id}-mention-${active}`);
  };
  const update = () => {
    const match = textarea.value.slice(0, textarea.selectionStart).match(/@(?:\{)?([\p{L}\p{N}_ -]*)$/u);
    if (!match) return hide();
    start = textarea.selectionStart - match[0].length;
    choices = currentReferences(`#${textarea.id}`).filter((reference) => reference.url && reference.name.includes(match[1]));
    if (!choices.length) return hide();
    active = 0;
    menu.hidden = false;
    paint();
  };
  const select = (index) => {
    const reference = choices[index];
    if (!reference) return;
    const end = textarea.selectionStart;
    const token = `@{${reference.name}} `;
    textarea.setRangeText(token, start, end, "end");
    hide();
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };
  textarea.addEventListener("input", update);
  textarea.addEventListener("click", update);
  textarea.addEventListener("keydown", (event) => {
    if (menu.hidden || event.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length;
      paint();
    } else if (["Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      select(active);
    } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); hide(); }
  });
  textarea.addEventListener("blur", hide);
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-mention-index]");
    if (option) select(Number(option.dataset.mentionIndex));
  });
}

function getImageUrl(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  return data?.previewUrl
    || data?.assetUrl
    || data?.referenceUrl
    || data?.localUrl
    || data?.url
    || data?.asset_url
    || data?.image_url
    || first?.url
    || first?.assetUrl
    || first?.asset_url
    || first?.image_url
    || "";
}

function absoluteAssetUrl(url) {
  if (!url) return "";
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

function syncGeneratedAssetsToSeedance() {
  const mode = $("#seedanceImageSource")?.value || "generated";
  if (mode !== "custom") {
    $("#seedancePerson").value = state.generatedCreatorUrls[0] || "";
    $("#seedanceImages").value = state.generatedSceneUrls[0] || "";
  }
  $("#seedancePerson").readOnly = mode !== "custom";
  $("#seedanceImages").readOnly = mode !== "custom";
  updateSeedanceAssetHint();
  renderGenerationContext();
}

function seedanceReferenceImages() {
  const product = state.imageDataUrl;
  const person = listValue("#seedancePerson")[0] || "";
  const scene = listValue("#seedanceImages")[0] || "";
  return [product, person, scene];
}

function renderVideoReferencePreview() {
  const container = $("#videoReferencePreview");
  if (!container) return;
  const [product = "", person = "", scene = ""] = seedanceReferenceImages();
  const items = [
    { index: 1, src: product, title: "商品原图", rule: "唯一商品外观依据" },
    { index: 2, src: person, title: "人物持品图", rule: "锁定人物、手势、持握关系与商品尺度" },
    { index: 3, src: scene, title: "商品场景图", rule: "锁定环境、机位、商品摆位与尺度" },
    ...state.additionalReferences.map((reference, index) => ({ index: index + 4, src: reference.url, title: reference.name, rule: reference.target || ReferenceBindings.roleLabels[reference.role] })),
  ];
  container.innerHTML = items.map((item) => `<div class="video-reference-card ${item.src ? "ready" : "missing"}">
    <div class="video-reference-image">${item.src && !item.src.startsWith("asset:") ? `<img src="${escapeHtml(item.src)}" alt="图片${item.index} ${escapeHtml(item.title)}">` : `<b>${item.index}</b>`}</div>
    <div><small>图片${item.index}</small><strong>${escapeHtml(item.title)}</strong><span>${item.src ? escapeHtml(item.rule) : "尚未就绪"}</span></div>
  </div>`).join("");
  container.classList.toggle("complete", Boolean(product && person && scene));
  renderReferenceSelectors();
}

function updateSeedanceAssetHint() {
  const hint = $("#seedanceAssetHint");
  if (!hint) return;
  const creatorReady = Boolean(state.generatedCreatorUrls.length);
  const sceneReady = Boolean(state.generatedSceneUrls.length);
  const mode = $("#seedanceImageSource")?.value || "generated";
  if (mode === "custom") {
    hint.textContent = state.imageDataUrl
      ? "图片1已锁定商品原图；自定义图片2需提供人物持品图，图片3需提供商品场景图。"
      : "未上传商品原图；严格三参考暂不可提交。";
  } else if (!creatorReady || !sceneReady) {
    hint.textContent = `图片1商品已锁定；${creatorReady ? "图片2人物持品已就绪" : "等待生成人物持品图"}；${sceneReady ? "图片3商品场景已就绪" : "等待生成商品场景图"}。`;
  } else {
    hint.textContent = "三图已就绪；图片1商品细节优先，图片2补充持握关系，图片3补充场景摆位。";
  }
}

function saveGeneratedImageUrl(role, url) {
  if (!url) return;
  const normalized = absoluteAssetUrl(url);
  const key = role === "creator" ? "generatedCreatorUrls" : "generatedSceneUrls";
  const storageKey = role === "creator" ? "seedance-generated-creator-urls-v2" : "seedance-generated-scene-urls-v2";
  state[key] = [normalized, ...state[key].filter((item) => item !== normalized)].slice(0, 3);
  localStorage.setItem(storageKey, JSON.stringify(state[key]));
  syncGeneratedAssetsToSeedance();
  renderGenerationContext();
}

function renderImageResult(data, role) {
  const result = role === "creator" ? $("#creatorResult") : $("#sceneResult");
  const label = role === "creator" ? "人物持品图" : "商品场景图";
  const url = getImageUrl(data);
  if (!url) {
    const fields = Object.keys(data || {}).filter((key) => !["apiKey"].includes(key)).join(", ") || "无字段";
    result.innerHTML = `<div class="job-card"><strong>未拿到${label}</strong><span>${escapeHtml(data.message || data.id || "接口没有返回 URL 或 base64 图片。")}</span><span>返回字段：${escapeHtml(fields)}</span></div>`;
    return;
  }
  const normalizedUrl = absoluteAssetUrl(url);
  saveGeneratedImageUrl(role, normalizedUrl);
  result.innerHTML = `<div class="image-output">
    <img src="${escapeHtml(normalizedUrl)}" alt="${label}">
    <div class="asset-url-row">
      <input readonly value="${escapeHtml(normalizedUrl)}" aria-label="生成图片 URL">
      <button class="small-button" type="button" data-copy-url="${escapeHtml(normalizedUrl)}">复制URL</button>
      <a class="small-link" href="${escapeHtml(normalizedUrl)}" target="_blank" rel="noreferrer">打开</a>
    </div>
    ${data.assetSource ? `<small class="asset-source">来源：${escapeHtml(data.assetSource === "base64-local" ? "接口返回 base64，已保存为本地资产" : "接口返回 URL")}</small>` : ""}
    <small class="asset-reference-ok">${label}已使用图片1商品原图编辑生成，并进入视频参考链</small>
  </div>`;
}

async function generateReferenceImage(role) {
  const creator = role === "creator";
  const button = creator ? $("#generateCreator") : $("#generateScene");
  const prompt = creator ? $("#creatorPrompt").value : $("#scenePrompt").value;
  const label = creator ? "人物持品图" : "商品场景图";
  if (!state.imageDataUrl || !state.plan) {
    toast("请先完成商品上传、智能定向和导演方案");
    goToStep(1);
    return;
  }
  if (!prompt.trim()) return toast(`请先填写${label}提示词`);
  setLoading(button, true, `正在生成${label}`);
  try {
    const references = ReferenceBindings.validateReferences(currentReferences(creator ? "#creatorPrompt" : "#scenePrompt"));
    ReferenceBindings.compilePrompt(prompt, references);
    const data = await post("/api/generate/image", {
      prompt,
      purpose: role,
      referenceImageDataUrl: state.imageDataUrl,
      additional_references: state.additionalReferences,
      referenceProductName: state.analysis?.product?.name || "商品",
      context: {
        productName: state.analysis?.product?.name || "商品",
        category: state.analysis?.product?.category || "",
        summary: state.analysis?.product?.summary || "",
        market: state.plan?.targeting?.market || state.selections?.market || "",
        platform: state.plan?.targeting?.platform || state.selections?.platform || "",
        format: state.plan?.targeting?.format || state.selections?.format || "",
        script: state.plan?.script || [],
      },
      config: state.config,
    });
    if (!data.referenceApplied || data.referenceMode !== "image-edit" || !data.productGrounded) {
      throw new Error(`${label}未正确绑定图片1商品原图，已阻止进入视频参考链`);
    }
    renderImageResult(data, role);
    toast(data.mode === "demo" ? `演示${label}已生成` : `${label}已独立生成`);
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
}

function listValue(selector) {
  return $(selector).value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function seedanceInput() {
  syncGeneratedAssetsToSeedance();
  const mode = $("#seedanceMode").value;
  const [productReference = "", personReference = "", sceneReference = ""] = seedanceReferenceImages();
  const strictReferences = mode === "reference-to-video";
  return {
    model: state.config.video.model || "doubao-seedance-2.0",
    prompt: $("#videoPrompt").value.trim(),
    generation_type: mode,
    reference_policy: strictReferences ? "product-interaction-scene-strict-v2" : "",
    product_image_url: strictReferences ? productReference : "",
    person_image_url: strictReferences ? personReference : "",
    scene_image_urls: strictReferences && sceneReference ? [sceneReference] : [],
    image_urls: strictReferences ? [productReference, personReference, sceneReference].filter(Boolean) : [sceneReference || productReference].filter(Boolean),
    additional_references: strictReferences ? state.additionalReferences : [],
    video_urls: listValue("#seedanceVideos"),
    audio_urls: listValue("#seedanceAudios"),
    duration: Number($("#seedanceDuration").value),
    ratio: $("#seedanceRatio").value,
    generate_audio: $("#seedanceAudio").checked,
    watermark: $("#seedanceWatermark").checked,
  };
}

const successfulVideoStatuses = new Set(["completed", "succeeded", "success"]);
const failedVideoStatuses = new Set(["failed", "error", "cancelled", "canceled"]);
const terminalVideoStatuses = new Set([...successfulVideoStatuses, ...failedVideoStatuses]);

function videoTaskFromData(data) {
  const task = data.task || {};
  const results = data.data?.results || data.results || [];
  const firstResult = Array.isArray(results) ? results[0] : results;
  return {
    mode: data.mode || "live",
    taskId: task.taskId || data.taskId || data.task_id || data.id || state.lastVideoTaskId || "",
    status: String(task.status || data.status || "submitted").toLowerCase(),
    videoUrl: task.videoUrl
      || data.videoUrl
      || data.video_url
      || data.content?.video_url
      || data.data?.content?.video_url
      || (typeof firstResult === "string" ? firstResult : firstResult?.video_url || firstResult?.url)
      || "",
    failedReason: task.failedReason || data.failed_reason || data.data?.failed_reason || "",
    expiresAt: task.expiresAt || data.data?.video_expires_at || data.video_expires_at || "",
    progress: Number(task.progress ?? data.progress ?? data.data?.progress ?? 0),
    progressSource: task.progressSource || data.progressSource || "estimated",
    createdAt: task.createdAt || data.created_at || data.data?.created_at || "",
    updatedAt: task.updatedAt || data.updated_at || data.data?.updated_at || "",
  };
}

function isTerminalVideoStatus(status) {
  return terminalVideoStatuses.has(String(status || "").toLowerCase());
}

function isSuccessfulVideoStatus(status) {
  return successfulVideoStatuses.has(String(status || "").toLowerCase());
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}分 ${String(seconds).padStart(2, "0")}秒` : `${seconds}秒`;
}

function formatSyncTime(timestamp) {
  if (!timestamp) return "等待首次同步";
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function estimatedTaskProgress(task, elapsedMs) {
  if (task.videoUrl) return 100;
  if (task.mode === "demo" && isSuccessfulVideoStatus(task.status)) return 100;
  if (isSuccessfulVideoStatus(task.status)) return 98;
  if (task.progressSource === "provider") return Math.min(98, Math.max(0, task.progress));
  const base = ["submitted", "created"].includes(task.status)
    ? 6
    : ["queued", "pending", "waiting"].includes(task.status) ? 12 : 24;
  const estimate = base + (94 - base) * (1 - Math.exp(-elapsedMs / 240_000));
  return Math.min(94, Math.max(base, Math.round(estimate)));
}

function taskStage(task) {
  if (task.videoUrl) return 4;
  if (isSuccessfulVideoStatus(task.status)) return task.mode === "demo" ? 4 : 3;
  if (["processing", "running", "in_progress", "generating"].includes(task.status)) return 2;
  if (["queued", "pending", "waiting"].includes(task.status)) return 1;
  return 0;
}

function refreshTaskClock() {
  const task = state.lastTaskSnapshot;
  if (!task) return;
  const elapsedMs = Date.now() - (state.taskStartedAt || Date.now());
  const progress = estimatedTaskProgress(task, elapsedMs);
  const elapsed = $("#taskElapsed");
  const nextSync = $("#taskNextSync");
  const progressText = $("#taskProgressText");
  const progressBar = $("#taskProgressBar");
  if (elapsed) elapsed.textContent = formatElapsed(elapsedMs);
  if (progressText) {
    const sourceLabel = task.mode === "demo" ? "演示进度" : task.progressSource === "provider" ? "供应商进度" : "预估进度";
    progressText.textContent = `${progress}% · ${sourceLabel}`;
  }
  if (progressBar) {
    progressBar.style.width = `${progress}%`;
    progressBar.parentElement?.setAttribute("aria-valuenow", String(progress));
  }
  if (nextSync) {
    const remaining = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1000));
    nextSync.textContent = state.polling ? "正在同步" : state.nextPollAt ? `${remaining}秒后` : "已停止";
  }
}

function ensureTaskClock() {
  if (state.taskClockTimer) return;
  state.taskClockTimer = setInterval(refreshTaskClock, 1000);
}

function stopTaskClock() {
  clearInterval(state.taskClockTimer);
  state.taskClockTimer = null;
}

function stopAutoPoll() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  state.nextPollAt = 0;
  state.polling = false;
  stopTaskClock();
}

function scheduleAutoPoll(delay = 6000) {
  if (!state.lastVideoTaskId) return;
  clearTimeout(state.pollTimer);
  state.nextPollAt = Date.now() + delay;
  ensureTaskClock();
  refreshTaskClock();
  state.pollTimer = setTimeout(() => pollSeedanceTask({ automatic: true }), delay);
}

function renderVideoTask(data) {
  const task = videoTaskFromData(data);
  const { taskId, status, videoUrl, failedReason, expiresAt } = task;
  const statusLabels = {
    submitted: "已提交",
    queued: "排队中",
    pending: "等待中",
    processing: "生成中",
    running: "生成中",
    in_progress: "生成中",
    generating: "生成中",
    completed: "已完成",
    succeeded: "已完成",
    success: "已完成",
    failed: "失败",
    error: "失败",
    cancelled: "已取消",
    canceled: "已取消",
  };
  const waitingForAsset = data.mode !== "demo" && isSuccessfulVideoStatus(status) && !videoUrl;
  const terminal = failedVideoStatuses.has(status)
    || (isSuccessfulVideoStatus(status) && (Boolean(videoUrl) || data.mode === "demo"));
  const elapsedMs = Date.now() - (state.taskStartedAt || Date.now());
  const displayProgress = estimatedTaskProgress(task, elapsedMs);
  const stage = taskStage(task);
  const message = failedReason
    || (videoUrl
      ? "成片已同步完成，可在下方播放、下载或打开原始地址。"
      : data.mode === "demo" && isSuccessfulVideoStatus(status)
        ? "演示任务已完成；真实模式会在这里展示成片播放器和下载按钮。"
      : waitingForAsset
        ? "生成已完成，正在同步成片播放与下载地址。"
        : data.message || "任务处理中，页面会持续同步供应商状态。");

  if (taskId) {
    if (state.lastVideoTaskId !== taskId || !state.taskStartedAt) {
      const providerCreatedAt = Date.parse(task.createdAt);
      state.taskStartedAt = Number.isFinite(providerCreatedAt) ? providerCreatedAt : Date.now();
      localStorage.setItem("seedance-task-started-at", String(state.taskStartedAt));
    }
    state.lastVideoTaskId = taskId;
    state.lastVideoTaskStatus = status;
    localStorage.setItem("seedance-last-task-id", taskId);
    localStorage.setItem("seedance-last-task-status", status);
  }
  if (videoUrl) {
    state.lastVideoUrl = videoUrl;
    localStorage.setItem("seedance-last-video-url", videoUrl);
  }
  state.lastTaskSyncAt = Date.now();
  state.lastTaskSnapshot = task;

  $("#videoResult").innerHTML = `<div class="seedance-task">
    <div class="task-head">
      <span class="task-status" title="${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>
      <strong>${escapeHtml(taskId || "未返回任务ID")}</strong>
    </div>
    <div class="task-metrics">
      <div><span>当前进度</span><b id="taskProgressText">${displayProgress}% · ${task.mode === "demo" ? "演示进度" : task.progressSource === "provider" ? "供应商进度" : "预估进度"}</b></div>
      <div><span>已用时间</span><b id="taskElapsed">${formatElapsed(elapsedMs)}</b></div>
      <div><span>最近同步</span><b>${formatSyncTime(state.lastTaskSyncAt)}</b></div>
      <div><span>下次同步</span><b id="taskNextSync">${terminal ? "已完成" : "准备中"}</b></div>
    </div>
    <div class="task-progress" role="progressbar" aria-label="视频生成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${displayProgress}"><i id="taskProgressBar" style="width:${displayProgress}%"></i></div>
    <div class="task-stages" aria-label="任务阶段">
      ${["提交", "排队", "生成", "成片"].map((label, index) => `<span class="${index < stage ? "done" : index === stage ? "active" : ""}"><i></i>${label}</span>`).join("")}
    </div>
    ${videoUrl ? `<div class="video-delivery">
      <div class="video-delivery-head"><strong>成片成品</strong><span>已完成</span></div>
      <video src="${escapeHtml(videoUrl)}" controls playsinline preload="metadata"></video>
      <div class="video-delivery-actions">
        <button class="primary-button" type="button" data-download-video="${escapeHtml(taskId)}">下载成片</button>
        <a class="secondary-link" href="${escapeHtml(videoUrl)}" target="_blank" rel="noreferrer">新窗口播放</a>
        <button class="secondary-button" type="button" data-copy-video="${escapeHtml(videoUrl)}">复制链接</button>
      </div>
    </div>` : ""}
    <p>${escapeHtml(message)}</p>
    ${expiresAt ? `<small>视频链接有效期：${escapeHtml(expiresAt)}</small>` : ""}
    ${!terminal ? '<small class="task-note">状态同步已开启，页面会自动刷新，无需前往供应商后台。</small>' : ""}
  </div>`;
  if (terminal) stopAutoPoll(); else ensureTaskClock();
  refreshTaskClock();
  return task;
}

async function submitSeedanceTask() {
  const button = $("#generateVideo");
  if (!$("#videoPrompt").value.trim()) return toast("请先填写视频提示词");
  if ($("#seedanceMode").value === "reference-to-video") {
    const [productReference, personReference, sceneReference] = seedanceReferenceImages();
    if (!productReference) return toast("缺少图片1商品原图，请返回第一步上传商品图");
    if (!personReference) return toast("缺少图片2人物持品图，请先根据商品原图生成");
    if (!sceneReference) return toast("缺少图片3商品场景图，请先根据导演分镜生成");
  }
  if ($("#seedanceMode").value !== "text-to-video" && !seedanceReferenceImages().filter(Boolean).length && !listValue("#seedanceVideos").length) {
    return toast("图生/参考生视频需要至少一个图片或视频 URL");
  }
  setLoading(button, true, "正在准备素材并提交");
  try {
    stopAutoPoll();
    state.finalizingPolls = 0;
    state.lastVideoUrl = "";
    localStorage.removeItem("seedance-last-video-url");
    const providerCheckIsFresh = state.videoProviderCheck?.ok
      && Date.now() - state.videoProviderCheck.checkedAt < 120_000;
    if ((state.config.video.enabled || state.serverProviders.video) && !providerCheckIsFresh) {
      setLoading(button, true, "正在检查视频接口");
      await runProviderCheck("video", { target: "#videoProviderStatus", quiet: true });
      setLoading(button, true, "正在准备素材并提交");
    }
    const input = seedanceInput();
    const data = await post("/api/seedance/create", { input, config: state.config });
    state.lastVideoDuration = input.duration;
    const task = renderVideoTask(data);
    const details = [];
    if (data.materializedImages) details.push(`${data.materializedImages} 张图已转素材库引用`);
    if (data.compressedImages) details.push(`压缩 ${data.compressedImages} 张图`);
    if (data.requestSizeKb) details.push(`请求 ${data.requestSizeKb}KB`);
    if (data.providerAttempts > 1) details.push("上游重试 1 次");
    if (data.referenceAudit?.strict
      && data.referenceAudit?.productBound
      && data.referenceAudit?.personBound
      && data.referenceAudit?.sceneBound
      && data.referenceAudit?.productPriorityApplied
      && data.referenceAudit?.interactionBindingApplied
      && data.referenceAudit?.sceneAdaptationApplied
      && data.referenceAudit?.singleProductApplied) details.push("商品优先级与人物/场景关系已锁定");
    if (data.parameterAudit) {
      const audit = data.parameterAudit;
      const warning = audit.warnings?.[0] ? `；提示：${audit.warnings[0]}` : "";
      const transport = audit.referenceTransport?.map((item) => item.transport === "asset" ? "素材库" : item.transport === "asset-preview" ? "提交时转素材库" : "公网URL").join(" / ") || "无参考图";
      $("#videoProviderStatus").textContent = `参数${audit.ok ? "通过" : "异常"}：图片1商品优先 · 图片2持握关系 · 图片3场景摆位 · ${transport} · ${audit.ratio} · ${audit.duration}秒 · ${audit.model}${warning}`;
      if (!audit.ok) throw new Error("Seedance 参数审计未通过：参考图顺序或提示词绑定异常");
    }
    const suffix = details.length ? `（${details.join("，")}）` : "";
    toast(data.mode === "demo" ? `演示任务已提交${suffix}` : `Seedance 任务已提交${suffix}`);
    state.pollFailures = 0;
    if (!isTerminalVideoStatus(task.status) || (data.mode !== "demo" && isSuccessfulVideoStatus(task.status) && !task.videoUrl)) {
      scheduleAutoPoll(data.mode === "demo" ? 1200 : 5000);
    }
  } catch (error) {
    $("#videoResult").innerHTML = `<div class="job-card"><strong>视频任务提交失败</strong><span>${escapeHtml(error.message)}</span></div>`;
    toast("提交失败，原因已显示在结果区");
  } finally {
    setLoading(button, false);
  }
}

async function pollSeedanceTask(options = {}) {
  const automatic = Boolean(options.automatic);
  const taskId = state.lastVideoTaskId || (!automatic ? prompt("请输入 Seedance taskId") : "");
  if (!taskId) return;
  if (state.polling) return;
  const button = $("#pollVideoTask");
  state.polling = true;
  state.nextPollAt = 0;
  refreshTaskClock();
  if (!automatic) setLoading(button, true, "正在查询");
  try {
    const data = await post("/api/seedance/task", { taskId, config: state.config });
    const task = renderVideoTask(data);
    state.pollFailures = 0;
    if (!automatic) toast("任务状态已更新");
    if (data.mode !== "demo" && isSuccessfulVideoStatus(task.status) && !task.videoUrl) {
      state.finalizingPolls += 1;
      if (state.finalizingPolls <= 10) {
        scheduleAutoPoll(4000);
      } else {
        stopAutoPoll();
        const note = $("#videoResult .task-note");
        if (note) note.textContent = "生成已完成，但成片地址暂未返回。请点击“立即刷新状态”继续同步。";
      }
    } else if (!isTerminalVideoStatus(task.status)) {
      state.finalizingPolls = 0;
      const elapsed = Date.now() - (state.taskStartedAt || Date.now());
      scheduleAutoPoll(elapsed > 20 * 60_000 ? 15_000 : 6000);
    } else {
      state.finalizingPolls = 0;
    }
  } catch (error) {
    state.pollFailures += 1;
    if (automatic && state.pollFailures <= 3) {
      const note = $("#videoResult .task-note");
      if (note) note.textContent = `状态查询暂时失败，10 秒后自动重试（${state.pollFailures}/3）。`;
      scheduleAutoPoll(10_000);
    } else {
      stopAutoPoll();
      toast(error.message);
    }
  } finally {
    state.polling = false;
    if (!automatic) setLoading(button, false);
  }
}

async function downloadSeedanceVideo(button, taskId) {
  setLoading(button, true, "正在下载");
  try {
    const response = await fetch("/api/seedance/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, config: state.config }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "成片下载失败");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const fileName = disposition.match(/filename="([^"]+)"/i)?.[1] || `seedance-${taskId}.mp4`;
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    toast("成片已开始下载");
  } catch (error) {
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
}

function resumeLastVideoTask() {
  if (!state.lastVideoTaskId) return;
  if (!state.taskStartedAt) {
    state.taskStartedAt = Date.now();
    localStorage.setItem("seedance-task-started-at", String(state.taskStartedAt));
  }
  const status = state.lastVideoTaskStatus || "processing";
  const task = renderVideoTask({
    mode: state.lastVideoTaskId.startsWith("demo-") ? "demo" : "live",
    task: {
      taskId: state.lastVideoTaskId,
      status,
      videoUrl: state.lastVideoUrl,
      progress: 0,
      progressSource: "estimated",
    },
    message: state.lastVideoUrl ? "已恢复上一次生成完成的成片。" : "已恢复上一次视频任务，正在同步最新状态。",
  });
  if (!isTerminalVideoStatus(task.status) || (!state.lastVideoTaskId.startsWith("demo-") && isSuccessfulVideoStatus(task.status) && !task.videoUrl)) {
    scheduleAutoPoll(1200);
  }
}

function renderApiForms(active = "text") {
  const labels = { text: "文本推理", image: "图片生成", video: "视频生成" };
  $("#apiForms").innerHTML = Object.keys(labels).map((type) => {
    const config = state.config[type];
    return `<div class="api-form ${type === active ? "active" : ""}" data-api-form="${type}">
      <label class="toggle-line">启用真实${labels[type]} API <input type="checkbox" data-config="${type}.enabled" ${config.enabled ? "checked" : ""}></label>
      <label class="full-field">API Base URL<input data-config="${type}.baseUrl" value="${escapeHtml(config.baseUrl)}" placeholder="https://api.example.com/v1"></label>
      <label>模型名称<input data-config="${type}.model" value="${escapeHtml(config.model)}" placeholder="model-name" ${type === "video" ? 'list="videoModelOptions"' : ""}></label>
      ${type === "video" ? `<datalist id="videoModelOptions"><option value="doubao-seedance-2.0">Seedance 2.0</option><option value="doubao-seedance-2.5">Seedance 2.5</option></datalist><p class="dialog-note full-field">支持 Seedance 2.5 等兼容当前任务接口的新模型。可选择候选名称或填写供应商提供的完整模型 ID；30 秒需供应商及模型实际支持，Seedance 2.0 系列请选择 15 秒以内。</p>` : ""}
      ${type !== "text" ? `<label>Endpoint<input data-config="${type}.endpoint" value="${escapeHtml(config.endpoint || "")}" placeholder="${type === "image" ? "/v1/images/generations" : "/api/v3/contents/generations/tasks"}"></label>` : ""}
      ${type === "image" ? `<label class="full-field">参考图编辑 Endpoint<input data-config="image.editEndpoint" value="${escapeHtml(config.editEndpoint || "/v1/images/edits")}" placeholder="/v1/images/edits"></label>` : ""}
      ${type === "video" ? `<label>查询 Endpoint<input data-config="${type}.taskEndpoint" value="${escapeHtml(config.taskEndpoint || "/api/v3/contents/generations/tasks")}" placeholder="/api/v3/contents/generations/tasks"></label>` : ""}
      <label class="full-field">API Key<input type="password" data-config="${type}.apiKey" value="${escapeHtml(config.apiKey)}" placeholder="sk-..."></label>
    </div>`;
  }).join("");
}

function collectSettings() {
  $$("[data-config]").forEach((input) => {
    const [type, key] = input.dataset.config.split(".");
    state.config[type][key] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
}

function providerCheckMarkup(result) {
  const stateClass = result.ok ? "ok" : "error";
  const latency = result.latencyMs ? ` · ${result.latencyMs}ms` : "";
  return `<span class="provider-check ${stateClass}">${escapeHtml(result.message || (result.ok ? "接口正常" : "接口不可用"))}${escapeHtml(latency)}</span>`;
}

async function runProviderCheck(type, options = {}) {
  const button = options.button || null;
  const target = options.target ? $(options.target) : $("#providerCheckResult");
  if ($("#settingsDialog").open) collectSettings();
  if (button) setLoading(button, true, "正在检查");
  if (target) target.innerHTML = '<span class="provider-check pending">正在检查接口与鉴权...</span>';
  try {
    const result = await post("/api/provider/check", { type, config: state.config });
    if (target) target.innerHTML = providerCheckMarkup(result);
    if (type === "video") state.videoProviderCheck = { ...result, checkedAt: Date.now() };
    if (!result.ok) throw new Error(result.message || "接口检查未通过");
    if (!options.quiet) {
      const label = type === "video" ? "视频" : type === "image" ? "图片" : "文本";
      toast(`${label}接口检查通过`);
    }
    return result;
  } catch (error) {
    if (target) target.innerHTML = providerCheckMarkup({ ok: false, message: error.message });
    if (type === "video") {
      state.videoProviderCheck = { ok: false, checkedAt: Date.now(), message: error.message };
    }
    throw error;
  } finally {
    if (button) setLoading(button, false);
  }
}

async function testActiveProvider() {
  const button = $("#testProvider");
  try {
    await runProviderCheck(state.activeApiTab, { button });
  } catch (error) {
    toast(error.message);
  }
}

function saveSettings() {
  collectSettings();
  localStorage.setItem("seedance-model-config", JSON.stringify(state.config));
  $("#settingsDialog").close();
  state.videoProviderCheck = null;
  updateMode();
  toast("模型接口设置已保存");
}

function openPromptEditor(targetSelector, title) {
  const target = $(targetSelector);
  if (!target) return;
  state.activePromptTarget = targetSelector;
  $("#promptEditorTitle").textContent = title;
  $("#promptEditorText").value = target.value;
  renderReferenceSelectors();
  $("#promptEditorDialog").showModal();
  $("#promptEditorText").focus();
}

function savePromptEditor() {
  const target = $(state.activePromptTarget);
  try {
    ReferenceBindings.compilePrompt($("#promptEditorText").value, currentReferences("#promptEditorText"));
  } catch (error) { return toast(error.message); }
  if (target) {
    target.value = $("#promptEditorText").value;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
  $("#promptEditorDialog").close();
  toast("提示词已更新");
}

function updateMode() {
  const liveCount = Object.keys(state.config)
    .filter((type) => state.config[type].enabled || state.serverProviders[type])
    .length;
  $("#modeLabel").textContent = liveCount ? `${liveCount} 个真实模型已启用` : "演示引擎";
  $(".status-dot").classList.toggle("live", liveCount > 0);
}

async function loadServerCapabilities() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const data = await response.json();
    state.serverProviders = { ...state.serverProviders, ...(data.providers || {}) };
    updateMode();
  } catch {
    // The page remains usable in demo mode if the health check is temporarily unavailable.
  }
}

function resetProject() {
  if (state.activeRequests) return toast("当前项目仍在处理，请等待请求结束后再新建或切换订单");
  state.lastVideoDuration = 0;
  state.businessDuration = null;
  window.clearBusinessOrder?.();
  stopAutoPoll();
  state.analysis = null;
  state.plan = null;
  state.selections = null;
  state.lastVideoTaskId = "";
  state.lastVideoTaskStatus = "";
  state.lastVideoUrl = "";
  state.taskStartedAt = 0;
  state.lastTaskSnapshot = null;
  state.pollFailures = 0;
  state.finalizingPolls = 0;
  state.generatedCreatorUrls = [];
  state.generatedSceneUrls = [];
  localStorage.removeItem("seedance-last-task-id");
  localStorage.removeItem("seedance-last-task-status");
  localStorage.removeItem("seedance-last-video-url");
  localStorage.removeItem("seedance-task-started-at");
  localStorage.removeItem("seedance-generated-image-urls");
  localStorage.removeItem("seedance-generated-creator-urls");
  localStorage.removeItem("seedance-generated-scene-urls");
  localStorage.removeItem("seedance-generated-creator-urls-v2");
  localStorage.removeItem("seedance-generated-scene-urls-v2");
  setImage("");
  $("#productName").value = "";
  $("#productDescription").value = "";
  $("#creatorResult").innerHTML = '<div class="result-empty">人物持品图将在这里显示</div>';
  $("#sceneResult").innerHTML = '<div class="result-empty">商品场景图将在这里显示</div>';
  $("#videoResult").innerHTML = '<div class="result-empty">视频任务状态将在这里显示</div>';
  if ($("#seedanceImages")) $("#seedanceImages").value = "";
  if ($("#seedancePerson")) $("#seedancePerson").value = "";
  updateSeedanceAssetHint();
  goToStep(1);
}

window.prepareBusinessOrder = (order) => {
  if (state.activeRequests) { toast("当前项目仍在处理，请等待请求结束后再切换订单"); return false; }
  if ((state.imageDataUrl || state.plan) && !window.confirm("切换订单会清空当前页面的制作素材和方案。已写回的订单交付链接会保留。是否继续？")) return false;
  resetProject();
  state.businessDuration = order.duration;
  $("#productName").value = order.product;
  $("#productDescription").value = order.brief;
  $("#seedanceDuration").value = String(order.duration);
  toast("订单需求已带入，请上传该订单对应的商品图片");
  return true;
};
window.currentBusinessVideo = () => {
  if (!state.lastVideoTaskId || state.lastVideoTaskId.startsWith("demo-") || !isSuccessfulVideoStatus(state.lastVideoTaskStatus)) return "";
  return state.lastVideoUrl ? { url: state.lastVideoUrl, duration: state.lastVideoDuration } : null;
};

$("#chooseFile").addEventListener("click", () => $("#fileInput").click());
$("#fileInput").addEventListener("change", (event) => loadFile(event.target.files[0]));
$("#removeImage").addEventListener("click", () => setImage(""));
$("#useDemo").addEventListener("click", useDemo);
$("#analyzeButton").addEventListener("click", analyzeProduct);
$("#planButton").addEventListener("click", generatePlan);
$("#copyPlan").addEventListener("click", copyPlan);
$("#toGenerate").addEventListener("click", () => goToStep(4));
$("#generateCreator").addEventListener("click", () => generateReferenceImage("creator"));
$("#generateScene").addEventListener("click", () => generateReferenceImage("scene"));
$("#insertPromptReference").addEventListener("click", () => insertPromptReference());
$("#insertEditorReference").addEventListener("click", () => insertPromptReference("#editorReferenceSelector", "#promptEditorText"));
$("#videoPrompt").addEventListener("input", renderReferenceBindingPreview);
$("#seedanceMode").addEventListener("change", renderReferenceSelectors);
$("#addReferenceTarget").addEventListener("click", () => {
  if (state.additionalReferences.length >= 6) return;
  let number = 1;
  while (state.additionalReferences.some((reference) => reference.name === `物体${number}`)) number += 1;
  state.additionalReferences.push({ id: `extra-${crypto.randomUUID()}`, name: `物体${number}`, role: "object", target: "", url: "" });
  renderReferenceTargets();
  renderGenerationContext();
});
$("#referenceTargetList").addEventListener("click", (event) => {
  const row = event.target.closest("[data-reference-id]");
  if (!row) return;
  if (event.target.closest("[data-remove-reference]")) {
    state.additionalReferences = state.additionalReferences.filter((reference) => reference.id !== row.dataset.referenceId);
    renderReferenceTargets();
    renderGenerationContext();
  }
  if (event.target.closest("[data-upload-reference]")) $("[data-reference-file]", row).click();
});
$("#referenceTargetList").addEventListener("change", (event) => {
  const row = event.target.closest("[data-reference-id]");
  const reference = state.additionalReferences.find((item) => item.id === row?.dataset.referenceId);
  if (!reference) return;
  if (event.target.matches("[data-reference-field]")) {
    reference[event.target.dataset.referenceField] = event.target.value.trim();
    renderReferenceTargets();
    renderGenerationContext();
  }
  if (event.target.matches("[data-reference-file]")) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) return toast("请选择不超过 10MB 的参考图片");
    const reader = new FileReader();
    reader.onload = () => {
      if (!state.additionalReferences.includes(reference)) return;
      reference.url = reader.result;
      renderReferenceTargets();
      renderGenerationContext();
    };
    reader.readAsDataURL(file);
  }
});
$("#referenceTargetList").addEventListener("input", (event) => {
  if (!event.target.matches("[data-reference-field]")) return;
  const row = event.target.closest("[data-reference-id]");
  const reference = state.additionalReferences.find((item) => item.id === row?.dataset.referenceId);
  if (!reference) return;
  reference[event.target.dataset.referenceField] = event.target.value.trim();
  $(".reference-target-head strong", row).textContent = `@${reference.name || "未命名"}`;
  $("[data-remove-reference]", row).setAttribute("aria-label", `删除 ${reference.name || "未命名"}`);
  if (event.target.dataset.referenceField === "url") $(".reference-target-thumbnail", row).textContent = reference.url ? "图片已绑定" : "未选图片";
  renderGenerationContext();
});
[$("#creatorPrompt"), $("#scenePrompt"), $("#videoPrompt"), $("#promptEditorText")].forEach(bindReferenceMentions);
$("#generateVideo").addEventListener("click", submitSeedanceTask);
$("#pollVideoTask").addEventListener("click", () => pollSeedanceTask());
$("#checkVideoProvider").addEventListener("click", async () => {
  const button = $("#checkVideoProvider");
  try {
    setLoading(button, true, "检查参数");
    const validation = await post("/api/seedance/validate", { input: seedanceInput(), config: state.config });
    setLoading(button, true, "检查接口");
    const provider = await runProviderCheck("video", { target: "#videoProviderStatus", quiet: true });
    const audit = validation.audit;
    const warning = audit.warnings?.[0] ? `；${audit.warnings[0]}` : "";
    const transport = audit.referenceTransport?.map((item) => item.transport === "asset-preview" ? `图片${item.position}提交时转素材库` : `图片${item.position}${item.transport === "asset" ? "素材库" : "公网URL"}`).join("，") || "无参考图";
    $("#videoProviderStatus").textContent = `参数与接口通过：${transport}；图片1商品最高优先，图片2持握关系，图片3场景摆位；${audit.ratio}，${audit.duration}秒，${audit.model}，接口 ${provider.latencyMs || 0}ms${warning}`;
    toast("Seedance 参数与接口检查通过");
  } catch (error) {
    $("#videoProviderStatus").textContent = error.message;
    toast(error.message);
  } finally {
    setLoading(button, false);
  }
});
$("#newProject").addEventListener("click", resetProject);
$("#seedanceImageSource").addEventListener("change", () => {
  syncGeneratedAssetsToSeedance();
  updateSeedanceAssetHint();
});
$("#selectionGrid").addEventListener("change", (event) => {
  if (event.target.matches("[data-selection]")) state.selections = getSelections();
});
$("#seedanceImages").addEventListener("input", renderGenerationContext);
$("#seedancePerson").addEventListener("input", renderGenerationContext);
[$("#creatorResult"), $("#sceneResult")].forEach((container) => container.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-url]");
  if (!button) return;
  navigator.clipboard.writeText(button.dataset.copyUrl).then(() => toast("图片 URL 已复制"));
}));
$("#videoResult").addEventListener("click", (event) => {
  const downloadButton = event.target.closest("[data-download-video]");
  if (downloadButton) {
    downloadSeedanceVideo(downloadButton, downloadButton.dataset.downloadVideo);
    return;
  }
  const copyButton = event.target.closest("[data-copy-video]");
  if (copyButton) navigator.clipboard.writeText(copyButton.dataset.copyVideo).then(() => toast("成片链接已复制"));
});
$$(".back-button").forEach((button) => button.addEventListener("click", () => goToStep(Number(button.dataset.back))));
$$(".plan-tabs button").forEach((button) => button.addEventListener("click", () => renderPlan(button.dataset.tab)));
$$(".step-item").forEach((button) => button.addEventListener("click", () => {
  const target = Number(button.dataset.step);
  if (target === 1 || (target === 2 && state.analysis) || (target >= 3 && state.plan)) goToStep(target);
}));

const uploadZone = $("#uploadZone");
["dragenter", "dragover"].forEach((name) => uploadZone.addEventListener(name, (event) => { event.preventDefault(); uploadZone.classList.add("drag"); }));
["dragleave", "drop"].forEach((name) => uploadZone.addEventListener(name, (event) => { event.preventDefault(); uploadZone.classList.remove("drag"); }));
uploadZone.addEventListener("drop", (event) => loadFile(event.dataTransfer.files[0]));

$("#settingsButton").addEventListener("click", () => {
  renderApiForms(state.activeApiTab);
  $("#providerCheckResult").innerHTML = "";
  $$(".api-tabs button").forEach((item) => item.classList.toggle("active", item.dataset.apiTab === state.activeApiTab));
  $("#settingsDialog").showModal();
});
$(".api-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-api-tab]");
  if (!button) return;
  state.activeApiTab = button.dataset.apiTab;
  $("#providerCheckResult").innerHTML = "";
  $$(".api-tabs button").forEach((item) => item.classList.toggle("active", item === button));
  $$("[data-api-form]").forEach((form) => form.classList.toggle("active", form.dataset.apiForm === button.dataset.apiTab));
});
$("#testProvider").addEventListener("click", testActiveProvider);
$("#saveSettings").addEventListener("click", saveSettings);
$("#editCreatorPrompt").addEventListener("click", () => openPromptEditor("#creatorPrompt", "编辑人物持品图提示词"));
$("#editScenePrompt").addEventListener("click", () => openPromptEditor("#scenePrompt", "编辑商品场景图提示词"));
$("#editVideoPrompt").addEventListener("click", () => openPromptEditor("#videoPrompt", "编辑 Seedance 视频提示词"));
$("#savePromptEditor").addEventListener("click", savePromptEditor);

normalizeImageConfig();
normalizeVideoConfig();
syncGeneratedAssetsToSeedance();
updateSeedanceAssetHint();
updateMode();
loadServerCapabilities();
goToStep(1);
resumeLastVideoTask();
