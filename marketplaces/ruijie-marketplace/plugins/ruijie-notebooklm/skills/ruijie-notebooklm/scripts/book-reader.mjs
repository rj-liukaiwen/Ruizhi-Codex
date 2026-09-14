#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, parse, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const TOKEN = "st-ruijie";
const DEFAULT_BACKEND_BASE_URL = "http://107.175.202.99:5173";
const SOURCE_TIMEOUT_MS = Number(process.env.NOTEBOOKLM_SOURCE_TIMEOUT_MS || 180000);
const POLL_INTERVAL_MS = Number(process.env.NOTEBOOKLM_SOURCE_POLL_INTERVAL_MS || 2500);
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function usage() {
  process.stdout.write(`锐捷-读书助手 CLI

用法:
  node ${basename(SCRIPT_PATH)} pick-upload [--file <PDF路径>]
  node ${basename(SCRIPT_PATH)} generate --notebook-id <笔记本ID> --kind <quick|summary|diagram> [--diagram-type <mindmap|flowchart|timeline>]

说明:
  pick-upload 会弹出系统文件选择框，只允许选择一个 PDF。
  generate 会把 Markdown 结果输出到 stdout。

环境变量:
  NOTEBOOKLM_BACKEND_BASE_URL  默认 ${DEFAULT_BACKEND_BASE_URL}
  NOTEBOOKLM_SOURCE_TIMEOUT_MS 默认 ${SOURCE_TIMEOUT_MS}
`);
}

function parseArgs(argv) {
  const result = { _: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }

    const eqIndex = item.indexOf("=");
    if (eqIndex !== -1) {
      result[item.slice(2, eqIndex)] = item.slice(eqIndex + 1);
      continue;
    }

    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }

  return result;
}

function requiredString(options, key, label) {
  const value = options[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少 ${label}：--${key}`);
  }
  return value.trim();
}

function backendBaseUrl() {
  const raw = process.env.NOTEBOOKLM_BACKEND_BASE_URL || DEFAULT_BACKEND_BASE_URL;
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

function apiUrl(pathname) {
  return backendApiUrl(`notebooklm-bridge/${pathname}`);
}

function backendApiUrl(pathname) {
  const url = backendBaseUrl();
  const prefix = url.pathname === "/" ? "" : url.pathname;
  url.pathname = `${prefix}/api/${pathname}`.replace(/\/{2,}/gu, "/");
  return url;
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
    const message = body && typeof body === "object" && typeof body.message === "string"
      ? body.message
      : text || `HTTP ${response.status}`;
    throw new Error(message);
  }

  if (body && typeof body === "object" && body.success === false) {
    throw new Error(String(body.message || body.error || "NotebookLM 调用失败"));
  }

  return body;
}

async function callNative(method, args = []) {
  const body = await requestJson("call", {
    method: "POST",
    body: JSON.stringify({ method, args }),
  });

  if (!body || typeof body !== "object" || body.success !== true) {
    throw new Error(`NotebookLM 原生方法返回异常：${previewJson(body)}`);
  }

  return body.result;
}

async function requestSse(pathname, options = {}) {
  const response = await fetch(backendApiUrl(pathname), {
    ...options,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "x-notebooklm-token": TOKEN,
      ...(options.headers || {}),
    },
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
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

      if (event === "error") {
        throw new Error(data || "NotebookLM 后端返回 SSE 错误");
      }

      if (event !== "complete") {
        continue;
      }

      let parsed;
      try {
        parsed = data ? JSON.parse(data) : {};
      } catch {
        throw new Error(`NotebookLM 后端返回的完成事件不是合法 JSON：${data}`);
      }

      if (!parsed || typeof parsed !== "object") {
        throw new Error(`NotebookLM 后端完成事件格式异常：${previewJson(parsed)}`);
      }

      if (parsed.success === false) {
        throw new Error(String(parsed.error || parsed.message || "NotebookLM 后端处理失败"));
      }

      return parsed;
    }
  }

  throw new Error("NotebookLM 后端 SSE 流提前结束，未收到完成事件");
}

function previewJson(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}

function escapeMultipartQuotedValue(value) {
  return String(value).replace(/[\r\n]/gu, "_").replace(/\\/gu, "\\\\").replace(/"/gu, "%22");
}

function buildPdfMultipartBody(fileName, content) {
  const boundary = `----ruijie-book-reader-${randomUUID().replace(/-/gu, "")}`;
  const header = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${escapeMultipartQuotedValue(fileName)}"`,
      "Content-Type: application/pdf",
      "",
      "",
    ].join("\r\n"),
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  return {
    boundary,
    body: Buffer.concat([header, content, footer]),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: null, stdout, stderr: stderr || error.message, error });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

