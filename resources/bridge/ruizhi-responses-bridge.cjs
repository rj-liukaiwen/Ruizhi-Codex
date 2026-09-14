const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const BRIDGE_RETRY_COUNT = 5;
const BRIDGE_RETRY_DELAY_MS = 5000;
const UPSTREAM_REQUEST_TIMEOUT_MS = 300000;
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 502, 503, 504]);
const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"];

function json(res, status, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function fail(res, status, message) {
  json(res, status, { error: { type: "bridge_error", code: "ruizhi_bridge_error", message } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortTraceId() {
  return randomUUID().replace(/[^0-9a-f]/gi, "").slice(0, 6).toUpperCase();
}

function ensureLoopbackNoProxy() {
  const existing = [process.env.NO_PROXY, process.env.no_proxy].filter((value) => typeof value === "string" && value.trim()).join(",");
  const parts = existing.split(",").map((part) => part.trim()).filter(Boolean);
  const lower = new Set(parts.map((part) => part.toLowerCase()));
  for (const host of LOOPBACK_NO_PROXY_HOSTS) {
    if (!lower.has(host.toLowerCase())) parts.push(host);
  }
  const next = parts.join(",");
  process.env.NO_PROXY = next;
  process.env.no_proxy = next;
  return next;
}

function upstreamRequestId(headers) {
  if (!headers) return "";
  return headers.get("x-request-id") || headers.get("request-id") || headers.get("x-correlation-id") || headers.get("cf-ray") || "";
}

function responseMeta(response) {
  return response && response.__ruizhiBridgeMeta && typeof response.__ruizhiBridgeMeta === "object"
    ? response.__ruizhiBridgeMeta
    : {};
}

function withResponseMeta(response, meta) {
  try {
    Object.defineProperty(response, "__ruizhiBridgeMeta", {
      value: meta,
      enumerable: false,
      configurable: true,
    });
  } catch {
    response.__ruizhiBridgeMeta = meta;
  }
  return response;
}

function truncateText(text, maxLength = 500) {
  const value = String(text || "").trim();
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function extractUpstreamMessage(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  try {
    const parsed = JSON.parse(value);
    const message = parsed && parsed.error && typeof parsed.error.message === "string" ? parsed.error.message.trim() : "";
    if (message) return truncateText(message);
  } catch {}
  if (value.startsWith("<")) return "";
  return truncateText(value);
}

function retryableTransportError(error) {
  const code = String(error && (error.code || error.cause && error.cause.code) || "");
  const name = String(error && error.name || "");
  const message = String(error && error.message || "");
  if (name === "AbortError") return true;
  if (["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code)) return true;
  return /fetch failed|terminated|network|timeout|aborted/i.test(message) && !/invalid url|failed to parse url/i.test(message);
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { ...(init && init.headers && typeof init.headers === "object" ? init.headers : {}), "accept-encoding": "identity" };
  return fetch(url, { ...init, headers, signal: controller.signal }).finally(() => clearTimeout(timeout));
}

function bridgeErrorCategory(kind, status) {
  if (kind === "network") return "NETWORK";
  if (kind === "bridge") return "LOCAL";
  if (Number.isInteger(status)) return String(status);
  return "UPSTREAM";
}

function bridgeHttpStatus(kind, status) {
  if (kind === "network") return 502;
  if (kind === "bridge") return 500;
  return Number.isInteger(status) ? status : 502;
}

function bridgeErrorMessage({ kind, status, attempts, code }) {
  const retryCount = Math.max(0, Number(attempts || 1) - 1);
  const retryText = retryCount > 0 ? `锐捷已重试 ${retryCount} 次仍失败。` : "";
  if (kind === "network") {
    return `故障位置：本机到上游模型服务的网络连接。本机当前无法连接上游模型服务，可能是网络断开、热点不可用、VPN/代理异常或企业网络拦截，${retryText}请恢复网络后重试。错误代码：${code}`;
  }
  if (kind === "bridge") {
    return `故障位置：锐捷本地模型协议转换服务。本地转换服务处理失败，请将错误代码发给我们定位。错误代码：${code}`;
  }
  if (status === 429) {
    return `故障位置：上游模型服务。上游模型服务当前请求过多或触发限流，${retryText}请稍后再试，或临时切换其他模型。错误代码：${code}`;
  }
  if ([502, 503, 504].includes(status)) {
    return `故障位置：上游模型服务网关。上游模型服务网关异常或临时不可用，${retryText}请稍后再试，或临时切换其他模型。错误代码：${code}`;
  }
  return `故障位置：上游模型服务。上游模型服务返回 HTTP ${status || "未知状态"}，${retryText}请稍后再试，或临时切换其他模型。错误代码：${code}`;
}

function bridgeErrorBody(input) {
  const kind = input.kind || "upstream";
  const status = Number.isInteger(input.status) ? input.status : Number.isInteger(input.upstreamStatus) ? input.upstreamStatus : undefined;
  const httpStatus = bridgeHttpStatus(kind, status);
  const category = bridgeErrorCategory(kind, status);
  const code = input.code || `RZ-BRIDGE-${category}-${shortTraceId()}`;
  const attempts = Number.isInteger(input.attempts) ? input.attempts : 1;
  const error = {
    type: kind === "bridge" ? "bridge_error" : "upstream_error",
    code,
    message: bridgeErrorMessage({ kind, status, attempts, code }),
    status: httpStatus,
    model: input.model || "",
    route: input.route || "",
    attempts,
  };
  if (Number.isInteger(input.upstreamStatus)) error.upstream_status = input.upstreamStatus;
  if (input.upstreamRequestId) error.upstream_request_id = input.upstreamRequestId;
  const upstreamMessage = extractUpstreamMessage(input.upstreamBody);
  if (upstreamMessage) error.upstream_message = upstreamMessage;
  return { status: httpStatus, body: { error } };
}

function contentFilterErrorBody(input = {}) {
  const code = input.code || `RZ-MODEL-CONTENT-FILTER-${shortTraceId()}`;
  return {
    status: 400,
    body: {
      error: {
        type: "model_content_filter",
        code,
        message: `上游模型触发内容安全过滤，本次回复被中止。若当前内容正常，可能是上游误判、历史上下文或模型输出触发。建议调整表述、缩短上下文，或临时切换其他模型。错误代码：${code}`,
        status: 400,
        model: input.model || "",
        route: input.route || "",
        attempts: Number.isInteger(input.attempts) ? input.attempts : 1,
      },
    },
  };
}

function isContentFilterReason(reason) {
  return String(reason || "").trim().toLowerCase() === "content_filter";
}

function rateLimitErrorBody(input = {}) {
  return bridgeErrorBody({
    kind: "upstream",
    status: 429,
    upstreamStatus: 429,
    upstreamBody: input.upstreamBody,
    upstreamRequestId: input.upstreamRequestId,
    model: input.model,
    route: input.route,
    attempts: Number.isInteger(input.attempts) ? input.attempts : 1,
  });
}

function isRateLimitText(text) {
  return /429|too many requests|rate[_ -]?limit|rate_limit_exceeded/i.test(String(text || ""));
}

function isRateLimitError(error) {
  if (!error || typeof error !== "object") return false;
  return isRateLimitText(error.code) || isRateLimitText(error.message) || isRateLimitText(error.type);
}

function responseEventId(data) {
  const response = data && data.response && typeof data.response === "object" ? data.response : null;
  return typeof response?.id === "string" && response.id ? response.id : `resp_${randomUUID().slice(0, 12)}`;
}

function responseIncompleteReason(data) {
  const response = data && data.response && typeof data.response === "object" ? data.response : null;
  return response?.incomplete_details?.reason || data?.incomplete_details?.reason || "";
}

function responseFailedError(data) {
  const response = data && data.response && typeof data.response === "object" ? data.response : null;
  const error = response?.error || data?.error;
  return error && typeof error === "object" ? error : null;
}

function terminalResponsesFailure(data, context = {}) {
  const eventType = typeof data?.type === "string" ? data.type : "";
  if (eventType === "response.incomplete" && isContentFilterReason(responseIncompleteReason(data))) {
    return contentFilterErrorBody({ model: context.model, route: context.route });
  }
  if (eventType === "response.failed" && isRateLimitError(responseFailedError(data))) {
    const error = responseFailedError(data);
    return rateLimitErrorBody({
      model: context.model,
      route: context.route,
      upstreamBody: error && error.message,
    });
  }
  return null;
}

function shouldSendSseError(context = {}) {
  return context.codexResponses === true && (context.stream === true || context.acceptsSse === true);
}

function logBridgeEvent(level, message, fields) {
  const log = level === "warn" ? console.warn : console.error;
  log(`ruizhi responses bridge ${message}`, JSON.stringify(fields));
}

function logRetry(context, fields) {
  logBridgeEvent("warn", "upstream retry", {
    model: context.model || "",
    upstream_model: context.upstreamModel || "",
    route: context.route || "",
    endpoint: context.endpoint || "",
    status: fields.status || null,
    attempt: fields.attempt,
    max_retries: BRIDGE_RETRY_COUNT,
    retry_in_ms: BRIDGE_RETRY_DELAY_MS,
    upstream_request_id: fields.upstreamRequestId || "",
    error: truncateText(fields.error || "", 240),
  });
}

function logFinalError(errorBody, context) {
  const error = errorBody && errorBody.error ? errorBody.error : {};
  logBridgeEvent("error", "final error", {
    code: error.code || "",
    model: error.model || context.model || "",
    upstream_model: context.upstreamModel || "",
    route: error.route || context.route || "",
    endpoint: context.endpoint || "",
    status: error.status || null,
    upstream_status: error.upstream_status || null,
    attempts: error.attempts || null,
    upstream_request_id: error.upstream_request_id || "",
  });
}

function sendBridgeError(res, input, headers = {}) {
  const built = bridgeErrorBody(input);
  if (shouldSendSseError(input.context || {})) {
    logFinalError(built.body, input.context || {});
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers,
    });
    res.write(failedResponseEvent(`resp_${randomUUID().slice(0, 12)}`, input.upstreamModel || input.context?.upstreamModel || input.model || "", built.body));
    res.end();
    return;
  }
  logFinalError(built.body, input.context || {});
  return json(res, built.status, built.body, headers);
}

function failedResponseEvent(id, model, errorBody, options = {}) {
  const error = errorBody && errorBody.error ? errorBody.error : {};
  return sse("response.failed", {
    response: {
      id,
      status: "failed",
      model,
      error: {
        code: options.codexCode || "invalid_prompt",
        message: error.message || "锐捷本地模型协议转换服务处理失败。",
      },
      metadata: { ruizhi_error_code: error.code || "RZ-BRIDGE-LOCAL" },
    },
  });
}

async function sendUpstreamHttpError(res, upstream, context, headers = {}) {
  const text = await upstream.text().catch(() => "");
  const meta = responseMeta(upstream);
  const built = bridgeErrorBody({
    kind: "upstream",
    status: upstream.status,
    upstreamStatus: upstream.status,
    upstreamBody: text,
    upstreamRequestId: upstreamRequestId(upstream.headers) || meta.upstreamRequestId,
    model: context.model,
    route: context.route,
    attempts: meta.attempts || 1,
    context,
  });
  if (shouldSendSseError(context)) {
    logFinalError(built.body, context);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers,
    });
    res.write(failedResponseEvent(`resp_${randomUUID().slice(0, 12)}`, context.upstreamModel || context.model || "", built.body));
    res.end();
    return;
  }
  logFinalError(built.body, context);
  return json(res, built.status, built.body, headers);
}

function transportFailure(error, meta) {
  const failure = new Error(error && error.message ? error.message : String(error));
  failure.name = "RuizhiBridgeTransportError";
  failure.cause = error;
  failure.ruizhiBridgeTransport = true;
  failure.ruizhiBridgeMeta = meta;
  return failure;
}

async function fetchUpstreamWithPolicy(url, init, options, context) {
  let lastFailure = null;
  for (let retryIndex = 0; retryIndex <= BRIDGE_RETRY_COUNT; retryIndex += 1) {
    const attempt = retryIndex + 1;
    try {
      const response = await fetchWithTimeout(url, init, options.upstreamTimeoutMs || UPSTREAM_REQUEST_TIMEOUT_MS);
      const meta = {
        attempts: attempt,
        upstreamRequestId: upstreamRequestId(response.headers),
        url,
      };
      if (!RETRYABLE_UPSTREAM_STATUSES.has(response.status) || retryIndex >= BRIDGE_RETRY_COUNT) {
        return withResponseMeta(response, meta);
      }
      const body = await response.text().catch(() => "");
      lastFailure = { status: response.status, body, upstreamRequestId: meta.upstreamRequestId, attempt };
      logRetry(context, { status: response.status, upstreamRequestId: meta.upstreamRequestId, attempt });
    } catch (error) {
      if (!retryableTransportError(error) || retryIndex >= BRIDGE_RETRY_COUNT) {
        throw transportFailure(error, {
          attempts: attempt,
          lastFailure,
          url,
        });
      }
      lastFailure = { error: error && error.message ? error.message : String(error), attempt };
      logRetry(context, { error: lastFailure.error, attempt });
    }
    await sleep(BRIDGE_RETRY_DELAY_MS);
  }
  throw transportFailure(new Error("upstream retry exhausted"), { attempts: BRIDGE_RETRY_COUNT + 1, lastFailure, url });
}

function sendTransportError(res, error, context, headers = {}) {
  const meta = error && error.ruizhiBridgeMeta || {};
  const lastFailure = meta.lastFailure || {};
  return sendBridgeError(res, {
    kind: "network",
    status: 502,
    upstreamStatus: lastFailure.status,
    upstreamBody: lastFailure.body || lastFailure.error || error && error.message,
    upstreamRequestId: lastFailure.upstreamRequestId,
    model: context.model,
    route: context.route,
    attempts: meta.attempts || 1,
    context,
  }, headers);
}

function bodyText(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function bodyJson(req) {
  const text = await bodyText(req);
  return text.trim() ? JSON.parse(text) : {};
}

function baseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function bareModel(model) {
  const value = String(model || "");
  const index = value.indexOf(":");
  return index > 0 ? value.slice(index + 1) : value;
}

function routeFor(model, routes) {
  const route = routes[model] || routes[bareModel(model)];
  if (typeof route === "string") return { protocol: route };
  if (route && typeof route === "object") return route;
  return /^(gpt|qwen)/i.test(model) ? { protocol: "responses" } : { protocol: "chat" };
}

function hasFunctionTools(tools) {
  return Array.isArray(tools) && tools.some((tool) => tool && typeof tool === "object" && tool.type === "function");
}

function routeForRequest(model, routes, body) {
  const route = routeFor(model, routes);
  if (route.protocol === "responses" && /^qwen/i.test(bareModel(model)) && hasFunctionTools(body && body.tools)) {
    return { ...route, protocol: "chat" };
  }
  return route;
}

function catalogInfo(catalogPath) {
  if (!catalogPath || !fs.existsSync(catalogPath)) return { etag: "ruizhi-models-missing", models: [] };
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  return {
    etag: typeof catalog.etag === "string" ? catalog.etag : "ruizhi-models",
    models: Array.isArray(catalog.models) ? catalog.models : [],
  };
}

function authFromFile(authHome) {
  const file = path.join(authHome, "auth.json");
  if (!fs.existsSync(file)) return "";
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  const candidates = [
    auth && typeof auth.RUIJIE_UNIAPI_KEY === "string" ? auth.RUIJIE_UNIAPI_KEY : "",
    auth && typeof auth.RUIZHI_API_KEY === "string" ? auth.RUIZHI_API_KEY : "",
    auth && auth.tokens && typeof auth.tokens.access_token === "string" ? auth.tokens.access_token : "",
    auth && typeof auth.access_token === "string" ? auth.access_token : "",
    auth && typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "",
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value;
  }
  return "";
}

function authHeader(req, authHome) {
  const incoming = req.headers.authorization;
  if (typeof incoming === "string" && incoming.trim()) return incoming.trim();
  const key = authFromFile(authHome);
  return key ? `Bearer ${key}` : "";
}

function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (part && part.type === "input_text") return { type: "text", text: String(part.text || "") };
    if (part && part.type === "input_image") return { type: "image_url", image_url: { url: String(part.image_url || "") } };
    return { type: "text", text: "" };
  });
}

function inputToMessages(input) {
  const messages = [];
  if (typeof input === "string") {
    return [{ role: "user", content: input }];
  }
  if (!Array.isArray(input)) return messages;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.role === "string") {
      const role = item.role === "system" ? "system" : item.role === "assistant" ? "assistant" : "user";
      messages.push({ role, content: contentToChat(item.content) });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const call = {
        id: String(item.call_id || `call_${randomUUID().slice(0, 8)}`),
        type: "function",
        function: {
          name: String(item.name || ""),
          arguments: item.type === "custom_tool_call"
            ? JSON.stringify({ input: String(item.input || "") })
            : String(item.arguments || "{}"),
        },
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: String(item.call_id || ""), content: String(item.output || "") });
    }
  }
  return messages;
}

