"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_FEATURES = {
  menu: false,
  pluginEntryUnlock: true,
  forcePluginInstall: true,
  sessionDelete: false,
  markdownExport: true,
  projectMove: false,
  timeline: true,
  threadScrollRestore: true,
  threadSort: true,
  modelWhitelistUnlock: false,
  zedRemoteOpen: false,
  upstreamWorktreeCreate: false,
  serviceTierControls: false
};

const DEFAULT_PLATFORM_BASE_URL = "https://gptauth.ruijie.com.cn";
const PLATFORM_REQUEST_TIMEOUT_MS = 8_000;
const PLATFORM_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PLATFORM_TOKEN_REFRESH_SKEW_SECONDS = 60;
// A negative one-minute window is an internal renderer sentinel for a wallet
// balance. It deliberately avoids pretending that a rechargeable balance has
// a monthly reset date while still reusing Codex's native usage components.
const RUIZHI_WALLET_WINDOW_SECONDS = -60;

function createRuizhiEnhanceService(options = {}) {
  const codexHome = options.codexHome || process.env.RUIZHI_HOME || path.join(os.homedir(), ".ruizhi");
  const platformBaseUrl = String(
    options.platformBaseUrl || process.env.RUIZHI_PLATFORM_BASE_URL || DEFAULT_PLATFORM_BASE_URL
  ).replace(/\/+$/, "");
  const config = normalizeConfig(options.config);
  const settingsPath = path.join(codexHome, "ruizhi-page-enhance-settings.json");
  const dbPath = path.join(codexHome, "state_5.sqlite");
  const backupDir = path.join(codexHome, "backups", "ruizhi-page-enhance");
  const logPath = path.join(codexHome, "logs", "ruizhi-page-enhance.log");

  function settings() {
    return readSettings(settingsPath, config);
  }

  function writeSettings(patch) {
    const current = settings();
    const next = {
      ...current,
      ...(isRecord(patch) ? patch : {}),
      features: {
        ...current.features,
        ...(isRecord(patch?.features) ? patch.features : {}),
        sessionDelete: false,
        projectMove: false
      }
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }

  async function call(route, payload = {}) {
    try {
      switch (String(route || "")) {
        case "/backend/status":
          return { status: "ok", message: "增强服务已连接", version: "rj-v1" };
        case "/settings/get":
          return settings();
        case "/settings/set":
          return writeSettings(payload);
        case "/diagnostics/log":
          appendDiagnostic(logPath, payload);
          return { status: "ok", message: "日志已记录" };
        case "/delete":
          return { status: "disabled", message: "会话删除增强已停用" };
        case "/undo":
          return { status: "disabled", message: "会话删除撤销增强已停用" };
        case "/export-markdown":
          return withStorage(dbPath, backupDir, (storage) => storage.exportMarkdown(sessionFromPayload(payload)));
        case "/archive-thread":
          return withStorage(dbPath, backupDir, (storage) => storage.archiveThreadBySession(sessionFromPayload(payload)));
        case "/list-archived-threads":
          return withStorage(dbPath, backupDir, (storage) => storage.listArchivedThreads(payload));
        case "/unarchive-thread":
          return withStorage(dbPath, backupDir, (storage) => storage.unarchiveThread(archivedSessionFromPayload(payload)));
        case "/delete-archived-thread":
          return withStorage(dbPath, backupDir, (storage) => storage.deleteArchivedThread(archivedSessionFromPayload(payload)));
        case "/delete-all-archived-threads":
          return withStorage(dbPath, backupDir, (storage) => storage.deleteAllArchivedThreads(payload));
        case "/archived-thread":
          return withStorage(dbPath, backupDir, (storage) => storage.findArchivedThread(String(payload?.title || "")));
        case "/move-thread-workspace":
          return { status: "disabled", message: "会话迁移增强已停用" };
        case "/thread-sort-key":
          return withStorage(dbPath, backupDir, (storage) => storage.threadSortKey(sessionFromPayload(payload)));
        case "/thread-sort-keys":
          return withStorage(dbPath, backupDir, (storage) => storage.threadSortKeys(Array.isArray(payload?.sessions) ? payload.sessions.map(sessionFromPayload) : []));
        case "/models/list":
          return listModelsFromUserCache(codexHome, payload);
        case "/profile/usage":
          return withStorage(dbPath, backupDir, (storage) => storage.profileUsage());
        case "/usage/platform":
          return await platformUsage(codexHome, platformBaseUrl);
        default:
          return { status: "failed", message: `Unknown enhance route: ${route}` };
      }
    } catch (error) {
      appendDiagnostic(logPath, { event: "route_failed", route, error: errorMessage(error) });
      return {
        status: "failed",
        session_id: String(payload?.session_id || ""),
        message: errorMessage(error)
      };
    }
  }

  return { call, settings, writeSettings };
}

async function platformUsage(codexHome, platformBaseUrl) {
  let token = await ensureFreshPlatformAccessToken(codexHome, platformBaseUrl);
  if (!token.accessToken) {
    throw new Error("\u9510\u6377 Codex \u767b\u5f55\u4ee4\u724c\u4e0d\u5b58\u5728\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55");
  }
  let usage;
  let subscription;
  try {
    [usage, subscription] = await requestPlatformBillingPair(platformBaseUrl, token.accessToken);
  } catch (error) {
    if (!isUnauthorizedPlatformError(error) || !token.refreshToken) throw error;
    const refreshedAccessToken = await refreshPlatformAccessToken(codexHome, platformBaseUrl, token.refreshToken, token.source);
    [usage, subscription] = await requestPlatformBillingPair(platformBaseUrl, refreshedAccessToken);
  }
  const totalUsageCents = finiteNonNegativeNumber(usage?.total_usage, "\u6a21\u578b\u5e73\u53f0\u7d2f\u8ba1\u7528\u91cf");
  const limitUsd = finitePositiveNumber(subscription?.hard_limit_usd ?? subscription?.soft_limit_usd, "\u6a21\u578b\u5e73\u53f0\u7528\u91cf\u4e0a\u9650");
  const usedUsd = totalUsageCents / 100;
  const remainingUsd = roundUsage(Math.max(0, limitUsd - usedUsd));
  const usedPercent = Math.min(100, Math.max(0, (usedUsd / limitUsd) * 100));
  return {
    status: "ok",
    data: {
      plan_type: "ruijie",
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          limit_window_seconds: RUIZHI_WALLET_WINDOW_SECONDS,
          reset_at: null
        },
        secondary_window: null
      },
      code_review_rate_limit: null,
      additional_rate_limits: [],
      credits: {
        balance: remainingUsd,
        has_credits: true,
        unlimited: false
      }
    },
    metadata: {
      source: "ruizhi-model-platform",
      used_usd: roundUsage(usedUsd),
      limit_usd: roundUsage(limitUsd),
      remaining_usd: remainingUsd,
      window_kind: "wallet"
    }
  };
}

