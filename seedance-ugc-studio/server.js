const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const sharp = require("sharp");
const { version: APP_VERSION } = require("./package.json");
const ReferenceBindings = require("./public/references");
const { createBusinessStore } = require("./business");

const PUBLIC_DIR = path.join(__dirname, "public");
const GENERATED_DIR = path.join(PUBLIC_DIR, "generated");
const MAX_BODY = 15 * 1024 * 1024;
const PROVIDER_TIMEOUT_MS = 60_000;
const ALLOWED_GENERATION_TYPES = new Set(["reference-to-video", "image-to-video", "text-to-video"]);
const ALLOWED_RATIOS = new Set(["9:16", "16:9", "1:1"]);
const ALLOWED_DURATIONS = new Set([5, 8, 10, 15, 30]);

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadLocalEnv();

const businessStore = createBusinessStore(process.env.BUSINESS_DATA_FILE || path.join(__dirname, ".runtime", "business.json"));

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(payload));
}

function healthPayload() {
  const sharedKey = usableApiKey(process.env.YUNCENAI_API_KEY);
  return {
    ok: true,
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    providers: {
      text: false,
      image: Boolean(usableApiKey(process.env.YUNCENAI_IMAGE_API_KEY) || sharedKey),
      video: Boolean(usableApiKey(process.env.YUNCENAI_VIDEO_API_KEY) || sharedKey),
    },
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("请求内容超过 15MB"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        if (size > MAX_BODY) return;
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : {};
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("JSON 对象无效");
        resolve(body);
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function extractJson(text) {
  const cleaned = text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("模型未返回有效 JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function usableApiKey(value) {
  const key = String(value || "").trim();
  if (!key || /^your-/i.test(key)) return "";
  return key;
}

function normalizeBaseUrl(value, fallback) {
  const raw = String(value || fallback || "").trim().replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("API Base URL 格式无效");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("API Base URL 仅支持 http/https");
  return raw;
}

function normalizeEndpoint(value, fallback) {
  const endpoint = String(value || fallback || "").trim();
  if (!endpoint.startsWith("/") || endpoint.includes("..")) throw new Error("Endpoint 必须是以 / 开头的安全路径");
  return endpoint.replace(/\/$/, "");
}

function firstImageUrl(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  return data?.previewUrl
    || data?.url
    || data?.asset_url
    || data?.image_url
    || first?.url
    || first?.asset_url
    || first?.image_url
    || "";
}

function firstImageBase64(data) {
  const first = Array.isArray(data?.data) ? data.data[0] : null;
  return data?.b64_json
    || data?.base64
    || data?.image_base64
    || data?.image
    || first?.b64_json
    || first?.base64
    || first?.image_base64
    || first?.image
    || "";
}

function generatedAssetUrl(filename) {
  return `/generated/${filename}`;
}

function saveGeneratedImage(base64Value, outputFormat = "png") {
  const raw = String(base64Value || "");
  if (!raw) return "";
  const match = raw.match(/^data:image\/([a-z0-9.+-]+);base64,(.+)$/i);
  const ext = (match?.[1] || outputFormat || "png").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "");
  const base64 = match?.[2] || raw;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return "";
  fs.mkdirSync(GENERATED_DIR, { recursive: true });
  const filename = `image-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext || "png"}`;
  fs.writeFileSync(path.join(GENERATED_DIR, filename), buffer);
  return generatedAssetUrl(filename);
}

function imageAssetFromResponse(data) {
  const url = firstImageUrl(data);
  if (url) return { previewUrl: url, assetUrl: url, source: "url" };
  const base64 = firstImageBase64(data);
  if (!base64) return { previewUrl: "", assetUrl: "", source: "missing" };
  const localUrl = saveGeneratedImage(base64, data?.output_format || "png");
  return { previewUrl: localUrl, assetUrl: localUrl, source: "base64-local" };
}

function imageEditEndpoint(config, generationEndpoint) {
  if (config.editEndpoint) return normalizeEndpoint(config.editEndpoint, "/v1/images/edits");
  if (/\/generations$/i.test(generationEndpoint)) return generationEndpoint.replace(/\/generations$/i, "/edits");
  return "/v1/images/edits";
}

function imageReferenceFile(value) {
  const raw = String(value || "").trim();
  const filePath = localPublicAssetPath(raw);
  const mimeMatch = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  let mimeType = mimeMatch?.[1] || "";
  let buffer = dataImageBuffer(raw);

  if (filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw new Error("商品参考图文件不存在");
    mimeType = mimeTypes[path.extname(filePath).toLowerCase()] || "";
    buffer = fs.readFileSync(filePath);
  }

  if (!buffer || !mimeType.startsWith("image/")) {
    throw new Error("达人/场景图生成必须提供已上传的商品原图");
  }
  if (buffer.length > 10 * 1024 * 1024) throw new Error("商品参考图超过 10MB，请压缩后重新上传");
  const extension = mimeType.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  return { buffer, mimeType, filename: `product-reference.${extension}` };
}

function imageEditForm(model, prompt, reference, fieldName = "image[]") {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("n", "1");
  for (const item of Array.isArray(reference) ? reference : [reference]) {
    form.append(fieldName, new Blob([item.buffer], { type: item.mimeType }), item.filename);
  }
  return form;
}

async function resolveEditReference(reference) {
  if (isInlineImageReference(reference.url)) return imageReferenceFile(reference.url);
  if (reference.url.startsWith("asset://")) {
    throw new Error(`图片编辑参考「${reference.name}」需要本地图片或 HTTPS URL，视频素材 asset:// 不能用于图片编辑`);
  }
  validateMediaReference(reference.url, "image");
  const response = await fetchWithTimeout(reference.url, {}, 30_000);
  if (!response.ok) throw new Error(`无法读取参考图「${reference.name}」 (${response.status})`);
  const mimeType = (response.headers.get("content-type") || "").split(";")[0];
  if (!mimeType.startsWith("image/")) throw new Error(`参考「${reference.name}」没有返回图片`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 10 * 1024 * 1024) throw new Error(`参考图「${reference.name}」超过 10MB`);
    chunks.push(chunk);
  }
  return imageReferenceFile(`data:${mimeType};base64,${Buffer.concat(chunks).toString("base64")}`);
}

const materialGroupCache = new Map();
const materialAssetCache = new Map();

function nestedField(value, names, depth = 0) {
  if (depth > 7 || value == null) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedField(item, names, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const name of names) {
    const field = value[name];
    if (typeof field === "string" && field.trim()) return field.trim();
  }
  for (const child of Object.values(value)) {
    const found = nestedField(child, names, depth + 1);
    if (found) return found;
  }
  return "";
}

function findMaterialGroup(value, groupName, depth = 0) {
  if (depth > 7 || value == null) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMaterialGroup(item, groupName, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  const name = String(value.group_name || value.name || "").trim();
  const id = String(value.group_id || value.groupId || "").trim();
  if (id && name === groupName) return id;
  for (const child of Object.values(value)) {
    const found = findMaterialGroup(child, groupName, depth + 1);
    if (found) return found;
  }
  return "";
}

async function materialJsonRequest(config, endpoint, options = {}) {
  const response = await fetchWithTimeout(`${config.baseUrl}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(options.headers || {}),
    },
  }, 60_000);
  const data = await readProviderResponse(response);
  if (!response.ok) {
    const message = data.error?.message || data.message || data.error || `素材服务请求失败 (${response.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return data;
}

function materialCacheNamespace(config) {
  const credentialHash = crypto.createHash("sha256").update(String(config.apiKey || "")).digest("hex").slice(0, 12);
  return `${config.baseUrl}|${credentialHash}`;
}

async function ensureMaterialGroup(config) {
  const namespace = materialCacheNamespace(config);
  if (materialGroupCache.has(namespace)) return materialGroupCache.get(namespace);
  const groupName = "Seedance UGC Studio";
  try {
    const groups = await materialJsonRequest(config, "/v1/materials/groups");
    const existing = findMaterialGroup(groups, groupName);
    if (existing) {
      materialGroupCache.set(namespace, existing);
      return existing;
    }
  } catch {
    // Some gateways allow group creation even when group listing is unavailable.
  }
  const created = await materialJsonRequest(config, "/v1/materials/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group_name: groupName, description: "Seedance UGC 商品、人物持品与商品场景参考图" }),
  });
  const groupId = nestedField(created, ["group_id", "groupId"]);
  if (!groupId) throw new Error("素材组创建成功但未返回 group_id");
  materialGroupCache.set(namespace, groupId);
  return groupId;
}

async function waitMaterialReady(config, assetId) {
  const localProvider = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(config.baseUrl);
  const intervalMs = localProvider ? 10 : 2_000;
  const maxAttempts = localProvider ? 20 : 60;
  let lastStatus = "processing";
  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const data = await materialJsonRequest(config, `/v1/materials/${encodeURIComponent(assetId)}`);
      lastStatus = String(nestedField(data, ["status", "state"]) || "ready").toLowerCase();
      if (["ready", "succeeded", "success", "completed", "available", "active", "processed", "finished"].includes(lastStatus)) {
        return lastStatus;
      }
      if (["failed", "error", "cancelled", "canceled", "rejected"].includes(lastStatus)) {
        throw new Error(`素材 ${assetId} 处理失败，状态：${lastStatus}`);
      }
      lastError = "";
    } catch (error) {
      if (/处理失败，状态/.test(String(error?.message || ""))) throw error;
      lastError = String(error?.message || error);
    }
    if (attempt < maxAttempts - 1) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const detail = lastError ? `，最近一次查询：${lastError}` : `，当前状态：${lastStatus}`;
  throw new Error(`素材 ${assetId} 自动等待 120 秒后仍未就绪${detail}；已保留该素材，下次提交会继续查询而不会重复上传`);
}

async function uploadSeedanceMaterial(config, value, position) {
  const reference = imageReferenceFile(value);
  const namespace = materialCacheNamespace(config);
  const fileHash = crypto.createHash("sha256").update(reference.buffer).digest("hex");
  const cacheKey = `${namespace}|${fileHash}`;
  if (materialAssetCache.has(cacheKey)) {
    const cached = materialAssetCache.get(cacheKey);
    await waitMaterialReady(config, cached.assetId);
    return cached.assetUrl;
  }

  const groupId = await ensureMaterialGroup(config);
  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([reference.buffer], { type: reference.mimeType }), `reference-${position}.${reference.filename.split(".").pop()}`);
  uploadForm.append("asset_type", "Image");
  const uploadResponse = await fetchWithTimeout(`${config.baseUrl}/v1/materials/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: uploadForm,
  }, 120_000);
  const uploadData = await readProviderResponse(uploadResponse);
  if (!uploadResponse.ok) {
    const message = uploadData.error?.message || uploadData.message || `素材上传失败 (${uploadResponse.status})`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  const uploadId = nestedField(uploadData, ["upload_id", "uploadId"]);
  if (!uploadId) throw new Error("素材上传成功但未返回 upload_id");

  const material = await materialJsonRequest(config, "/v1/materials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      group_id: groupId,
      asset_name: `ugc-reference-${position}-${fileHash.slice(0, 10)}`,
      asset_type: "Image",
      upload_id: uploadId,
    }),
  });
  const assetId = nestedField(material, ["asset_id", "assetId"]);
  if (!assetId) throw new Error("素材记录创建成功但未返回 asset_id");
  const assetUrl = `asset://${assetId}`;
  materialAssetCache.set(cacheKey, { assetId, assetUrl });
  await waitMaterialReady(config, assetId);
  return assetUrl;
}

function localPublicAssetPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return "";
    }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return "";
    pathname = parsed.pathname;
  } else if (!raw.startsWith("/")) {
    return "";
  }

  const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  const publicRoot = `${path.normalize(PUBLIC_DIR)}${path.sep}`;
  if (!filePath.startsWith(publicRoot)) return "";
  return filePath;
}

function dataImageBuffer(value) {
  const match = String(value || "").match(/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[1], "base64");
  return buffer.length ? buffer : null;
}

function isInlineImageReference(value) {
  return Boolean(localPublicAssetPath(value) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(value || "")));
}