function responsesNativeToolNames(tools) {
  return new Set(Array.isArray(tools)
    ? tools.filter((tool) => tool && typeof tool === "object" && tool.type !== "function" && typeof tool.name === "string").map((tool) => tool.name)
    : []);
}

function enforcedToolDescription(tool) {
  const name = String(tool && (tool.name || tool.function?.name) || "").trim().toLowerCase();
  const description = String(tool && (tool.description || tool.function?.description) || "").trim();
  let policy = "";
  if (name === "apply_patch") {
    policy = "MANDATORY and ONLY tool for creating, editing, moving, or deleting files. Submit the complete patch.";
  } else if (name === "shell_command" || name.endsWith("__shell_command")) {
    policy = "Run read-only commands and tests. NEVER create, edit, move, or delete files with this tool; use apply_patch instead.";
  }
  if (!policy || description.startsWith(policy)) return description;
  return description ? `${policy}\n${description}` : policy;
}

function enforceToolDescriptions(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    if (tool.function && typeof tool.function === "object") {
      return { ...tool, function: { ...tool.function, description: enforcedToolDescription(tool) } };
    }
    return { ...tool, description: enforcedToolDescription(tool) };
  });
}

function toolsToChat(tools) {
  if (!Array.isArray(tools)) return undefined;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "function" && tool.function && typeof tool.function === "object") converted.push(tool);
    else if (tool.type === "function" && typeof tool.name === "string") {
      converted.push({
        type: "function",
        function: {
          name: tool.name,
          description: enforcedToolDescription(tool),
          parameters: tool.parameters && typeof tool.parameters === "object" ? tool.parameters : { type: "object", properties: {} },
        },
      });
    } else if (typeof tool.name === "string") {
      converted.push({
        type: "function",
        function: {
          name: tool.name,
          description: `${enforcedToolDescription(tool)}\nReturn the complete freeform tool input in the input field.`,
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Complete raw freeform tool input" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      });
    }
  }
  return converted.length ? converted : undefined;
}

function toolChoiceToChat(toolChoice) {
  if (toolChoice && typeof toolChoice === "object" && toolChoice.type !== "function" && typeof toolChoice.name === "string") {
    return { type: "function", function: { name: toolChoice.name } };
  }
  return toolChoice;
}

function toChatRequest(body, model, route) {
  const messages = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) messages.push({ role: "system", content: body.instructions });
  messages.push(...inputToMessages(body.input));
  const chat = { model, messages, stream: body.stream !== false };
  if (Number.isFinite(body.max_output_tokens)) chat.max_tokens = body.max_output_tokens;
  if (body.text && body.text.format && typeof body.text.format === "object") chat.response_format = body.text.format;
  const tools = toolsToChat(body.tools);
  if (tools) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = toolChoiceToChat(body.tool_choice);
  }
  if (route.reasoningEffort === true && body.reasoning && typeof body.reasoning.effort === "string") {
    chat.reasoning_effort = body.reasoning.effort;
  }
  return { chat, nativeToolNames: responsesNativeToolNames(body.tools) };
}

