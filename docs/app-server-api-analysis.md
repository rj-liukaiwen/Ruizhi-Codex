# App Server API 调用梳理

本文档基于当前仓库里的打包产物与覆盖层分析：

- 实际调用点：`.work/inspect-current-asar/webview/assets/app-server-manager-signals-Csopz8aM.js`
- 协议类型来源：`dist/锐捷Codex.app/Contents/Resources/codex app-server generate-ts --experimental`
- 锐捷本地模型桥：`resources/bridge/ruizhi-responses-bridge.cjs`
- 锐捷页面增强桥：`resources/bridge/ruizhi-enhance-service.cjs`
- 桌面 IPC 注入：`scripts/build-windows.mjs`、`scripts/build-macos.mjs`

结论：桌面前端真正调用 Codex app-server 的接口是 JSON-RPC 方法，不是普通 REST。当前 renderer bundle 里直接出现的 `sendRequest(method, params)` app-server 方法共 50 个。锐捷另外增加了一个本地 HTTP Responses bridge 和一组 `window.ruizhiDesktop` IPC 接口。

## 复现方式

```bash
mkdir -p .work/app-server-api/ts .work/app-server-api/schema
dist/锐捷Codex.app/Contents/Resources/codex app-server generate-ts --experimental --out .work/app-server-api/ts
dist/锐捷Codex.app/Contents/Resources/codex app-server generate-json-schema --experimental --out .work/app-server-api/schema
```

实际调用的方法可用下面的提取逻辑复核：

