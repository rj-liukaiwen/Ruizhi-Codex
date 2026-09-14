# 资料来源

## 火山引擎官方 API 文档

- **视频生成教程**：https://www.volcengine.com/docs/82379/1366799
  - 原生端点：`POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`
  - 关键参数：`ratio`（字符串，例如 `"16:9"`）、`duration`（整数秒）、`resolution`（字符串，例如 `"720p"`）、`watermark`（布尔值）
  - 支持的画幅比例：`16:9`、`9:16`、`1:1`、`4:3`、`3:4`、`21:9`、`adaptive`
  - Seedance 2.0 时长范围：4-15 秒
  - 状态轮询：`GET /api/v3/contents/generations/tasks/{id}`

- **Seedance 2.0 系列教程**：https://www.volcengine.com/docs/82379/2291680

## UniAPI 文档

- **创建视频生成任务**：https://docs.newapi.pro/zh/docs/api/ai-model/videos/createvideogeneration
  - UniAPI 端点：`POST /v1/video/generations`
  - 注意：`width` / `height` 整数参数不能可靠映射到火山引擎的 `ratio`。应使用 `metadata.ratio` 作为规避方案。
