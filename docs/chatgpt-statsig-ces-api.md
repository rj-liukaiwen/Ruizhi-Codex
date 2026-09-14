# ChatGPT Statsig 与 CES 接口说明

本文记录 Codex Desktop / 锐捷桌面端启动时出现的两个 OpenAI 官方前端网络接口：

- `https://ab.chatgpt.com/v1/initialize`：Statsig feature gate / experiment 初始化。
- `https://chatgpt.com/ces/v1/rgstr`：CES structured analytics 初始化与事件上报。

结论基于本机打包产物 `/Applications/Codex.app/Contents/Resources/app.asar` 的前端 bundle 观察，以及 Statsig JavaScript SDK 的通用请求约定。它不是 OpenAI 对外稳定 API 文档；字段、query 参数、响应结构都可能随官方前端版本变化。

## 1. `ab.chatgpt.com/v1/initialize`

### 用途

该接口由前端 Statsig SDK 调用，用来初始化实验和功能开关上下文。Codex 前端依赖它读取：

- feature gate：布尔开关，例如某个 UI 入口、原生 webview 能力是否开启。
- dynamic config：动态配置，例如默认启用的功能名集合。
- experiment / layer：实验分流与参数值。
- SDK metadata：Statsig session、stable ID、SDK 类型、SDK 版本等运行元信息。

如果该接口超时或失败，常见影响是：

- 控制台出现 `[Statsig] A networking error occurred`。
- 部分官方实验或 gate 维持默认值。
- 锐捷构建脚本中已经 patch 的少数 gate 仍可由本地补丁强制打开，但未 patch 的远端开关不会更新。

锐捷当前构建策略：构建期将 Statsig `networkConfig` 中的 `networkOverrideFunc` 替换为 `preventAllNetworkTraffic:!0`，阻止 SDK 发起 `https://ab.chatgpt.com/v1/initialize` 和 `sdk_exception` 等 Statsig 网络请求。实验和功能开关不再远程拉取，只使用 SDK 默认值与本项目本地 gate 补丁。

### 端点

```http
POST https://ab.chatgpt.com/v1/initialize?k=<statsig-client-key>&st=javascript-client-react&sv=<sdk-version>&t=<timestamp-ms>&sid=<session-id>&se=<sequence>
```

本机观察到的示例：

```text
https://ab.chatgpt.com/v1/initialize?k=client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR&st=javascript-client-react&sv=3.32.6&t=1781075825197&sid=68fc234f-67ea-4bd4-9645-c3e81b39cbd4&se=1
```

### Query 参数

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| `k` | `client-sYWqz...` | Statsig client SDK key。Codex bundle 中默认值为 `client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR`。 |
| `st` | `javascript-client-react` | Statsig SDK 类型。 |
| `sv` | `3.32.6` | Statsig SDK 版本。 |
| `t` | `1781075825197` | 毫秒时间戳或请求时间标记。 |
| `sid` | UUID | Statsig session ID；Codex 会尝试用 Electron app session ID 覆盖 SDK 初始 session ID。 |
| `se` | `1` | SDK 事件/请求序号。 |
| `gz` | `1` | 可选。请求体压缩时出现，表示 gzip/压缩传输。 |

### 请求头

实际请求由 Statsig SDK 构造，再经 Codex 的 `networkOverrideFunc` 交给 Electron 主进程网络层发送。本机 bundle 中可确认会合并常规 JSON 头，并在二进制体透传时加 `x-codex-base64: 1`。

常见头部如下：

```http
Content-Type: application/json
STATSIG-API-KEY: <statsig-client-key>
STATSIG-SDK-TYPE: javascript-client-react
STATSIG-SDK-VERSION: 3.32.6
```

注意：Statsig SDK 的部分元信息也会放入 query 参数和 body 的 `statsigMetadata` 中，不同 SDK 版本会有差异。

### 请求体

请求体是 JSON。字段分为两类：

- Codex 前端明确构造的 `user` 字段。
- Statsig SDK 自动附加的 `statsigMetadata`、缓存/哈希/诊断字段。

#### `user` 字段

