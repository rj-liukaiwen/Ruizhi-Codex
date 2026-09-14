# 锐捷 Codex 模型能力与推理强度兼容说明

> 本文说明：当后端模型接口只返回基础模型信息时，锐捷 Codex 如何在客户端补齐模型能力、推理强度和多协议兼容字段。

## 1. 问题背景

后端接口当前返回的数据类似：

```json
{
  "data": [
    {
      "id": "gpt-5.6-luna 经济模型",
      "object": "model",
      "created": 1626777600,
      "owned_by": "azure",
      "supported_endpoint_types": ["openai"],
      "default_reasoning_level": "",
      "supported_reasoning_levels": null
    }
  ]
}
```

这类响应只描述了模型的基础身份，没有完整声明：

- 是否支持图片输入；
- 支持哪些推理强度；
- 默认推理强度是什么；
- 前端应使用哪种字段命名；
- 模型应该走 Responses API 还是 Chat Completions API。

因此，后端返回的模型列表不能直接作为 Codex Desktop 的完整模型能力描述使用。锐捷 Codex 在客户端增加了一层模型能力兼容层，对原始数据进行补齐、归一化和协议适配。

---

## 2. 总体兼容架构

```text
后端基础模型列表
        |
        v
内置锐捷模型目录
resources/ruizhi-model-catalog.json
        |
        v
启动时同步到用户缓存
.ruizhi/models_cache.json
        |
        v
模型目录兼容补丁
补齐图片能力、推理等级、默认值
        |
        +-----------------------------+
        |                             |
        v                             v
本地增强服务                  前端实时列表归一化
ruizhi-enhance-service.cjs     list-models-for-host
        |                             |
        +-------------+---------------+
                      |
                      v
             Codex Desktop 模型结构
                      |
                      v
               请求协议转换与转发
       Responses API / Chat Completions API
```

当前实现主要由以下模块共同完成：

| 模块 | 作用 |
|---|---|
| `resources/ruizhi-model-catalog.json` | 保存锐捷维护的模型能力目录和默认元数据 |
| `scripts/windows-asar-overrides.mjs` | 构建期、启动期和前端 bundle 兼容补丁 |
| `scripts/build-macos.mjs` | macOS 构建过程中的模型目录同步与兼容处理 |
| `resources/bridge/ruizhi-enhance-service.cjs` | 读取用户模型缓存并转换为 Codex 前端结构 |
| `resources/bridge/ruizhi-responses-bridge.cjs` | Responses 与 Chat Completions 协议转换 |
| `tests/ruizhi-model-catalog-version.test.mjs` | 验证模型目录和能力兼容行为 |

---

## 3. 第一层：内置模型目录

项目使用内置模型目录作为比后端基础接口更完整的能力描述来源：

```text
D:\rj_codex_build\rj-codex-bak\resources\ruizhi-model-catalog.json
```

一个完整的模型目录条目可以包含：

```json
{
  "slug": "gpt-5.6-luna",
  "display_name": "GPT-5.6 Luna",
  "description": "支持文本和图片输入",
  "default_reasoning_level": "medium",
  "supported_reasoning_levels": [
    {
      "effort": "minimal",
      "description": "最少推理"
    },
    {
      "effort": "low",
      "description": "轻量推理"
    },
    {
      "effort": "medium",
      "description": "标准推理"
    },
    {
      "effort": "high",
      "description": "深度推理"
    },
    {
      "effort": "xhigh",
      "description": "最高推理"
    }
  ],
  "input_modalities": [
    "text",
    "image"
  ],
  "visibility": "list",
  "supported_in_api": true
}
```

启动时，模型目录会被同步到用户运行目录：

```text
C:\Users\liyanqi\.ruizhi\models_cache.json
```

Codex 前端和锐捷本地增强服务优先读取这份缓存，而不是完全依赖后端实时返回的简化字段。

---

## 4. 第二层：模型目录兼容补丁

核心兼容函数位于：

```text
D:\rj_codex_build\rj-codex-bak\scripts\windows-asar-overrides.mjs
```

以及：

```text
D:\rj_codex_build\rj-codex-bak\resources\bridge\ruizhi-enhance-service.cjs
```

主要处理函数为：

```text
applyRuizhiModelCatalogCompatibilityPatches
```

### 4.1 补齐图片输入能力

当前实现会为模型写入：