async function compressReferenceImage(buffer, targetBytes) {
  if (buffer.length > 15 * 1024 * 1024) throw new Error("本地参考图片超过 15MB，请压缩后再提交");
  let maxEdge = 1280;
  let quality = 78;
  let output = buffer;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    output = await sharp(buffer, { failOn: "none", limitInputPixels: 64 * 1024 * 1024 })
      .rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality, progressive: true, chromaSubsampling: "4:2:0" })
      .toBuffer();
    if (output.length <= targetBytes) return output;
    if (quality > 48) {
      quality -= 10;
    } else {
      maxEdge = Math.max(480, Math.round(maxEdge * 0.82));
      quality = 68;
    }
  }
  return output;
}

async function inlineImageReference(value, targetBytes) {
  const raw = String(value || "").trim();
  const filePath = localPublicAssetPath(raw);
  let buffer = dataImageBuffer(raw);
  let mimeType = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,/i)?.[1] || "image/jpeg";

  if (filePath) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw new Error(`本地参考图片不存在：${path.basename(filePath)}`);
    }
    mimeType = mimeTypes[path.extname(filePath).toLowerCase()] || "";
    if (!mimeType.startsWith("image/")) throw new Error("本地参考素材不是支持的图片格式");
    buffer = await fs.promises.readFile(filePath);
  }

  if (!buffer) return { url: raw, inlined: false, compressed: false, bytes: 0 };
  if (buffer.length <= targetBytes) {
    return { url: `data:${mimeType};base64,${buffer.toString("base64")}`, inlined: true, compressed: false, bytes: buffer.length };
  }

  const compressed = await compressReferenceImage(buffer, targetBytes);
  if (compressed.length > targetBytes * 1.15) {
    throw new Error("参考图片压缩后仍过大，请减少参考图数量或改用公网 URL");
  }
  return {
    url: `data:image/jpeg;base64,${compressed.toString("base64")}`,
    inlined: true,
    compressed: true,
    bytes: compressed.length,
  };
}

async function readProviderResponse(response) {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const plain = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { message: plain.slice(0, 500) };
  }
}

function isCloudflareHostError(status, data) {
  const message = String(data?.error?.message || data?.message || "");
  return status === 502 && /cloudflare|host error|bad gateway/i.test(message);
}

function cloudflareFailureMessage(data, attempts) {
  const message = String(data?.error?.message || data?.message || "");
  const host = message.match(/([a-z0-9.-]+\.[a-z]{2,})\s*\|\s*502/i)?.[1] || "供应商上游";
  const rayId = message.match(/Cloudflare Ray ID:\s*([a-z0-9]+)/i)?.[1] || "";
  const rayText = rayId ? `，Ray ID：${rayId}` : "";
  const retryText = attempts > 1 ? "，已自动重试 1 次" : "";
  return `${host} 暂时不可用（Cloudflare 502 Host Error${rayText}${retryText}）。本地图片与请求大小均已通过检查，请稍后重新提交`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`供应商响应超时（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`无法连接供应商：${error.message || "网络错误"}`);
  } finally {
    clearTimeout(timer);
  }
}

async function requestProvider(url, options, retryCloudflare502 = false, timeoutMs = PROVIDER_TIMEOUT_MS) {
  let lastResult;
  const maxAttempts = retryCloudflare502 ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchWithTimeout(url, options, timeoutMs);
    const data = await readProviderResponse(response);
    lastResult = { response, data, attempts: attempt };
    if (response.ok || !isCloudflareHostError(response.status, data) || attempt === maxAttempts) return lastResult;
    await wait(2500);
  }
  return lastResult;
}

function demoAnalysis(body) {
  return {
    mode: "demo",
    product: {
      name: String(body.productName || "待命名产品").trim(),
      category: "待客户确认",
      summary: String(body.description || "尚未提供产品说明，请先向客户确认真实用途与卖点。"),
      visibleClues: ["本地规则草稿：未调用视觉或文本模型，不能识别图片内容"],
      claimsToVerify: ["产品外观与材质", "真实用途与卖点", "素材授权与验收标准"],
    },
    recommendations: {
      market: "待客户确认",
      marketReason: "当前为本地草稿，未识别图片或推断包装语言。请按客户真实投放地区、平台和语言选择。",
      platform: "待客户确认",
      language: "中文普通话",
      format: "真人口播 + 手部演示 + 体验反应",
      creator: "虚拟达人",
      duration: "15秒",
    },
    confidence: 0,
  };
}

function demoPlan(input) {
  const p = input.analysis?.product || {};
  const r = input.selections || input.analysis?.recommendations || {};
  const duration = directorDuration(r.duration);
  const script = demoScript(p, r, duration);
  const voices = script.map((row) => row.voice);
  return {
    mode: "demo",
    title: `${p.name || "产品"} · ${duration}秒${r.platform || "短视频"} UGC`,
    strategy: {
      positioning: p.summary || "用真实使用过程降低购买犹豫。",
      audience: `${r.market || "目标市场"}中正在比较同类产品的移动端消费者`,
      angle: `按${r.platform || "短视频平台"}节奏，从真实使用痛点切入，用商品近景和使用过程建立信任。`,
    },
    creator: {
      profile: r.creator === "无人物" ? "无人物出镜，以商品和真实使用动作推进。" : `${r.creator || "虚拟达人"}，表达自然，像给朋友分享。`,
      visual: `${r.format || "真人口播 + 手部演示"}，环境与${r.market || "目标市场"}、${r.platform || "短视频平台"}审美一致。`,
      credibility: "不使用专家身份，以持续使用者和细节观察者建立可信度。",
    },
    hooks: [
      voices[0],
      `先别划走，看看${p.name || "这个产品"}的真实细节。`,
      `买${p.category || "这类产品"}之前，先看这一点。`,
      `我最想实拍给你看的，是这个使用细节。`,
      `不加滤镜，直接看${p.name || "产品"}近景。`,
      `这不是广告腔，就是一次真实体验。`,
      `为什么我会把它留在日常使用清单里？`,
      `用前先看包装和实际操作。`,
      `这个设计到底方不方便，现场试给你看。`,
      `最后两秒看清商品，再决定适不适合你。`,
    ],
    script,
    broll: [
      "商品原图对应包装正面近景",
      "品牌与标签清晰特写",
      "真实手部取用或操作",
      "核心材质、结构或质地微距",
      "目标使用场景中的产品主体",
      "平台原生手持镜头运动",
      "真实体验反应或使用结果",
      "商品与环境自然同框",
      "产品标签清晰定格",
    ],
    checklist: [
      "包装、标签、颜色与上传产品一致",
      "口播与字幕语言一致",
      "前3秒同时有动作、痛点和产品",
      "未加入无法证实的功效承诺",
      "静音观看仍能理解完整内容",
      "CTA自然且适配发布平台",
    ],
  };
}

function directorDuration(value) {
  const seconds = Number.parseInt(String(value || "15"), 10);
  return ALLOWED_DURATIONS.has(seconds) ? seconds : 15;
}

function scriptWindows(duration) {
  const points = [0, 0.14, 0.34, 0.66, 0.86, 1].map((ratio) => Math.round(duration * ratio));
  for (let index = 1; index < points.length; index += 1) {
    points[index] = Math.max(points[index], Math.min(duration, points[index - 1] + 1));
  }
  points[points.length - 1] = duration;
  return points.slice(0, -1).map((start, index) => `${start}-${points[index + 1]}s`);
}

function localizedDemoVoices(language, productName) {
  if (language === "粤语") return [
    `先唔好划走，呢件${productName}有个细节一定要睇。`,
    `我拎近啲俾你睇，包装同实物就系咁。`,
    `实际用落手，操作好直接，过程都睇得清清楚楚。`,
    `我最钟意系佢够日常，唔使讲到太夸张。`,
    `睇清楚产品先，再决定啱唔啱你。`,
  ];
  if (/中文|普通话/.test(language)) return [
    `先别划走，${productName}这个细节一定要看。`,
    `镜头拉近，包装和实物细节看得更清楚。`,
    `现在直接演示真实用法，整个过程不加滤镜。`,
    `我更看重它在日常场景里是否方便。`,
    `先看清产品，再决定它适不适合你。`,
  ];
  if (/英文|English/i.test(language)) return [
    `Don't scroll yet. There is one detail about ${productName} worth seeing.`,
    `Here is the packaging and the real product up close.`,
    `Let me show you exactly how it works in a real routine.`,
    `What matters to me is how naturally it fits into everyday use.`,
    `Take a closer look and decide whether it fits your routine.`,
  ];
  return [
    `[${language}] 用一句平台原生口语提出${productName}的真实痛点。`,
    `[${language}] 近距离介绍商品包装和可见细节。`,
    `[${language}] 配合画面说明真实操作步骤。`,
    `[${language}] 分享克制、可信的使用感受。`,
    `[${language}] 用自然语气邀请观众查看商品。`,
  ];
}

