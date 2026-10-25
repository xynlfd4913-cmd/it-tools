# Personal Tools

当前版本 v0.2：新增合作接单中心，组织推广伙伴带客户、制作伙伴交付，跟踪订单、回款、成本、直接推荐佣金与退款追回。工作室在本机集中管理，通过推广包、任务单和对账表与伙伴协作。

Windows 用户完成下方 `npm ci` 首次安装后，可双击 `启动工作台.cmd`，再点击“合作接单”。完整使用说明见 [合作经营说明](./seedance-ugc-studio/COOPERATE.md)。

## Seedance UGC Studio

[Seedance UGC Studio](./seedance-ugc-studio) 是本地运行的 UGC 电商短视频工作台，覆盖商品分析、智能定向、导演方案、参考图编辑、Seedance 视频生成与成片下载。

支持在提示词中使用 `@{人物}`、`@{商品}`、`@{场景}` 和自定义物体名称，将目标绑定到实际上传的参考图片。

```bash
cd seedance-ugc-studio
npm ci
npm start
```

打开 http://127.0.0.1:4173/，在设置中填写自己的模型接口和密钥。项目仅附带演示素材，不包含 API 密钥和私人生成记录。