function sanitizeResponsesRequest(body) {
  if (!body || typeof body !== "object") return body;
  const input = Array.isArray(body.input) ? body.input.filter((item) => !(
    item
    && typeof item === "object"
    && item.type === "reasoning"
    && typeof item.encrypted_content === "string"
    && item.encrypted_content.trim()
  )) : body.input;
  const tools = enforceToolDescriptions(body.tools);
  const inputChanged = input !== body.input && input.length !== body.input.length;
  const toolsChanged = Array.isArray(tools) && tools.some((tool, index) => tool !== body.tools[index]);
  return inputChanged || toolsChanged ? { ...body, input, tools } : body;
}

function sse(event, data) {
  const payload = normalizeResponseEventPayload(event, data);
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function parseSseBlock(block) {
  const out = { event: "message", data: "" };
  for (const raw of String(block || "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) out.event = line.slice(6).trim();
    if (line.startsWith("data:")) out.data += `${out.data ? "\n" : ""}${line.slice(5).trimStart()}`;
  }
  return out.data ? out : null;
}

async function* parseSse(response) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const parsed = parseSseBlock(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      if (parsed) yield parsed;
    }
  }
  buffer += decoder.decode();
  const parsed = parseSseBlock(buffer);
  if (parsed) yield parsed;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  }
  return 0;
}