function demoScript(product, selections, duration) {
  const productName = product.name || "产品";
  const voices = localizedDemoVoices(selections.language || "中文普通话", productName);
  const noPerson = selections.creator === "无人物";
  const visuals = [
    `${noPerson ? "手部" : "达人"}从画面外快速拿入图片1中的${productName}，包装正面朝镜头`,
    `商品微距，严格保持图片1中商品的颜色、轮廓、标签和品牌位置`,
    `按${selections.format || "真实演示"}完成一次核心使用动作，商品始终清晰`,
    `${noPerson ? "手部与商品" : "达人自然反应与商品"}同框，展示真实使用场景`,
    `图片1中的商品居中定格，包装清晰，出现适配${selections.platform || "平台"}的轻CTA`,
  ];
  const captions = voices.map((voice) => voice.replace(/^\[[^\]]+\]\s*/, "").slice(0, 24));
  return scriptWindows(duration).map((time, index) => ({ time, visual: visuals[index], voice: voices[index], caption: captions[index] }));
}

function enrichDirectorPlan(plan, analysis, selections) {
  const product = analysis?.product || {};
  const duration = directorDuration(selections?.duration);
  const targeting = {
    market: selections?.market || "目标市场",
    platform: selections?.platform || "短视频平台",
    language: selections?.language || "中文普通话",
    format: selections?.format || "真人口播 + 手部演示",
    creator: selections?.creator || "虚拟达人",
    duration: `${duration}秒`,
    durationSeconds: duration,
    ratio: "9:16",
  };
  const fallbackScript = demoScript(product, selections || {}, duration);
  const incomingScript = Array.isArray(plan?.script) && plan.script.length >= 3 ? plan.script.slice(0, 5) : fallbackScript;
  const windows = scriptWindows(duration);
  const script = windows.map((time, index) => {
    const row = incomingScript[index] || fallbackScript[index];
    const incomingVoice = String(row?.voice || "").trim();
    const cantoneseLooksValid = /[唔冇喺佢咁嗰啲嘅俾睇拎啱钟]/.test(incomingVoice);
    const voice = targeting.language === "粤语" && !cantoneseLooksValid
      ? fallbackScript[index].voice
      : incomingVoice || fallbackScript[index].voice;
    let visual = String(row?.visual || fallbackScript[index].visual).trim();
    if (targeting.creator === "无人物") {
      visual = visual.replace(/达人|人物|博主|创作者|面部|人脸/g, "手部");
    }
    return {
      time,
      visual: `${visual}；执行${targeting.format}，商品外观只以图片1中的商品为准`,
      voice,
      caption: voice.slice(0, 24),
    };
  });
  const productName = product.name || "商品";
  const creatorRule = [plan?.creator?.profile || "自然可信的UGC创作者", plan?.creator?.visual || "动作自然、不过度摆拍"]
    .map((value) => String(value).replace(/[。；;]+$/g, ""))
    .join("；");
  const creatorSubject = targeting.creator === "无人物"
    ? "自然手部与前臂身份参考，不出现脸部或完整人物"
    : targeting.creator === "仅手部出镜"
      ? "自然手部与前臂身份参考"
      : `${targeting.creator}人物身份参考`;
  const sceneExecutionBrief = script
    .map((row, index) => `镜头${index + 1} ${row.time}：${String(row.visual || "").replace(/；商品外观只以图片1中的商品为准$/, "")}`)
    .join("；");
  const brollBrief = Array.isArray(plan?.broll) ? plan.broll.map(String).filter(Boolean).slice(0, 5).join("；") : "";
  const creatorPrompt = `【图片2用途：人物持品关系参考】输入图片就是图片1商品原图，必须直接编辑该图生成一张人物持品参考，不得凭文字重新设计商品。\n【商品最高优先级】人物手中只出现输入图片里的同一件${productName}，逐项保留轮廓、长宽比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节；商品正面清晰、无遮挡、不过小，不得换款、换色、增删部件或生成相似替代品。\n【人物】${creatorSubject}；${creatorRule}。保持单一人物身份、脸型、五官、发型、肤色、体型和服装清晰稳定。\n【动作】人物以符合${product.category || productName}真实用途的方式自然拿起、展示或使用商品，双手结构正确，手指不得遮挡核心标签；商品尺寸和持握比例符合输入图片。\n【构图】9:16竖屏，中近景，简洁中性背景，均匀自然光，真实手机摄影质感，重点记录人物身份、手势、持握关系和商品尺度。\n【禁止】多人、多件商品、商品复制、拼图、换装对比、海报排版、额外文字、水印、畸形手部、过度磨皮。`;
  const scenePrompt = `【图片3用途：商品场景构图参考】输入图片就是图片1商品原图，必须直接编辑该图生成一张与导演方案匹配的商品场景图，不得凭文字重新设计商品。\n【商品最高优先级】场景中只出现输入图片里的同一件${productName}，逐项保留轮廓、长宽比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节；不得换款、换色、复制商品或生成相似替代品。\n【定向依据】投放市场：${targeting.market}；平台：${targeting.platform}；形式：${targeting.format}；创意角度：${plan?.strategy?.angle || "真实使用体验"}。\n【导演分镜场景依据】${sceneExecutionBrief}${brollBrief ? `；补充镜头：${brollBrief}` : ""}。从这些分镜中提炼一个贯穿全片的主场景，必须能够真实完成脚本里的核心使用动作，不得生成与商品类别无关的泛化风景。\n【环境】选择与${product.category || productName}真实购买和使用语境直接相关、符合${targeting.market}审美的环境；9:16竖屏，平台原生手机摄影，自然光，空间层次清晰，预留人物站位、手部动作和商品展示区域。\n【场景图规则】画面不得出现人物、手部或脸部；商品需要清晰放在计划使用位置，用于锁定环境、光线、机位、商品摆位和尺度。\n【禁止】无关风景、人物剪影、商品替代物、多件商品、海报排版、额外文字、水印、过度棚拍、虚假景深。`;
  const imagePrompt = scenePrompt;
  const shotPrompt = script.map((row, index) => `镜头${index + 1} ${row.time}｜画面：${row.visual}｜口播：${row.voice}｜字幕：${row.caption}`).join("\n");
  const videoPrompt = `【全局参数】${targeting.ratio}竖屏，${duration}秒，投放市场：${targeting.market}，发布平台：${targeting.platform}，内容形式：${targeting.format}，人物方式：${targeting.creator}。\n【三图职责与冲突优先级】图片1中的商品原图是商品外观唯一最高优先级依据，锁定轮廓、比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节。图片2是人物持品关系图，只锁定人物身份、服装、手势、持握动作、人与商品的相对尺度；图片2中的商品若与图片1有任何差异，必须用图片1商品替换。图片3是商品场景构图图，只锁定空间、光线、色调、机位、商品摆位和尺度；图片3中的商品若与图片1有任何差异，也必须用图片1商品替换。最终画面只能有一件图片1商品，禁止把三张图里的商品叠加或复制。\n【组合执行】让图片2中的同一人物按照图片2的持握关系拿着图片1商品，并在图片3场景内按照图片3的机位、光线和摆位执行下列分镜。商品从首帧到尾帧必须清晰可辨，人物接触商品时不得改写包装、标签或Logo。\n【声音与字幕】全程使用${targeting.language}自然口播，逐字执行下列口播；字幕同为${targeting.language}，口播与字幕同步。\n【逐镜头脚本】\n${shotPrompt}\n【镜头风格】${targeting.platform}原生手机拍摄，轻微手持运动，商品主体持续可辨认，镜头切换服从时间点。\n【硬性禁止】改变图片1商品、改变图片2人物身份与持握关系、改变图片3环境与机位、复制商品、错误文字或Logo、生成相似替代品、增加其他人物或商品、跳过镜头、改写口播、畸形手部、过度磨皮、电视广告感、未经证实的功效表现。`;
  return {
    ...plan,
    title: `${productName} · ${duration}秒 ${targeting.platform} UGC`,
    targeting,
    referenceMap: [
      { position: 1, role: "商品原图", rule: "锁定商品外观、包装、标签、品牌与文字" },
      { position: 2, role: "人物持品图", rule: "锁定人物身份、服装、手势、持握关系与商品尺度；商品细节仍以图片1为准" },
      { position: 3, role: "商品场景图", rule: "锁定空间、光线、机位、商品摆位与尺度；商品细节仍以图片1为准" },
    ],
    script,
    creatorPrompt,
    scenePrompt,
    imagePrompt,
    videoPrompt,
  };
}

