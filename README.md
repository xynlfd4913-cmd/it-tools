# Personal Tools

## Seedance UGC Studio

[Seedance UGC Studio](./seedance-ugc-studio) 是本地运行的 UGC 电商短视频工作台，覆盖商品分析、智能定向、导演方案、参考图编辑、Seedance 视频生成与成片下载。

支持在提示词中使用 `@{人物}`、`@{商品}`、`@{场景}` 和自定义物体名称，将目标绑定到实际上传的参考图片。

```bash
cd seedance-ugc-studio
npm ci
npm start
```

打开 http://127.0.0.1:4173/，在设置中填写自己的模型接口和密钥。项目仅附带演示素材，不包含 API 密钥和私人生成记录。

