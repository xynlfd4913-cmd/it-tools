# Seedance UGC Studio

本地可视化 UGC 电商短视频工作台：上传产品图，生成 UGC 导演方案，并对接 Seedance-2.0 异步视频生成任务。

当前链路已覆盖：产品分析 → 智能定向 → UGC 导演方案 → 定向/脚本提示词编译 → 场景图生成 → 商品原图与场景图按序绑定 → Seedance 提交 → 页面自动轮询 → 视频预览/下载。详细边界见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

第四步采用横向三栏工作台：左侧核对步骤 1–3 的执行链，中间独立生成人物持品图和商品场景图，右侧提交视频并查看进度与成片。视频参考顺序固定为图片1商品、图片2人物持品、图片3场景；更换产品、重新分析或重新生成导演方案时，旧素材和旧视频任务会自动失效，避免资产串项目。

## 指定人物与物体参考

第四步的“人物 / 物体参考目标”支持最多 6 个自定义目标，每个目标填写独立名称、类型、图片和目标描述。例如名称“演员”、目标“左侧戴眼镜的人物”；名称“蓝色杯子”、目标“桌上的蓝色杯子”。可上传本地图片或填写公网图片地址；`asset://` 地址仅用于视频参考，图片编辑需要图片文件或公网 URL。

在图片、视频提示词或大窗口编辑器中输入 `@`，从菜单选择目标，也可以使用“插入引用”。推荐标记为 `@{商品}`、`@{人物}`、`@{场景}`、`@{演员}`、`@{蓝色杯子}`，同时兼容已有的 `@人物`、`@图片1` 写法。未绑定、缺少图片、重复名称或超出数量上限的目标会在提交前提示。

`@` 是工作台提供的引用方式。后端会将名称转换成模型实际收到的“图片N中的指定目标”，并按相同顺序发送真实图片。视频中的自定义图片从图片4开始；图片编辑中的自定义图片从图片2开始。名称标记会随当前参考顺序重新解析，添加或移除目标后不会沿用旧图片编号。视频区域的“引用对应与提交提示词”可核对名称、图片编号和展开后的正文；最终提交审计还会显示完整约束提示词。

参考目标可约束同一张图中的指定人物或物体，商品外观仍以商品原图为准。模型的生成结果仍需人工核对；引用绑定成功不代表模型能保证像素级外观或人物一致性。

## 本地启动

```bash
npm ci
npm start
```

默认地址：

```text
http://127.0.0.1:4173
```

如需换端口：

```bash
PORT=5173 npm start
```

## 本地密钥

可以复制 `.env.example` 为 `.env`，把自己的 Yuncenai API Key 填进去：

```text
YUNCENAI_API_KEY=your-yuncenai-api-key
YUNCENAI_IMAGE_API_KEY=your-yuncenai-image-api-key
YUNCENAI_VIDEO_API_KEY=your-yuncenai-video-api-key
```

图片和视频独立密钥优先；如果不设置，会回退使用 `YUNCENAI_API_KEY`。也可以不写 `.env`，直接在网页右上角齿轮里填写 API Key。`.env` 中的 `HOST` 和 `PORT` 同样有效。

模型设置窗口和视频生成区均可先执行“接口检查”。真实视频任务提交后，页面会自动轮询状态；进度面板显示供应商进度或明确标注的预估进度、已用时间、最近同步、下次刷新和任务阶段，无需进入供应商后台查看进度。刷新页面后，未完成任务会自动恢复同步。

## gpt-image-2 对接

打开页面右上角齿轮，进入“图片生成”：

- API Base URL：默认 `https://yuncenai.com`
- 模型名称：默认 `gpt-image-2`
- 生成 Endpoint：默认 `/v1/images/generations`，仅保留作兼容配置
- 参考图编辑 Endpoint：默认 `/v1/images/edits`
- API Key：填写你的 Bearer Token，或使用本地 `.env`

生成达人 / 场景图时，工作台会强制读取第一步上传的商品原图，并调用参考图编辑接口：

```text
POST /v1/images/edits
```

请求使用 `multipart/form-data`，核心字段如下：

```text
model=gpt-image-2
prompt=包含商品一致性锁定的场景提示词
n=1
image[]=第一步上传的商品原图
```

本地后端会在用户提示词前加入商品一致性约束，要求保留轮廓、比例、颜色、材质、包装、标签、品牌文字、Logo 与装饰细节，禁止改款或生成相似替代品。缺少商品原图时前端会阻止生成。成功后读取 `data[0].url` 或 base64 结果并直接在页面展示，同时标记“商品原图已作为高保真参考应用”。供应商若使用单数文件字段，后端会在参数错误时从 `image[]` 自动回退为 `image`。