ChatGPT 登录态和 APIKey 模式会构造不同用户上下文。

APIKey / logged out 模式常见结构：

```json
{
  "user": {
    "userID": "ua-<stable-id>",
    "email": null,
    "locale": "zh-CN",
    "customIDs": {
      "stableID": "<stable-id>",
      "account_id": null,
      "workspace_id": "<workspace-id>"
    },
    "appVersion": "26.513.40821",
    "custom": {
      "auth_status": "logged_out",
      "auth_method": "apikey",
      "account_id": null,
      "plan_type": null,
      "compute_residency": null,
      "workspace_id": "<workspace-id>",
      "is_openai_internal": false,
      "systemName": "macOS",
      "systemVersion": "<os-version>",
      "codex_window_type": "electron",
      "codex_build_flavor": "prod",
      "codex_app_session_id": "<app-session-id>"
    }
  }
}
```

ChatGPT 登录态常见结构：

```json
{
  "user": {
    "userID": "<chatgpt-user-id-or-account-user-id>",
    "email": "<email>",
    "locale": "zh-CN",
    "customIDs": {
      "stableID": "<stable-id>",
      "account_id": "<account-id>",
      "workspace_id": "<workspace-id>"
    },
    "appVersion": "26.513.40821",
    "custom": {
      "auth_status": "logged_in",
      "auth_method": "chatgpt",
      "account_id": "<account-id>",
      "plan_type": "<plan>",
      "compute_residency": "<region-or-null>",
      "workspace_id": "<workspace-id>",
      "is_openai_internal": false,
      "systemName": "macOS",
      "systemVersion": "<os-version>",
      "codex_window_type": "electron",
      "codex_build_flavor": "prod",
      "codex_app_session_id": "<app-session-id>"
    }
  }
}
```

#### `statsigMetadata` 字段

Statsig SDK 会自动附加类似下面的元信息：

```json
{
  "statsigMetadata": {
    "sdkType": "javascript-client-react",
    "sdkVersion": "3.32.6",
    "stableID": "<stable-id>",
    "sessionID": "<session-id>",
    "appIdentifier": "codex-electron",
    "appVersion": "26.513.40821",
    "systemName": "macOS",
    "systemVersion": "<os-version>",
    "fallbackUrl": null
  }
}
```

### 响应体

响应体由 Statsig SDK 消费，前端通常不会直接读原始 JSON。通用结构会包含 gates、configs、experiments、layers 等集合。示意结构如下：

```json
{
  "feature_gates": {
    "<gate-name-or-id>": {
      "name": "<gate>",
      "value": true,
      "rule_id": "<rule-id>",
      "secondary_exposures": []
    }
  },
  "dynamic_configs": {
    "<config-name-or-id>": {
      "name": "<config>",
      "value": {},
      "rule_id": "<rule-id>",
      "secondary_exposures": []
    }
  },
  "layer_configs": {},
  "sdkParams": {},
  "has_updates": true,
  "time": 1781075825197
}
```

Codex 前端观察到的使用方式：

- `client.checkGate(<gate-id>)`：读取 gate 布尔值。
- `client.getDynamicConfig("107580212").value`：读取动态配置。
- `values_updated` 事件：Statsig 值更新后，刷新本地 Owl feature 名称集合。

### 相关异常

日志示例：

```text
WARN  [Statsig] The user does not have the required id_type "userID" for Experiment "3525926994"
WARN  [Statsig] The user does not have the required id_type "userID" for Gate "4218407052"
ERROR [Statsig] A networking error occurred during POST request to https://ab.chatgpt.com/v1/initialize... Error: Timeout of 10000ms expired.
```

含义：

- `required id_type "userID"`：某个实验或 gate 要求 Statsig user 带 `userID`，但当前初始化上下文缺失或不满足要求。
- `Timeout of 10000ms`：请求 10 秒超时，通常是网络不可达、代理不通、域名被阻断或服务端无响应。

## 2. `chatgpt.com/ces/v1/rgstr`

### 用途

该接口是 ChatGPT / Codex 前端的 structured analytics 通道。Codex bundle 中它被配置为 AnalyticsLogger / Segment 兼容客户端的事件上报地址，用于发送产品事件、计数器、flush 等。