async function ensureFreshPlatformAccessToken(codexHome, platformBaseUrl, options = {}) {
  const token = readPlatformAuthTokens(codexHome);
  if (!token.accessToken || token.kind === "api_key" || !token.refreshToken) return token;
  if (!options.force && !shouldRefreshPlatformAccessToken(token.accessToken)) return token;
  const accessToken = await refreshPlatformAccessToken(codexHome, platformBaseUrl, token.refreshToken, token.source);
  return { ...token, accessToken };
}

function shouldRefreshPlatformAccessToken(accessToken) {
  const expiresAtSeconds = jwtExpiresAtSeconds(accessToken);
  if (!expiresAtSeconds) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return expiresAtSeconds <= nowSeconds + PLATFORM_TOKEN_REFRESH_SKEW_SECONDS;
}

function jwtExpiresAtSeconds(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(base64UrlToBase64(parts[1]), "base64").toString("utf8"));
    const expiresAtSeconds = Number(payload?.exp);
    return Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0 ? expiresAtSeconds : null;
  } catch {
    return null;
  }
}

function base64UrlToBase64(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
}

function tokenString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function readPlatformAuthTokens(codexHome) {
  const resolvedCodexHome = path.resolve(codexHome);
  const defaultRuizhiHome = path.resolve(os.homedir(), ".ruizhi");
  const fallbackHome = process.env.RUIZHI_PLATFORM_AUTH_FALLBACK_HOME
    ? path.resolve(process.env.RUIZHI_PLATFORM_AUTH_FALLBACK_HOME)
    : resolvedCodexHome === defaultRuizhiHome
      ? path.resolve(os.homedir(), ".codex")
      : "";
  const candidates = [
    path.join(resolvedCodexHome, "auth.json"),
    fallbackHome ? path.join(fallbackHome, "auth.json") : ""
  ];
  const seen = new Set();
  const tokens = [];
  for (const authPath of candidates) {
    if (!authPath) continue;
    const normalizedPath = path.resolve(authPath);
    if (seen.has(normalizedPath) || !fs.existsSync(normalizedPath)) continue;
    seen.add(normalizedPath);
    const auth = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    const apiKey = tokenString(auth?.OPENAI_API_KEY);
    const oauthToken = tokenString(auth?.tokens?.access_token);
    const refreshToken = tokenString(auth?.tokens?.refresh_token);
    if (apiKey) tokens.push({ accessToken: apiKey, refreshToken: "", source: normalizedPath, kind: "api_key" });
    if (oauthToken) tokens.push({ accessToken: oauthToken, refreshToken, source: normalizedPath, kind: "oauth" });
  }
  return tokens.find((candidate) => candidate.kind === "oauth") ?? tokens.find((candidate) => candidate.kind === "api_key") ?? tokens[0] ?? { accessToken: "", refreshToken: "", source: "", kind: "none" };
}

async function requestPlatformBillingPair(platformBaseUrl, accessToken) {
  const headers = { authorization: `Bearer ${accessToken}` };
  return Promise.all([
    requestPlatformJson(`${platformBaseUrl}/v1/dashboard/billing/usage`, headers),
    requestPlatformJson(`${platformBaseUrl}/v1/dashboard/billing/subscription`, headers)
  ]);
}

function isUnauthorizedPlatformError(error) {
  return /HTTP 401/.test(String(error?.message || error));
}

async function refreshPlatformAccessToken(codexHome, platformBaseUrl, refreshToken, authPath = path.join(codexHome, "auth.json")) {
  const response = await requestPlatformJson(`${platformBaseUrl}/oauth/token`, {
    "content-type": "application/x-www-form-urlencoded"
  }, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: PLATFORM_OAUTH_CLIENT_ID
  }).toString());
  const nextAccessToken = typeof response?.access_token === "string" ? response.access_token.trim() : "";
  if (!nextAccessToken) throw new Error("Platform token refresh response did not include an access token");
  const auth = fs.existsSync(authPath) ? JSON.parse(fs.readFileSync(authPath, "utf8")) : {};
  auth.tokens = {
    ...(auth.tokens && typeof auth.tokens === "object" ? auth.tokens : {}),
    ...response,
    access_token: nextAccessToken,
    refresh_token: typeof response?.refresh_token === "string" && response.refresh_token.trim()
      ? response.refresh_token.trim()
      : refreshToken
  };
  auth.last_refresh = new Date().toISOString();
  writeJsonAtomic(authPath, auth);
  return nextAccessToken;
}

