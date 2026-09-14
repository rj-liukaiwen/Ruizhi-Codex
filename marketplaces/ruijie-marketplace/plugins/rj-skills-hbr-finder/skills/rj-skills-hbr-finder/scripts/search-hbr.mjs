#!/usr/bin/env node
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "st-ruijie";
const BACKEND_BASE_URL = "http://skills.rjagi.cn/";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

const args = process.argv.slice(2);
const jsonOutput = consumeFlag(args, "--json");
const lastId = consumeOption(args, "--last-id") ?? consumeOption(args, "--lastId");
const excludeIds = consumeOption(args, "--exclude-ids") ?? consumeOption(args, "--excludeIds");
const limit = clampNumber(consumeOption(args, "--limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
const command = args[0];

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === "article") {
    const articleId = args[1]?.trim();
    if (!articleId) {
      throw new Error("article 需要文章 ID");
    }
    await printArticle(articleId, jsonOutput);
  } else {
    const query = args.join(" ").trim();
    if (!query) {
      usage();
      process.exit(1);
    }
    await printSearch(query, limit, jsonOutput);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function usage() {
  process.stderr.write(`哈佛商业评论中文版检索 CLI

用法:
  node ${basename(SCRIPT_PATH)} "AI 战略"
  node ${basename(SCRIPT_PATH)} "组织管理" --limit 5
  node ${basename(SCRIPT_PATH)} "组织管理" --limit 20 --json
  node ${basename(SCRIPT_PATH)} "组织管理" --last-id 2 --exclude-ids 481309,478039 --json
  node ${basename(SCRIPT_PATH)} "最新 AI 管理" --json
  node ${basename(SCRIPT_PATH)} article 481309
  node ${basename(SCRIPT_PATH)} article 481309 --json

环境变量:
  后端地址已固定为 ${BACKEND_BASE_URL}
`);
}

async function printSearch(query, limitValue, asJson) {
  const params = {
    query,
    limit: String(limitValue),
    ...(lastId ? { last_id: lastId } : {}),
    ...(excludeIds ? { exclude_ids: excludeIds } : {}),
    ...(asJson ? { format: "json" } : {}),
  };
  if (asJson) {
    printJson(removeDuplicateReadMoreLinks(await requestJson("search", params)));
    return;
  }

  process.stdout.write(`${removeDuplicateReadMoreLinks(await requestText("search", params))}\n`);
}

async function printArticle(articleId, asJson) {
  const path = `articles/${encodeURIComponent(articleId)}.md`;
  const params = asJson ? { format: "json" } : {};
  if (asJson) {
    printJson(await requestJson(path, params));
    return;
  }

  process.stdout.write(`${await requestText(path, params)}\n`);
}

async function requestJson(pathname, params) {
  const body = await request(pathname, params, "json");
  if (body && typeof body === "object" && body.success === true && "data" in body) {
    return body.data;
  }
  return body;
}

async function requestText(pathname, params) {
  return await request(pathname, params, "text");
}

async function request(pathname, params, responseType) {
  const response = await fetch(apiUrl(pathname, params), {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "x-skill-token": TOKEN,
      "x-hbr-token": TOKEN,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const message = body && typeof body === "object" && "message" in body
      ? body.message
      : text || `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  if (responseType === "text") {
    return text.trimEnd();
  }

  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`服务返回的 JSON 不合法：${error.message}`);
  }
}

function apiUrl(pathname, params = {}) {
  const url = backendBaseUrl();
  const prefix = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/u, "");
  url.pathname = `${prefix}/api/hbr-bridge/${pathname}`.replace(/\/{2,}/gu, "/");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function backendBaseUrl() {
  const url = new URL(BACKEND_BASE_URL);
  url.pathname = url.pathname || "/";
  url.search = "";
  url.hash = "";
  return url;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function removeDuplicateReadMoreLinks(value) {
  if (typeof value === "string") {
    return value.replace(/\n\n\[阅读全文\]\([^)]+\)\n/gu, "\n");
  }

  if (Array.isArray(value)) {
    return value.map((item) => removeDuplicateReadMoreLinks(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, removeDuplicateReadMoreLinks(item)]),
    );
  }

  return value;
}

function consumeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) {
    return false;
  }
  values.splice(index, 1);
  return true;
}

function consumeOption(values, name) {
  const index = values.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = values[index + 1] ?? null;
  values.splice(index, 2);
  return value;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function fail(message) {
  process.stderr.write(`错误：${message}\n`);
  process.exit(1);
}