## Seedance-2.0 对接

打开页面右上角齿轮，进入“视频生成”：

- 启用真实视频 API
- API Base URL：默认 `https://yuncenai.com`
- 模型名称：默认 `doubao-seedance-2.0`
- Endpoint：默认 `/api/v3/contents/generations/tasks`
- 查询 Endpoint：默认 `/api/v3/contents/generations/tasks`
- API Key：填写你的 Bearer Token

提交视频后，本地后端会调用：

```text
POST /api/v3/contents/generations/tasks
```

查询任务会调用：

```text
GET /api/v3/contents/generations/tasks/:taskId?beta=true
```

请求体按文档使用：

```json
{
  "model": "doubao-seedance-2.0",
  "content": [
    { "type": "text", "text": "图片1商品外观最高优先，图片2锁定人物持握关系，图片3锁定场景与商品摆位……" },
    {
      "type": "image_url",
      "image_url": { "url": "图片1：商品原图" },
      "role": "reference_image"
    },
    {
      "type": "image_url",
      "image_url": { "url": "图片2：人物持品图" },
      "role": "reference_image"
    },
    {
      "type": "image_url",
      "image_url": { "url": "图片3：商品场景图" },
      "role": "reference_image"
    }
  ],
  "generate_audio": true,
  "ratio": "9:16",
  "duration": 5,
  "watermark": false
}
```

## 素材 URL

Seedance-2.0 API 需要上游可访问的公网 URL 或 `asset://` 素材地址。工作台不会再把本地参考图作为 `data:image;base64` 直接提交给视频接口；本地商品图、人物持品图和商品场景图会自动经过 `/v1/materials/uploads` 与 `/v1/materials` 创建素材记录，再以 `asset://<asset_id>` 进入视频任务。公网图片 URL 和已有 `asset://` 地址保持原样。

素材创建后，工作台会自动轮询素材状态，最长等待 120 秒；如果素材仍在处理中，错误信息会保留对应素材编号，再次提交会继续查询同一素材，不会重复上传。

推荐做法：

- 商品原图由第一步自动进入参考链，无需再次填写 URL。
- 本地参考图由工作台自动上传素材库并转换为 `asset://<asset_id>`，无需手工进入供应商后台。
- 人物持品图和商品场景图分别生成，但两次都通过 `/v1/images/edits` 上传图片1商品原图，禁止退化为纯文字生图。
- 图片2负责人物身份、服装、手势和持握关系；图片3负责环境、光线、机位、商品摆位和尺度。两张派生图里的商品细节与图片1冲突时，以图片1为准。
- 场景提示词会同时包含第二步市场/平台/形式和第三步逐镜头分镜，禁止生成与商品类别和脚本无关的泛化风景。
- 严格参考模式固定只提交三张图片：图片1商品原图、图片2人物持品图、图片3商品场景图。
- 自定义人物图和场景图都只读取第一行，避免多余素材稀释一致性。
- 后端会重新锁定素材顺序、编译最终提示词，并在提交前执行参数审计。
- 提示词引用使用“图片1中的商品”“图片2中的人物”“图片3中的场景”，不使用 `@`，也不把 `asset_id` 写进提示词。

## 生成模式

- `reference-to-video`：默认严格三参考模式，必须同时提供商品原图、人物持品图和商品场景图。
- `image-to-video`：适合首帧或首尾帧图生视频。
- `text-to-video`：只用提示词生成视频。

## 演示模式

如果没有启用真实视频 API，页面仍可完整跑通 UGC 方案、提示词和任务提交/轮询 UI；此时不会消耗真实额度，也不会生成真实视频。

真实任务完成后，页面会显示成片播放器、原始地址和“下载成片”按钮。下载由本地网关重新确认任务结果后转发，避免跨域链接只能打开不能保存的问题。

## 检查与测试

```bash
npm run check
npm test
```

测试使用本地模拟供应商，覆盖健康检查、参数拦截、定向/语言/时长锁定、商品图与场景图顺序、演示任务、真实适配器提交、任务轮询和视频 URL 规范化，不消耗模型额度。

## Docker

```bash
docker build -t seedance-ugc-studio .
docker run --rm -p 4173:4173 --env-file .env seedance-ugc-studio
```

容器包含 `sharp` 图片压缩依赖、可写的本地素材目录和健康检查。