function hasVisibleText(text) {
  return typeof text === "string" && text.trim().length > 0;
}

function normalizeResponseUsage(usage) {
  const inputDetails = usage && typeof usage === "object"
    ? usage.input_tokens_details || usage.prompt_tokens_details
    : null;
  const outputDetails = usage && typeof usage === "object"
    ? usage.output_tokens_details || usage.completion_tokens_details
    : null;
  const inputTokens = usage && typeof usage === "object" ? firstNumber(usage.input_tokens, usage.prompt_tokens) : 0;
  const outputTokens = usage && typeof usage === "object" ? firstNumber(usage.output_tokens, usage.completion_tokens) : 0;
  const totalTokens = usage && typeof usage === "object" ? firstNumber(usage.total_tokens, inputTokens + outputTokens) : 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: firstNumber(inputDetails && inputDetails.cached_tokens) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: firstNumber(outputDetails && outputDetails.reasoning_tokens) },
    total_tokens: totalTokens,
  };
}

function completed(id, model, usage, text = "") {
  return {
    id,
    status: "completed",
    model,
    output: text ? [messageItem(text)] : [],
    output_text: text,
    usage: normalizeResponseUsage(usage),
  };
}

function messageItem(text) {
  return {
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }],
  };
}

function functionCallItem(state) {
  return {
    type: "function_call",
    call_id: state.callId,
    name: state.name,
    arguments: state.args,
  };
}

