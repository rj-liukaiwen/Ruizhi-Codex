#!/usr/bin/env node
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const TOKEN = "st-ruijie";
const BACKEND_BASE_URL = "http://skills.rjagi.cn/";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_LIMIT = 5;
const DEFAULT_COURSE_LIMIT = 3;
const MAX_LIMIT = 10;

const args = process.argv.slice(2);
const jsonOutput = consumeFlag(args, "--json");
const type = consumeOption(args, "--type") ?? "all";
const limit = clampNumber(consumeOption(args, "--limit"), type === "course" ? DEFAULT_COURSE_LIMIT : DEFAULT_LIMIT, 1, MAX_LIMIT);
const offset = clampNumber(consumeOption(args, "--offset"), 0, 0, Number.MAX_SAFE_INTEGER);
const command = args[0];

try {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    process.exit(command ? 0 : 1);
  }

  if (command === "course") {
    await printMarkdownResource("courses", args[1], "course 需要课程 ID", jsonOutput);
  } else if (command === "article") {
    await printMarkdownResource("articles", args[1], "article 需要文章 ID", jsonOutput);
  } else if (command === "collections") {
    await printCollections(args.slice(1).join(" ").trim(), limit, jsonOutput);
  } else if (command === "collection") {
    await printMarkdownResource("collections", args[1], "collection 需要集合 packageId", jsonOutput);
  } else {
    const query = args.join(" ").trim();
    if (!query) {
      usage();
      process.exit(1);
    }
    await printSearch(query, type, limit, offset, jsonOutput);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

function usage() {
  process.stderr.write(`混沌大学 CLI

用法:
  node ${basename(SCRIPT_PATH)} "战略"
  node ${basename(SCRIPT_PATH)} "战略" --type course
  node ${basename(SCRIPT_PATH)} "战略" --type article
  node ${basename(SCRIPT_PATH)} "战略" --json
  node ${basename(SCRIPT_PATH)} "战略" --type course --limit 3 --offset 3
  node ${basename(SCRIPT_PATH)} course <courseId>
  node ${basename(SCRIPT_PATH)} article <articleId>
  node ${basename(SCRIPT_PATH)} collections "战略"
  node ${basename(SCRIPT_PATH)} collection <packageId>

环境变量:
  后端地址已固定为 ${BACKEND_BASE_URL}
`);
}

async function printSearch(query, searchType, limitValue, offsetValue, asJson) {
  if (!["all", "course", "article", "topic"].includes(searchType)) {
    throw new Error("--type 只能是 all、course、article、topic");
  }

  const params = {
    query,
    type: searchType,
    limit: String(limitValue),
    offset: String(offsetValue),
    ...(asJson ? { format: "json" } : {}),
  };
  await printRequest("search", params, asJson);
}

async function printCollections(category, limitValue, asJson) {
  if (!category) {
    throw new Error("collections 需要分类关键词，例如：战略、组织、AI");
  }

  const params = {
    category,
    limit: String(limitValue),
    ...(asJson ? { format: "json" } : {}),
  };
  await printRequest("collections", params, asJson);
}

async function printMarkdownResource(kind, id, missingMessage, asJson) {
  const normalizedId = id?.trim();
  if (!normalizedId) {
    throw new Error(missingMessage);
  }

  await printRequest(`${kind}/${encodeURIComponent(normalizedId)}.md`, asJson ? { format: "json" } : {}, asJson);
}

async function printRequest(pathname, params, asJson) {
  if (asJson) {
    printJson(await requestJson(pathname, params));
    return;
  }

  process.stdout.write(`${await requestText(pathname, params)}\n`);
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
      "x-hundun-token": TOKEN,
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
  url.pathname = `${prefix}/api/hundun-bridge/${pathname}`.replace(/\/{2,}/gu, "/");
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
