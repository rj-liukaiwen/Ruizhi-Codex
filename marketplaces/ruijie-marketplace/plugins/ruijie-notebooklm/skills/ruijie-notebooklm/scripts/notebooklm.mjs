#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const TOKEN = "st-ruijie";
const DEFAULT_BACKEND_BASE_URL = "http://107.175.202.99:5173";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = resolve(SCRIPT_PATH, "..");

function usage() {
  console.log(`NotebookLM 原生调用 CLI

用法:
  node ${basename(SCRIPT_PATH)} capabilities
  node ${basename(SCRIPT_PATH)} methods [关键词]
  node ${basename(SCRIPT_PATH)} call <方法名> [参数JSON数组]
  node ${basename(SCRIPT_PATH)} stream <方法名> [参数JSON数组]
  node ${basename(SCRIPT_PATH)} list
  node ${basename(SCRIPT_PATH)} sources <笔记本ID>
  node ${basename(SCRIPT_PATH)} ask <笔记本ID> <问题> [选项JSON对象]
  node ${basename(SCRIPT_PATH)} add-url <笔记本ID> <URL> [标题]
  node ${basename(SCRIPT_PATH)} add-text <笔记本ID> <标题> <正文>
  node ${basename(SCRIPT_PATH)} add-file <笔记本ID> <文件路径> [MIME类型]

环境变量:
  NOTEBOOKLM_BACKEND_BASE_URL  默认 ${DEFAULT_BACKEND_BASE_URL}

脚本目录:
  ${SCRIPT_DIR}`);
}

function backendBaseUrl() {
  const raw = process.env.NOTEBOOKLM_BACKEND_BASE_URL || DEFAULT_BACKEND_BASE_URL;
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function apiUrl(pathname) {
  const url = backendBaseUrl();
  const prefix = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${prefix}/api/notebooklm-bridge/${pathname}`.replace(/\/{2,}/gu, "/");
  return url;
}

function parseJson(raw, fallback, label) {
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error.message}`);
  }
}

function parseArgsJson(raw) {
  const parsed = parseJson(raw, [], "参数");
  if (!Array.isArray(parsed)) {
    throw new Error("参数 JSON 必须是数组，对应 SDK 方法的位置参数");
  }
  return parsed;
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(apiUrl(pathname), {
    ...options,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "x-notebooklm-token": TOKEN,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? body.message
      : text || `HTTP ${response.status}`;
    throw new Error(String(message));
  }

  return body;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function callNative(method, args = []) {
  return await requestJson("call", {
    method: "POST",
    body: JSON.stringify({ method, args }),
  });
}

async function streamNative(method, args = []) {
  const response = await fetch(apiUrl("stream"), {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "x-notebooklm-token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, args }),
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split(/\r?\n\r?\n/u);
    buffer = frames.pop() || "";

    for (const frame of frames) {
      const event = frame.match(/^event:\s*(.+)$/mu)?.[1] || "message";
      const dataLines = frame
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      const data = dataLines.join("\n");
      if (event === "chunk") {
        try {
          printJson(JSON.parse(data));
        } catch {
          console.log(data);
        }
      } else if (event === "done") {
        return;
      } else if (event === "error") {
        throw new Error(data);
      }
    }
  }
}

async function addFile(notebookId, filePath, mimeType) {
  if (!notebookId || !filePath) {
    throw new Error("add-file 需要 <笔记本ID> 和 <文件路径>");
  }

  const absolutePath = resolve(process.cwd(), filePath);
  const content = await readFile(absolutePath);
  return await callNative("sources.addFromFile", [
    notebookId,
    {
      content: { $bufferBase64: content.toString("base64") },
      fileName: basename(absolutePath),
      ...(mimeType ? { mimeType } : {}),
    },
  ]);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "capabilities") {
    printJson(await requestJson("capabilities"));
    return;
  }

  if (command === "methods") {
    const keyword = args[0]?.toLowerCase();
    const capabilities = await requestJson("capabilities");
    const methods = keyword
      ? capabilities.methods.filter((method) => method.toLowerCase().includes(keyword))
      : capabilities.methods;
    printJson(methods);
    return;
  }

  if (command === "call") {
    const [method, argsJson] = args;
    if (!method) throw new Error("call 需要方法名");
    printJson(await callNative(method, parseArgsJson(argsJson)));
    return;
  }

  if (command === "stream") {
    const [method, argsJson] = args;
    if (!method) throw new Error("stream 需要方法名");
    await streamNative(method, parseArgsJson(argsJson));
    return;
  }

  if (command === "list") {
    printJson(await callNative("notebooks.list"));
    return;
  }

  if (command === "sources") {
    const [notebookId] = args;
    if (!notebookId) throw new Error("sources 需要笔记本 ID");
    printJson(await callNative("sources.list", [notebookId]));
    return;
  }

  if (command === "ask") {
    const [notebookId, prompt, optionsJson] = args;
    if (!notebookId || !prompt) throw new Error("ask 需要 <笔记本ID> 和 <问题>");
    const options = parseJson(optionsJson, undefined, "选项");
    printJson(await callNative("generation.chat", options === undefined ? [notebookId, prompt] : [notebookId, prompt, options]));
    return;
  }

  if (command === "add-url") {
    const [notebookId, url, title] = args;
    if (!notebookId || !url) throw new Error("add-url 需要 <笔记本ID> 和 <URL>");
    printJson(await callNative("sources.addFromURL", [notebookId, { url, ...(title ? { title } : {}) }]));
    return;
  }

  if (command === "add-text") {
    const [notebookId, title, content] = args;
    if (!notebookId || !title || !content) throw new Error("add-text 需要 <笔记本ID>、<标题> 和 <正文>");
    printJson(await callNative("sources.addFromText", [notebookId, { title, content }]));
    return;
  }

  if (command === "add-file") {
    const [notebookId, filePath, mimeType] = args;
    printJson(await addFile(notebookId, filePath, mimeType));
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