async function requestPlatformJson(url, headers, body) {
  try {
    if (typeof fetch === "function") {
      return await requestPlatformJsonWithFetch(url, headers, body);
    }
    return await requestPlatformJsonWithNodeHttp(url, headers, body);
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Platform usage request timed out: ${url}`);
    }
    if (error instanceof TypeError && String(error.message || "").includes("fetch failed")) {
      throw new Error(`Platform usage request failed: ${url}`);
    }
    throw error;
  }
}

async function requestPlatformJsonWithFetch(url, headers, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLATFORM_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: body == null ? "GET" : "POST", headers, body, signal: controller.signal });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok || !contentType.includes("application/json")) {
      const error = new Error(`Platform usage endpoint returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function requestPlatformJsonWithNodeHttp(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const request = client.request(parsed, { method: body == null ? "GET" : "POST", headers, timeout: PLATFORM_REQUEST_TIMEOUT_MS }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const statusCode = response.statusCode || 0;
        const contentType = String(response.headers["content-type"] || "").toLowerCase();
        const body = Buffer.concat(chunks).toString("utf8");
        if (statusCode < 200 || statusCode >= 300 || !contentType.includes("application/json")) {
          reject(new Error(`Platform usage endpoint returned HTTP ${statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Platform usage endpoint returned invalid JSON: ${error?.message || error}`));
        }
      });
    });
    request.on("timeout", () => {
      request.destroy(new Error(`Platform usage request timed out: ${url}`));
    });
    request.on("error", (error) => {
      reject(new Error(`Platform usage request failed: ${url}: ${error?.message || error}`));
    });
    request.end(body || undefined);
  });
}
function finiteNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}无效`);
  return number;
}

function finitePositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}无效`);
  return number;
}

function roundUsage(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function listModelsFromUserCache(codexHome, payload = {}) {
  const catalogPath = path.join(codexHome, "models_cache.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  applyRuizhiModelCatalogCompatibilityPatches(catalog);
  const defaultModel = typeof catalog.default_model === "string" && catalog.default_model.trim()
    ? catalog.default_model.trim()
    : "ray";
  const includeHidden = payload?.includeHidden === true;
  const limit = Number.isInteger(payload?.limit) && payload.limit > 0 ? payload.limit : 100;
  const models = (Array.isArray(catalog.models) ? catalog.models : [])
    .map((model) => modelFromCatalogEntry(model, defaultModel))
    .filter((model) => includeHidden || !model.hidden)
    .slice(0, limit);
  return { status: "ok", data: models, nextCursor: null, etag: typeof catalog.etag === "string" ? catalog.etag : "ruizhi-models" };
}

function modelFromCatalogEntry(entry, defaultModel) {
  const model = String(entry?.model || entry?.slug || "").trim();
  const displayName = String(entry?.displayName || entry?.display_name || model).trim() || model;
  const visibility = String(entry?.visibility || "list");
  const supportedReasoningEfforts = normalizeSupportedReasoningEfforts(entry);
  const defaultReasoningEffort = typeof entry?.defaultReasoningEffort === "string" && entry.defaultReasoningEffort.trim()
    ? entry.defaultReasoningEffort.trim()
    : typeof entry?.default_reasoning_level === "string" && entry.default_reasoning_level.trim()
      ? entry.default_reasoning_level.trim()
      : "medium";
  return {
    ...entry,
    model,
    slug: entry?.slug || model,
    input_modalities: ["text", "image"],
    inputModalities: ["text", "image"],
    displayName,
    display_name: entry?.display_name || displayName,
    description: typeof entry?.description === "string" ? entry.description : "",
    hidden: visibility !== "list",
    isDefault: model === defaultModel || entry?.isDefault === true,
    supported_reasoning_efforts: supportedReasoningEfforts.map((item) => item.reasoningEffort),
    supportedReasoningEfforts,
    default_reasoning_level: defaultReasoningEffort,
    defaultReasoningEffort
  };
}

function normalizeSupportedReasoningEfforts(entry) {
  const fromDesktop = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
        .map((item) => {
          if (typeof item === "string") return { reasoningEffort: item, description: item };
          if (!item || typeof item !== "object") return null;
          const reasoningEffort = String(item.reasoningEffort || item.effort || "").trim();
          if (!reasoningEffort) return null;
          return { reasoningEffort, description: String(item.description || reasoningEffort) };
        })
        .filter(Boolean)
    : [];
  if (fromDesktop.length > 0) return fromDesktop;

  const fromEfforts = Array.isArray(entry?.supported_reasoning_efforts)
    ? entry.supported_reasoning_efforts
        .map((item) => String(item || "").trim())
        .filter(Boolean)
        .map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }))
    : [];
  if (fromEfforts.length > 0) return fromEfforts;

  const fromLevels = Array.isArray(entry?.supported_reasoning_levels)
    ? entry.supported_reasoning_levels
        .map((item) => {
          if (typeof item === "string") return { reasoningEffort: item, description: item };
          if (!item || typeof item !== "object") return null;
          const reasoningEffort = String(item.effort || item.reasoningEffort || "").trim();
          if (!reasoningEffort) return null;
          return { reasoningEffort, description: String(item.description || reasoningEffort) };
        })
        .filter(Boolean)
    : [];
  return fromLevels.length > 0
    ? fromLevels
    : defaultReasoningEfforts().map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
}

function applyRuizhiModelCatalogCompatibilityPatches(catalog) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.models)) return catalog;
  const defaultReasoningLevels = () => [
    { effort: "minimal", description: "最少推理" },
    { effort: "low", description: "轻量推理" },
    { effort: "medium", description: "标准推理" },
    { effort: "high", description: "深度推理" },
    { effort: "xhigh", description: "最高推理" }
  ];
  for (const model of catalog.models) {
    if (!model || typeof model !== "object") continue;
    model.input_modalities = ["text", "image"];
    model.inputModalities = model.input_modalities;
    if (!Array.isArray(model.supported_reasoning_levels) || model.supported_reasoning_levels.length === 0) model.supported_reasoning_levels = defaultReasoningLevels();
    if (typeof model.default_reasoning_level !== "string" || model.default_reasoning_level.length === 0) model.default_reasoning_level = "medium";
    if (!Array.isArray(model.supported_reasoning_efforts) || model.supported_reasoning_efforts.length === 0) model.supported_reasoning_efforts = defaultReasoningEfforts();
    model.supportedReasoningEfforts = model.supported_reasoning_levels.map((entry) => ({
      reasoningEffort: entry.effort,
      description: entry.description ?? entry.effort
    }));
    model.defaultReasoningEffort = model.default_reasoning_level;
  }
  return catalog;
}