常见事件来源包括：

- legacy product event：旧式产品事件，部分仍走 Statsig `logEvent`。
- structured product event：结构化产品事件，走 AnalyticsLogger。
- counter：计数型指标。
- flush：页面关闭或队列刷新。

如果该接口失败，通常影响埋点上报，不应影响模型请求或本地核心功能。

锐捷当前构建策略：构建期将 CES 端点替换为 `ruizhi-disabled://ces/v1`，同时把 AnalyticsLogger 的 enabled 条件改为恒 false，阻止 SDK 初始化和发送 `https://chatgpt.com/ces/v1/rgstr` 批量事件请求。

### 端点

```http
POST https://chatgpt.com/ces/v1/rgstr?k=<statsig-client-key>&st=javascript-client-react&sv=<sdk-version>&t=<timestamp-ms>&sid=<session-id>&ec=<event-count>&gz=1
```

本机观察到的示例：

```text
https://chatgpt.com/ces/v1/rgstr?k=client-sYWqzCYMRkUg4DqqiZcR5DGTNl2iD7zNJY0HoeDLzxR&st=javascript-client-react&sv=3.32.6&t=1781075831538&sid=68fc234f-67ea-4bd4-9645-c3e81b39cbd4&ec=2&gz=1
```

Codex bundle 中还定义了 CES base URL：

```text
https://chatgpt.com/ces/v1
```

并将 Segment 兼容配置指向该 host/path：

```json
{
  "settings": {
    "writeKey": "oai",
    "cdnURL": "https://chatgpt.com/ces/v1"
  },
  "initOptions": {
    "disableClientPersistence": true,
    "integrations": {
      "Segment.io": {
        "apiHost": "chatgpt.com/ces/v1",
        "protocol": "https"
      }
    }
  }
}
```

### Query 参数

| 参数 | 示例 | 含义 |
| --- | --- | --- |
| `k` | `client-sYWqz...` | Statsig client SDK key。CES 请求复用了同一个前端 client key。 |
| `st` | `javascript-client-react` | SDK 类型。 |
| `sv` | `3.32.6` | SDK 版本。 |
| `t` | `1781075831538` | 毫秒时间戳或请求时间标记。 |
| `sid` | UUID | session ID。 |
| `ec` | `2` | event count，本次批量上报的事件数量。 |
| `gz` | `1` | 请求体压缩标记。 |

### 请求头

典型头部：

```http
Content-Type: application/json
STATSIG-API-KEY: <statsig-client-key>
STATSIG-SDK-TYPE: javascript-client-react
STATSIG-SDK-VERSION: 3.32.6
```

实际头部可能由 AnalyticsLogger、Segment 兼容层和 Statsig SDK 网络层共同生成。

### 请求体

请求体是批量事件 JSON。Statsig SDK 通常使用 `events` 数组承载事件，并附带 `statsigMetadata`。

示意结构：

```json
{
  "events": [
    {
      "eventName": "<event-name>",
      "value": null,
      "metadata": {
        "<key>": "<value>"
      },
      "time": 1781075831538,
      "user": {
        "userID": "<user-id-or-ua-stable-id>",
        "customIDs": {
          "stableID": "<stable-id>",
          "account_id": "<account-id>"
        },
        "locale": "zh-CN",
        "appVersion": "26.513.40821",
        "custom": {
          "auth_status": "logged_out",
          "auth_method": "apikey",
          "codex_window_type": "electron"
        }
      }
    }
  ],
  "statsigMetadata": {
    "sdkType": "javascript-client-react",
    "sdkVersion": "3.32.6",
    "stableID": "<stable-id>",
    "sessionID": "<session-id>",
    "appIdentifier": "codex-electron",
    "appVersion": "26.513.40821"
  }
}
```

Structured AnalyticsLogger 的内部事件会包含 message type 和 payload。Codex 前端将结构化事件交给：

```text
analyticsLogger.trackStructuredEvent(messageType, payload)
```

然后由 CES 通道发送。旧式事件会进入：