async function pickPdfFile(explicitFile) {
  if (explicitFile) {
    return resolve(process.cwd(), explicitFile);
  }

  const os = platform();
  if (os === "win32") {
    return await pickPdfFileWindows();
  }

  if (os === "darwin") {
    return await pickPdfFileMac();
  }

  throw new Error("当前系统不支持弹出 PDF 文件选择框；请使用 --file <PDF路径>");
}

async function pickPdfFileWindows() {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    "$dialog.Title = '选择一本 PDF 书籍'",
    "$dialog.Filter = 'PDF 文件 (*.pdf)|*.pdf'",
    "$dialog.Multiselect = $false",
    "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
    "  Write-Output $dialog.FileName",
    "  exit 0",
    "}",
    "exit 2",
  ].join("; ");

  const result = await runProcess("powershell.exe", [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);

  if (result.status === 2) {
    return null;
  }

  if (result.status !== 0) {
    throw new Error(`文件选择框打开失败：${result.stderr.trim() || `exit ${result.status}`}`);
  }

  return extractSelectedPdfPath(result.stdout);
}

function extractSelectedPdfPath(output) {
  const text = String(output || "");
  const candidates = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => line.match(/[A-Za-z]:\\[^\r\n]+?\.pdf/giu) || [])
    .map((item) => item.trim());

  return candidates.at(-1) || text.trim() || null;
}

async function pickPdfFileMac() {
  const result = await runProcess("osascript", [
    "-e",
    "try",
    "-e",
    "set chosenFile to choose file with prompt \"选择一本 PDF 书籍\" of type {\"com.adobe.pdf\"}",
    "-e",
    "POSIX path of chosenFile",
    "-e",
    "on error number -128",
    "-e",
    "return \"__CANCELLED__\"",
    "-e",
    "end try",
  ]);

  if (result.status !== 0) {
    throw new Error(`文件选择框打开失败：${result.stderr.trim() || `exit ${result.status}`}`);
  }

  const filePath = result.stdout.trim();
  if (!filePath || filePath === "__CANCELLED__") {
    return null;
  }

  return filePath;
}

async function validatePdf(filePath) {
  const absolutePath = resolve(process.cwd(), filePath);
  const info = await stat(absolutePath);
  if (!info.isFile()) {
    throw new Error("选择的路径不是文件");
  }

  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buffer, 0, 5, 0);
    if (bytesRead < 5 || buffer.toString("utf8") !== "%PDF-") {
      throw new Error("文件头不是 %PDF-，拒绝上传非 PDF 文件");
    }
  } finally {
    await handle.close();
  }

  return absolutePath;
}

function findStringByKeys(value, keys, seen = new WeakSet()) {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim()) {
      return entry.trim();
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys, seen);
      if (found) return found;
    }
    return null;
  }

  for (const item of Object.values(value)) {
    const found = findStringByKeys(item, keys, seen);
    if (found) return found;
  }

  return null;
}

function extractNotebookId(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const found = findStringByKeys(value, ["projectId", "notebookId", "notebookID", "id"]);
  if (!found) {
    throw new Error(`无法从 NotebookLM 创建结果中提取 notebookId：${previewJson(value)}`);
  }
  return found;
}

function extractSourceIds(value) {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  if (Array.isArray(value)) {
    const ids = value
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim());
    if (ids.length > 0) return ids;
  }

  if (value && typeof value === "object") {
    for (const key of ["allSourceIds", "sourceIds"]) {
      if (Array.isArray(value[key])) {
        const ids = value[key]
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim());
        if (ids.length > 0) return ids;
      }
    }

    const single = findStringByKeys(value, ["sourceId"]);
    if (single) return [single];
  }

  throw new Error(`无法从 PDF 上传结果中提取 sourceId：${previewJson(value)}`);
}

function sourceIdOf(source) {
  if (!source || typeof source !== "object") return "";
  return String(source.sourceId || source.id || "").trim();
}

function sourceTitleOf(source) {
  if (!source || typeof source !== "object") return "";
  return String(source.title || source.fileName || source.name || sourceIdOf(source) || "未知来源");
}

function sourceErrorOf(source) {
  if (!source || typeof source !== "object") return "";
  return String(source.error || source.message || source.errorMessage || "").trim();
}

function normalizeSourceState(raw) {
  if (raw === 2) return "ready";
  if (raw === 3) return "failed";
  if (raw === 1 || raw === 0 || raw === undefined || raw === null) return "processing";

  const value = String(raw).toLowerCase();
  if (value.includes("ready") || value.includes("done") || value.includes("complete")) return "ready";
  if (value.includes("fail") || value.includes("error")) return "failed";
  return "processing";
}

