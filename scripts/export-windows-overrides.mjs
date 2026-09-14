import fs from "node:fs";
import path from "node:path";
import {
  cleanDir,
  exportOverridesFromDirs,
  extractAsar,
  projectRoot,
  resolveProjectPath
} from "./windows-asar-overrides.mjs";

const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
const appVersion = process.env.RUIZHI_BUILD_VERSION ?? config.version;
const workRoot = resolveProjectPath(path.join(".work", "windows-overrides-export"));

function log(message) {
  console.log(`[ruizhi] ${message}`);
}

function readArg(name) {
  const prefix = `--${name}=`;
  const item = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function assertVersionFilePart(version) {
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
    throw new Error(`版本号不能用于测试目录名：${version}`);
  }
}

function windowsTestAppDirName(version = appVersion) {
  assertVersionFilePart(version);
  return `test-app-${version}`;
}

function findPatchedAsar() {
  const explicit = readArg("patched-asar");
  if (explicit) {
    return resolveProjectPath(explicit);
  }

  const candidates = [
    path.join(projectRoot, "dist", windowsTestAppDirName(), "resources", "app.asar"),
    path.join(projectRoot, "dist", "test-app", "resources", "app.asar"),
    path.join(projectRoot, ".work", "windows-app-out", "resources", "app.asar")
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("没有找到已补丁 app.asar。请先运行 npm run build:windows，或传入 --patched-asar=<path>。");
}

function officialAsarPath() {
  const appRoot = resolveProjectPath(config.windows.sourceAppRoot);
  return path.join(appRoot, "resources", "app.asar");
}

function main() {
  const baselineAsar = officialAsarPath();
  const patchedAsar = findPatchedAsar();
  const baselineDir = path.join(workRoot, "baseline");
  const patchedDir = path.join(workRoot, "patched");

  cleanDir(workRoot);

  log(`解包官方 asar：${baselineAsar}`);
  extractAsar(baselineAsar, baselineDir);
  log(`解包已补丁 asar：${patchedAsar}`);
  extractAsar(patchedAsar, patchedDir);

  const result = exportOverridesFromDirs(baselineDir, patchedDir);
  log(`覆盖层已导出：${result.overridesRoot}`);
  log(`差异文件：${result.changedFiles}，跳过运行时依赖文件：${result.skippedFiles}，总大小：${result.totalBytes} 字节`);
}

main();