async function callChatModel(config, messages, responseFormat = true) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl || !config.apiKey || !config.model) {
    throw new Error("文本模型 API 配置不完整");
  }
  const response = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.4,
      ...(responseFormat ? { response_format: { type: "json_object" } } : {}),
    }),
  }, 90_000);
  const data = await readProviderResponse(response);
  if (!response.ok) throw new Error(data.error?.message || `文本模型请求失败 (${response.status})`);
  return data.choices?.[0]?.message?.content || "";
}

function shouldRetryTextOnly(error) {
  const message = String(error?.message || "");
  return /image_url|unknown variant|deserialize|expected `?text`?|content.*string|messages\[\d+\]/i.test(message);
}

async function analyze(body) {
  if (!body.config?.text?.enabled) return demoAnalysis(body);
  const prompt = `你是跨境UGC广告导演。分析产品图片和文字，不能在证据不足时默认美国市场。返回严格JSON：
{"product":{"name":"","category":"","summary":"","visibleClues":[],"claimsToVerify":[]},"recommendations":{"market":"","marketReason":"","platform":"","language":"","format":"","creator":"","duration":""},"confidence":0}
市场可选泛英语市场、中国、日本、韩国、东南亚、欧洲、中东等；平台按市场推荐；语言可包含粤语；时长仅5秒/8秒/10秒/15秒/30秒，30秒适用于支持该时长的视频模型。`;
  const textOnlyContent = `产品名称：${body.productName || "未知"}
描述：${body.description || "未提供"}
图片状态：${body.imageDataUrl ? "用户已上传产品图，但当前文本接口可能无法读取图片；如果无法处理图片，请只基于产品名称和描述判断，并在 visibleClues 中写明“未读取图片内容”。" : "未上传图片"}`;
  const multimodalContent = [{
    type: "text",
    text: textOnlyContent,
  }];
  if (body.imageDataUrl) multimodalContent.push({ type: "image_url", image_url: { url: body.imageDataUrl } });
  try {
    return extractJson(await callChatModel(body.config.text, [
      { role: "system", content: prompt },
      { role: "user", content: body.imageDataUrl ? multimodalContent : textOnlyContent },
    ]));
  } catch (error) {
    if (!body.imageDataUrl || !shouldRetryTextOnly(error)) throw error;
    const result = extractJson(await callChatModel(body.config.text, [
      { role: "system", content: prompt },
      { role: "user", content: textOnlyContent },
    ]));
    result.mode = result.mode || "text-only-fallback";
    result.product = result.product || {};
    result.product.visibleClues = Array.isArray(result.product.visibleClues) ? result.product.visibleClues : [];
    if (!result.product.visibleClues.includes("未读取图片内容")) result.product.visibleClues.push("未读取图片内容");
    result.recommendations = result.recommendations || {};
    result.recommendations.marketReason = result.recommendations.marketReason || "当前文本模型接口不支持 image_url，已基于产品名称和补充描述生成初步推荐。";
    return result;
  }
}

async function createPlan(body) {
  const selections = body.selections || body.analysis?.recommendations || {};
  if (!body.config?.text?.enabled) return enrichDirectorPlan(demoPlan(body), body.analysis, selections);
  const prompt = `你是Seedance UGC中文广告导演。用中文策划说明，并按用户选定语言写口播。返回严格JSON，字段必须包含：
title, strategy{positioning,audience,angle}, creator{profile,visual,credibility}, hooks[10], script[{time,visual,voice,caption}], broll[], creatorPrompt, scenePrompt, videoPrompt, checklist[]。
必须逐项服从用户 selections 中的市场、平台、口播语言、画面形式、人物方式和时长；脚本总时长不得超过用户时长。视频提示词必须可直接用于Seedance/即梦，具体描述画面、动作、机位、语言、字幕、9:16和负面约束。不得编造功效，不得把用户选择改回默认值。`;
  const plan = extractJson(await callChatModel(body.config.text, [
    { role: "system", content: prompt },
    { role: "user", content: JSON.stringify({ analysis: body.analysis, selections: body.selections }) },
  ]));
  return enrichDirectorPlan(plan, body.analysis, selections);
}

async function generateMedia(kind, body) {
  const config = body.config?.[kind] || {};
  const envApiKey = kind === "image"
    ? usableApiKey(process.env.YUNCENAI_IMAGE_API_KEY || process.env.YUNCENAI_API_KEY)
    : "";
  const imagePurpose = kind === "image" ? String(body.purpose || "product-scene") : "";
  const usesProductReference = kind === "image";
  const reference = usesProductReference ? imageReferenceFile(body.referenceImageDataUrl) : null;
  const imageReferences = kind === "image"
    ? ReferenceBindings.validateReferences(ReferenceBindings.imageReferences(body.referenceImageDataUrl, body.additional_references))
    : [];
  const compiledPrompt = ReferenceBindings.compilePrompt(body.prompt, imageReferences);
  const promptBody = `${ReferenceBindings.bindingText(imageReferences)}\n${compiledPrompt.text}`;
  if (!config?.enabled && !envApiKey) {
    const demoPreview = imagePurpose === "creator"
      ? "/assets/demo-creator.svg"
      : imagePurpose === "scene" ? "/assets/demo-scene.svg" : "/assets/demo-product.png";
    return {
      mode: "demo",
      id: crypto.randomUUID(),
      status: kind === "image" ? "completed" : "queued",
      message: kind === "image" ? `演示模式已根据商品原图生成${imagePurpose === "creator" ? "人物持品" : "商品场景"}参考图` : "演示视频任务已加入队列",
      previewUrl: kind === "image" ? demoPreview : null,
      referenceApplied: usesProductReference,
      referenceBindings: imageReferences.map(({ url, ...item }) => item),
      compiledPrompt: promptBody,
      referenceMode: kind === "image" ? "image-edit" : undefined,
      referenceRole: imagePurpose,
      productGrounded: kind === "image",
      productReferencePriority: kind === "image" ? 1 : undefined,
      interactionBound: imagePurpose === "creator",
      sceneAdapted: imagePurpose === "scene",
    };
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl, kind === "image" ? "https://yuncenai.com" : "");
  const apiKey = usableApiKey(config.apiKey) || envApiKey;
  const model = config.model || (kind === "image" ? "gpt-image-2" : "");
  if (!baseUrl || !apiKey || !model) throw new Error(`${kind} API 配置不完整`);
  const endpoint = normalizeEndpoint(config.endpoint, kind === "image" ? "/v1/images/generations" : "/videos");
  const context = body.context || {};
  const scriptContext = Array.isArray(context.script)
    ? context.script.slice(0, 5).map((row, index) => `镜头${index + 1} ${row.time || ""}：${row.visual || ""}`).join("；")
    : "";
  const contextPrompt = `【项目上下文】商品：${context.productName || body.referenceProductName || "以输入图为准"}；类别：${context.category || "以商品图与分析结果为准"}；市场：${context.market || "目标市场"}；平台：${context.platform || "短视频平台"}；形式：${context.format || "UGC演示"}${scriptContext ? `；导演分镜：${scriptContext}` : ""}。`;
  const isolationPrompt = imagePurpose === "creator"
    ? `【商品原图驱动的人物持品图】输入图片是图片1商品原图，不是风格参考。必须在不改变商品任何视觉细节的前提下，让一名人物自然拿着或使用这件同一商品。商品轮廓、比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节必须与输入图一致，正面清晰可见；只允许一件商品，禁止换款、换色、复制、重绘文字或生成相似替代品。人物身份、服装和指定物体按下方参考目标对应关系执行；没有绑定人物参考时按导演描述创作人物。\n${contextPrompt}\n${promptBody}`
    : imagePurpose === "scene"
      ? `【商品原图驱动的商品场景图】输入图片是图片1商品原图，不是风格参考。必须在不改变商品任何视觉细节的前提下，把这件同一商品放入与商品类别、目标市场、平台形式和导演分镜直接相关的真实使用环境。商品轮廓、比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节必须与输入图一致；只允许一件商品，禁止换款、换色、复制、重绘文字或生成相似替代品。画面不得出现人物、手部或脸部。环境、光线、机位与指定物体按下方参考目标对应关系执行，不得生成无关的泛化风景。\n${contextPrompt}\n${promptBody}`
      : `【商品一致性强制要求】输入参考图是唯一准确商品依据。必须保留商品轮廓、比例、颜色、材质、包装结构、标签、品牌文字、Logo及装饰细节；不得改款、换色、重绘文字、替换品牌或生成相似替代品。成图必须清晰出现该商品。\n${contextPrompt}\n${promptBody}`;
  const consistencyPrompt = kind === "image"
    ? isolationPrompt
    : String(body.prompt || "").trim();
  let response;
  let data;
  let usedImageField = "";

  if (kind === "image") {
    const editEndpoint = imageEditEndpoint(config, endpoint);
    const references = [reference];
    for (const item of imageReferences.slice(1)) {
      const file = await resolveEditReference(item);
      references.push({ ...file, filename: `reference-${item.position}.${file.filename.split(".").pop()}` });
    }
    usedImageField = "image[]";
    response = await fetchWithTimeout(`${baseUrl}${editEndpoint}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: imageEditForm(model, consistencyPrompt, references, usedImageField),
    }, 180_000);
    data = await readProviderResponse(response);
    const fieldError = [400, 422].includes(response.status)
      && /image|file|field|array|multipart/i.test(String(data.error?.message || data.message || ""));
    if (!response.ok && fieldError && references.length === 1) {
      usedImageField = "image";
      response = await fetchWithTimeout(`${baseUrl}${editEndpoint}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: imageEditForm(model, consistencyPrompt, reference, usedImageField),
      }, 180_000);
      data = await readProviderResponse(response);
    }
  } else {
    response = await fetchWithTimeout(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        prompt: consistencyPrompt,
        aspect_ratio: "9:16",
        duration: body.duration || 10,
      }),
    }, 120_000);
    data = await readProviderResponse(response);
  }
  if (!response.ok) {
    const message = data.error?.message || data.message || `${kind}模型请求失败 (${response.status})`;
    const endpointHint = kind === "image" && [404, 405].includes(response.status)
      ? "；当前供应商未开放商品参考编辑接口，请在图片模型设置中确认编辑 Endpoint（通常为 /v1/images/edits）"
      : "";
    throw new Error(`${message.replace("Unknown parameter", "接口不支持该参数")}${endpointHint}`);
  }
  if (kind !== "image") return { mode: "live", status: data.status || "completed", ...data };
  const asset = imageAssetFromResponse(data);
  const first = Array.isArray(data?.data) ? data.data[0] : {};
  const safeData = Array.isArray(data?.data)
    ? data.data.map((item) => {
        const { b64_json, base64, image_base64, image, ...safeItem } = item || {};
        return safeItem;
      })
    : data?.data;
  return {
    ...data,
    data: safeData,
    mode: "live",
    status: data.status || "completed",
    previewUrl: asset.previewUrl,
    assetUrl: asset.assetUrl,
    assetSource: asset.source,
    referenceApplied: usesProductReference,
    referenceMode: "image-edit",
    referenceRole: imagePurpose,
    referenceField: usedImageField,
    referenceBindings: imageReferences.map(({ url, ...item }) => item),
    productGrounded: true,
    productReferencePriority: 1,
    sceneAdapted: imagePurpose === "scene",
    interactionBound: imagePurpose === "creator",
    revisedPrompt: first?.revised_prompt || data?.revised_prompt || "",
  };
}