function listSourcesFrom(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.sources)) return value.sources;
  if (value && typeof value === "object" && Array.isArray(value.result)) return value.result;
  return [];
}

function inspectSources(value, sourceIds) {
  const targetIds = new Set(sourceIds.filter(Boolean));
  const sources = listSourcesFrom(value);

  if (value && typeof value === "object") {
    if (value.allReady === true) {
      return "ready";
    }

    if (Array.isArray(value.processing) && value.processing.length > 0) {
      const processingIds = value.processing.map((item) => String(item));
      if (targetIds.size === 0 || processingIds.some((id) => targetIds.has(id))) {
        return "processing";
      }
    }
  }

  if (sources.length === 0) {
    return "unknown";
  }

  const matched = sources.filter((source) => {
    const id = sourceIdOf(source);
    return targetIds.size === 0 || targetIds.has(id);
  });

  if (matched.length === 0) {
    return "processing";
  }

  for (const source of matched) {
    const state = normalizeSourceState(source.state ?? source.status);
    if (state === "failed") {
      const suffix = sourceErrorOf(source);
      throw new Error(`NotebookLM 来源处理失败：${sourceTitleOf(source)}${suffix ? `：${suffix}` : ""}`);
    }
    if (state !== "ready") {
      return "processing";
    }
  }

  return "ready";
}

async function getSourceReadiness(notebookId, sourceIds) {
  try {
    const listResult = await callNative("sources.list", [notebookId]);
    const status = inspectSources(listResult, sourceIds);
    return status === "unknown" ? "processing" : status;
  } catch (error) {
    const statusResult = await callNative("sources.status", [notebookId]);
    const status = inspectSources(statusResult, sourceIds);
    if (status === "ready" || status === "processing") {
      return status;
    }
    throw new Error(`检查来源状态失败：${error.message}`);
  }
}