```js
model.input_modalities = ["text", "image"];
model.inputModalities = model.input_modalities;
```

最终前端可获得：

```json
{
  "input_modalities": ["text", "image"],
  "inputModalities": ["text", "image"]
}
```

保留两种字段命名，是为了兼容不同版本的 Codex Desktop：

- `input_modalities`：snake_case，部分模型协议和缓存结构使用；
- `inputModalities`：camelCase，部分桌面端 UI 逻辑使用。

相关实现位置：

- `resources/bridge/ruizhi-enhance-service.cjs:397`
- `scripts/windows-asar-overrides.mjs:2297`
- `scripts/windows-asar-overrides.mjs:3876`
- `scripts/windows-asar-overrides.mjs:4416`

### 4.2 补齐默认推理强度

当后端返回：

```json
{
  "supported_reasoning_levels": null
}
```

或返回空数组时，客户端生成默认推理级别：

```js
[
  { effort: "minimal", description: "最少推理" },
  { effort: "low", description: "轻量推理" },
  { effort: "medium", description: "标准推理" },
  { effort: "high", description: "深度推理" },
  { effort: "xhigh", description: "最高推理" }
]
```

如果默认值缺失，则设置：

```js
model.default_reasoning_level = "medium";
model.defaultReasoningEffort = "medium";
```

同时补齐字符串形式的 effort 列表：

```js
model.supported_reasoning_efforts = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
```

以及桌面端使用的对象形式：

```js
model.supportedReasoningEfforts = [
  {
    reasoningEffort: "minimal",
    description: "最少推理"
  },
  {
    reasoningEffort: "low",
    description: "轻量推理"
  },
  {
    reasoningEffort: "medium",
    description: "标准推理"
  },
  {
    reasoningEffort: "high",
    description: "深度推理"
  },
  {
    reasoningEffort: "xhigh",
    description: "最高推理"
  }
];
```

相关实现位置：

- `resources/bridge/ruizhi-enhance-service.cjs:449`
- `scripts/windows-asar-overrides.mjs:2290`
- `scripts/windows-asar-overrides.mjs:2072`

---

## 5. 第三层：本地增强服务归一化

模型列表通过本地增强服务返回：

```text
D:\rj_codex_build\rj-codex-bak\resources\bridge\ruizhi-enhance-service.cjs
```

入口函数：

```js
listModelsFromUserCache()
```

处理流程如下：

```text
读取 .ruizhi/models_cache.json
        |
        v
应用模型目录兼容补丁
        |
        v
识别默认模型
        |
        v
转换为 Codex Desktop 模型结构
        |
        v
返回给前端
```

转换函数：

```js
modelFromCatalogEntry()
```

对应位置：

```text
resources/bridge/ruizhi-enhance-service.cjs:383
```

它会将一个基础模型对象扩展为类似下面的结构：

```json
{
  "model": "gpt-5.6-luna",
  "slug": "gpt-5.6-luna",
  "displayName": "GPT-5.6 Luna",
  "display_name": "GPT-5.6 Luna",
  "input_modalities": ["text", "image"],
  "inputModalities": ["text", "image"],
  "supported_reasoning_efforts": [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "supportedReasoningEfforts": [
    {
      "reasoningEffort": "minimal",
      "description": "最少推理"
    }
  ],
  "default_reasoning_level": "medium",
  "defaultReasoningEffort": "medium"
}
```

### 5.1 推理强度字段兼容顺序

本地增强服务支持多种输入格式，优先级如下：

```text
supportedReasoningEfforts
        ↓
supported_reasoning_efforts
        ↓
supported_reasoning_levels
        ↓
默认 minimal/low/medium/high/xhigh
```

也就是说，后端未来即使返回以下任意一种格式，客户端都可以进行归一化：

#### 格式 A：桌面端对象格式

```json
{
  "supportedReasoningEfforts": [
    {
      "reasoningEffort": "high",
      "description": "深度推理"
    }
  ]
}
```

#### 格式 B：字符串数组格式

```json
{
  "supported_reasoning_efforts": [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ]
}
```

#### 格式 C：后端 Codex 格式

```json
{
  "supported_reasoning_levels": [
    {
      "effort": "medium",
      "description": "标准推理"
    }
  ]
}
```

#### 格式 D：后端未提供

```json
{
  "supported_reasoning_levels": null
}
```

此时使用客户端默认列表。