function defaultReasoningEfforts() {
  return ["minimal", "low", "medium", "high", "xhigh"];
}

function ensureTextAndImageInputModalities(value) {
  const modalities = Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];
  for (const modality of ["text", "image"]) {
    if (!modalities.includes(modality)) modalities.push(modality);
  }
  return modalities;
}

function normalizeConfig(config) {
  const pageEnhance = isRecord(config?.pageEnhance) ? config.pageEnhance : {};
  return {
    enabled: pageEnhance.enabled !== false,
    appVersion: typeof pageEnhance.appVersion === "string" ? pageEnhance.appVersion.trim() : "",
    features: {
      ...DEFAULT_FEATURES,
      ...(isRecord(pageEnhance.features) ? pageEnhance.features : {}),
      sessionDelete: false,
      projectMove: false
    }
  };
}

function readSettings(settingsPath, config) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    stored = {};
  }
  return {
    enabled: stored.enabled ?? config.enabled,
    appVersion: typeof stored.appVersion === "string" && stored.appVersion.trim() ? stored.appVersion.trim() : config.appVersion,
    features: {
      ...config.features,
      ...(isRecord(stored.features) ? stored.features : {}),
      menu: false,
      sessionDelete: false,
      projectMove: false
    }
  };
}

function sessionFromPayload(payload) {
  return {
    session_id: normalizeThreadId(String(payload?.session_id || payload?.id || "")),
    title: String(payload?.title || "")
  };
}

function archivedSessionFromPayload(payload) {
  return {
    session_id: normalizeThreadId(String(payload?.session_id || payload?.conversationId || payload?.threadId || payload?.id || "")),
    title: String(payload?.title || "")
  };
}

function normalizeThreadId(value) {
  return String(value || "").replace(/^local:/, "");
}

function withStorage(dbPath, backupDir, callback) {
  if (!fs.existsSync(dbPath)) {
    return { status: "failed", message: `数据库不存在：${dbPath}` };
  }
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return { status: "failed", message: "当前 Electron/Node 运行时不支持 node:sqlite" };
  }
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    return callback(new StorageAdapter(db, dbPath, backupDir));
  } finally {
    db.close();
  }
}

class StorageAdapter {
  constructor(db, dbPath, backupDir) {
    this.db = db;
    this.dbPath = dbPath;
    this.backupDir = backupDir;
  }

  deleteThread(session) {
    if (!session.session_id) return failed("", "缺少会话 ID");
    if (!this.hasCodexThreads()) return failed(session.session_id, "不支持当前本地存储结构");
    const thread = this.getThread(session.session_id);
    if (!thread) return failed(session.session_id, "未找到对应会话");
    if (this.hasColumns("threads", ["archived", "archived_at"])) {
      return this.archiveThread(session, thread);
    }

    const tables = {
      threads: [thread],
      thread_dynamic_tools: this.relatedRows("thread_dynamic_tools", "thread_id = ?", [session.session_id]),
      thread_goals: this.relatedRows("thread_goals", "thread_id = ?", [session.session_id]),
      thread_spawn_edges: this.relatedRows("thread_spawn_edges", "parent_thread_id = ? OR child_thread_id = ?", [session.session_id, session.session_id]),
      stage1_outputs: this.relatedRows("stage1_outputs", "thread_id = ?", [session.session_id]),
      agent_job_items: this.relatedRows("agent_job_items", "assigned_thread_id = ?", [session.session_id])
    };
    const rollout = fileBackup(thread.rollout_path);
    if (rollout) tables.__files = [rollout];

    const token = this.writeBackup(session.session_id, tables);
    const backupPath = this.backupPath(token);
    const tx = this.transaction();
    try {
      this.deleteRows("thread_dynamic_tools", "thread_id = ?", [session.session_id]);
      this.deleteRows("thread_goals", "thread_id = ?", [session.session_id]);
      this.deleteRows("thread_spawn_edges", "parent_thread_id = ? OR child_thread_id = ?", [session.session_id, session.session_id]);
      this.deleteRows("stage1_outputs", "thread_id = ?", [session.session_id]);
      if (this.hasTable("agent_job_items") && this.hasColumns("agent_job_items", ["assigned_thread_id"])) {
        this.run("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?", [session.session_id]);
      }
      this.run("DELETE FROM threads WHERE id = ?", [session.session_id]);
      tx.commit();
    } catch (error) {
      tx.rollback();
      return {
        status: "failed",
        session_id: session.session_id,
        message: errorMessage(error),
        undo_token: token,
        backup_path: backupPath
      };
    }

    if (rollout?.path) {
      try {
        fs.rmSync(rollout.path, { force: true });
      } catch (error) {
        return {
          status: "failed",
          session_id: session.session_id,
          message: `本地数据库已删除，但 rollout 删除失败：${errorMessage(error)}`,
          undo_token: token,
          backup_path: backupPath
        };
      }
    }

    return {
      status: "local_deleted",
      session_id: session.session_id,
      message: "已从本地存储删除",
      undo_token: token,
      backup_path: backupPath
    };
  }

  archiveThreadBySession(session) {
    if (!session.session_id) return failed("", "???? ID");
    if (!this.hasCodexThreads()) return failed(session.session_id, "???????????");
    const thread = this.getThread(session.session_id);
    if (!thread) return failed(session.session_id, "???????");
    if (!this.hasColumns("threads", ["archived", "archived_at"])) return failed(session.session_id, "?????????????");
    return this.archiveThread(session, thread);
  }