async function waitForSourcesReady(notebookId, sourceIds) {
  const deadline = Date.now() + SOURCE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const status = await getSourceReadiness(notebookId, sourceIds);
    if (status === "ready") {
      return;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("NotebookLM 仍在处理 PDF 来源，稍后可用同一个 notebookId 继续生成");
}

async function listReadySourceIds(notebookId) {
  const listResult = await callNative("sources.list", [notebookId]);
  const sources = listSourcesFrom(listResult);
  const readyIds = [];

  for (const source of sources) {
    const state = normalizeSourceState(source?.state ?? source?.status);
    if (state === "failed") {
      const suffix = sourceErrorOf(source);
      throw new Error(`NotebookLM 来源处理失败：${sourceTitleOf(source)}${suffix ? `：${suffix}` : ""}`);
    }
    if (state === "ready") {
      const id = sourceIdOf(source);
      if (id) {
        readyIds.push(id);
      }
    }
  }

  if (readyIds.length === 0) {
    throw new Error("当前笔记本还没有处理完成的 PDF 来源");
  }

  return readyIds;
}

function buildNotebookTitle(pdfPath, shortId) {
  const name = parse(pdfPath).name.trim() || "未命名书籍";
  return `读书助手-${name}-${shortId}`;
}

async function createNotebook(title) {
  const result = await callNative("notebooks.create", [{ title }]);
  return extractNotebookId(result);
}

async function uploadPdf(notebookId, pdfPath) {
  const content = await readFile(pdfPath);
  const multipart = buildPdfMultipartBody(basename(pdfPath), content);

  const payload = await requestSse(`notebooks/${encodeURIComponent(notebookId)}/book-source/stream/upload-pdf`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${multipart.boundary}`,
      "Content-Length": String(multipart.body.length),
    },
    body: multipart.body,
  });

  if (!payload.result) {
    throw new Error(`NotebookLM 后端未返回来源信息：${previewJson(payload)}`);
  }

  return extractSourceIds(payload.result);
}

async function pickUpload(options) {
  const selected = await pickPdfFile(typeof options.file === "string" ? options.file : "");
  if (!selected) {
    process.stdout.write(`${JSON.stringify({ status: "cancelled" }, null, 2)}\n`);
    return;
  }

  const pdfPath = await validatePdf(selected);
  const shortId = randomUUID().slice(0, 8);
  const notebookTitle = buildNotebookTitle(pdfPath, shortId);
  const notebookId = await createNotebook(notebookTitle);
  const sourceIds = await uploadPdf(notebookId, pdfPath);
  await waitForSourcesReady(notebookId, sourceIds);

  process.stdout.write(`${JSON.stringify({
    status: "uploaded",
    pdfName: basename(pdfPath),
    notebookTitle,
    notebookId,
    sourceId: sourceIds[0] || null,
    sourceIds,
  }, null, 2)}\n`);
}

function buildPrompt(kind, diagramType) {
  if (kind === "quick") {
    return `请忽略此前任何对话、提问、回答和中间研究结论，只根据本笔记本当前来源中的 PDF 书籍内容，输出一份中文《快速读书》。

这是一份短版读前判断，不是长报告。请先自行识别书名与作者；如果某项信息无法从当前来源确认，明确写“信息不足”，不要猜。

输出结构：
1. 书名与作者：仅填写当前来源可以确认的信息
2. 核心主旨：用 1-2 句话概括全书真正要回答的问题和核心判断
3. 内容结构：用 3-4 个要点概括全书主要部分或关键论点的推进关系
4. 关键案例：列举 2-3 个当前来源里能明确确认的代表性案例、实验或故事
5. 适读人群：说明这本书最适合谁读，以及阅读收益是什么

写作要求：
- 使用 Markdown
- 总字数控制在 300 字左右，保持紧凑、可快速扫读
- 语言理性、准确、精炼，不写空洞赞美
- 不要补充作者背景、出版信息、外部评价或延伸资料
- 所有内容必须基于笔记本中的 PDF 来源，不得凭空捏造`;
  }

  if (kind === "summary") {
    return `请忽略此前任何对话、提问、回答和中间研究结论，只根据本笔记本当前来源中的 PDF 书籍内容，输出一份中文《书籍总结》。

目标不是把字数堆满，而是把这本书的论证链路、章节推进、关键概念、方法边界和实践启发讲清楚。凡是当前来源无法确认的章节细节、案例、引文或背景信息，都不要补写。

请按以下结构输出：
1. 基础判断：这本书试图解决什么问题，作者的核心结论是什么
2. 全书结构：按部分或章节梳理主题推进关系，说明每一部分在整体论证中的作用
3. 关键概念与方法：逐项解释书中最重要的概念、模型、方法及其前提条件
4. 重点章节精读：挑出最关键的章节或段落，拆解观点、证据、案例和推导过程
5. 论证链路与边界：说明作者如何得出结论，哪些地方证据更强，哪些地方需要谨慎吸收
6. 实践启发：基于书中内容总结可以直接迁移的方法、适用场景和常见误用风险

写作要求：
- 使用 Markdown
- 结构清楚，分段和分点清晰，拒绝机械注水和重复改写
- 语言理性、准确、精炼，不发散
- 不要推荐额外书单或外部资料
- 所有内容必须基于笔记本中的 PDF 来源，不得凭空捏造`;
  }

  const diagramPrompts = {
    mindmap: [
      "请只根据本笔记本当前来源中的 PDF 书籍内容，输出一个 Markdown Mermaid 思维导图代码块。",
      "只输出一个 ```mermaid 代码块，不要代码块外解释。",
      "Mermaid 必须以 mindmap 开头。",
      "根节点使用书名；下级优先包含核心主旨、章节结构、关键概念、论证脉络、案例与实践启发。",
      "节点文字简短，最多 4 层深度，每层 children 不要太多。",
      "不得补充 PDF 来源之外的信息。",
    ],
    flowchart: [
      "请只根据本笔记本当前来源中的 PDF 书籍内容，输出一个 Markdown Mermaid 概念关系图代码块。",
      "只输出一个 ```mermaid 代码块，不要代码块外解释。",
      "Mermaid 必须以 flowchart TD 开头。",
      "用于展示书中的核心概念、因果链、方法步骤或论证关系。",
      "节点文字简短，关系箭头清晰，不要堆太多节点。",
      "不得补充 PDF 来源之外的信息。",
    ],
    timeline: [
      "请只根据本笔记本当前来源中的 PDF 书籍内容，输出一个 Markdown Mermaid 时间线代码块。",
      "只输出一个 ```mermaid 代码块，不要代码块外解释。",
      "Mermaid 必须以 timeline 开头。",
      "适合历史、传记、技术演化或阶段推进类书籍；如果没有明确年份，不要杜撰年份，可用阶段名称组织。",
      "条目文字简短，突出关键事件、阶段或思想演进。",
      "不得补充 PDF 来源之外的信息。",
    ],
  };

  return diagramPrompts[diagramType].join("\n");
}