function customToolInput(argumentsText) {
  try {
    const parsed = JSON.parse(String(argumentsText || "{}"));
    for (const key of ["input", "patch", "command"]) {
      if (typeof parsed?.[key] === "string") return parsed[key];
    }
  } catch {}
  return String(argumentsText || "");
}

function responseToolCallItem(state, nativeToolNames) {
  if (nativeToolNames.has(state.name)) {
    return {
      type: "custom_tool_call",
      call_id: state.callId,
      name: state.name,
      input: customToolInput(state.args),
    };
  }
  return functionCallItem(state);
}

function normalizeNativeToolCallItem(item, nativeToolNames, calls = new Map()) {
  if (!item || typeof item !== "object" || item.type !== "function_call" || !nativeToolNames.has(item.name)) return item;
  const state = {
    callId: String(item.call_id || item.id || `call_${randomUUID().slice(0, 8)}`),
    name: String(item.name || ""),
    args: typeof item.arguments === "string" ? item.arguments : "",
  };
  calls.set(state.callId, state);
  if (typeof item.id === "string" && item.id) calls.set(item.id, state);
  return {
    ...(typeof item.id === "string" && item.id ? { id: item.id } : {}),
    type: "custom_tool_call",
    call_id: state.callId,
    name: state.name,
    input: customToolInput(state.args),
    ...(typeof item.status === "string" && item.status ? { status: item.status } : {}),
  };
}

function normalizeNativeToolResponse(response, nativeToolNames, calls = new Map()) {
  if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray(response.output)) return response;
  return {
    ...response,
    output: response.output.map((item) => normalizeNativeToolCallItem(item, nativeToolNames, calls)),
  };
}

function normalizeCompletedResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  const out = { ...response };
  if (typeof out.id !== "string") out.id = `resp_${randomUUID().slice(0, 12)}`;
  out.usage = normalizeResponseUsage(out.usage);
  return out;
}