```text
statsig.logEvent(eventName, metadata)
```

### 响应体

成功响应通常不被业务代码消费；SDK 只关心 HTTP 状态和是否成功 flush。常见形态可能是：

```json
{}
```

或空响应 / `204 No Content`。失败时 SDK 会记录 `Failed to flush AnalyticsLogger`、`Structured product event logging failed` 或 Statsig 网络错误。

## 3. 与模型 API 的区别

这两个接口都不是模型推理接口，也不受 `config/rj-codex.json` 中 `openai.baseUrl` 控制。

| 类型 | 端点 | 配置来源 | 作用 |
| --- | --- | --- | --- |
| 模型/API provider | `https://gptauth.ruijie.com.cn/v1` | `config/rj-codex.json` 的 `openai.baseUrl` | 模型请求、Responses/Chat Completions 代理。 |
| Statsig | `https://ab.chatgpt.com/v1` | 前端 bundle 硬编码 | 实验和 feature gate。 |
| CES analytics | `https://chatgpt.com/ces/v1` | 前端 bundle 硬编码 | 产品事件和结构化埋点。 |

## 4. 本项目中的相关 patch 点

当前锐捷构建脚本已经 patch 了部分 Statsig gate 的读取结果，并禁用了 Statsig 初始化网络请求与 CES 分析上报请求；`ab.chatgpt.com` 和 `chatgpt.com/ces` 仍不是运行时配置项。

- macOS：`scripts/build-macos.mjs` 的 `patchNativeWebviewFeatureGates()`。
- macOS：`scripts/build-macos.mjs` 的 `patchNativeStatsigNetwork()`。
- macOS：`scripts/build-macos.mjs` 的 `patchNativeCesAnalyticsNetwork()`。
- Windows：`scripts/build-windows.mjs` 的 `patchNativeWebviewFeatureGates()`。
- Windows：`scripts/build-windows.mjs` 的 `patchNativeStatsigNetwork()`。
- Windows：`scripts/build-windows.mjs` 的 `patchNativeCesAnalyticsNetwork()`。
- Windows 覆盖层导出：`scripts/windows-asar-overrides.mjs` 的 `patchNativeWebviewFeatureGates()`。
- Windows 覆盖层导出：`scripts/windows-asar-overrides.mjs` 的 `patchNativeStatsigNetwork()`。
- Windows 覆盖层导出：`scripts/windows-asar-overrides.mjs` 的 `patchNativeCesAnalyticsNetwork()`。

如需进一步治理这两个接口，建议选择构建期策略，而不是用户运行时配置：

1. **静默禁用 analytics**：当前已禁用 AnalyticsLogger 初始化，并把 `chatgpt.com/ces/v1/rgstr` 替换为 `ruizhi-disabled://ces/v1/rgstr`。
2. **禁用 Statsig 网络**：当前已给 Statsig SDK 注入 `preventAllNetworkTraffic:!0`，后续新增依赖远端 gate 的功能时需要显式添加本地默认。
3. **内网代理**：将 `ab.chatgpt.com/v1` 和 `chatgpt.com/ces/v1` 替换为内网兼容服务；需要模拟 Statsig/CES 响应格式。
4. **保留请求但降噪**：仅降低超时和错误日志级别，不改变接口行为。

## 5. 排查建议

看到以下日志时，可以按优先级判断：

```text
[Statsig] A networking error occurred during POST request to https://ab.chatgpt.com/v1/initialize ... Timeout of 10000ms expired.
[Statsig] A networking error occurred during POST request to https://chatgpt.com/ces/v1/rgstr ... Timeout of 10000ms expired.
```

处理建议：

- 如果模型调用正常，只是启动日志报错，可以先归类为“官方实验/埋点网络不可达”。
- 如果某个 UI 功能依赖远端 gate，检查该 gate 是否已被本地 patch 或是否需要新增默认值。
- 如果要面向内网发行，优先在构建脚本中显式禁用或替换这些 endpoint，避免每次启动等待 10 秒超时。
- 不要把这两个接口和 `gptauth.ruijie.com.cn/v1` 混为一谈；后者是模型请求链路。