function extractChatText(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  for (const key of ["text", "answer", "response", "content", "message"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }

  if (Array.isArray(value.rawData) && value.rawData.length > 0) {
    const first = value.rawData[0];
    if (Array.isArray(first) && typeof first[0] === "string" && first[0].trim()) {
      return first[0].trim();
    }
    if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
  }

  const chunks = Array.isArray(value.chunks) ? value.chunks : [];
  const longestChunk = chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk.trim();
      if (chunk && typeof chunk === "object") {
        return String(chunk.text || chunk.response || chunk.content || "").trim();
      }
      return "";
    })
    .sort((a, b) => b.length - a.length)[0];

  return longestChunk || "";
}

function extractChatError(value) {
  if (value && typeof value === "object" && Array.isArray(value.chunks)) {
    const errorChunk = value.chunks.find((chunk) => chunk && typeof chunk === "object" && chunk.isError);
    if (errorChunk) {
      if (errorChunk.errorCode === 8) {
        return "您已达到每日对话次数上限，改日再来吧！";
      }
      return `NotebookLM 生成失败${errorChunk.errorCode ? `，错误码 ${errorChunk.errorCode}` : ""}`;
    }
  }

  return `NotebookLM 返回空内容：${previewJson(value)}`;
}

function diagramKeyword(diagramType) {
  if (diagramType === "flowchart") return "flowchart";
  return diagramType;
}

function looksLikeDiagramText(text, diagramType) {
  const keyword = diagramKeyword(diagramType);
  if (text.includes("```mermaid")) {
    return new RegExp(`(^|\\n)\\s*${keyword}\\b`, "u").test(text);
  }
  return new RegExp(`(^|\\n)\\s*${keyword}\\b`, "u").test(text);
}

function findDiagramText(value, diagramType, seen = new WeakSet()) {
  if (typeof value === "string") {
    const text = value.trim();
    return looksLikeDiagramText(text, diagramType) ? text : "";
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  if (seen.has(value)) {
    return "";
  }
  seen.add(value);

  for (const key of ["text", "response", "content", "message"]) {
    const found = findDiagramText(value[key], diagramType, seen);
    if (found) return found;
  }

  for (const key of ["rawData", "chunks"]) {
    const found = findDiagramText(value[key], diagramType, seen);
    if (found) return found;
  }

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const found = findDiagramText(value[index], diagramType, seen);
      if (found) return found;
    }
    return "";
  }

  for (const item of Object.values(value)) {
    const found = findDiagramText(item, diagramType, seen);
    if (found) return found;
  }

  return "";
}

function normalizeDiagramMarkdown(text, diagramType) {
  if (text.includes("```mermaid")) {
    return text.trim();
  }

  const keyword = diagramType === "flowchart" ? "flowchart" : diagramType;
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim().startsWith(keyword));
  if (start !== -1) {
    return `\`\`\`mermaid\n${lines.slice(start).join("\n").trim()}\n\`\`\``;
  }

  return text.trim();
}

function isValidDiagramMarkdown(text, diagramType) {
  return looksLikeDiagramText(text, diagramType);
}

async function generate(options) {
  const notebookId = requiredString(options, "notebook-id", "笔记本 ID");
  const kind = requiredString(options, "kind", "生成类型");
  if (!["quick", "summary", "diagram"].includes(kind)) {
    throw new Error("--kind 只能是 quick、summary 或 diagram");
  }

  const diagramType = String(options["diagram-type"] || "mindmap");
  if (kind === "diagram" && !["mindmap", "flowchart", "timeline"].includes(diagramType)) {
    throw new Error("--diagram-type 只能是 mindmap、flowchart 或 timeline");
  }

  const prompt = buildPrompt(kind, diagramType);
  await waitForSourcesReady(notebookId, []);
  const sourceIds = await listReadySourceIds(notebookId);
  const result = await callNative("generation.chat", [notebookId, prompt, { sourceIds }]);
  const text = kind === "diagram"
    ? findDiagramText(result, diagramType) || extractChatText(result)
    : extractChatText(result);
  if (!text) {
    throw new Error(extractChatError(result));
  }

  if (kind === "diagram") {
    const diagram = normalizeDiagramMarkdown(text, diagramType);
    if (!isValidDiagramMarkdown(diagram, diagramType)) {
      throw new Error(`NotebookLM 未返回有效的 Mermaid ${diagramType} 图表，请稍后重试`);
    }
    process.stdout.write(`${diagram}\n`);
    return;
  }

  process.stdout.write(`${text.trim()}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const [command] = options._;

  if (!command || command === "help" || command === "--help" || command === "-h" || options.help) {
    usage();
    return;
  }

  if (command === "pick-upload") {
    await pickUpload(options);
    return;
  }

  if (command === "generate") {
    await generate(options);
    return;
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