  archiveThread(session, thread) {
    const rollout = this.archivedRolloutPath(session.session_id, thread.rollout_path);
    if (!rollout.path) return failed(session.session_id, "会话缺少 rollout 文件");
    const token = this.writeBackup(session.session_id, { threads: [thread] });
    const backupPath = this.backupPath(token);
    const archivedAt = Math.floor(Date.now() / 1000);
    try {
      if (rollout.moveFrom && rollout.moveTo) {
        fs.mkdirSync(path.dirname(rollout.moveTo), { recursive: true });
        try {
          fs.renameSync(rollout.moveFrom, rollout.moveTo);
        } catch (error) {
          const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
          if (code !== "ENOENT" && code !== "EEXIST") throw error;
        }
      }
    } catch (error) {
      return {
        status: "failed",
        session_id: session.session_id,
        message: errorMessage(error),
        undo_token: token,
        backup_path: backupPath
      };
    }
    const tx = this.transaction();
    try {
      this.run("UPDATE threads SET archived = 1, archived_at = ?, rollout_path = ? WHERE id = ?", [archivedAt, rollout.path, session.session_id]);
      tx.commit();
    } catch (error) {
      tx.rollback();
      return {
        status: "failed",
        session_id: session.session_id,
        message: errorMessage(error),
        undo_token: token,
        backup_path: backupPath
      };
    }

    return {
      status: "archived",
      session_id: session.session_id,
      message: "已移到已删除对话",
      undo_token: token,
      backup_path: backupPath,
      archived_at: archivedAt
    };
  }

  archivedRolloutPath(threadId, rolloutPath) {
    const original = String(rolloutPath || "").trim();
    if (!original) return { path: "" };
    const current = path.resolve(original);
    const codexHome = path.dirname(this.dbPath);
    const archivedRoot = path.resolve(codexHome, "archived_sessions");
    if (isPathInside(archivedRoot, current)) return { path: current };
    const sessionsRoot = path.resolve(codexHome, "sessions");
    if (!isPathInside(sessionsRoot, current)) return { path: "" };
    const fallbackName = `${String(threadId || "").replace(/[\\/]/g, "_")}.jsonl`;
    const target = path.join(archivedRoot, path.basename(current) || fallbackName);
    return { path: target, moveFrom: current, moveTo: target };
  }

  undo(token) {
    if (!token) return failed("", "缺少撤销 token");
    const backup = this.readBackup(token);
    const tables = isRecord(backup.tables) ? backup.tables : {};
    this.detectRestoreConflicts(tables);
    const tx = this.transaction();
    try {
      for (const [table, rows] of Object.entries(tables)) {
        if (table.startsWith("__") || !Array.isArray(rows)) continue;
        for (const row of rows) {
          if (table === "agent_job_items" && this.updateAgentJobItem(row)) continue;
          if (table === "threads" && this.updateExistingRow(table, row)) continue;
          this.insertRow(table, row);
        }
      }
      tx.commit();
    } catch (error) {
      tx.rollback();
      return {
        status: "failed",
        session_id: String(backup.session_id || ""),
        message: errorMessage(error),
        undo_token: token
      };
    }

    for (const file of Array.isArray(tables.__files) ? tables.__files : []) {
      const target = String(file?.path || "");
      if (!target || fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(String(file.content_b64 || ""), "base64"));
    }

    return {
      status: "undone",
      session_id: String(backup.session_id || ""),
      message: "已恢复本地会话",
      undo_token: token
    };
  }

  exportMarkdown(session) {
    if (!session.session_id) return exportFailed("", "缺少会话 ID");
    if (!this.hasCodexThreads()) return exportFailed(session.session_id, "不支持当前本地存储结构");
    const thread = this.getThread(session.session_id);
    if (!thread) return exportFailed(session.session_id, "未找到对应会话");
    const rolloutPath = String(thread.rollout_path || "");
    if (!rolloutPath || !fs.existsSync(rolloutPath)) return exportFailed(session.session_id, "会话缺少 rollout 文件");
    const title = displayTitle(thread.title || session.title || "Untitled session");
    const messages = rolloutMessages(rolloutPath);
    if (messages.length === 0) return exportFailed(session.session_id, "未找到可导出的用户或助手消息");
    const markdown = renderMarkdown(title, messages);
    const filename = `${safeFilename(title)}-${safeFilename(session.session_id)}.md`;
    return {
      status: "exported",
      session_id: session.session_id,
      message: `已导出为 Markdown：${filename}`,
      filename,
      markdown
    };
  }