function normalizeResponseEventPayload(event, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const payload = data.type == null ? { type: event, ...data } : { ...data };
  if (payload.type === "response.completed" && payload.response && typeof payload.response === "object") {
    payload.response = normalizeCompletedResponse(payload.response);
  }
  return payload;
}

function chatJsonToResponse(chat, model, nativeToolNames = new Set()) {
  const id = typeof chat.id === "string" ? chat.id : `resp_${randomUUID().slice(0, 12)}`;
  const choice = Array.isArray(chat.choices) ? chat.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === "object" ? choice.message : {};
  const text = typeof message.content === "string" ? message.content : "";
  const response = completed(id, model, chat.usage, text);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  response.output = calls.map((call, index) => responseToolCallItem({
    callId: String(call?.id || `call_${index}`),
    name: String(call?.function?.name || ""),
    args: String(call?.function?.arguments || "{}"),
  }, nativeToolNames));
  if (text) response.output.push(messageItem(text));
  return response;
}

async function pipe(upstream, res, headers = {}, context = {}) {
  if (!upstream.ok) return sendUpstreamHttpError(res, upstream, context, headers);
  const outHeaders = {};
  for (const [key, value] of upstream.headers.entries()) {
    if (key.toLowerCase() !== "content-encoding") outHeaders[key] = value;
  }
  res.writeHead(upstream.status, { ...outHeaders, ...headers });
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
    }
  } catch (error) {
    logBridgeEvent("warn", "upstream pipe ended with stream error", {
      model: context.model || "",
      upstream_model: context.upstreamModel || "",
      route: context.route || "",
      endpoint: context.endpoint || "",
      error: truncateText(error && error.message ? error.message : String(error), 240),
    });
    if (!res.headersSent) return sendTransportError(res, error, context, headers);
  }
  res.end();
}

async function pipeResponses(upstream, res, headers = {}, context = {}, nativeToolNames = new Set()) {
  if (!upstream.ok) return sendUpstreamHttpError(res, upstream, context, headers);
  const contentType = upstream.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    res.writeHead(upstream.status, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...headers,
    });
    let sawTerminalResponseEvent = false;
    const nativeCalls = new Map();
    try {
      for await (const event of parseSse(upstream)) {
        if (event.data === "[DONE]") {
          res.write("data: [DONE]\n\n");
          continue;
        }
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          res.write(`event: ${event.event}\ndata: ${event.data}\n\n`);
          continue;
        }
        const terminalFailure = terminalResponsesFailure(data, context);
        if (terminalFailure) {
          logFinalError(terminalFailure.body, context);
          res.write(failedResponseEvent(responseEventId(data), context.upstreamModel || context.model || "", terminalFailure.body));
          res.end();
          return;
        }
        const eventName = typeof data.type === "string" ? data.type : event.event;
        if (eventName === "response.output_item.added" || eventName === "response.output_item.done") {
          data = { ...data, item: normalizeNativeToolCallItem(data.item, nativeToolNames, nativeCalls) };
        } else if (eventName === "response.function_call_arguments.delta" || eventName === "response.function_call_arguments.done") {
          const state = nativeCalls.get(data.call_id) || nativeCalls.get(data.item_id);
          if (state) {
            if (typeof data.delta === "string") state.args += data.delta;
            else if (typeof data.arguments === "string") state.args = data.arguments;
            continue;
          }
        } else if (eventName === "response.completed" && data.response) {
          data = { ...data, response: normalizeNativeToolResponse(data.response, nativeToolNames, nativeCalls) };
        }
        if (eventName === "response.completed" || eventName === "response.failed" || eventName === "response.incomplete") {
          sawTerminalResponseEvent = true;
        }
        res.write(sse(eventName, data));
      }
    } catch (error) {
      if (sawTerminalResponseEvent) {
        logBridgeEvent("warn", "ignored stream tail decode error after terminal response event", {
          model: context.model || "",
          upstream_model: context.upstreamModel || "",
          route: context.route || "",
          endpoint: context.endpoint || "",
          error: truncateText(error && error.message ? error.message : String(error), 240),
        });
        res.end();
        return;
      }
      const built = bridgeErrorBody({
        kind: "network",
        status: 502,
        upstreamBody: error && error.message,
        model: context.model,
        route: context.route,
        attempts: responseMeta(upstream).attempts || 1,
      });
      logFinalError(built.body, context);
      res.write(failedResponseEvent(`resp_${randomUUID().slice(0, 12)}`, context.upstreamModel || context.model || "", built.body));
    }
    res.end();
    return;
  }
  if (contentType.includes("application/json")) {
    const text = await upstream.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      res.writeHead(upstream.status, { "content-type": contentType, ...headers });
      res.end(text);
      return;
    }
    if (body && typeof body === "object" && !Array.isArray(body) && body.usage) {
      body.usage = normalizeResponseUsage(body.usage);
    }
    body = normalizeNativeToolResponse(body, nativeToolNames);
    return json(res, upstream.status, body, headers);
  }
  return pipe(upstream, res, headers, context);
}