---

## 6. 第四层：前端实时列表归一化

除了读取用户模型缓存，前端还会调用：

```text
list-models-for-host
```

项目对这一实时接口也进行了 bundle 级兼容处理，位置：

```text
D:\rj_codex_build\rj-codex-bak\scripts\windows-asar-overrides.mjs:1274
```

实时接口返回空能力字段时，前端会执行类似逻辑：

```js
for (const model of models) {
  model.input_modalities = ["text", "image"];
  model.inputModalities = model.input_modalities;

  const levels = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
    : [];

  const efforts = levels.length > 0
    ? levels.map((entry) => entry.effort)
    : ["minimal", "low", "medium", "high", "xhigh"];

  model.supported_reasoning_efforts = efforts;
  model.supportedReasoningEfforts = efforts.map((effort) => ({
    reasoningEffort: effort,
    description: effort
  }));

  model.default_reasoning_level =
    model.default_reasoning_level || "medium";

  model.defaultReasoningEffort =
    model.default_reasoning_level;
}
```

这样做的目的是避免以下情况：

```text
本地缓存有完整能力字段
实时接口却返回空字段
        ↓
前端刷新后能力下拉框消失
```

通过前端实时归一化，缓存路径和实时接口路径最终返回相同结构。

---

## 7. 推理强度如何真正参与请求

推理强度不是只用于前端展示，完整请求链路如下：

```text
用户选择 medium
        |
        v
Codex 前端生成 reasoning.effort = "medium"
        |
        +-----------------------------+
        |                             |
        v                             v
Responses 路由                  Chat 路由
/v1/responses                   /v1/chat/completions
        |                             |
        |                             v
        |                    reasoning_effort = "medium"
        |                             |
        +-------------+---------------+
                      |
                      v
                 上游模型服务
```

对于 Chat Completions 路由，桥接代码位于：

```text
D:\rj_codex_build\rj-codex-bak\resources\bridge\ruizhi-responses-bridge.cjs:541
```

核心逻辑：

```js
if (
  route.reasoningEffort === true &&
  body.reasoning &&
  typeof body.reasoning.effort === "string"
) {
  chat.reasoning_effort = body.reasoning.effort;
}
```

因此：

- Responses 模型通常沿用 Codex 原生 `reasoning.effort` 参数；
- Chat Completions 模型由 bridge 转换为 `reasoning_effort`；
- 只有路由配置中声明 `reasoningEffort: true` 的模型才会进行该转换。

路由配置位于：

```text
D:\rj_codex_build\rj-codex-bak\config\rj-codex.json
```

典型配置：

```json
{
  "protocol": "chat",
  "reasoningEffort": true
}
```

---

## 8. 这套方案解决的兼容问题

### 8.1 字段命名兼容

同时支持：

```text
supported_reasoning_levels
supported_reasoning_efforts
supportedReasoningEfforts
default_reasoning_level
defaultReasoningEffort
input_modalities
inputModalities
```

### 8.2 数据缺失兼容

后端缺少以下字段时，客户端仍可运行：

```text
supported_reasoning_levels = null
input_modalities 缺失
default_reasoning_level 缺失
```

### 8.3 协议兼容

统一承接：

```text
Responses API
Chat Completions API
```

### 8.4 版本兼容

不同版本的 Codex Desktop 可能读取不同命名的字段，因此项目同时写入 snake_case 和 camelCase 字段，降低前端 bundle 版本变化带来的风险。

---

## 9. 重要边界：元数据补齐不等于真实能力验证

当前实现中，图片能力是统一声明的：

```json
{
  "input_modalities": ["text", "image"]
}
```

这代表客户端允许前端展示图片输入能力，但不一定代表每个模型的后端都真的支持图片。

可能出现：

```text
前端允许上传图片
        ↓
后端模型实际不支持图片
        ↓
请求失败或被上游拒绝
```

推理强度也存在同样边界：

```text
前端展示 high
        ↓
bridge 转换为 reasoning_effort = "high"
        ↓
上游模型是否接受 high，由实际模型服务决定
```

因此，应当把以下概念区分开：

| 概念 | 含义 |
|---|---|
| 前端能力元数据 | UI 是否展示图片、推理等级等选项 |
| 协议参数转换 | 请求如何从 Responses 转成 Chat Completions |
| 后端真实能力 | 上游模型是否真正接受并执行该参数 |
| 运行时验证 | 通过真实请求或探测确认模型能力 |

