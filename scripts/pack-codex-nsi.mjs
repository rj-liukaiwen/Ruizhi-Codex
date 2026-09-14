#!/usr/bin/env node
// pack-codex-nsi.mjs
// 把 vendor\codex-desktop\windows\current\app 原样打成 NSIS 安装包（不改造）
// 用法: node scripts/pack-codex-nsi.mjs

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

// ---- 路径常量 ----
const sourceRoot = path.join(projectRoot, "vendor", "codex-desktop", "windows", "current");
const sourceDir = path.join(sourceRoot, "app");
const manifestPath = path.join(sourceRoot, "source-manifest.json");
const templatePath = path.join(projectRoot, "scripts", "templates", "codex-installer.nsi");
const outDir = path.join(projectRoot, "dist", "codex-installer");
const nsiOutPath = path.join(projectRoot, ".work", "codex-installer.nsi");

function log(msg) {
  console.log(`[codex-nsis] ${msg}`);
}

// ---- 读取版本号 ----
if (!fs.existsSync(manifestPath)) {
  console.error(`[codex-nsis] 找不到 source-manifest.json: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const rawVersion = manifest.packageVersion || "1.0.0.0";

// VIProductVersion 需要 X.X.X.X 四段，每段 0-65535
function toVersionInfo(v) {
  const parts = String(v).split(".").map((n) => {
    const num = parseInt(n, 10);
    if (Number.isNaN(num)) return 0;
    return Math.max(0, Math.min(65535, num));
  });
  while (parts.length < 4) parts.push(0);
  return parts.slice(0, 4).join(".");
}
const version = toVersionInfo(rawVersion);

// ---- 校验源目录 ----
if (!fs.existsSync(sourceDir)) {
  console.error(`[codex-nsis] 源目录不存在: ${sourceDir}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(sourceDir, "ChatGPT.exe"))) {
  console.error(`[codex-nsis] 源目录缺少入口 ChatGPT.exe: ${sourceDir}`);
  process.exit(1);
}

const outFile = path.join(outDir, `Codex-Setup-${rawVersion}.exe`);
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.dirname(nsiOutPath), { recursive: true });

// ---- 渲染 .nsi ----
let nsi = fs.readFileSync(templatePath, "utf8");
const sourceDirWin = sourceDir.replace(/\\/g, "\\");
const outFileWin = outFile.replace(/\\/g, "\\");
nsi = nsi.split("@@VERSION@@").join(version);
nsi = nsi.split("@@SOURCE_DIR@@").join(sourceDirWin);
nsi = nsi.split("@@OUT_FILE@@").join(outFileWin);
// NSIS 3.x 需 BOM 才能正确识别 UTF-8 脚本（含中文注释/文案），否则报 "Bad text encoding"
fs.writeFileSync(nsiOutPath, "\uFEFF" + nsi, "utf8");

// ---- 查找 makensis ----
function findMakensisInTree(dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const maybe = path.join(full, "makensis.exe");
      if (fs.existsSync(maybe)) results.push(maybe);
      else results.push(...findMakensisInTree(full));
    }
  }
  return results;
}

function findMakensis() {
  const candidates = [];
  // 1. PATH
  for (const p of (process.env.PATH || "").split(path.delimiter)) {
    if (p) candidates.push(path.join(p, "makensis.exe"));
  }
  // 2. 项目内便携版
  candidates.push(...findMakensisInTree(path.join(projectRoot, ".work", "nsis")));
  // 3. 常见安装路径
  candidates.push("C:\\Program Files (x86)\\NSIS\\makensis.exe");
  candidates.push("C:\\Program Files\\NSIS\\makensis.exe");
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

const makensis = findMakensis();
if (!makensis) {
  console.error("[codex-nsis] 未找到 makensis.exe，请先安装 NSIS（放到 .work/nsis 或加入 PATH）");
  process.exit(1);
}

// ---- 统计源目录大小 ----
function dirSize(dir) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try {
          total += fs.statSync(full).size;
          count++;
        } catch {}
      }
    }
  }
  return { total, count };
}
const { total, count } = dirSize(sourceDir);
log(`makensis : ${makensis}`);
log(`version  : ${rawVersion} (VI: ${version})`);
log(`source   : ${sourceDir}`);
log(`output   : ${outFile}`);
log(`source size: ${(total / 1024 / 1024).toFixed(1)} MB / ${count} files`);
log(`开始编译（固体 LZMA 压缩，预计 5-15 分钟，请耐心等待）...`);

// ---- 调用 makensis 编译 ----
const t0 = Date.now();
try {
  execFileSync(makensis, [`-V2`, nsiOutPath], {
    stdio: "inherit",
    cwd: path.dirname(nsiOutPath),
    maxBuffer: 1024 * 1024 * 64,
  });
} catch (err) {
  console.error("[codex-nsis] makensis 编译失败:", err.message);
  process.exit(1);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ---- 验证产物 ----
if (fs.existsSync(outFile)) {
  const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  const ratio = ((fs.statSync(outFile).size / total) * 100).toFixed(1);
  log(`完成 (耗时 ${elapsed}s)`);
  log(`产物: ${outFile}`);
  log(`大小: ${sizeMB} MB (压缩率 ${ratio}%)`);
} else {
  console.error(`[codex-nsis] 编译完成但未找到输出文件: ${outFile}`);
  process.exit(1);
}