async function streamChat(upstream, res, model, etag, context = {}, nativeToolNames = new Set()) {
  if (!upstream.ok) return sendUpstreamHttpError(res, upstream, context, { "x-models-etag": etag });
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive", "x-models-etag": etag });
  let id = `resp_${randomUUID().slice(0, 12)}`;
  let created = false;
  let usage = null;
  let outputText = "";
  const calls = new Map();
  try {
    for await (const event of parseSse(upstream)) {
      if (event.data === "[DONE]") continue;
      let chunk;
      try { chunk = JSON.parse(event.data); } catch { continue; }
      if (!created) {
        id = typeof chunk.id === "string" ? chunk.id : id;
        res.write(sse("response.created", { response: { id, status: "in_progress", model } }));
        created = true;
      }
      if (isRateLimitError(chunk.error)) {
        const built = rateLimitErrorBody({ model: context.model, route: context.route, upstreamBody: chunk.error.message });
        logFinalError(built.body, context);
        res.write(failedResponseEvent(id, model, built.body));
        res.end();
        return;
      }
      if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
      for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
        const delta = choice && choice.delta && typeof choice.delta === "object" ? choice.delta : {};
        if (isContentFilterReason(choice && choice.finish_reason)) {
          const built = contentFilterErrorBody({ model: context.model, route: context.route });
          logFinalError(built.body, context);
          res.write(failedResponseEvent(id, model, built.body));
          res.end();
          return;
        }
        if (typeof delta.content === "string" && delta.content) {
          outputText += delta.content;
          res.write(sse("response.output_text.delta", { delta: delta.content }));
        }
        for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = typeof toolCall.index === "number" ? toolCall.index : 0;
          const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : {};
          if (!calls.has(index)) {
            const callId = typeof toolCall.id === "string" ? toolCall.id : `call_${randomUUID().slice(0, 8)}`;
            const name = typeof fn.name === "string" ? fn.name : "";
            calls.set(index, { callId, name, args: "" });
            res.write(sse("response.output_item.added", { output_index: index, item: { ...responseToolCallItem(calls.get(index), nativeToolNames), id: `item_${index}` } }));
          } else if (typeof fn.name === "string" && fn.name) {
            calls.get(index).name = fn.name;
          }
          if (typeof fn.arguments === "string" && fn.arguments) {
            const state = calls.get(index);
            state.args += fn.arguments;
            if (!nativeToolNames.has(state.name)) {
              res.write(sse("response.function_call_arguments.delta", { call_id: state.callId, delta: fn.arguments, output_index: index }));
            }
          }
        }
      }
    }
  } catch (error) {
    const built = bridgeErrorBody({
      kind: "network",
      status: 502,
      upstreamBody: error && error.message,
      model: context.model,
      route: context.route,
      attempts: responseMeta(upstream).attempts || 1,
    });
    logFinalError(built.body, context);
    if (!created) res.write(sse("response.created", { response: { id, status: "in_progress", model } }));
    res.write(failedResponseEvent(id, model, built.body));
    res.end();
    return;
  }
  if (!created) res.write(sse("response.created", { response: { id, status: "in_progress", model } }));
  for (const [index, state] of calls) {
    if (!nativeToolNames.has(state.name)) {
      res.write(sse("response.function_call_arguments.done", { call_id: state.callId, name: state.name, arguments: state.args, output_index: index }));
    }
    res.write(sse("response.output_item.done", { output_index: index, item: responseToolCallItem(state, nativeToolNames) }));
  }
  const finalText = hasVisibleText(outputText) ? outputText : "";
  if (finalText) {
    res.write(sse("response.output_item.done", { output_index: calls.size, item: messageItem(outputText) }));
  }
  res.write(sse("response.completed", { response: completed(id, model, usage, finalText) }));
  res.end();
}

