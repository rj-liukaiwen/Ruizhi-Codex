#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_URL = "https://gptauth.ruijie.com.cn/v1";
const DEFAULT_MODEL = "doubao-seedance-2-0-260128";
const DEFAULT_DURATION = 10;
const DEFAULT_RATIO = "16:9";
const DEFAULT_RESOLUTION = "720p";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const RATIO_SIZES = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "21:9": { width: 2560, height: 1080 }
};

function usage() {
  console.error(`用法：
  node generate-video.mjs --prompt "..." [--image path-or-url] [--duration 10] [--ratio 16:9] [--out output/video/result.mp4] [--force]
  node generate-video.mjs --prompt-file prompt.txt --dry-run

参数：
  --prompt <text>             文生视频提示词。
  --prompt-file <path>        从 UTF-8 文本文件读取提示词。
  --image <path-or-url>       可选，用于图生视频的图片路径或 URL。
  --model <id>                默认值：${DEFAULT_MODEL}
  --duration <seconds>        4-15 秒，默认值：${DEFAULT_DURATION}
  --ratio <ratio>             16:9、9:16、1:1、4:3、3:4、21:9 或 adaptive。
  --resolution <value>        默认值：${DEFAULT_RESOLUTION}
  --out <path>                返回视频 URL 时下载到该文件。
  --force                     覆盖 --out 指定的已有文件。
  --no-poll                   只提交任务并打印任务元数据，不轮询。
  --dry-run                   只打印请求 payload，不提交任务。
  --poll-interval-ms <ms>     默认值：${DEFAULT_POLL_INTERVAL_MS}
  --timeout-ms <ms>           默认值：${DEFAULT_TIMEOUT_MS}`);
}

function parseArgs(argv) {
  const args = {
    model: DEFAULT_MODEL,
    duration: DEFAULT_DURATION,
    ratio: DEFAULT_RATIO,
    resolution: DEFAULT_RESOLUTION,
    poll: true,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    force: false,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${item} 缺少参数`);
      return argv[i];
    };
    switch (item) {
      case "--prompt":
        args.prompt = next();
        break;
      case "--prompt-file":
        args.promptFile = next();
        break;
      case "--image":
        args.image = next();
        break;
      case "--model":
        args.model = next();
        break;
      case "--duration":
        args.duration = Number(next());
        break;
      case "--ratio":
        args.ratio = next();
        break;
      case "--resolution":
        args.resolution = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-poll":
        args.poll = false;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--poll-interval-ms":
        args.pollIntervalMs = Number(next());
        break;
      case "--timeout-ms":
        args.timeoutMs = Number(next());
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${item}`);
    }
  }
  return args;
}

function readPrompt(args) {
  if (String(args.prompt ?? "").trim() && String(args.promptFile ?? "").trim()) {
    throw new Error("只能使用 --prompt 或 --prompt-file 其中一个");
  }
  if (String(args.promptFile ?? "").trim()) {
    return fs.readFileSync(args.promptFile, "utf8").trim();
  }
  return String(args.prompt ?? "").trim();
}

function validateArgs(args, prompt) {
  if (!prompt) throw new Error("缺少 --prompt 或 --prompt-file");
  if (!Number.isInteger(args.duration) || args.duration < 4 || args.duration > 15) {
    throw new Error("--duration 必须是 4 到 15 的整数秒");
  }
  if (args.ratio !== "adaptive" && !RATIO_SIZES[args.ratio]) {
    throw new Error("--ratio 必须是 16:9、9:16、1:1、4:3、3:4、21:9 或 adaptive");
  }
  if (!Number.isFinite(args.pollIntervalMs) || args.pollIntervalMs < 1000) {
    throw new Error("--poll-interval-ms 不能小于 1000");
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs < args.pollIntervalMs) {
    throw new Error("--timeout-ms 必须大于 --poll-interval-ms");
  }
}