```bash
node - <<'NODE'
const fs = require("fs");
const source = ".work/inspect-current-asar/webview/assets/app-server-manager-signals-Csopz8aM.js";
const text = fs.readFileSync(source, "utf8");
const methods = [...new Set(
  [...text.matchAll(/\.sendRequest\(`([^`]+)`|sendRequest\(`([^`]+)`/g)]
    .map((match) => match[1] || match[2])
    .filter(Boolean)
    .filter((method) => !["DELETE", "PATCH"].includes(method))
)].sort();
console.log(methods.join("\n"));
NODE
```

## App-Server JSON-RPC 接口

说明：

- `method` 是 JSON-RPC `method` 字段。
- 参数与返回值的类型名来自生成的 `app-server generate-ts`。
- `?field` 表示可选字段。
- 更深层对象如 `Thread`、`Turn`、`Config`、`Model` 可在 `.work/app-server-api/ts` 中查对应类型。

| method | 参数类型 | 参数字段 | 返回类型 | 返回字段 |
| --- | --- | --- | --- | --- |
| `account/login/cancel` | `CancelLoginAccountParams` | loginId: string | `CancelLoginAccountResponse` | status: `CancelLoginAccountStatus` |
| `account/login/start` | `LoginAccountParams` | union: ApiKey / Chatgpt / ChatgptDeviceCode / ChatgptAuthTokens | `LoginAccountResponse` | union: ApiKey / Chatgpt / ChatgptDeviceCode / ChatgptAuthTokens |
| `account/logout` | `undefined` | 无 | `LogoutAccountResponse` | `{}` |
| `account/read` | `GetAccountParams` | ?refreshToken: boolean | `GetAccountResponse` | ?account: `Account` or null; requiresOpenaiAuth: boolean |
| `app/list` | `AppsListParams` | ?cursor: string or null; ?forceRefetch: boolean; ?limit: integer or null; ?threadId: string or null | `AppsListResponse` | data: Array<`AppInfo`>; ?nextCursor: string or null |
| `collaborationMode/list` | `CollaborationModeListParams` | `{}` | `CollaborationModeListResponse` | data: Array<`CollaborationModeMask`> |
| `config/batchWrite` | `ConfigBatchWriteParams` | edits: Array<`ConfigEdit`>; ?expectedVersion: string or null; ?filePath: string or null; ?reloadUserConfig: boolean | `ConfigWriteResponse` | filePath: `AbsolutePathBuf`; ?overriddenMetadata: `OverriddenMetadata` or null; status: `WriteStatus`; version: string |
| `config/read` | `ConfigReadParams` | ?cwd: string or null; ?includeLayers: boolean | `ConfigReadResponse` | config: `Config`; ?layers: array or null; origins: object |
| `config/value/write` | `ConfigValueWriteParams` | ?expectedVersion: string or null; ?filePath: string or null; keyPath: string; mergeStrategy: `MergeStrategy`; value: any | `ConfigWriteResponse` | filePath: `AbsolutePathBuf`; ?overriddenMetadata: `OverriddenMetadata` or null; status: `WriteStatus`; version: string |
| `configRequirements/read` | `undefined` | 无 | `ConfigRequirementsReadResponse` | ?requirements: `ConfigRequirements` or null |
| `feedback/upload` | `FeedbackUploadParams` | classification: string; ?extraLogFiles: array or null; includeLogs: boolean; ?reason: string or null; ?tags: object or null; ?threadId: string or null | `FeedbackUploadResponse` | threadId: string |
| `fs/createDirectory` | `FsCreateDirectoryParams` | path: `AbsolutePathBuf`; ?recursive: boolean or null | `FsCreateDirectoryResponse` | `{}` |
| `fs/unwatch` | `FsUnwatchParams` | watchId: string | `FsUnwatchResponse` | `{}` |
| `fs/watch` | `FsWatchParams` | path: `AbsolutePathBuf`; watchId: string | `FsWatchResponse` | path: `AbsolutePathBuf` |
| `fs/writeFile` | `FsWriteFileParams` | dataBase64: string; path: `AbsolutePathBuf` | `FsWriteFileResponse` | `{}` |
| `fuzzyFileSearch` | `FuzzyFileSearchParams` | ?cancellationToken: string or null; query: string; roots: Array<string> | `FuzzyFileSearchResponse` | files: Array<`FuzzyFileSearchResult`> |
| `fuzzyFileSearch/sessionStart` | `FuzzyFileSearchSessionStartParams` | roots: Array<string>; sessionId: string | `FuzzyFileSearchSessionStartResponse` | `{}` |
| `fuzzyFileSearch/sessionStop` | `FuzzyFileSearchSessionStopParams` | sessionId: string | `FuzzyFileSearchSessionStopResponse` | `{}` |
| `fuzzyFileSearch/sessionUpdate` | `FuzzyFileSearchSessionUpdateParams` | query: string; sessionId: string | `FuzzyFileSearchSessionUpdateResponse` | `{}` |
| `gitDiffToRemote` | `GitDiffToRemoteParams` | cwd: string | `GitDiffToRemoteResponse` | sha: `GitSha`; diff: string |
| `mcpServer/oauth/login` | `McpServerOauthLoginParams` | name: string; ?scopes: array or null; ?timeoutSecs: integer or null | `McpServerOauthLoginResponse` | authorizationUrl: string |
| `mcpServer/tool/call` | `McpServerToolCallParams` | ?_meta: any; ?arguments: any; server: string; threadId: string; tool: string | `McpServerToolCallResponse` | ?_meta: any; content: Array<any>; ?isError: boolean or null; ?structuredContent: any |
| `mcpServerStatus/list` | `ListMcpServerStatusParams` | ?cursor: string or null; ?detail: `McpServerStatusDetail` or null; ?limit: integer or null | `ListMcpServerStatusResponse` | data: Array<`McpServerStatus`>; ?nextCursor: string or null |
| `model/list` | `ModelListParams` | ?cursor: string or null; ?includeHidden: boolean or null; ?limit: integer or null | `ModelListResponse` | data: Array<`Model`>; ?nextCursor: string or null |
| `plugin/install` | `PluginInstallParams` | ?marketplacePath: `AbsolutePathBuf` or null; pluginName: string; ?remoteMarketplaceName: string or null | `PluginInstallResponse` | appsNeedingAuth: Array<`AppSummary`>; authPolicy: `PluginAuthPolicy` |
| `plugin/list` | `PluginListParams` | ?cwds: array or null; ?marketplaceKinds: array or null | `PluginListResponse` | ?featuredPluginIds: Array<string>; ?marketplaceLoadErrors: Array<`MarketplaceLoadErrorInfo`>; marketplaces: Array<`PluginMarketplaceEntry`> |
| `plugin/read` | `PluginReadParams` | ?marketplacePath: `AbsolutePathBuf` or null; pluginName: string; ?remoteMarketplaceName: string or null | `PluginReadResponse` | plugin: `PluginDetail` |
| `plugin/uninstall` | `PluginUninstallParams` | pluginId: string | `PluginUninstallResponse` | `{}` |
| `remoteControl/status/read` | `undefined` | 无 | `RemoteControlStatusReadResponse` | ?environmentId: string or null; installationId: string; serverName: string; status: `RemoteControlConnectionStatus` |
| `skills/config/write` | `SkillsConfigWriteParams` | enabled: boolean; ?name: string or null; ?path: `AbsolutePathBuf` or null | `SkillsConfigWriteResponse` | effectiveEnabled: boolean |
| `thread/archive` | `ThreadArchiveParams` | threadId: string | `ThreadArchiveResponse` | `{}` |
| `thread/backgroundTerminals/clean` | `ThreadBackgroundTerminalsCleanParams` | threadId: string | `ThreadBackgroundTerminalsCleanResponse` | `{}` |
| `thread/compact/start` | `ThreadCompactStartParams` | threadId: string | `ThreadCompactStartResponse` | `{}` |
| `thread/fork` | `ThreadForkParams` | ?approvalPolicy; ?approvalsReviewer; ?baseInstructions; ?config; ?cwd; ?developerInstructions; ?ephemeral; ?excludeTurns; ?model; ?modelProvider; ?path; ?permissions; ?persistExtendedHistory; ?runtimeWorkspaceRoots; ?sandbox; ?serviceTier; threadId; ?threadSource | `ThreadForkResponse` | ?activePermissionProfile; approvalPolicy; approvalsReviewer; cwd; ?instructionSources; model; modelProvider; ?reasoningEffort; ?runtimeWorkspaceRoots; sandbox; ?serviceTier; thread |
| `thread/goal/clear` | `ThreadGoalClearParams` | threadId: string | `ThreadGoalClearResponse` | cleared: boolean |
| `thread/goal/get` | `ThreadGoalGetParams` | threadId: string | `ThreadGoalGetResponse` | ?goal: `ThreadGoal` or null |
| `thread/goal/set` | `ThreadGoalSetParams` | ?objective: string or null; ?status: `ThreadGoalStatus` or null; threadId: string; ?tokenBudget: integer or null | `ThreadGoalSetResponse` | goal: `ThreadGoal` |
| `thread/inject_items` | `ThreadInjectItemsParams` | items: Array<any>; threadId: string | `ThreadInjectItemsResponse` | `{}` |
| `thread/list` | `ThreadListParams` | ?archived; ?cursor; ?cwd; ?limit; ?modelProviders; ?searchTerm; ?sortDirection; ?sortKey; ?sourceKinds; ?useStateDbOnly | `ThreadListResponse` | ?backwardsCursor; data: Array<`Thread`>; ?nextCursor |
| `thread/name/set` | `ThreadSetNameParams` | name: string; threadId: string | `ThreadSetNameResponse` | `{}` |
| `thread/read` | `ThreadReadParams` | ?includeTurns: boolean; threadId: string | `ThreadReadResponse` | thread: `Thread` |
| `thread/resume` | `ThreadResumeParams` | ?approvalPolicy; ?approvalsReviewer; ?baseInstructions; ?config; ?cwd; ?developerInstructions; ?excludeTurns; ?history; ?model; ?modelProvider; ?path; ?permissions; ?persistExtendedHistory; ?personality; ?runtimeWorkspaceRoots; ?sandbox; ?serviceTier; threadId | `ThreadResumeResponse` | ?activePermissionProfile; approvalPolicy; approvalsReviewer; cwd; ?instructionSources; model; modelProvider; ?reasoningEffort; ?runtimeWorkspaceRoots; sandbox; ?serviceTier; thread |
| `thread/rollback` | `ThreadRollbackParams` | numTurns: integer; threadId: string | `ThreadRollbackResponse` | thread: `Thread` |
| `thread/start` | `ThreadStartParams` | ?approvalPolicy; ?approvalsReviewer; ?baseInstructions; ?config; ?cwd; ?developerInstructions; ?dynamicTools; ?environments; ?ephemeral; ?experimentalRawEvents; ?mockExperimentalField; ?model; ?modelProvider; ?permissions; ?persistExtendedHistory; ?personality; ?runtimeWorkspaceRoots; ?sandbox; ?serviceName; ?serviceTier; ?sessionStartSource; ?threadSource | `ThreadStartResponse` | ?activePermissionProfile; approvalPolicy; approvalsReviewer; cwd; ?instructionSources; model; modelProvider; ?reasoningEffort; ?runtimeWorkspaceRoots; sandbox; ?serviceTier; thread |
| `thread/turns/list` | `ThreadTurnsListParams` | ?cursor; ?itemsView; ?limit; ?sortDirection; threadId | `ThreadTurnsListResponse` | ?backwardsCursor; data: Array<`Turn`>; ?nextCursor |
| `thread/unarchive` | `ThreadUnarchiveParams` | threadId: string | `ThreadUnarchiveResponse` | thread: `Thread` |
| `thread/unsubscribe` | `ThreadUnsubscribeParams` | threadId: string | `ThreadUnsubscribeResponse` | status: `ThreadUnsubscribeStatus` |
| `turn/interrupt` | `TurnInterruptParams` | threadId: string; turnId: string | `TurnInterruptResponse` | `{}` |
| `turn/start` | `TurnStartParams` | ?approvalPolicy; ?approvalsReviewer; ?collaborationMode; ?cwd; ?effort; ?environments; input; ?model; ?outputSchema; ?permissions; ?personality; ?responsesapiClientMetadata; ?runtimeWorkspaceRoots; ?sandboxPolicy; ?serviceTier; ?summary; threadId | `TurnStartResponse` | turn: `Turn` |
| `windowsSandbox/setupStart` | `WindowsSandboxSetupStartParams` | ?cwd: `AbsolutePathBuf` or null; mode: `WindowsSandboxSetupMode` | `WindowsSandboxSetupStartResponse` | started: boolean |

## Renderer 调用补充说明

这些方法不是都在同一功能里触发，主要调用场景如下：

- 会话生命周期：`thread/start`、`thread/resume`、`thread/fork`、`thread/read`、`thread/list`、`thread/turns/list`、`turn/start`、`turn/interrupt`。
- 会话整理：`thread/archive`、`thread/unarchive`、`thread/unsubscribe`、`thread/rollback`、`thread/name/set`、`thread/compact/start`、`thread/backgroundTerminals/clean`。
- 目标任务：`thread/goal/get`、`thread/goal/set`、`thread/goal/clear`。
- 配置与模型：`config/read`、`config/value/write`、`config/batchWrite`、`configRequirements/read`、`model/list`、`collaborationMode/list`。
- 插件/MCP/App：`plugin/list`、`plugin/read`、`plugin/install`、`plugin/uninstall`、`mcpServerStatus/list`、`mcpServer/oauth/login`、`mcpServer/tool/call`、`app/list`。
- 远程/文件辅助：`fs/createDirectory`、`fs/writeFile`、`fs/watch`、`fs/unwatch`、`gitDiffToRemote`、`remoteControl/status/read`。
- 登录与反馈：`account/login/start`、`account/login/cancel`、`account/read`、`account/logout`、`feedback/upload`。

## 锐捷本地 Responses Bridge

该 bridge 在 Electron 启动时由 `startRuizhiResponsesBridge()` 启动，默认监听 `127.0.0.1:17888`，返回给 Codex provider 的 base URL 是 `http://127.0.0.1:17888/v1`。上游地址来自 `config/rj-codex.json` 的 `openai.baseUrl`，当前为 `https://gptauth.ruijie.com.cn/v1`。

| HTTP 接口 | 参数 | 返回值 | 说明 |
| --- | --- | --- | --- |
| `GET /health` | 无 | `{ ok: true }` | 本地 bridge 存活检查。 |
| `GET /v1/models` | 无 | `{ models: catalog.models }`，响应头 `x-models-etag` | 读取 `~/.codex/models_cache.json` 里的模型目录。 |
| `POST /v1/responses` | OpenAI Responses 风格 body。关键字段：`model`、`input`、`instructions`、`stream`、`tools`、`tool_choice`、`reasoning`、`max_output_tokens`、`text.format` | Responses 风格 JSON 或 SSE。错误为 `{ error: { type, code, message, status, model, route, attempts, upstream_status?, upstream_request_id?, upstream_message? } }` | 根据 `modelBridge.routes` 判断走上游 `/responses` 或转换到 `/chat/completions`。 |
| `POST /v1/responses/compact` | 同 `/v1/responses` | 同 `/v1/responses` | 与 Responses 路径共用处理函数。 |
| `POST /v1/chat/completions` | OpenAI Chat Completions 风格 body 原样透传。关键字段：`model`、`messages`、`stream`、`tools` 等 | 上游 Chat Completions JSON/SSE 原样转发；错误同 bridge 统一错误结构 | 用于直接 chat-compatible 调用。 |

认证逻辑：优先使用请求里的 `Authorization` header；如果没有，则读取 `authHome/auth.json` 的 `OPENAI_API_KEY` 并拼成 `Bearer <key>`。没有 key 时返回 401：`{ error: { type: "bridge_error", code: "ruizhi_bridge_error", message: "缺少 API Key" } }`。

重试逻辑：上游状态码 `429`、`502`、`503`、`504` 和常见网络错误会重试，默认最多 5 次，每次间隔 5000ms，单次上游超时 300000ms。

## 锐捷桌面 IPC 接口

这些接口通过 `window.ruizhiDesktop` 暴露给 renderer，底层是 Electron `ipcRenderer.invoke/sendSync`。它们不是 app-server JSON-RPC，但属于锐捷桌面新增的本地 API 面。

| 前端入口 | IPC channel | 参数 | 返回值 |
| --- | --- | --- | --- |
| `ruizhiDesktop.update.getState()` | `ruizhi:update:get-state` | 无 | `{ status, currentVersion, version, progress, message, ... }` |
| `ruizhiDesktop.update.installNow()` | `ruizhi:update:install-now` | 无 | 成功 `{ ok: true }`；失败 `{ ok: false, error }` |
| `ruizhiDesktop.auth.getCached()` | `ruizhi:auth:get-sync` | 无 | `{ configured, masked, configuredBy, version, error? }` |
| `ruizhiDesktop.auth.get()` | `ruizhi:auth:get` | 无 | `{ configured, masked, configuredBy, version, error? }` |
| `ruizhiDesktop.auth.setAndTest(key)` | `ruizhi:auth:set-and-test` | `key: string` | Windows: 成功 `{ ok: true, apiKey, status }`；失败 `{ ok: false, error, status }` |
| `ruizhiDesktop.auth.resetToLogin()` | `ruizhi:auth:reset-to-login` | 无 | Windows: `{ ok: true, removed, backupPath }`，随后重启应用 |
| `ruizhiDesktop.runtime.installVcRedist()` | `ruizhi:runtime:install-vc-redist` | 无 | Windows: `{ ok, exitCode?, launched?, logPath, launchLogPath, error? }` |
| `ruizhiDesktop.enhance.call(route, payload)` | `ruizhi:enhance:call` | `route: string`, `payload?: object` | 见下一节增强服务 route |

macOS 当前只注册 `auth.get/getCached`、`update.*` 和 `enhance.call`；`setAndTest`、`resetToLogin`、`runtime.installVcRedist` 是 Windows 覆盖层里的能力。

## 锐捷页面增强服务 route

这些 route 都通过 `ruizhiDesktop.enhance.call(route, payload)` 进入 `resources/bridge/ruizhi-enhance-service.cjs`。

| route | 参数 | 返回值 |
| --- | --- | --- |
| `/backend/status` | `{}` | `{ status: "ok", message: "增强服务已连接", version: "rj-v1" }` |
| `/settings/get` | `{}` | `{ enabled, appVersion, features }` |
| `/settings/set` | patch object | 写入后的 `{ enabled, appVersion, features }`；`sessionDelete`、`projectMove` 会被强制为 `false` |
| `/diagnostics/log` | 任意诊断对象 | `{ status: "ok", message: "日志已记录" }` |
| `/delete` | `{ session_id?/id?, title? }` | 当前停用：`{ status: "disabled", message: "会话删除增强已停用" }` |
| `/undo` | `{ undo_token? }` | 当前停用：`{ status: "disabled", message: "会话删除撤销增强已停用" }` |
| `/export-markdown` | `{ session_id?/id?, title? }` | 成功 `{ status: "exported", session_id, message, filename, markdown }`；失败 `{ status: "failed", session_id, message }` |
| `/archived-thread` | `{ title }` | `{ session_id, title }`，找不到则空字符串 |
| `/move-thread-workspace` | `{ session_id?/id?, title?, target_cwd? }` | 当前停用：`{ status: "disabled", message: "会话迁移增强已停用" }` |
| `/thread-sort-key` | `{ session_id?/id?, title? }` | 成功 `{ status: "ok", session_id, created_at?, updated_at?, archived_at? }`；失败 `{ status: "failed", session_id, message }` |
| `/thread-sort-keys` | `{ sessions: Array<{ session_id?/id?, title? }> }` | `{ status: "ok", sort_keys: Array<{ session_id, created_at?, updated_at?, archived_at? }> }` |
| 其他 route | 任意 | `{ status: "failed", message: "Unknown enhance route: <route>" }` |

## 需要注意的边界

- app-server JSON-RPC 协议由 `resources/codex` 或 Windows 的 `resources/codex.exe` 实现；本仓库没有 Rust 源码，参数和返回结构以当前二进制导出的 TS/JSON Schema 为准。
- `.work/app-server-api/ts` 和 `.work/app-server-api/schema` 是本次分析临时生成的协议定义，不需要提交；需要时可用上面的命令重新生成。
- `resources/bridge/ruizhi-responses-bridge.cjs` 是锐捷本地模型协议转换服务，不是官方 app-server；它对外暴露 HTTP `/v1/*`，对上游调用 `https://gptauth.ruijie.com.cn/v1/responses` 或 `/chat/completions`。
- `ruizhiDesktop.*` IPC 是桌面覆盖层 API，主要服务登录、更新、VC runtime、页面增强，不走 app-server JSON-RPC。