function cleanList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const STRICT_REFERENCE_POLICY = "product-interaction-scene-strict-v2";
const STRICT_REFERENCE_POLICIES = new Set([STRICT_REFERENCE_POLICY, "product-person-scene-strict"]);

function isStrictReferencePolicy(value) {
  return STRICT_REFERENCE_POLICIES.has(String(value || ""));
}

function normalizeSeedanceReferenceTerms(value) {
  return String(value || "")
    .replace(/图片2中的场景与达人/g, "图片3中的场景")
    .replace(/图片2中的场景/g, "图片3中的场景")
    .replace(/参考图\s*1中的/g, "图片1中的")
    .replace(/参考图\s*1商品/g, "图片1中的商品")
    .replace(/参考图\s*1/g, "图片1中的商品")
    .replace(/参考图\s*2中的/g, "图片2中的")
    .replace(/参考图\s*2/g, "图片2中的人物")
    .replace(/参考图\s*3中的/g, "图片3中的")
    .replace(/参考图\s*3/g, "图片3中的场景");
}

function strictSeedanceReferencePrompt(value) {
  const prompt = normalizeSeedanceReferenceTerms(value).trim();
  const binding = [
    "必须严格同时使用前三张基础图片，并按参考目标对应关系使用其他输入图片完成整条视频，前三张基础图不是同等权重。",
    "图片1中的商品是商品外观唯一最高优先级依据：所有镜头必须保持同一件商品的轮廓、长宽比例、颜色、材质、包装结构、标签位置、品牌文字、Logo和装饰细节，不得改款、换色、增删部件、重绘文字或生成相似替代品。",
    "图片2中的人物是唯一人物身份与持品关系依据：锁定同一张脸、五官、发型、肤色、体型、服装、手势、持握动作以及人与商品的相对尺度。图片2中的背景一律忽略；图片2中的商品若与图片1有任何差异，必须保留图片2的手势和持握位置，但把商品外观完整替换为图片1中的商品。",
    "图片3中的场景是唯一环境与商品摆位依据：锁定空间结构、光线、色调、陈设、机位、构图、商品摆放位置和尺度，不得从图片3生成新人物。图片3中的商品若与图片1有任何差异，必须保留图片3的摆位和尺度，但把商品外观完整替换为图片1中的商品。",
    "组合顺序必须是：先复制图片1商品，再套用图片2的人物和持握关系，最后放入图片3的环境、光线与机位。最终画面只能出现一件图片1商品，禁止把图片1、图片2、图片3中的商品叠加、并排或复制。",
    "从首帧到尾帧保持图片1同一商品、图片2同一人物、图片3同一主场景；人物接触商品时不得遮挡或改写标签与Logo，禁止商品消失、变形、换包装、换品牌、人物变脸、手指穿模或场景跳变。",
  ].join("");
  return `${binding}\n${prompt}`;
}

function validateMediaReference(value, kind) {
  const raw = String(value || "").trim();
  if (!raw) return;
  if (raw.startsWith("asset://")) return;
  if (kind === "image" && (localPublicAssetPath(raw) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(raw))) return;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}参考地址格式无效：${raw.slice(0, 80)}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("参考素材仅支持公网 http/https URL 或 asset:// 地址");
}

function validateSeedanceInput(input) {
  const generationType = input.generation_type || "reference-to-video";
  const ratio = input.ratio || input.aspect_ratio || "9:16";
  const duration = Number(input.duration || 5);
  const strictReferencePolicy = isStrictReferencePolicy(input.reference_policy);
  const productImageUrl = String(input.product_image_url || "").trim();
  const personImageUrl = String(input.person_image_url || "").trim();
  const sceneImageUrls = cleanList(input.scene_image_urls);
  const imageReferences = ReferenceBindings.videoReferences(input);
  const imageUrls = imageReferences.map((item) => item.url);
  const videoUrls = cleanList(input.video_urls);
  const audioUrls = cleanList(input.audio_urls);

  if (!ALLOWED_GENERATION_TYPES.has(generationType)) throw new Error("Seedance 生成模式无效");
  if (!ALLOWED_RATIOS.has(ratio)) throw new Error("Seedance 画幅仅支持 9:16、16:9 或 1:1");
  if (!ALLOWED_DURATIONS.has(duration)) throw new Error("成片时长请选择 5、8、10、15 或 30 秒；实际支持时长以所选模型和供应商为准");
  if (imageUrls.length > 9) throw new Error("参考图片最多 9 张");
  if (videoUrls.length > 3) throw new Error("参考视频最多 3 条");
  if (audioUrls.length > 3) throw new Error("参考音频最多 3 条");
  if (strictReferencePolicy && generationType !== "reference-to-video") {
    throw new Error("严格商品一致性必须使用多参考生成模式");
  }
  if (strictReferencePolicy && !productImageUrl) throw new Error("严格三参考缺少图片1：商品原图");
  if (strictReferencePolicy && !personImageUrl) throw new Error("严格三参考缺少图片2：人物持品图");
  if (strictReferencePolicy && !sceneImageUrls.length) throw new Error("严格三参考缺少图片3：商品场景图");
  ReferenceBindings.validateReferences(imageReferences);
  ReferenceBindings.compilePrompt(input.prompt, imageReferences);
  if (generationType === "image-to-video" && imageUrls.length > 2) throw new Error("首尾帧模式最多 2 张图片；人物与物体多参考请使用多参考模式");
  imageUrls.forEach((url) => validateMediaReference(url, "image"));
  videoUrls.forEach((url) => validateMediaReference(url, "video"));
  audioUrls.forEach((url) => validateMediaReference(url, "audio"));
  if (generationType !== "text-to-video" && !imageUrls.length && !videoUrls.length) {
    throw new Error("图生或参考生视频至少需要一张图片或一条参考视频");
  }
  return {
    generationType,
    ratio,
    duration,
    imageUrls,
    imageReferences,
    videoUrls,
    audioUrls,
    strictReferencePolicy,
    productImageUrl,
    personImageUrl,
    sceneImageUrl: sceneImageUrls[0] || "",
  };
}