function baseUrl() {
  return String(process.env.RUIZHI_OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function readAuthJsonKey(root) {
  if (!root) return "";
  const file = path.join(root, "auth.json");
  if (!fs.existsSync(file)) return "";
  const auth = JSON.parse(fs.readFileSync(file, "utf8"));
  return String(auth.OPENAI_API_KEY || "").trim();
}

function apiKey() {
  const fromEnv = String(process.env.RUIZHI_API_KEY || "").trim();
  if (fromEnv) return fromEnv;
  const home = os.homedir();
  const roots = [
    process.env.RUIZHI_HOME,
    process.env.CODEX_HOME,
    path.join(home, ".ruizhi")
  ];
  for (const root of roots) {
    const key = readAuthJsonKey(root);
    if (key) return key;
  }
  const openaiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (openaiKey) return openaiKey;
  throw new Error("缺少 APIKey：请先登录锐捷，或设置 RUIZHI_API_KEY");
}

function imageValue(input) {
  if (!input) return undefined;
  if (/^https?:\/\//i.test(input) || /^data:/i.test(input)) return input;
  const abs = path.resolve(input);
  const ext = path.extname(abs).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const data = fs.readFileSync(abs).toString("base64");
  return `data:${mime};base64,${data}`;
}

function buildPayload(args, prompt) {
  const size = RATIO_SIZES[args.ratio] ?? RATIO_SIZES[DEFAULT_RATIO];
  const payload = {
    model: args.model,
    prompt,
    duration: args.duration,
    width: size.width,
    height: size.height,
    metadata: {
      ratio: args.ratio,
      duration: args.duration,
      resolution: args.resolution
    }
  };
  const image = imageValue(args.image);
  if (image) payload.image = image;
  return payload;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const detail = json?.error?.message || json?.message || text.slice(0, 500);
    throw new Error(`视频接口请求失败：${response.status} ${response.statusText} ${detail}`);
  }
  return json ?? {};
}

function taskIdFrom(response) {
  return response.id || response.task_id || response.data?.id || response.data?.task_id || "";
}

function taskStatusFrom(response) {
  return String(response.status || response.task_status || response.data?.status || response.data?.task_status || "").toLowerCase();
}

function videoUrlFrom(response) {
  return response.url || response.video_url || response.output_url || response.data?.url || response.data?.video_url || response.data?.output_url || response.data?.[0]?.url || "";
}

async function submitTask(payload, key) {
  return requestJson(`${baseUrl()}/video/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function fetchTask(id, key) {
  return requestJson(`${baseUrl()}/video/generations/${encodeURIComponent(id)}`, {
    headers: {
      "Authorization": `Bearer ${key}`
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollTask(id, key, args) {
  const started = Date.now();
  for (;;) {
    const task = await fetchTask(id, key);
    const status = taskStatusFrom(task);
    if (["completed", "succeeded", "success"].includes(status) || videoUrlFrom(task)) return task;
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
      throw new Error(`视频生成失败：${JSON.stringify(task)}`);
    }
    if (Date.now() - started > args.timeoutMs) {
      throw new Error(`视频生成超时，task_id=${id}`);
    }
    console.error(`正在轮询任务 ${id}：${status || "unknown"}`);
    await sleep(args.pollIntervalMs);
  }
}

async function downloadVideo(url, out, force) {
  const target = path.resolve(out);
  if (fs.existsSync(target) && !force) {
    throw new Error(`输出文件已存在：${target}（使用 --force 覆盖）`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`视频下载失败：${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = readPrompt(args);
  validateArgs(args, prompt);
  const payload = buildPayload(args, prompt);
  if (args.dryRun) {
    console.log(JSON.stringify({ endpoint: `${baseUrl()}/video/generations`, payload }, null, 2));
    return;
  }
  const key = apiKey();
  const submitted = await submitTask(payload, key);
  const id = taskIdFrom(submitted);
  console.log(JSON.stringify({ submitted }, null, 2));
  const finalTask = args.poll && id ? await pollTask(id, key, args) : submitted;
  const url = videoUrlFrom(finalTask);
  if (args.poll) console.log(JSON.stringify({ final: finalTask }, null, 2));
  if (args.out && url) {
    const saved = await downloadVideo(url, args.out, args.force);
    console.log(`已写入 ${saved}`);
    console.log(`Markdown [生成的视频](${saved.replaceAll("\\", "/")})`);
  } else if (url) {
    console.log(`视频 ${url}`);
  } else if (args.out) {
    throw new Error("任务完成响应中没有视频 URL，无法下载 --out");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
