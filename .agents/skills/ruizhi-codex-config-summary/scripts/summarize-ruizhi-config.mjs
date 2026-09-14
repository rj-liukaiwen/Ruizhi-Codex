#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const includeEnv = args.includes("--include-env");
const includeFiles = args.includes("--include-files");
const homeIndex = args.indexOf("--home");
const home = (homeIndex >= 0 ? args[homeIndex + 1] : null) || process.env.RUIZHI_HOME || path.join(os.homedir(), ".ruizhi");
const files = { config: path.join(home, "config.toml"), auth: path.join(home, "auth.json"), models: path.join(home, "models_cache.json") };

function read(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }
function readJson(file) { const raw = read(file); if (raw === null) return { value: null, error: "missing" }; try { return { value: JSON.parse(raw), error: null }; } catch (e) { return { value: null, error: String(e.message || e) }; } }
function scalar(value) { const s = String(value || "").trim(); if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\([\\"])/g, "$1"); if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1); if (s === "true" || s === "false") return s === "true"; if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s); return s; }
function parseToml(raw) { const out = {}; let section = ""; for (const source of (raw || "").split(/\r?\n/)) { const line = source.replace(/\s+#.*$/, "").trim(); const sectionMatch = line.match(/^\[([^\]]+)\]$/); if (sectionMatch) { section = sectionMatch[1]; continue; } const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/); if (match) out[section ? `${section}.${match[1]}` : match[1]] = scalar(match[2]); } return out; }
function configValue(suffix) { const entry = Object.entries(config).find(([key]) => key === suffix || key.endsWith(`.${suffix}`)); return entry ? entry[1] : null; }
function cleanUrl(value) { if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value; try { const u = new URL(value); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.toString().replace(/\/$/, ""); } catch { return value.replace(/[?#].*$/, ""); } }
function secret(key) { return /key|token|secret|password|cookie|authorization|credential/i.test(key); }
function safe(key, value) { return secret(key) ? (value ? "present (redacted)" : "absent") : cleanUrl(value); }
function collectModels(value, result = []) { if (Array.isArray(value)) { for (const item of value) collectModels(item, result); return result; } if (!value || typeof value !== "object") return result; const id = value.slug || value.id || value.model || value.name; if (typeof id === "string" && (value.display_name || value.displayName || value.slug || value.supported_reasoning_levels)) result.push({ id, displayName: value.display_name || value.displayName || id, visibility: value.visibility ?? null, supportedInApi: value.supported_in_api ?? value.supportedInApi ?? null }); for (const child of Object.values(value)) collectModels(child, result); return result; }
function unique(items) { const seen = new Set(); return items.filter((item) => !seen.has(item.id) && seen.add(item.id)); }
function fileInfo(file) { const stat = fs.existsSync(file) ? fs.statSync(file) : null; return { path: file, exists: Boolean(stat), size: stat?.size ?? null, modified: stat?.mtime?.toISOString() ?? null }; }

const config = parseToml(read(files.config));
const authRead = readJson(files.auth);
const modelsRead = readJson(files.models);
const auth = authRead.value && typeof authRead.value === "object" ? authRead.value : {};
const listedModels = unique(collectModels(modelsRead.value));
const endpoints = Object.entries(config).filter(([key, value]) => typeof value === "string" && /url|callback|redirect|auth|oauth|token|issuer|proxy|base/i.test(key)).map(([key, value]) => ({ key, value: safe(key, value) }));
const bridgeHost = config["modelBridge.host"] || "127.0.0.1";
const bridgePort = config["modelBridge.port"] || null;
const envNames = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "RUIZHI_PROXY", "RUIZHI_PLATFORM_BASE_URL", "RUIZHI_OPENAI_BASE_URL"];
const report = { generatedAt: new Date().toISOString(), home, files: Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fileInfo(file)])), provider: { name: config.model_provider || null, defaultModel: config.model || null, reasoningEffort: config.model_reasoning_effort || null, baseUrl: safe("base_url", configValue("base_url")), envKey: safe("env_key", configValue("env_key")), wireApi: configValue("wire_api") || null, bridge: { enabled: configValue("modelBridge.enabled") ?? null, host: bridgeHost, port: bridgePort, localBaseUrl: bridgePort ? `http://${bridgeHost}:${bridgePort}/v1` : null } }, models: { count: listedModels.length, listed: listedModels }, proxy: { localBridge: bridgePort ? `http://${bridgeHost}:${bridgePort}/v1` : null, configured: endpoints.filter((item) => /proxy|base_url/i.test(item.key)) }, auth: { mode: auth.auth_mode || config.auth_mode || null, fields: Object.keys(auth).sort().map((key) => ({ key, state: secret(key) ? "present (redacted)" : safe(key, auth[key]) })), tokenPresent: Boolean(auth.tokens || auth.access_token || auth.refresh_token), endpoints: endpoints.filter((item) => /auth|oauth|token|issuer|login|callback|redirect/i.test(item.key)) }, marketplaces: { ruijie: fs.existsSync(path.join(home, "plugins", "marketplaces", "ruijie-marketplace")), openaiCurated: fs.existsSync(path.join(home, "plugins", "marketplaces", "openai-curated")) }, warnings: [] };
if (includeEnv) report.proxy.environment = Object.fromEntries(envNames.map((key) => [key, process.env[key] ? "present (value redacted)" : "absent"]));
if (!report.files.config.exists) report.warnings.push("config.toml not found");
if (!report.files.auth.exists) report.warnings.push("auth.json not found");
if (!report.files.models.exists) report.warnings.push("models_cache.json not found");
if (modelsRead.error && modelsRead.error !== "missing") report.warnings.push(`models_cache.json invalid: ${modelsRead.error}`);
if (authRead.error && authRead.error !== "missing") report.warnings.push(`auth.json invalid: ${authRead.error}`);
if (report.files.models.modified && Date.now() - Date.parse(report.files.models.modified) > 7 * 86400000) report.warnings.push("models_cache.json is older than seven days");

function printText(value) {
  console.log("\u9510\u6377Codex \u672c\u5730\u914d\u7f6e\u6458\u8981");
  console.log(`\u914d\u7f6e\u6839\u76ee\u5f55: ${value.home}`);
  console.log(`\n[\u63d0\u4f9b\u65b9\u4e0e\u6a21\u578b] provider=${value.provider.name || "not found"}`);
  console.log(`base_url=${value.provider.baseUrl || "not found"}`);
  console.log(`default_model=${value.provider.defaultModel || "not found"}`);
  console.log(`wire_api=${value.provider.wireApi || "not found"}`);
  console.log(`bridge=${value.provider.bridge.localBaseUrl || "disabled/not found"}`);
  console.log(`listed_models=${value.models.count}`);
  for (const model of value.models.listed) console.log(`  - ${model.id}${model.displayName !== model.id ? ` (${model.displayName})` : ""}`);
  console.log("\n[\u4ee3\u7406\u4e0e\u7f51\u7edc]");
  for (const item of value.proxy.configured) console.log(`${item.key}=${item.value}`);
  if (value.proxy.environment) for (const [key, state] of Object.entries(value.proxy.environment)) console.log(`${key}=${state}`);
  console.log("\n[\u8ba4\u8bc1\u4e0e\u56de\u8c03\u5730\u5740]");
  console.log(`auth_mode=${value.auth.mode || "not found"}`);
  console.log(`token_state=${value.auth.tokenPresent ? "present (redacted)" : "absent/not found"}`);
  if (value.auth.endpoints.length) for (const item of value.auth.endpoints) console.log(`${item.key}=${item.value}`); else console.log("explicit_auth_callback_or_oauth_endpoint=not found");
  console.log(`\n[\u63d2\u4ef6\u5e02\u573a] ruijie=${value.marketplaces.ruijie ? "present" : "not found"}; openai-curated=${value.marketplaces.openaiCurated ? "present" : "not found"}`);
  if (value.warnings.length) { console.log("\n[\u8b66\u544a]"); for (const warning of value.warnings) console.log(`- ${warning}`); }
  if (includeFiles) { console.log("\n[\u68c0\u67e5\u6587\u4ef6]"); for (const item of Object.values(value.files)) console.log(`${item.path}: ${item.exists ? "present" : "missing"}`); }
}
if (jsonOutput) { if (!includeFiles) delete report.files; console.log(JSON.stringify(report, null, 2)); } else printText(report);