function seedanceConfig(body, options = {}) {
  const config = body.config?.video || {};
  const envApiKey = usableApiKey(process.env.YUNCENAI_VIDEO_API_KEY || process.env.YUNCENAI_API_KEY);
  const apiKey = usableApiKey(config.apiKey) || envApiKey;
  const baseUrl = normalizeBaseUrl(config.baseUrl, "https://yuncenai.com");
  const createEndpoint = normalizeEndpoint(config.endpoint, "/api/v3/contents/generations/tasks");
  const taskEndpoint = normalizeEndpoint(config.taskEndpoint, "/api/v3/contents/generations/tasks");
  const model = config.model || "doubao-seedance-2.0";
  const enabled = options.forceLive || config.enabled || Boolean(envApiKey);
  if (!enabled) return { demo: true, baseUrl, createEndpoint, taskEndpoint, model };
  if (!apiKey) throw new Error("请先在视频模型设置或 .env 中填写 Seedance API Key");
  return {
    demo: false,
    apiKey,
    baseUrl,
    createEndpoint,
    taskEndpoint,
    model,
  };
}

function seedanceParameterAudit(config, input, prepared, requestBytes = 0) {
  const model = input.model || config.model || "doubao-seedance-2.0";
  const createEndpoint = config.createEndpoint || "/api/v3/contents/generations/tasks";
  const taskEndpoint = config.taskEndpoint || "/api/v3/contents/generations/tasks";
  const warnings = [];
  if (!/\/api\/v3\/contents\/generations\/tasks$/i.test(createEndpoint)) warnings.push("创建任务 Endpoint 不是标准 /api/v3/contents/generations/tasks");
  if (!/\/api\/v3\/contents\/generations\/tasks$/i.test(taskEndpoint)) warnings.push("查询任务 Endpoint 不是标准 /api/v3/contents/generations/tasks");
  const expectedOrder = ["product", "person", "scene"];
  const actualOrder = prepared.referenceOrder.map((item) => item.role);
  const strictOrderValid = !prepared.strictReferencePolicy
    || expectedOrder.every((role, index) => actualOrder[index] === role);
  if (prepared.strictReferencePolicy && !prepared.productPriorityApplied) warnings.push("图片1商品最高优先级规则未写入最终提示词");
  if (prepared.strictReferencePolicy && !prepared.interactionBindingApplied) warnings.push("图片2人物持握关系规则未写入最终提示词");
  if (prepared.strictReferencePolicy && !prepared.sceneAdaptationApplied) warnings.push("图片3场景摆位与适配规则未写入最终提示词");
  if (prepared.strictReferencePolicy && !prepared.singleProductApplied) warnings.push("单件商品与禁止复制规则未写入最终提示词");
  const referenceTransportValid = prepared.referenceTransport.every((item) => ["asset", "public-url", "asset-preview"].includes(item.transport));
  if (!referenceTransportValid) warnings.push("存在未上传到素材库的本地参考图");
  return {
    ok: (!prepared.strictReferencePolicy || (strictOrderValid && prepared.promptBindingApplied)) && referenceTransportValid,
    model,
    modelProfile: model === "doubao-seedance-2.0" ? "documented-provider-model" : "explicit-model-id",
    createEndpoint,
    taskEndpoint,
    generationType: input.generation_type,
    ratio: input.ratio,
    duration: input.duration,
    generateAudio: input.generate_audio !== false,
    referenceCount: prepared.referenceOrder.length,
    referenceOrder: prepared.referenceOrder,
    mentions: prepared.mentions,
    compiledPrompt: prepared.content[0].text,
    referenceTransport: prepared.referenceTransport,
    materializedImages: prepared.materializedImages,
    strictOrderValid,
    promptBindingApplied: prepared.promptBindingApplied,
    referenceContract: prepared.strictReferencePolicy ? "v2-product-grounded-interaction-scene" : "standard",
    productPriorityApplied: prepared.productPriorityApplied,
    interactionBindingApplied: prepared.interactionBindingApplied,
    sceneAdaptationApplied: prepared.sceneAdaptationApplied,
    singleProductApplied: prepared.singleProductApplied,
    requestSizeKb: requestBytes ? Math.ceil(requestBytes / 1024) : 0,
    warnings,
  };
}

async function buildSeedanceContent(input, options = {}) {
  const generationType = input.generation_type || "reference-to-video";
  const strictReferencePolicy = isStrictReferencePolicy(input.reference_policy);
  const references = input.reference_bindings || ReferenceBindings.videoReferences(input);
  const compiled = ReferenceBindings.compilePrompt(input.prompt, references);
  const boundPrompt = `${ReferenceBindings.bindingText(references)}\n${compiled.text}`.trim();
  const finalPrompt = strictReferencePolicy
    ? strictSeedanceReferencePrompt(boundPrompt)
    : boundPrompt;
  const content = [{ type: "text", text: finalPrompt }];
  const includeReferences = generationType !== "text-to-video";
  let inlinedLocalImages = 0;
  let compressedImages = 0;
  let inlineImageBytes = 0;
  let materializedImages = 0;
  const referenceOrder = [];
  const referenceTransport = [];

  if (includeReferences) {
    for (const [index, reference] of references.entries()) {
      const url = reference.url;
      const isLocal = isInlineImageReference(url);
      let finalUrl = url;
      let transport = String(url).startsWith("asset://") ? "asset" : "public-url";
      if (isLocal && options.materializeLocalAssets) {
        if (!options.config?.apiKey) throw new Error("本地参考图上传素材库时缺少 Seedance API Key");
        finalUrl = await uploadSeedanceMaterial(options.config, url, index + 1);
        transport = "asset";
        materializedImages += 1;
      } else if (isLocal && options.previewMaterialAssets) {
        finalUrl = `asset://preview-reference-${index + 1}`;
        transport = "asset-preview";
      } else if (isLocal) {
        transport = "local-unresolved";
      }
      const role = generationType === "image-to-video" ? (index === 0 ? "first_frame" : "last_frame") : "reference_image";
      content.push({ type: "image_url", image_url: { url: finalUrl }, role });
      referenceOrder.push({
        position: index + 1,
        role: reference.role,
        name: reference.name,
        target: reference.target || "",
        id: reference.id,
      });
      referenceTransport.push({ position: index + 1, transport });
    }
  }

  if (generationType === "reference-to-video") {
    cleanList(input.video_urls).forEach((url) => {
      content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    });
    cleanList(input.audio_urls).forEach((url) => {
      content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    });
  }

  const productPriorityApplied = strictReferencePolicy
    && /图片1中的商品是商品外观唯一最高优先级依据/.test(finalPrompt);
  const interactionBindingApplied = strictReferencePolicy
    && /图片2中的人物是唯一人物身份与持品关系依据/.test(finalPrompt)
    && /图片2中的商品若与图片1有任何差异/.test(finalPrompt);
  const sceneAdaptationApplied = strictReferencePolicy
    && /图片3中的场景是唯一环境与商品摆位依据/.test(finalPrompt)
    && /图片3中的商品若与图片1有任何差异/.test(finalPrompt);
  const singleProductApplied = strictReferencePolicy
    && /最终画面只能出现一件图片1商品/.test(finalPrompt)
    && /禁止把图片1、图片2、图片3中的商品叠加、并排或复制/.test(finalPrompt);

  return {
    content,
    inlinedLocalImages,
    compressedImages,
    inlineImageBytes,
    materializedImages,
    referenceOrder,
    mentions: compiled.mentions,
    referenceTransport,
    strictReferencePolicy,
    productPriorityApplied,
    interactionBindingApplied,
    sceneAdaptationApplied,
    singleProductApplied,
    promptBindingApplied: productPriorityApplied
      && interactionBindingApplied
      && sceneAdaptationApplied
      && singleProductApplied,
  };
}

function mediaUrlValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return mediaUrlValue(value.url || value.href || value.uri || value.video_url || value.videoUrl);
}

function findVideoUrl(value, keyHint = "", depth = 0) {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") {
    const url = value.trim();
    const looksLikeUrl = /^(https?:\/\/|asset:\/\/)/i.test(url);
    const looksLikeVideo = /\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(url);
    const videoKey = /video|download|output|result|file/i.test(keyHint) && !/image|audio/i.test(keyHint);
    return looksLikeUrl && (looksLikeVideo || videoKey) ? url : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item, keyHint, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  const priorityKeys = ["video_url", "videoUrl", "download_url", "downloadUrl", "output_url", "outputUrl", "file_url", "fileUrl"];
  for (const key of priorityKeys) {
    if (value[key] !== undefined) {
      const direct = mediaUrlValue(value[key]);
      if (direct) return direct;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findVideoUrl(child, key, depth + 1);
    if (found) return found;
  }
  return "";
}

function normalizeTaskStatus(value, hasVideo) {
  const raw = String(value || (hasVideo ? "completed" : "submitted")).trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    created: "submitted",
    waiting: "pending",
    in_progress: "processing",
    generating: "processing",
    done: "completed",
    finished: "completed",
    succeed: "succeeded",
    canceled: "cancelled",
  };
  const normalized = aliases[raw] || raw;
  if (hasVideo && !["failed", "error", "cancelled"].includes(normalized)) return "completed";
  return normalized;
}