---

## 10. 更严谨的改进方案

当前兼容方式适合快速统一 Codex Desktop 的模型展示和请求结构，但生产环境建议改为按模型维护能力矩阵：

```json
{
  "gpt-5.6-luna": {
    "input_modalities": ["text", "image"],
    "reasoning_levels": [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh"
    ],
    "protocol": "responses"
  },
  "ray": {
    "input_modalities": ["text"],
    "reasoning_levels": ["low", "medium", "high"],
    "protocol": "chat"
  }
}
```

建议将当前的全量写入：

```js
model.input_modalities = ["text", "image"];
```

逐步调整为：

```js
if (!Array.isArray(model.input_modalities)) {
  model.input_modalities = capabilityMap[model.slug]?.input_modalities || ["text"];
}
```

推理强度也建议按模型限制：

```js
const supported = capabilityMap[model.slug]?.reasoning_levels;

if (!Array.isArray(model.supported_reasoning_levels)) {
  model.supported_reasoning_levels = supported || defaultReasoningLevels();
}
```

同时建议增加以下能力：

1. 启动时模型能力探测；
2. 按模型记录图片输入探测结果；
3. 按模型记录 reasoning effort 支持结果；
4. 上游返回参数不支持时自动降级；
5. 将模型能力矩阵纳入版本化配置；
6. 在模型 picker 中展示“已声明”与“已实测”状态。

---

## 11. 测试覆盖

相关测试文件：

```text
D:\rj_codex_build\rj-codex-bak\tests\ruizhi-model-catalog-version.test.mjs
```

当前测试覆盖以下场景：

### 11.1 图片能力补齐

后端没有 `input_modalities` 时：

```js
assert.deepEqual(model.input_modalities, ["text", "image"]);
assert.deepEqual(model.inputModalities, ["text", "image"]);
```

已有 `text` 时，也会补充 `image`。

### 11.2 非聊天模型过滤

模型目录会过滤：

```text
gpt-image-2
text-embedding-3-large
bge-reranker-v2
gpt-realtime
```

避免把图片生成、Embedding、Rerank 和 Realtime 模型错误展示到聊天模型 picker。

### 11.3 推理强度补齐

当后端返回空推理列表时，测试确认客户端补齐：

```text
minimal
low
medium
high
xhigh
```

并设置：

```text
default_reasoning_level = medium
defaultReasoningEffort = medium
```

### 11.4 多格式归一化

测试还验证了：

- `supported_reasoning_levels` 能转换为 `supportedReasoningEfforts`；
- `supported_reasoning_efforts` 能转换为对象数组；
- 已有完整推理列表时不会被默认列表覆盖；
- 缓存和实时模型列表都能经过兼容处理。

---

## 12. 总结

锐捷 Codex 并不是直接修改后端 `/models` 接口，而是在客户端增加了模型能力适配层。

完整链路是：

```text
后端返回基础模型身份
        ↓
锐捷维护的模型目录补充能力
        ↓
启动时同步到 .ruizhi/models_cache.json
        ↓
兼容层补齐字段和默认值
        ↓
本地增强服务返回统一模型结构
        ↓
前端实时列表再次归一化
        ↓
bridge 根据路由转换推理参数
```

因此，后端只返回：

```json
{
  "id": "gpt-5.6-luna 经济模型",
  "supported_reasoning_levels": null
}
```

客户端最终可以补齐为：

```json
{
  "id": "gpt-5.6-luna 经济模型",
  "input_modalities": ["text", "image"],
  "inputModalities": ["text", "image"],
  "supported_reasoning_levels": [
    { "effort": "minimal", "description": "最少推理" },
    { "effort": "low", "description": "轻量推理" },
    { "effort": "medium", "description": "标准推理" },
    { "effort": "high", "description": "深度推理" },
    { "effort": "xhigh", "description": "最高推理" }
  ],
  "supported_reasoning_efforts": [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh"
  ],
  "default_reasoning_level": "medium"
}
```

核心结论是：

> 后端返回基础模型身份，客户端维护面向 Codex Desktop 的能力元数据、字段兼容和协议转换。

但需要注意：

> 前端展示的模型能力属于客户端声明，最终是否真正支持图片输入和具体推理强度，仍应通过模型能力矩阵或真实请求验证。