async function handleResponses(req, res, options) {
  const body = await bodyJson(req);
  const catalog = catalogInfo(options.catalogPath);
  const model = typeof body.model === "string" ? body.model : "";
  const acceptsSse = String(req.headers.accept || "").includes("text/event-stream");
  const stream = body.stream !== false;
  const route = routeForRequest(model, options.routes, body);
  const authorization = authHeader(req, options.authHome);
  if (!authorization) return fail(res, 401, "缺少 API Key");
  if (route.protocol === "chat") {
    const upstreamModel = route.upstreamModel || bareModel(model);
    const { chat, nativeToolNames } = toChatRequest(body, upstreamModel, route);
    const context = { model, upstreamModel, route: "chat", endpoint: "/chat/completions", codexResponses: true, stream: chat.stream === true, acceptsSse };
    let upstream;
    try {
      upstream = await fetchUpstreamWithPolicy(`${options.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", accept: chat.stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(chat),
      }, options, context);
    } catch (error) {
      return sendTransportError(res, error, context, { "x-models-etag": catalog.etag });
    }
    if (chat.stream) return streamChat(upstream, res, upstreamModel, catalog.etag, context, nativeToolNames);
    const text = await upstream.text();
    if (!upstream.ok) return sendBridgeError(res, {
      kind: "upstream",
      status: upstream.status,
      upstreamStatus: upstream.status,
      upstreamBody: text,
      upstreamRequestId: upstreamRequestId(upstream.headers) || responseMeta(upstream).upstreamRequestId,
      model,
      route: "chat",
      attempts: responseMeta(upstream).attempts || 1,
      context,
    }, { "x-models-etag": catalog.etag });
    try {
      return json(res, 200, chatJsonToResponse(JSON.parse(text), upstreamModel, nativeToolNames), { "x-models-etag": catalog.etag });
    } catch (error) {
      return sendBridgeError(res, {
        kind: "bridge",
        upstreamBody: error && error.message,
        model,
        route: "chat",
        attempts: responseMeta(upstream).attempts || 1,
        context,
      }, { "x-models-etag": catalog.etag });
    }
  }
  const upstreamModel = route.upstreamModel || bareModel(model);
  const context = { model, upstreamModel, route: "responses", endpoint: "/responses", codexResponses: true, stream, acceptsSse };
  const upstreamBody = sanitizeResponsesRequest(body);
  const nativeToolNames = responsesNativeToolNames(body.tools);
  let upstream;
  try {
    upstream = await fetchUpstreamWithPolicy(`${options.upstreamBaseUrl}/responses`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", accept: req.headers.accept || "text/event-stream" },
      body: JSON.stringify({ ...upstreamBody, model: upstreamModel }),
    }, options, context);
  } catch (error) {
    return sendTransportError(res, error, context, { "x-models-etag": catalog.etag });
  }
  return pipeResponses(upstream, res, { "x-models-etag": catalog.etag }, context, nativeToolNames);
}

async function handleChat(req, res, options) {
  const authorization = authHeader(req, options.authHome);
  if (!authorization) return fail(res, 401, "缺少 API Key");
  const requestBody = await bodyText(req);
  let model = "";
  let stream = false;
  const acceptsSse = String(req.headers.accept || "").includes("text/event-stream");
  try {
    const parsed = requestBody.trim() ? JSON.parse(requestBody) : {};
    model = typeof parsed.model === "string" ? parsed.model : "";
    stream = parsed.stream === true;
  } catch {}
  const context = { model, upstreamModel: bareModel(model), route: "chat-direct", endpoint: "/chat/completions", codexResponses: false, stream, acceptsSse };
  let upstream;
  try {
    upstream = await fetchUpstreamWithPolicy(`${options.upstreamBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization, "content-type": req.headers["content-type"] || "application/json", accept: req.headers.accept || "*/*" },
      body: requestBody,
    }, options, context);
  } catch (error) {
    return sendTransportError(res, error, context);
  }
  return pipe(upstream, res, {}, context);
}

function startRuizhiResponsesBridge(input = {}) {
  if (global.__RUIZHI_RESPONSES_BRIDGE__) return global.__RUIZHI_RESPONSES_BRIDGE__;
  ensureLoopbackNoProxy();
  const options = {
    host: input.host || "127.0.0.1",
    port: Number.isInteger(input.port) ? input.port : 17888,
    upstreamBaseUrl: baseUrl(input.upstreamBaseUrl),
    authHome: input.authHome,
    catalogPath: input.catalogPath,
    routes: input.routes && typeof input.routes === "object" ? input.routes : {},
    upstreamTimeoutMs: Number.isInteger(input.upstreamTimeoutMs) ? input.upstreamTimeoutMs : UPSTREAM_REQUEST_TIMEOUT_MS,
  };
  if (!options.upstreamBaseUrl) throw new Error("缺少 upstreamBaseUrl");
  if (!options.authHome) throw new Error("缺少 authHome");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${options.host}:${options.port}`);
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const catalog = catalogInfo(options.catalogPath);
        const data = catalog.models.map((model) => ({
          ...model,
          id: String(model.id || model.slug || ""),
          object: "model",
          owned_by: model.owned_by || "ruizhi",
        }));
        return json(res, 200, { object: "list", data, models: catalog.models }, { "x-models-etag": catalog.etag });
      }
      if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/v1/responses/compact")) return handleResponses(req, res, options);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") return handleChat(req, res, options);
      return fail(res, 404, `未知 bridge 路径：${url.pathname}`);
    } catch (error) {
      return sendBridgeError(res, {
        kind: "bridge",
        upstreamBody: error && error.message ? error.message : String(error),
        route: "bridge",
        attempts: 1,
      });
    }
  });
  server.on("error", (error) => console.error("ruizhi responses bridge failed", error));
  server.listen(options.port, options.host);
  const handle = {
    baseUrl: `http://${options.host}:${options.port}/v1`,
    close: () => new Promise((resolve) => server.close(() => {
      if (global.__RUIZHI_RESPONSES_BRIDGE__ === handle) delete global.__RUIZHI_RESPONSES_BRIDGE__;
      resolve();
    })),
  };
  global.__RUIZHI_RESPONSES_BRIDGE__ = handle;
  return handle;
}

module.exports = { startRuizhiResponsesBridge };