function normalizeProgress(value) {
  if (value === undefined || value === null || value === "") return { value: 0, supplied: false };
  const numeric = Number(String(value).replace("%", "").trim());
  if (!Number.isFinite(numeric)) return { value: 0, supplied: false };
  const percent = numeric > 0 && numeric < 1 ? numeric * 100 : numeric;
  return { value: Math.min(100, Math.max(0, Math.round(percent))), supplied: true };
}

function normalizeTaskData(data, fallbackTaskId = "") {
  const videoUrl = findVideoUrl(data);
  const rawStatus = data?.status
    || data?.data?.status
    || data?.task?.status
    || data?.data?.task?.status
    || data?.result?.status
    || data?.data?.result?.status
    || data?.state
    || data?.data?.state;
  const rawProgress = data?.progress
    ?? data?.data?.progress
    ?? data?.task?.progress
    ?? data?.data?.task?.progress
    ?? data?.completion_percent
    ?? data?.data?.completion_percent
    ?? data?.percent
    ?? data?.data?.percent;
  const progress = normalizeProgress(rawProgress);
  return {
    taskId: String(data?.taskId || data?.task_id || data?.id || data?.task?.id || data?.data?.task_id || data?.data?.id || data?.data?.task?.id || fallbackTaskId || ""),
    status: normalizeTaskStatus(rawStatus, Boolean(videoUrl)),
    videoUrl,
    failedReason: String(data?.failed_reason || data?.data?.failed_reason || data?.task?.failed_reason || data?.error?.message || data?.data?.error?.message || ""),
    expiresAt: String(data?.video_expires_at || data?.data?.video_expires_at || data?.expires_at || ""),
    progress: progress.value,
    progressSource: progress.supplied ? "provider" : "estimated",
    createdAt: String(data?.created_at || data?.data?.created_at || data?.task?.created_at || ""),
    updatedAt: String(data?.updated_at || data?.data?.updated_at || data?.task?.updated_at || ""),
  };
}

async function checkProvider(body) {
  const type = String(body.type || "video");
  if (!["text", "image", "video"].includes(type)) throw new Error("未知的模型接口类型");
  const startedAt = Date.now();

  if (type === "video") {
    const config = seedanceConfig(body, { forceLive: true });
    const diagnosticId = `diagnostic-${crypto.randomUUID().slice(0, 8)}`;
    const result = await requestProvider(
      `${config.baseUrl}${config.taskEndpoint}/${diagnosticId}?beta=true`,
      { headers: { Authorization: `Bearer ${config.apiKey}` } },
      true,
      20_000,
    );
    const { response, data, attempts } = result;
    const authenticated = ![401, 403].includes(response.status);
    const reachable = response.status < 500;
    const message = isCloudflareHostError(response.status, data)
      ? cloudflareFailureMessage(data, attempts)
      : authenticated
        ? (reachable ? "Seedance 网关可访问，鉴权请求已送达" : `Seedance 上游暂不可用（${response.status}）`)
        : "Seedance 鉴权未通过：API Key 无效或当前账号无视频接口权限";
    return { ok: reachable && authenticated, type, status: response.status, latencyMs: Date.now() - startedAt, authenticated, message };
  }

  const config = body.config?.[type] || {};
  const envApiKey = type === "image"
    ? usableApiKey(process.env.YUNCENAI_IMAGE_API_KEY || process.env.YUNCENAI_API_KEY)
    : "";
  const apiKey = usableApiKey(config.apiKey) || envApiKey;
  if (!apiKey) throw new Error(`请先填写${type === "image" ? "图片" : "文本"}模型 API Key`);
  const baseUrl = normalizeBaseUrl(config.baseUrl, type === "image" ? "https://yuncenai.com" : "");
  const probeUrl = type === "text" ? `${baseUrl}/models` : baseUrl;
  const response = await fetchWithTimeout(probeUrl, { headers: { Authorization: `Bearer ${apiKey}` } }, 20_000);
  await response.body?.cancel();
  const authenticated = ![401, 403].includes(response.status);
  const reachable = response.status < 500;
  return {
    ok: reachable && authenticated,
    type,
    status: response.status,
    latencyMs: Date.now() - startedAt,
    authenticated,
    message: authenticated ? "接口地址可访问" : "鉴权未通过：API Key 无效或当前账号无接口权限",
  };
}

async function validateSeedanceParameters(body) {
  const config = seedanceConfig(body);
  const input = body.input || {};
  if (!String(input.prompt || "").trim()) throw new Error("请填写 Seedance 视频提示词");
  const validated = validateSeedanceInput(input);
  const normalizedInput = {
    ...input,
    generation_type: validated.generationType,
    ratio: validated.ratio,
    duration: validated.duration,
    image_urls: validated.imageUrls,
    reference_bindings: validated.imageReferences,
    video_urls: validated.videoUrls,
    audio_urls: validated.audioUrls,
    reference_policy: validated.strictReferencePolicy ? STRICT_REFERENCE_POLICY : "",
    product_image_url: validated.productImageUrl,
    person_image_url: validated.personImageUrl,
    scene_image_urls: validated.sceneImageUrl ? [validated.sceneImageUrl] : [],
  };
  const prepared = await buildSeedanceContent(normalizedInput, { previewMaterialAssets: true });
  const requestPayload = {
    model: normalizedInput.model || config.model || "doubao-seedance-2.0",
    content: prepared.content,
    generate_audio: normalizedInput.generate_audio !== false,
    ratio: normalizedInput.ratio,
    duration: normalizedInput.duration,
    watermark: Boolean(normalizedInput.watermark),
  };
  const requestBytes = Buffer.byteLength(JSON.stringify(requestPayload));
  if (requestBytes > 900 * 1024) throw new Error(`Seedance 参数检查失败：请求体 ${(requestBytes / 1024).toFixed(0)}KB，超过 900KB 安全上限`);
  const audit = seedanceParameterAudit(config, normalizedInput, prepared, requestBytes);
  if (!audit.ok) throw new Error("Seedance 参数检查失败：三参考顺序或提示词图片编号未正确绑定");
  return { ok: true, audit };
}

async function createSeedanceTask(body) {
  const config = seedanceConfig(body);
  const input = body.input || {};
  if (!String(input.prompt || "").trim()) throw new Error("请填写 Seedance 视频提示词");
  const validated = validateSeedanceInput(input);
  const normalizedInput = {
    ...input,
    generation_type: validated.generationType,
    ratio: validated.ratio,
    duration: validated.duration,
    image_urls: validated.imageUrls,
    reference_bindings: validated.imageReferences,
    video_urls: validated.videoUrls,
    audio_urls: validated.audioUrls,
    reference_policy: validated.strictReferencePolicy ? STRICT_REFERENCE_POLICY : "",
    product_image_url: validated.productImageUrl,
    person_image_url: validated.personImageUrl,
    scene_image_urls: validated.sceneImageUrl ? [validated.sceneImageUrl] : [],
  };

  if (config.demo) {
    const taskId = `demo-${crypto.randomUUID().slice(0, 8)}`;
    const prepared = await buildSeedanceContent(normalizedInput, { previewMaterialAssets: true });
    const parameterAudit = seedanceParameterAudit(config, normalizedInput, prepared);
    if (!parameterAudit.ok) throw new Error("Seedance 参数审计未通过：三参考顺序或提示词绑定异常");
    return {
      mode: "demo",
      taskId,
      status: "queued",
      message: `演示模式：已模拟提交 ${normalizedInput.model || config.model} 任务。启用真实视频 API 后会提交到供应商。`,
      request: {
        model: normalizedInput.model || config.model,
        content: prepared.content,
        generate_audio: normalizedInput.generate_audio !== false,
        ratio: normalizedInput.ratio,
        duration: normalizedInput.duration,
        watermark: Boolean(normalizedInput.watermark),
      },
      referenceAudit: {
        strict: prepared.strictReferencePolicy,
        productBound: prepared.referenceOrder.some((item) => item.role === "product"),
        personBound: prepared.referenceOrder.some((item) => item.role === "person"),
        sceneBound: prepared.referenceOrder.some((item) => item.role === "scene"),
        promptBindingApplied: prepared.promptBindingApplied,
        productPriorityApplied: prepared.productPriorityApplied,
        interactionBindingApplied: prepared.interactionBindingApplied,
        sceneAdaptationApplied: prepared.sceneAdaptationApplied,
        singleProductApplied: prepared.singleProductApplied,
        order: prepared.referenceOrder,
      },
      parameterAudit,
    };
  }

  const prepared = await buildSeedanceContent(normalizedInput, { materializeLocalAssets: true, config });
  const requestPayload = {
    model: normalizedInput.model || config.model,
    content: prepared.content,
    generate_audio: normalizedInput.generate_audio !== false,
    ratio: normalizedInput.ratio,
    duration: normalizedInput.duration,
    watermark: Boolean(normalizedInput.watermark),
  };
  const requestBody = JSON.stringify(requestPayload);
  const requestBytes = Buffer.byteLength(requestBody);
  if (requestBytes > 900 * 1024) {
    throw new Error(`Seedance 请求体仍有 ${(requestBytes / 1024).toFixed(0)}KB，超过安全上限；请减少参考图数量或改用公网 HTTPS URL / asset:// 地址`);
  }
  const parameterAudit = seedanceParameterAudit(config, normalizedInput, prepared, requestBytes);
  if (!parameterAudit.ok) throw new Error("Seedance 参数审计未通过：三参考顺序或提示词绑定异常");

  const providerResult = await requestProvider(`${config.baseUrl}${config.createEndpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: requestBody,
  }, true);
  const { response, data, attempts } = providerResult;
  if (!response.ok) {
    const upstreamMessage = isCloudflareHostError(response.status, data)
      ? cloudflareFailureMessage(data, attempts)
      : (data.error?.message || data.message || `供应商返回 ${response.status}`);
    const localHint = prepared.materializedImages
      ? `；${prepared.materializedImages} 张本地参考图已上传素材库并转换为 asset:// 地址`
      : "";
    throw new Error(`Seedance 任务提交失败（${response.status}）：${upstreamMessage}${localHint}`);
  }
  const task = normalizeTaskData(data);
  if (!task.taskId) throw new Error("Seedance 接口已响应，但没有返回任务 ID；请检查供应商接口版本");
  return {
    ...data,
    mode: "live",
    task,
    taskId: task.taskId,
    status: task.status,
    localImagesInlined: 0,
    compressedImages: 0,
    materializedImages: prepared.materializedImages,
    requestSizeKb: Math.ceil(requestBytes / 1024),
    providerAttempts: attempts,
    referenceAudit: {
      strict: prepared.strictReferencePolicy,
      productBound: prepared.referenceOrder.some((item) => item.role === "product"),
      personBound: prepared.referenceOrder.some((item) => item.role === "person"),
      sceneBound: prepared.referenceOrder.some((item) => item.role === "scene"),
      promptBindingApplied: prepared.promptBindingApplied,
      productPriorityApplied: prepared.productPriorityApplied,
      interactionBindingApplied: prepared.interactionBindingApplied,
      sceneAdaptationApplied: prepared.sceneAdaptationApplied,
      singleProductApplied: prepared.singleProductApplied,
      order: prepared.referenceOrder,
    },
    parameterAudit,
  };
}

