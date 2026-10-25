const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { startServer, server, normalizeTaskData } = require("../server");

function listen(instance) {
  return new Promise((resolve, reject) => {
    instance.once("error", reject);
    instance.listen(0, "127.0.0.1", () => {
      instance.off("error", reject);
      resolve(instance.address().port);
    });
  });
}

function close(instance) {
  return new Promise((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
}

async function jsonRequest(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, body === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}

test("Seedance UGC Studio architecture flow", async (t) => {
  let receivedCreatePayload;
  const receivedImageEditRequests = [];
  const receivedImageGenerationRequests = [];
  const receivedMaterialUploads = [];
  const receivedMaterialRecords = [];
  const materialStatusChecks = new Map();
  const mockProvider = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    if (req.method === "POST" && req.url === "/v1/images/edits") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      receivedImageEditRequests.push({
        headers: req.headers,
        body,
      });
      const suffix = /人物持品/.test(body) ? "creator" : /商品场景/.test(body) ? "scene" : "product-scene";
      res.end(JSON.stringify({ data: [{ url: `https://cdn.example.com/${suffix}.png` }] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/images/generations") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const payload = JSON.parse(raw);
      receivedImageGenerationRequests.push(payload);
      const suffix = /人物参考图/.test(payload.prompt) ? "creator" : "scene";
      res.end(JSON.stringify({ data: [{ url: `https://cdn.example.com/${suffix}.png` }] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/materials/groups") {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/materials/groups") {
      res.end(JSON.stringify({ data: { group_id: "group-ugc-1" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/materials/uploads") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      receivedMaterialUploads.push(Buffer.concat(chunks).toString("latin1"));
      res.end(JSON.stringify({ data: { upload_id: `upload-${receivedMaterialUploads.length}` } }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/materials") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      receivedMaterialRecords.push(JSON.parse(raw));
      res.end(JSON.stringify({ data: { asset_id: `asset-${receivedMaterialRecords.length}` } }));
      return;
    }
    if (req.method === "GET" && /^\/v1\/materials\/asset-\d+$/.test(req.url)) {
      const assetId = req.url.split("/").at(-1);
      const checkCount = (materialStatusChecks.get(assetId) || 0) + 1;
      materialStatusChecks.set(assetId, checkCount);
      res.end(JSON.stringify({ data: { asset_id: assetId, status: checkCount < 3 ? "processing" : "ready" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/v3/contents/generations/tasks") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      receivedCreatePayload = JSON.parse(raw);
      res.end(JSON.stringify({ data: { id: "task-live-1", status: "queued" } }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/v3/contents/generations/tasks/task-live-1")) {
      res.end(JSON.stringify({
        data: {
          id: "task-live-1",
          status: "succeeded",
          content: { video_url: `http://127.0.0.1:${mockProvider.address().port}/result.mp4` },
          progress: 100,
        },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/result.mp4") {
      res.setHeader("Content-Type", "video/mp4");
      res.end(Buffer.from("mock-video-bytes"));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "task not found" }));
  });

  const providerPort = await listen(mockProvider);
  const appServer = startServer(0, "127.0.0.1");
  if (!appServer.listening) await new Promise((resolve) => appServer.once("listening", resolve));
  const appPort = appServer.address().port;
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const providerBaseUrl = `http://127.0.0.1:${providerPort}`;

  t.after(async () => {
    await close(server);
    await close(mockProvider);
  });

  await t.test("health and static shell are available", async () => {
    const health = await jsonRequest(baseUrl, "/api/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.data.ok, true);
    assert.match(health.data.version, /^\d+\.\d+\.\d+$/);
    assert.equal(typeof health.data.providers.video, "boolean");

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("cache-control"), /no-store/);
    assert.match(await page.text(), /Seedance UGC/);
  });

  await t.test("local analysis preserves customer requirements without inventing visual facts", async () => {
    const result = await jsonRequest(baseUrl, "/api/analyze", { productName: "原木衣柜", description: "黑胡桃原木，30秒，面向本地装修客户", config: { text: { enabled: false } } });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.product.name, "原木衣柜");
    assert.match(result.data.product.summary, /黑胡桃原木/);
    assert.doesNotMatch(result.data.product.summary, /护肤|精华/);
    assert.equal(result.data.confidence, 0);
    assert.match(result.data.product.visibleClues.join(""), /未调用/);
    assert.equal(result.data.recommendations.market, "待客户确认");
  });

  await t.test("demo submission and polling use a stable task contract", async () => {
    const created = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: {
        prompt: "测试提示词",
        generation_type: "text-to-video",
        duration: 5,
        ratio: "9:16",
      },
      config: { video: { enabled: false } },
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.mode, "demo");
    assert.ok(created.data.taskId.startsWith("demo-"));

    const queried = await jsonRequest(baseUrl, "/api/seedance/task", {
      taskId: created.data.taskId,
      config: { video: { enabled: false } },
    });
    assert.equal(queried.data.task.status, "completed");
    assert.equal(queried.data.task.taskId, created.data.taskId);
  });

  await t.test("invalid Seedance parameters are rejected before provider calls", async () => {
    const result = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: {
        prompt: "测试提示词",
        generation_type: "text-to-video",
        duration: 12,
        ratio: "4:3",
      },
      config: { video: { enabled: false } },
    });
    assert.equal(result.response.status, 400);
    assert.match(result.data.error, /画幅|时长/);
  });

  await t.test("strict reference video requires product, person and scene images", async () => {
    const result = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: {
        prompt: "严格三参考测试",
        generation_type: "reference-to-video",
        reference_policy: "product-interaction-scene-strict-v2",
        product_image_url: "https://cdn.example.com/product-original.png",
        scene_image_urls: [],
        duration: 5,
        ratio: "9:16",
      },
      config: { video: { enabled: false } },
    });
    assert.equal(result.response.status, 400);
    assert.match(result.data.error, /缺少图片2/);
  });

  await t.test("parameter validation audits three reference roles before submission", async () => {
    const result = await jsonRequest(baseUrl, "/api/seedance/validate", {
      input: {
        prompt: "图片1商品、图片2人物、图片3场景生成视频。",
        generation_type: "reference-to-video",
        reference_policy: "product-interaction-scene-strict-v2",
        product_image_url: "https://cdn.example.com/product-original.png",
        person_image_url: "https://cdn.example.com/generated-person.png",
        scene_image_urls: ["https://cdn.example.com/generated-scene.png"],
        duration: 15,
        ratio: "9:16",
      },
      config: { video: { enabled: false, model: "doubao-seedance-2.0" } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.audit.ok, true);
    assert.equal(result.data.audit.referenceCount, 3);
    assert.equal(result.data.audit.strictOrderValid, true);
    assert.equal(result.data.audit.productPriorityApplied, true);
    assert.equal(result.data.audit.interactionBindingApplied, true);
    assert.equal(result.data.audit.sceneAdaptationApplied, true);
    assert.equal(result.data.audit.singleProductApplied, true);
    assert.equal(result.data.audit.referenceContract, "v2-product-grounded-interaction-scene");
    assert.deepEqual(result.data.audit.referenceOrder.map((item) => item.role), ["product", "person", "scene"]);
  });

  await t.test("director plan locks targeting, language, duration and reference roles", async () => {
    const result = await jsonRequest(baseUrl, "/api/plan", {
      analysis: {
        product: {
          name: "测试钢笔",
          category: "文具",
          summary: "墨绿色与金色细节的钢笔。",
        },
      },
      selections: {
        market: "中国大陆",
        platform: "抖音",
        language: "粤语",
        format: "真人口播 + 手部演示 + 体验反应",
        creator: "无人物",
        duration: "15秒",
      },
      config: { text: { enabled: false } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.targeting.platform, "抖音");
    assert.equal(result.data.targeting.language, "粤语");
    assert.equal(result.data.targeting.creator, "无人物");
    assert.equal(result.data.targeting.durationSeconds, 15);
    assert.equal(result.data.script.at(-1).time.endsWith("15s"), true);
    assert.equal(result.data.script.every((row) => /[唔冇喺佢咁嗰啲嘅俾睇拎啱钟]/.test(row.voice)), true);
    assert.equal(result.data.script.every((row) => row.visual.includes("图片1")), true);
    assert.match(result.data.creatorPrompt, /输入图片就是图片1商品原图/);
    assert.match(result.data.creatorPrompt, /人物手中只出现输入图片里的同一件测试钢笔/);
    assert.match(result.data.scenePrompt, /商品场景构图参考/);
    assert.match(result.data.scenePrompt, /导演分镜场景依据/);
    assert.match(result.data.scenePrompt, /不得生成与商品类别无关的泛化风景/);
    assert.match(result.data.videoPrompt, /图片1中的商品原图是商品外观唯一最高优先级依据/);
    assert.match(result.data.videoPrompt, /图片2是人物持品关系图/);
    assert.match(result.data.videoPrompt, /图片3是商品场景构图图/);
    assert.match(result.data.videoPrompt, /最终画面只能有一件图片1商品/);
    assert.match(result.data.videoPrompt, /全程使用粤语自然口播/);
  });

  await t.test("30 second director plan keeps the full timeline and video prompt", async () => {
    const result = await jsonRequest(baseUrl, "/api/plan", {
      analysis: { product: { name: "测试钢笔", category: "文具" } },
      selections: { market: "中国大陆", platform: "抖音", language: "中文普通话", duration: "30秒" },
      config: { text: { enabled: false } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.targeting.durationSeconds, 30);
    assert.equal(result.data.targeting.duration, "30秒");
    assert.match(result.data.title, /30秒/);
    assert.match(result.data.videoPrompt, /30秒/);
    let previousEnd = 0;
    for (const row of result.data.script) {
      const [, start, end] = row.time.match(/^(\d+)-(\d+)s$/);
      assert.equal(Number(start), previousEnd);
      assert.ok(Number(end) > Number(start));
      previousEnd = Number(end);
    }
    assert.equal(previousEnd, 30);
  });

  await t.test("30 second validation and demo preserve configured and explicit new model IDs", async () => {
    for (const model of ["doubao-seedance-2.5", "provider-custom-video-model"]) {
      const body = {
        input: { prompt: "30秒产品展示", generation_type: "text-to-video", duration: 30 },
        config: { video: { enabled: false, model } },
      };
      const validated = await jsonRequest(baseUrl, "/api/seedance/validate", body);
      assert.equal(validated.response.status, 200);
      assert.equal(validated.data.audit.duration, 30);
      assert.equal(validated.data.audit.model, model);
      const created = await jsonRequest(baseUrl, "/api/seedance/create", body);
      assert.equal(created.response.status, 200);
      assert.equal(created.data.mode, "demo");
      assert.equal(created.data.request.duration, 30);
      assert.equal(created.data.request.model, model);
      assert.match(created.data.message, new RegExp(model));

      const explicit = await jsonRequest(baseUrl, "/api/seedance/create", {
        ...body, input: { ...body.input, model: "explicit-provider-model" },
      });
      assert.equal(explicit.response.status, 200);
      assert.equal(explicit.data.request.model, "explicit-provider-model");
    }
    const invalid = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: { prompt: "不支持的时长", generation_type: "text-to-video", duration: 31 },
      config: { video: { enabled: false, model: "doubao-seedance-2.5" } },
    });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.data.error, /时长/);
  });

  await t.test("live adapter forwards 30 seconds and new model IDs to the provider unchanged", async () => {
    for (const model of ["doubao-seedance-2.5", "provider-custom-video-model"]) {
      const created = await jsonRequest(baseUrl, "/api/seedance/create", {
        input: {
          prompt: "图片1中的商品、图片2中的人物与图片3中的场景，完成30秒产品展示。",
          generation_type: "reference-to-video",
          reference_policy: "product-interaction-scene-strict-v2",
          product_image_url: "https://cdn.example.com/product-original.png",
          person_image_url: "https://cdn.example.com/generated-person.png",
          scene_image_urls: ["https://cdn.example.com/generated-scene.png"],
          duration: 30,
          ratio: "9:16",
        },
        config: { video: { enabled: true, apiKey: "test-key", baseUrl: providerBaseUrl, model } },
      });
      assert.equal(created.response.status, 200);
      assert.equal(created.data.mode, "live");
      assert.equal(receivedCreatePayload.duration, 30);
      assert.equal(receivedCreatePayload.model, model);
      assert.equal(created.data.parameterAudit.duration, 30);
      assert.equal(created.data.parameterAudit.model, model);
      assert.equal(created.data.parameterAudit.referenceCount, 3);
    }
  });

  await t.test("image generation uses the product image through multipart edits", async () => {
    const result = await jsonRequest(baseUrl, "/api/generate/image", {
      prompt: "把商品放进自然桌面使用场景，商品清晰可见。",
      referenceProductName: "测试钢笔",
      referenceImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      config: {
        image: {
          enabled: true,
          apiKey: "test-key",
          baseUrl: providerBaseUrl,
          model: "gpt-image-2",
          endpoint: "/v1/images/generations",
          editEndpoint: "/v1/images/edits",
        },
      },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.data.referenceApplied, true);
    assert.equal(result.data.referenceMode, "image-edit");
    assert.equal(result.data.previewUrl, "https://cdn.example.com/product-scene.png");
    const request = receivedImageEditRequests.at(-1);
    assert.match(request.headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(request.body, /name="image\[\]"/);
    assert.match(request.body, /filename="product-reference\.png"/);
    assert.match(request.body, /gpt-image-2/);
  });

  await t.test("person interaction and product scene references both use image1 through multipart edits", async () => {
    const config = {
      image: {
        enabled: true,
        apiKey: "test-key",
        baseUrl: providerBaseUrl,
        model: "gpt-image-2",
        endpoint: "/v1/images/generations",
        editEndpoint: "/v1/images/edits",
      },
    };
    const creator = await jsonRequest(baseUrl, "/api/generate/image", {
      purpose: "creator",
      prompt: "人物持品图，正面中近景，保持商品清晰。",
      referenceImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      context: { productName: "测试钢笔", category: "文具", market: "中国大陆", platform: "抖音" },
      config,
    });
    const scene = await jsonRequest(baseUrl, "/api/generate/image", {
      purpose: "scene",
      prompt: "商品场景图，竖屏自然光，书桌书写环境。",
      referenceImageDataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      context: {
        productName: "测试钢笔",
        category: "文具",
        market: "中国大陆",
        platform: "抖音",
        script: [{ time: "0-3s", visual: "在书桌上拿起钢笔书写" }],
      },
      config,
    });
    assert.equal(creator.response.status, 200);
    assert.equal(scene.response.status, 200);
    assert.equal(creator.data.referenceMode, "image-edit");
    assert.equal(scene.data.referenceMode, "image-edit");
    assert.equal(creator.data.referenceApplied, true);
    assert.equal(scene.data.referenceApplied, true);
    assert.equal(creator.data.productGrounded, true);
    assert.equal(scene.data.productGrounded, true);
    assert.equal(creator.data.interactionBound, true);
    assert.equal(scene.data.sceneAdapted, true);
    assert.equal(creator.data.previewUrl, "https://cdn.example.com/creator.png");
    assert.equal(scene.data.previewUrl, "https://cdn.example.com/scene.png");
    const creatorRequest = receivedImageEditRequests.at(-2);
    const sceneRequest = receivedImageEditRequests.at(-1);
    assert.match(creatorRequest.body, /商品原图驱动的人物持品图/);
    assert.match(creatorRequest.body, /没有绑定人物参考时按导演描述创作人物/);
    assert.doesNotMatch(creatorRequest.body, /图片2负责/);
    assert.match(creatorRequest.body, /filename="product-reference\.png"/);
    assert.match(sceneRequest.body, /商品原图驱动的商品场景图/);
    assert.match(sceneRequest.body, /导演分镜：镜头1 0-3s：在书桌上拿起钢笔书写/);
    assert.match(sceneRequest.body, /filename="product-reference\.png"/);
    assert.equal(receivedImageGenerationRequests.length, 0);
  });

  await t.test("nested provider results normalize finished status, progress and media URL", () => {
    const normalized = normalizeTaskData({
      data: {
        task: { id: "nested-task", status: "finished" },
        completion_percent: "100",
        result: { output: { video_url: { url: "https://cdn.example.com/nested.mp4" } } },
      },
    });
    assert.equal(normalized.taskId, "nested-task");
    assert.equal(normalized.status, "completed");
    assert.equal(normalized.progress, 100);
    assert.equal(normalized.progressSource, "provider");
    assert.equal(normalized.videoUrl, "https://cdn.example.com/nested.mp4");
  });

  await t.test("live local references are uploaded to the material service and submitted as asset URLs", async () => {
    const config = {
      video: {
        enabled: true,
        apiKey: "test-key",
        baseUrl: providerBaseUrl,
        model: "doubao-seedance-2.0",
        endpoint: "/api/v3/contents/generations/tasks",
        taskEndpoint: "/api/v3/contents/generations/tasks",
      },
    };
    const dataUrl = (value) => `data:image/png;base64,${Buffer.from(value).toString("base64")}`;
    const created = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: {
        prompt: "图片1中的商品由图片2中的人物拿起，并放在图片3中的场景。",
        generation_type: "reference-to-video",
        reference_policy: "product-interaction-scene-strict-v2",
        product_image_url: dataUrl("product-reference"),
        person_image_url: dataUrl("person-reference"),
        scene_image_urls: [dataUrl("scene-reference")],
        duration: 15,
        ratio: "9:16",
      },
      config,
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.materializedImages, 3);
    assert.equal(receivedMaterialUploads.length, 3);
    assert.equal(receivedMaterialRecords.length, 3);
    assert.equal([...materialStatusChecks.values()].every((count) => count >= 3), true);
    assert.deepEqual(receivedMaterialRecords.map((record) => record.asset_type), ["Image", "Image", "Image"]);
    assert.deepEqual(receivedCreatePayload.content.slice(1, 4).map((item) => item.image_url.url), [
      "asset://asset-1",
      "asset://asset-2",
      "asset://asset-3",
    ]);
    assert.deepEqual(created.data.parameterAudit.referenceTransport.map((item) => item.transport), ["asset", "asset", "asset"]);
  });

  await t.test("live adapter submits, normalizes and polls provider tasks", async () => {
    const config = {
      video: {
        enabled: true,
        apiKey: "test-key",
        baseUrl: providerBaseUrl,
        model: "doubao-seedance-2.0",
        endpoint: "/api/v3/contents/generations/tasks",
        taskEndpoint: "/api/v3/contents/generations/tasks",
      },
    };
    const created = await jsonRequest(baseUrl, "/api/seedance/create", {
      input: {
        prompt: "@图片1中的商品由@图片2中的人物拿起，并在@图片3中的场景完成演示。",
        generation_type: "reference-to-video",
        reference_policy: "product-interaction-scene-strict-v2",
        product_image_url: "https://cdn.example.com/product-original.png",
        person_image_url: "https://cdn.example.com/generated-person.png",
        scene_image_urls: ["https://cdn.example.com/generated-scene.png"],
        image_urls: [
          "https://cdn.example.com/generated-scene.png",
          "https://cdn.example.com/product-original.png",
          "https://cdn.example.com/generated-person.png",
        ],
        duration: 5,
        ratio: "9:16",
      },
      config,
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.data.task.taskId, "task-live-1");
    assert.equal(created.data.task.status, "queued");
    assert.equal(receivedCreatePayload.model, "doubao-seedance-2.0");
    assert.equal(receivedCreatePayload.content[0].type, "text");
    assert.match(receivedCreatePayload.content[0].text, /图片1中的商品是商品外观唯一最高优先级依据/);
    assert.match(receivedCreatePayload.content[0].text, /图片2中的人物是唯一人物身份与持品关系依据/);
    assert.match(receivedCreatePayload.content[0].text, /图片3中的场景是唯一环境与商品摆位依据/);
    assert.match(receivedCreatePayload.content[0].text, /最终画面只能出现一件图片1商品/);
    assert.doesNotMatch(receivedCreatePayload.content[0].text, /@图片/);
    assert.equal(receivedCreatePayload.content[1].type, "image_url");
    assert.equal(receivedCreatePayload.content[1].image_url.url, "https://cdn.example.com/product-original.png");
    assert.equal(receivedCreatePayload.content[2].image_url.url, "https://cdn.example.com/generated-person.png");
    assert.equal(receivedCreatePayload.content[3].image_url.url, "https://cdn.example.com/generated-scene.png");
    assert.equal(created.data.referenceAudit.strict, true);
    assert.equal(created.data.referenceAudit.productBound, true);
    assert.equal(created.data.referenceAudit.personBound, true);
    assert.equal(created.data.referenceAudit.sceneBound, true);
    assert.equal(created.data.referenceAudit.promptBindingApplied, true);
    assert.equal(created.data.referenceAudit.productPriorityApplied, true);
    assert.equal(created.data.referenceAudit.interactionBindingApplied, true);
    assert.equal(created.data.referenceAudit.sceneAdaptationApplied, true);
    assert.equal(created.data.referenceAudit.singleProductApplied, true);
    assert.equal(created.data.parameterAudit.ok, true);
    assert.equal(created.data.parameterAudit.referenceCount, 3);
    assert.equal(created.data.parameterAudit.referenceContract, "v2-product-grounded-interaction-scene");
    assert.deepEqual(created.data.parameterAudit.referenceOrder.map((item) => item.role), ["product", "person", "scene"]);

    const queried = await jsonRequest(baseUrl, "/api/seedance/task", { taskId: "task-live-1", config });
    assert.equal(queried.data.task.status, "completed");
    assert.equal(queried.data.task.videoUrl, `${providerBaseUrl}/result.mp4`);

    const downloaded = await fetch(`${baseUrl}/api/seedance/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "task-live-1", config }),
    });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get("content-disposition"), /seedance-task-live-1\.mp4/);
    assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString(), "mock-video-bytes");

    const checked = await jsonRequest(baseUrl, "/api/provider/check", { type: "video", config });
    assert.equal(checked.response.status, 200);
    assert.equal(checked.data.ok, true);
    assert.equal(checked.data.authenticated, true);
  });

  await t.test("video adapter sends named targets as actual ordered references and rejects unbound mentions before provider calls", async () => {
    const config = { video: { enabled: true, apiKey: "test-key", baseUrl: providerBaseUrl, model: "doubao-seedance-2.0" } };
    const input = {
      prompt: "@{人物}展示@{商品}，镜头移向@{蓝色杯子}。",
      generation_type: "reference-to-video",
      reference_policy: "product-interaction-scene-strict-v2",
      product_image_url: "asset://product-original",
      person_image_url: "asset://person-original",
      scene_image_urls: ["asset://scene-original"],
      additional_references: [{ id: "cup", name: "蓝色杯子", role: "object", target: "桌上蓝色杯子的外观", url: "asset://cup-original" }],
      duration: 15,
    };
    const created = await jsonRequest(baseUrl, "/api/seedance/create", { config, input });
    assert.equal(created.response.status, 200);
    assert.deepEqual(receivedCreatePayload.content.slice(1).map((item) => item.image_url.url), ["asset://product-original", "asset://person-original", "asset://scene-original", "asset://cup-original"]);
    assert.equal(receivedCreatePayload.content.slice(1).every((item) => item.role === "reference_image"), true);
    assert.match(receivedCreatePayload.content[0].text, /图片4中的桌上蓝色杯子的外观/);
    assert.doesNotMatch(receivedCreatePayload.content[0].text, /@/);
    assert.equal(created.data.parameterAudit.mentions.at(-1).position, 4);
    assert.equal(created.data.parameterAudit.referenceOrder.at(-1).name, "蓝色杯子");
    const previousPayload = receivedCreatePayload;
    const invalid = await jsonRequest(baseUrl, "/api/seedance/create", { config, input: { ...input, prompt: "@{不存在的演员}" } });
    assert.equal(invalid.response.status, 400);
    assert.match(invalid.data.error, /没有对应参考图片/);
    assert.equal(receivedCreatePayload, previousPayload);
  });

  await t.test("image edit sends product, named person and object files in compiled mention order", async () => {
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    const result = await jsonRequest(baseUrl, "/api/generate/image", {
      purpose: "creator", referenceImageDataUrl: image,
      prompt: "@{演员}拿着@{商品}，桌旁放着@{杯子}。",
      additional_references: [
        { id: "actor", name: "演员", role: "person", url: image, target: "戴眼镜的同一人物" },
        { id: "cup", name: "杯子", role: "object", url: image, target: "蓝色陶瓷杯" },
      ],
      config: { image: { enabled: true, apiKey: "test-key", baseUrl: providerBaseUrl, model: "gpt-image-2" } },
    });
    assert.equal(result.response.status, 200);
    const request = receivedImageEditRequests.at(-1);
    assert.equal((request.body.match(/name="image\[\]"/g) || []).length, 3);
    assert.match(request.body, /图片2中的戴眼镜的同一人物/);
    assert.match(request.body, /图片3中的蓝色陶瓷杯/);
    assert.doesNotMatch(request.body, /@\{/);
    assert.deepEqual(result.data.referenceBindings.map((item) => item.name), ["商品", "演员", "杯子"]);
  });

  await t.test("image to video uses first and last frame roles instead of reference image roles", async () => {
    const result = await jsonRequest(baseUrl, "/api/seedance/create", {
      config: { video: { enabled: true, apiKey: "test-key", baseUrl: providerBaseUrl } },
      input: { prompt: "从@图片1过渡到@图片2", generation_type: "image-to-video", image_urls: ["asset://first", "asset://last"] },
    });
    assert.equal(result.response.status, 200);
    assert.deepEqual(receivedCreatePayload.content.slice(1).map((item) => item.role), ["first_frame", "last_frame"]);
  });
});
