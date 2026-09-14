# 锐捷 KM 插件

本地 Codex 插件，用于查询锐捷 KM 知识库。

## 设计目标

这个插件不是只暴露 KM OpenAPI，而是优先作为“知识库助手”使用：

- 用户说“查最新彩页/参数规格/产品资料”时，优先用 `km_search`。
- 用户已经有 `docId` 时，用 `km_get_document`。
- 用户要浏览知识库目录时，用分类工具。
- 用户明确要求下载记录或审计时，才用下载记录工具。

## 工具

- `km_search`：面向用户的自然检索入口，会返回摘要化结果、KM 链接和附件信息。
- `km_list_documents`：底层文档分页接口。
- `km_get_document`：文档详情。
- `km_list_categories`：完整分类树。
- `km_list_categories_by_parent`：按父分类展开；顶层传 `parentId=0`。
- `km_list_tags`：标签查询。
- `km_list_downloads`：附件下载记录。可能包含下载者、部门、IP、下载时间，仅在用户明确要求时使用。
- `km_get_config`：检查当前环境配置。

## 已覆盖接口

- `GET /api/v1/knowledge/documents`
- `GET /api/v1/knowledge/documents/{docId}`
- `GET /api/v1/knowledge/categories`
- `GET /api/v1/knowledge/categoriesByParentId`
- `GET /api/v1/knowledge/tags`
- `GET /api/v1/knowledge/download`

## 平台过滤

生产环境实际可用的平台值是 `marketing`。插件会把这些别名统一归一为 `marketing`：

- `marketing`
- `makiting`
- `市场资料平台`
- `市场资料`

## 运行时

MCP server 只使用 Python 标准库：

```bash
python3 plugins/ruijie-km/scripts/ruijie_km_mcp.py
```

可用环境变量：

- `RUIJIE_KM_ENV`：`prod` 或 `test`，默认 `prod`。
- `RUIJIE_KM_BASE_URL`：显式覆盖 KM base URL。
- `RUIJIE_KM_COOKIE`：可选 `Cookie` 请求头。
- `RUIJIE_KM_AUTHORIZATION`：可选 `Authorization` 请求头。
- `RUIJIE_KM_EXTRA_HEADERS`：可选额外请求头，格式为 JSON object。
- `RUIJIE_KM_TIMEOUT_SECONDS`：请求超时时间，默认 `20` 秒。
- `RUIJIE_KM_CA_FILE`：可选企业 CA bundle 路径。
- `RUIJIE_KM_INSECURE_TLS`：设为 `1` 时跳过 TLS 校验，只用于内部 smoke test 或本机证书链未配置完整的临时场景。

内置 `.mcp.json` 设置了 `RUIJIE_KM_ENV=prod` 和 `RUIJIE_KM_INSECURE_TLS=1`，因为本机 Python 运行时能访问生产 KM，但无法校验内部证书链。后续如果有企业 CA bundle，应优先改成 `RUIJIE_KM_CA_FILE`，不要长期依赖跳过 TLS 校验。

## 本地 smoke test

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"km_search","arguments":{"query":"交换机 产品彩页","pageSize":3,"platform":"市场资料平台"}}}' \
  | RUIJIE_KM_INSECURE_TLS=1 python3 -B plugins/ruijie-km/scripts/ruijie_km_mcp.py
```