async function getSeedanceTask(body) {
  const config = seedanceConfig(body);
  const taskId = String(body.taskId || "").trim();
  if (!taskId) throw new Error("缺少 taskId");

  if (config.demo) {
    const task = {
      taskId,
      status: "completed",
      videoUrl: "",
      failedReason: "",
      expiresAt: "",
      progress: 100,
    };
    return {
      mode: "demo",
      task,
      taskId,
      id: taskId,
      status: "completed",
      billing_status: "demo",
      content: { video_url: "" },
      usage: { completion_tokens: 0, total_tokens: 0 },
      message: "演示模式：轮询流程正常。启用真实视频 API 后这里会返回视频 URL。",
    };
  }

  const providerResult = await requestProvider(`${config.baseUrl}${config.taskEndpoint}/${encodeURIComponent(taskId)}?beta=true`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  }, true);
  const { response, data, attempts } = providerResult;
  if (!response.ok) {
    const message = isCloudflareHostError(response.status, data)
      ? cloudflareFailureMessage(data, attempts)
      : (data.error?.message || data.message || `Seedance 任务查询失败 (${response.status})`);
    throw new Error(message);
  }
  const task = normalizeTaskData(data, taskId);
  return { ...data, mode: "live", task, taskId: task.taskId, status: task.status };
}

async function downloadSeedanceVideo(req, res) {
  try {
    const body = await readJson(req);
    const taskData = await getSeedanceTask(body);
    const task = taskData.task || normalizeTaskData(taskData, body.taskId);
    if (!task.videoUrl) throw new Error("供应商尚未返回成片地址，请稍后刷新任务状态");

    let mediaUrl;
    try {
      mediaUrl = new URL(task.videoUrl);
    } catch {
      throw new Error("供应商返回的成片地址无效");
    }
    if (!['http:', 'https:'].includes(mediaUrl.protocol)) throw new Error("当前成片地址暂不支持直接下载");

    const mediaResponse = await fetchWithTimeout(mediaUrl, {}, 180_000);
    if (!mediaResponse.ok || !mediaResponse.body) throw new Error(`下载成片失败（${mediaResponse.status}）`);
    const providerType = mediaResponse.headers.get("content-type") || "video/mp4";
    const extension = path.extname(mediaUrl.pathname).replace(/[^.a-z0-9]/gi, "") || ".mp4";
    const safeTaskId = String(task.taskId || body.taskId || "video").replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    const headers = {
      "Content-Type": providerType,
      "Content-Disposition": `attachment; filename="seedance-${safeTaskId}${extension}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const length = mediaResponse.headers.get("content-length");
    if (length) headers["Content-Length"] = length;
    res.writeHead(200, headers);
    Readable.fromWeb(mediaResponse.body).pipe(res);
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    return sendJson(res, 400, { error: error.message || "下载失败" });
  }
}

async function handleApi(req, res, pathname) {
  try {
    const body = await readJson(req);
    if (pathname === "/api/analyze") return sendJson(res, 200, await analyze(body));
    if (pathname === "/api/plan") return sendJson(res, 200, await createPlan(body));
    if (pathname === "/api/generate/image") return sendJson(res, 200, await generateMedia("image", body));
    if (pathname === "/api/generate/video") return sendJson(res, 200, await generateMedia("video", body));
    if (pathname === "/api/seedance/validate") return sendJson(res, 200, await validateSeedanceParameters(body));
    if (pathname === "/api/seedance/create") return sendJson(res, 200, await createSeedanceTask(body));
    if (pathname === "/api/seedance/task") return sendJson(res, 200, await getSeedanceTask(body));
    if (pathname === "/api/provider/check") return sendJson(res, 200, await checkProvider(body));
    if (pathname === "/api/health") return sendJson(res, 200, healthPayload());
    return sendJson(res, 404, { error: "API 路径不存在" });
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "请求失败" });
  }
}

function serveStatic(res, pathname) {
  let relative;
  try { relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1)); }
  catch { return sendJson(res, 400, { error: "页面地址编码无效" }); }
  if (relative.includes("\0")) return sendJson(res, 400, { error: "页面地址无效" });
  const filePath = path.normalize(path.join(PUBLIC_DIR, relative));
  const publicRoot = `${path.normalize(PUBLIC_DIR)}${path.sep}`;
  if (!filePath.startsWith(publicRoot)) return sendJson(res, 403, { error: "禁止访问" });
  fs.readFile(filePath, (error, data) => {
    if (error) {
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) return sendJson(res, 404, { error: "页面不存在" });
        res.writeHead(200, {
          "Content-Type": mimeTypes[".html"],
          "Cache-Control": "no-store, max-age=0",
        });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store, max-age=0",
    });
    res.end(data);
  });
}

async function handleBusiness(req, res, url) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    const remote = req.socket.remoteAddress;
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) || !["127.0.0.1", "localhost", "[::1]"].includes(host.hostname)) return sendJson(res, 403, { error: "合作经营数据仅供本机管理，不能通过公网或局域网读取" });
    if (req.headers.origin && req.headers.origin !== host.origin) return sendJson(res, 403, { error: "拒绝其他网站访问经营数据" });
    if (req.method === "GET" && url.pathname === "/api/business") return sendJson(res, 200, businessStore.snapshot());
    if (req.method === "GET" && ["/api/business/orders.csv", "/api/business/partner.csv"].includes(url.pathname)) {
      const partnerId = url.pathname.endsWith("partner.csv") ? url.searchParams.get("id") : "";
      if (url.pathname.endsWith("partner.csv") && !partnerId) return sendJson(res, 400, { error: "缺少合作伙伴编号" });
      const csv = businessStore.csv(partnerId);
      res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${partnerId ? "partner-report" : "orders"}.csv"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      return res.end(csv);
    }
    if (req.method === "GET" && url.pathname === "/api/business/export") {
      res.setHeader("Content-Disposition", 'attachment; filename="business-backup.json"');
      return sendJson(res, 200, businessStore.export());
    }
    const action = url.pathname.slice("/api/business/".length);
    if (req.method !== "POST") return sendJson(res, 405, { error: "经营接口仅支持 GET / POST" });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "经营操作需要 application/json" });
    if (!["settings", "partner", "order", "settlement"].includes(action)) return sendJson(res, 404, { error: "经营操作不存在" });
    return sendJson(res, 200, businessStore.mutate(action, await readJson(req)));
  } catch (error) { return sendJson(res, error.status || 400, { error: error.message || "经营数据保存失败" }); }
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { return sendJson(res, 400, { error: "请求地址无效" }); }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    if (req.headers.origin && req.headers.origin !== new URL(`http://${req.headers.host}`).origin) return sendJson(res, 403, { error: "拒绝其他网站发起工作台操作" });
    if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) return sendJson(res, 415, { error: "操作需要 application/json" });
  }
  if (url.pathname === "/api/business" || url.pathname.startsWith("/api/business/")) return handleBusiness(req, res, url);
  if (req.method === "POST" && url.pathname === "/api/seedance/download") {
    return downloadSeedanceVideo(req, res);
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url.pathname);
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, healthPayload());
  }
  if (req.method === "GET") return serveStatic(res, url.pathname);
  sendJson(res, 405, { error: "Method not allowed" });
});

function startServer(port = PORT, host = HOST) {
  return server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Seedance UGC Studio running at http://${host}:${actualPort}`);
  });
}

if (require.main === module) startServer();

module.exports = {
  server,
  startServer,
  normalizeTaskData,
  validateSeedanceInput,
};