  findArchivedThread(title) {
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["archived"])) {
      return { session_id: "", title: "" };
    }
    const row = this.get(
      "SELECT id, title FROM threads WHERE archived = 1 AND (title = ? OR title LIKE ? OR ? LIKE '%' || title || '%') ORDER BY archived_at DESC LIMIT 1",
      [title, `%${title}%`, title]
    );
    return row ? { session_id: String(row.id || ""), title: String(row.title || title) } : { session_id: "", title: "" };
  }

  listArchivedThreads(payload = {}) {
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["archived"])) return [];
    const hostId = String(payload?.host_id || payload?.hostId || "local");
    const rows = this.all(
      "SELECT id, title, cwd, rollout_path, archived_at, updated_at, updated_at_ms, recency_at, recency_at_ms, created_at, created_at_ms FROM threads WHERE archived = 1 ORDER BY COALESCE(archived_at, updated_at, created_at, 0) DESC LIMIT 500"
    );
    return rows.map((row) => archivedThreadResult(row, hostId));
  }

  unarchiveThread(session) {
    if (!session.session_id) return failed("", "缺少会话 ID");
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["archived"])) return failed(session.session_id, "不支持当前本地存储结构");
    const thread = this.getThread(session.session_id);
    if (!thread) return failed(session.session_id, "未找到对应会话");
    const assignments = ["archived = 0"];
    const values = [];
    if (this.hasColumns("threads", ["archived_at"])) assignments.push("archived_at = NULL");
    this.run(`UPDATE threads SET ${assignments.join(", ")} WHERE id = ?`, [...values, session.session_id]);
    return {
      status: "unarchived",
      session_id: session.session_id,
      id: session.session_id,
      message: "已取消归档本地会话"
    };
  }

  deleteArchivedThread(session) {
    if (!session.session_id) return failed("", "缺少会话 ID");
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["archived"])) return failed(session.session_id, "不支持当前本地存储结构");
    const thread = this.getThread(session.session_id);
    if (!thread) return failed(session.session_id, "未找到对应会话");
    if (Number(thread.archived || 0) !== 1) return failed(session.session_id, "会话未归档，已拒绝删除");

    const tables = {
      threads: [thread],
      thread_dynamic_tools: this.relatedRows("thread_dynamic_tools", "thread_id = ?", [session.session_id]),
      thread_goals: this.relatedRows("thread_goals", "thread_id = ?", [session.session_id]),
      thread_spawn_edges: this.relatedRows("thread_spawn_edges", "parent_thread_id = ? OR child_thread_id = ?", [session.session_id, session.session_id]),
      stage1_outputs: this.relatedRows("stage1_outputs", "thread_id = ?", [session.session_id]),
      agent_job_items: this.relatedRows("agent_job_items", "assigned_thread_id = ?", [session.session_id])
    };
    const rollout = fileBackup(thread.rollout_path);
    if (rollout) tables.__files = [rollout];
    const token = this.writeBackup(session.session_id, tables);
    const backupPath = this.backupPath(token);
    const tx = this.transaction();
    try {
      this.deleteRows("thread_dynamic_tools", "thread_id = ?", [session.session_id]);
      this.deleteRows("thread_goals", "thread_id = ?", [session.session_id]);
      this.deleteRows("thread_spawn_edges", "parent_thread_id = ? OR child_thread_id = ?", [session.session_id, session.session_id]);
      this.deleteRows("stage1_outputs", "thread_id = ?", [session.session_id]);
      if (this.hasTable("agent_job_items") && this.hasColumns("agent_job_items", ["assigned_thread_id"])) {
        this.run("UPDATE agent_job_items SET assigned_thread_id = NULL WHERE assigned_thread_id = ?", [session.session_id]);
      }
      this.run("DELETE FROM threads WHERE id = ?", [session.session_id]);
      tx.commit();
    } catch (error) {
      tx.rollback();
      return { status: "failed", session_id: session.session_id, message: errorMessage(error), undo_token: token, backup_path: backupPath };
    }

    if (rollout?.path) {
      try {
        fs.rmSync(rollout.path, { force: true });
      } catch (error) {
        return { status: "failed", session_id: session.session_id, message: `本地数据已删除，但 rollout 删除失败：${errorMessage(error)}`, undo_token: token, backup_path: backupPath };
      }
    }

    return { status: "deleted", session_id: session.session_id, message: "已永久删除已归档本地会话", undo_token: token, backup_path: backupPath };
  }

  deleteAllArchivedThreads(payload = {}) {
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["archived"])) return [];
    const rows = this.all("SELECT id FROM threads WHERE archived = 1 ORDER BY COALESCE(archived_at, updated_at, created_at, 0) DESC LIMIT 500");
    return rows.map((row) => this.deleteArchivedThread({ session_id: String(row.id || "") }));
  }

  moveThreadWorkspace(session, targetCwd) {
    const target = String(targetCwd || "").trim();
    if (!session.session_id) return failed("", "缺少会话 ID");
    if (!this.hasCodexThreads() || !this.hasColumns("threads", ["cwd", "rollout_path"])) {
      return failed(session.session_id, "不支持当前本地存储结构");
    }
    const thread = this.getThread(session.session_id);
    if (!thread) return failed(session.session_id, "未找到对应会话");
    this.run("UPDATE threads SET cwd = ? WHERE id = ?", [target, session.session_id]);
    const rolloutResult = updateRolloutCwd(String(thread.rollout_path || ""), target);
    return {
      status: "moved",
      session_id: session.session_id,
      message: target ? "已移动对话" : "已移动到普通对话",
      previous_cwd: String(thread.cwd || ""),
      target_cwd: target,
      rollout_updated: rolloutResult.updated,
      rollout_error: rolloutResult.error,
      ...timestampPayload(thread)
    };
  }

  threadSortKey(session) {
    const thread = session.session_id ? this.getThread(session.session_id) : null;
    if (!thread) return failed(session.session_id, "未找到对应会话");
    return { status: "ok", session_id: session.session_id, ...timestampPayload(thread) };
  }

  threadSortKeys(sessions) {
    const sortKeys = [];
    for (const session of sessions.slice(0, 200)) {
      if (!session.session_id) continue;
      const thread = this.getThread(session.session_id);
      if (thread) sortKeys.push({ session_id: session.session_id, ...timestampPayload(thread) });
    }
    return { status: "ok", sort_keys: sortKeys };
  }

  profileUsage() {
    if (!this.hasTable("threads") || !this.hasColumns("threads", ["tokens_used"])) {
      return { status: "failed", message: "不支持当前本地存储结构" };
    }
    const rows = this.all("SELECT tokens_used, created_at, updated_at, created_at_ms, updated_at_ms FROM threads WHERE COALESCE(tokens_used, 0) > 0");
    const daily = new Map();
    let totalTextTokens = 0;
    let peakTokens = 0;
    for (const row of rows) {
      const tokens = Math.max(0, Math.round(Number(row.tokens_used) || 0));
      if (tokens <= 0) continue;
      const date = isoDateFromThreadRow(row);
      if (!date) continue;
      const next = (daily.get(date) || 0) + tokens;
      daily.set(date, next);
      totalTextTokens += tokens;
      peakTokens = Math.max(peakTokens, next);
    }
    const dailyUsage = Array.from(daily.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, credits]) => ({ start_date: date, tokens: credits }));
    const streaks = usageStreaks(dailyUsage.map((entry) => entry.start_date));
    return {
      status: "ok",
      profile: {
        display_name: os.userInfo().username || "锐捷 用户",
        profile_picture_url: null,
        username: null
      },
      stats: {
        lifetime_tokens: totalTextTokens,
        peak_daily_tokens: peakTokens,
        longest_running_turn_sec: null,
        current_streak_days: streaks.current,
        longest_streak_days: streaks.longest,
        daily_usage_buckets: dailyUsage,
        fast_mode_usage_percentage: null,
        top_invocations: [],
        most_used_reasoning_effort: null,
        most_used_reasoning_effort_percentage: null,
        unique_skills_used: null,
        total_skills_used: null,
        total_threads: rows.length
      },
      metadata: { stats_error: "" }
    };
  }

  hasCodexThreads() {
    return this.hasTable("threads") && this.hasColumns("threads", ["id", "title", "rollout_path"]);
  }

  getThread(threadId) {
    return this.get("SELECT * FROM threads WHERE id = ?", [normalizeThreadId(threadId)]);
  }

  relatedRows(table, whereClause, params) {
    if (!this.hasTable(table)) return [];
    return this.all(`SELECT * FROM ${quoteIdent(table)} WHERE ${whereClause}`, params);
  }

  deleteRows(table, whereClause, params) {
    if (!this.hasTable(table)) return;
    this.run(`DELETE FROM ${quoteIdent(table)} WHERE ${whereClause}`, params);
  }

  hasTable(table) {
    return !!this.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", [table]);
  }

  hasColumns(table, columns) {
    const existing = new Set(this.all(`PRAGMA table_info(${quoteIdent(table)})`).map((row) => row.name));
    return columns.every((column) => existing.has(column));
  }

  all(sql, params = []) {
    return this.db.prepare(sql).all(...params);
  }

  get(sql, params = []) {
    return this.db.prepare(sql).get(...params);
  }

  run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  transaction() {
    this.db.exec("BEGIN IMMEDIATE");
    let closed = false;
    return {
      commit: () => {
        if (!closed) {
          closed = true;
          this.db.exec("COMMIT");
        }
      },
      rollback: () => {
        if (!closed) {
          closed = true;
          this.db.exec("ROLLBACK");
        }
      }
    };
  }

  backupPath(token) {
    return path.join(this.backupDir, `${token}.json`);
  }

  writeBackup(sessionId, tables) {
    const token = `${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
    fs.mkdirSync(this.backupDir, { recursive: true });
    fs.writeFileSync(
      this.backupPath(token),
      `${JSON.stringify({ session_id: sessionId, source_db: this.dbPath, tables, created_at: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    return token;
  }

  readBackup(token) {
    const backupPath = this.backupPath(token);
    if (!fs.existsSync(backupPath)) throw new Error("撤销备份不存在或已过期");
    return JSON.parse(fs.readFileSync(backupPath, "utf8"));
  }

  detectRestoreConflicts(tables) {
    const files = Array.isArray(tables.__files) ? tables.__files : [];
    for (const file of files) {
      const target = String(file?.path || "");
      if (target && fs.existsSync(target)) throw new Error(`restore conflict: rollout file already exists: ${target}`);
    }
    for (const [table, rows] of Object.entries(tables)) {
      if (table.startsWith("__") || !Array.isArray(rows) || !this.hasTable(table)) continue;
      for (const row of rows) {
        const key = restoreKey(table, row);
        if (!key) continue;
        const where = key.columns.map((column) => `${quoteIdent(column)} = ?`).join(" AND ");
        if (this.get(`SELECT 1 AS ok FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`, key.values)) {
          if (table === "threads" || table === "agent_job_items") continue;
          throw new Error(`restore conflict: ${table} row already exists`);
        }
      }
    }
  }

  updateAgentJobItem(row) {
    if (!isRecord(row) || !this.hasTable("agent_job_items") || row.id == null) return false;
    const existing = this.get("SELECT * FROM agent_job_items WHERE id = ?", [row.id]);
    if (!existing) return false;
    this.run("UPDATE agent_job_items SET assigned_thread_id = ? WHERE id = ?", [row.assigned_thread_id ?? null, row.id]);
    return true;
  }

  updateExistingRow(table, row) {
    if (!isRecord(row) || !this.hasTable(table)) return false;
    const key = restoreKey(table, row);
    if (!key) return false;
    const where = key.columns.map((column) => `${quoteIdent(column)} = ?`).join(" AND ");
    const existing = this.get(`SELECT * FROM ${quoteIdent(table)} WHERE ${where} LIMIT 1`, key.values);
    if (!existing) return false;
    const columns = Object.keys(row);
    if (columns.length === 0) return false;
    const assignments = columns.map((column) => `${quoteIdent(column)} = ?`).join(", ");
    this.run(
      `UPDATE ${quoteIdent(table)} SET ${assignments} WHERE ${where}`,
      [...columns.map((column) => row[column]), ...key.values]
    );
    return true;
  }

  insertRow(table, row) {
    if (!isRecord(row)) return;
    const columns = Object.keys(row);
    if (columns.length === 0) return;
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders})`;
    this.run(sql, columns.map((column) => row[column]));
  }
}

function restoreKey(table, row) {
  if (!isRecord(row)) return null;
  const candidates = {
    threads: ["id"],
    thread_dynamic_tools: ["thread_id", "tool_name"],
    thread_goals: ["thread_id", "goal_id"],
    thread_spawn_edges: ["parent_thread_id", "child_thread_id"],
    stage1_outputs: ["thread_id"],
    agent_job_items: ["id"]
  }[table] || ["id"];
  const columns = candidates.filter((column) => row[column] != null);
  return columns.length ? { columns, values: columns.map((column) => row[column]) } : null;
}

function fileBackup(filePath) {
  const target = String(filePath || "");
  if (!target || !fs.existsSync(target)) return null;
  return { path: target, content_b64: fs.readFileSync(target).toString("base64") };
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function archivedThreadResult(row, hostId) {
  const threadId = String(row?.id || "");
  const cwd = stripExtendedPathPrefix(String(row?.cwd || ""));
  const title = displayTitle(row?.title || row?.first_user_message || "Untitled session");
  const updatedAt = numberOrNull(row?.recency_at_ms) ?? numberOrNull(row?.updated_at_ms) ?? secondsToMs(row?.archived_at) ?? secondsToMs(row?.updated_at) ?? secondsToMs(row?.created_at) ?? 0;
  const createdAt = numberOrNull(row?.created_at_ms) ?? secondsToMs(row?.created_at) ?? updatedAt;
  return {
    id: threadId,
    kind: "local",
    threadId,
    conversationId: threadId,
    threadKey: `local@${encodeURIComponent(hostId || "local")}:${threadId}`,
    name: title,
    preview: title,
    title,
    cwd,
    path: cwd,
    projectLabel: cwd ? path.basename(cwd.replaceAll("\\", "/")) : "",
    rolloutPath: String(row?.rollout_path || ""),
    createdAt,
    updatedAt,
    recencyAt: updatedAt
  };
}

function stripExtendedPathPrefix(value) {
  return String(value || "").replace(/^\\\\\?\\/, "");
}

function secondsToMs(value) {
  const number = numberOrNull(value);
  if (number == null || number <= 0) return null;
  return number < 10_000_000_000 ? number * 1000 : number;
}

function rolloutMessages(rolloutPath) {
  const messages = [];
  for (const line of fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "response_item" || event.payload?.type !== "message") continue;
    const role = event.payload.role;
    const speaker = role === "user" ? "User" : role === "assistant" ? "Assistant" : null;
    if (!speaker) continue;
    const body = serializeMessageContent(event.payload.content);
    if (!body) continue;
    messages.push({ speaker, timestamp: formatTimestamp(event.timestamp), body });
  }
  return messages;
}

function serializeMessageContent(content) {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const type = block?.type;
    if (type === "input_text" || type === "output_text") return normalizeNewlines(block.text || "").trim();
    if (type === "input_image") {
      const url = String(block.image_url || "").trim();
      return url && !url.startsWith("data:") ? `> Image attachment\n[Image link](<${url}>)` : "> Image attachment";
    }
    return "";
  }).filter(Boolean).join("\n\n").trim();
}

function renderMarkdown(title, messages) {
  const lines = [`# ${title}`, ""];
  for (const message of messages) {
    lines.push(`### ${message.speaker}`);
    if (message.timestamp) lines.push(`_${message.timestamp}_`);
    lines.push("", message.body.trimEnd(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function updateRolloutCwd(rolloutPath, targetCwd) {
  if (!rolloutPath || !fs.existsSync(rolloutPath)) return { updated: false, error: "rollout 文件不存在" };
  try {
    const lines = fs.readFileSync(rolloutPath, "utf8").split(/\r?\n/);
    for (let index = 0; index < Math.min(lines.length, 8); index += 1) {
      if (!lines[index].trim()) continue;
      const event = JSON.parse(lines[index]);
      if (event.payload && isRecord(event.payload)) event.payload.cwd = targetCwd;
      if (Object.prototype.hasOwnProperty.call(event, "cwd")) event.cwd = targetCwd;
      lines[index] = JSON.stringify(event);
      fs.writeFileSync(rolloutPath, lines.join("\n"), "utf8");
      return { updated: true, error: "" };
    }
    return { updated: false, error: "未找到可更新的 rollout metadata" };
  } catch (error) {
    return { updated: false, error: errorMessage(error) };
  }
}

function timestampPayload(row) {
  const updatedAtMs = numberOrNull(row.updated_at_ms) ?? numberOrNull(row.updated_at) ?? numberOrNull(row.archived_at);
  return {
    updated_at_ms: updatedAtMs,
    updated_at: row.updated_at ?? null,
    archived_at: row.archived_at ?? null
  };
}

function isoDateFromThreadRow(row) {
  const millis = numberOrNull(row.updated_at_ms) ?? numberOrNull(row.created_at_ms);
  const seconds = numberOrNull(row.updated_at) ?? numberOrNull(row.created_at);
  const date = millis != null ? new Date(millis) : seconds != null ? new Date(seconds * 1000) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

function usageStreaks(dates) {
  const sorted = Array.from(new Set(dates)).sort();
  let longest = 0;
  let currentRun = 0;
  let previous = null;
  for (const date of sorted) {
    currentRun = previous && addUtcDays(previous, 1) === date ? currentRun + 1 : 1;
    longest = Math.max(longest, currentRun);
    previous = date;
  }
  const today = new Date().toISOString().slice(0, 10);
  let current = 0;
  let cursor = today;
  const dateSet = new Set(sorted);
  while (dateSet.has(cursor)) {
    current += 1;
    cursor = addUtcDays(cursor, -1);
  }
  return { current, longest };
}

function addUtcDays(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function displayTitle(value) {
  return String(value || "Untitled session").replace(/\s+/g, " ").trim() || "Untitled session";
}

function safeFilename(value) {
  const cleaned = displayTitle(value).replace(/[<>:"/\\|?*\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  return cleaned || "Untitled session";
}

function formatTimestamp(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : null;
}

function normalizeNewlines(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, "\"\"")}"`;
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function failed(sessionId, message) {
  return { status: "failed", session_id: sessionId, message };
}

function exportFailed(sessionId, message) {
  return { status: "failed", session_id: sessionId, message, filename: null, markdown: null };
}

function appendDiagnostic(logPath, payload) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...sanitizePayload(payload) })}\n`, "utf8");
  } catch {
  }
}

function sanitizePayload(payload) {
  if (!isRecord(payload)) return { payload_type: typeof payload };
  const safe = {};
  for (const [key, value] of Object.entries(payload)) {
    if (/token|key|authorization|secret/i.test(key)) {
      safe[key] = "[redacted]";
    } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
    } else {
      safe[key] = Array.isArray(value) ? `[array:${value.length}]` : "[object]";
    }
  }
  return safe;
}

function errorMessage(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

module.exports = {
  DEFAULT_FEATURES,
  createRuizhiEnhanceService
};
