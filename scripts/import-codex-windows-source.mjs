import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import fsExtra from "fs-extra";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));

function log(message) {
  console.log(`[ruizhi] ${message}`);
}

function assertInsideProject(targetPath) {
  const resolvedRoot = path.resolve(projectRoot).toLowerCase();
  const resolvedTarget = path.resolve(targetPath).toLowerCase();
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`拒绝写入项目外路径：${targetPath}`);
  }
}

function resolveProjectPath(targetPath) {
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  assertInsideProject(resolvedTarget);
  return resolvedTarget;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }

  return hash.digest("hex");
}

function fileInfo(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    sha256: sha256File(filePath)
  };
}

function appRootFromCodexExe(exePath) {
  const normalized = path.resolve(exePath);
  const resourcesDir = path.dirname(normalized);
  const appRoot = path.dirname(resourcesDir);
  if (
    path.basename(resourcesDir).toLowerCase() === "resources" &&
    fs.existsSync(path.join(resourcesDir, "app.asar")) &&
    fs.existsSync(path.join(appRoot, config.windows.sourceExeName))
  ) {
    return appRoot;
  }
  return null;
}

function parsePackageVersion(appRoot) {
  const packageDir = path.basename(path.dirname(appRoot));
  const match = packageDir.match(/^OpenAI\.Codex_([^_]+)_/);
  if (match) {
    return match[1];
  }

  const versionPath = path.join(appRoot, "version");
  if (fs.existsSync(versionPath)) {
    return fs.readFileSync(versionPath, "utf8").trim();
  }

  return null;
}

function validateCodexAppRoot(appRoot) {
  const appAsarPath = path.join(appRoot, "resources", "app.asar");
  const sourceExePath = path.join(appRoot, config.windows.sourceExeName);

  if (!fs.existsSync(appAsarPath)) {
    throw new Error(`Codex Desktop 源缺少 resources\\app.asar：${appRoot}`);
  }
  if (!fs.existsSync(sourceExePath)) {
    throw new Error(`Codex Desktop 源缺少 ${config.windows.sourceExeName}：${appRoot}`);
  }
}

function findInstalledCodexAppRoot() {
  if (process.env.CODEX_APP_ROOT) {
    const explicit = path.resolve(process.env.CODEX_APP_ROOT);
    validateCodexAppRoot(explicit);
    return explicit;
  }

  try {
    const output = execFileSync("where.exe", ["codex"], { encoding: "utf8" });
    for (const line of output.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const appRoot = appRootFromCodexExe(line);
      if (appRoot) {
        validateCodexAppRoot(appRoot);
        return appRoot;
      }
    }
  } catch {
    // where 找不到不算致命，继续扫 WindowsApps。
  }

  const windowsApps = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "WindowsApps");
  const candidates = fs
    .readdirSync(windowsApps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
    .map((entry) => path.join(windowsApps, entry.name, "app"))
    .filter((candidate) => fs.existsSync(path.join(candidate, "resources", "app.asar")))
    .map((candidate) => ({
      path: candidate,
      mtimeMs: fs.statSync(candidate).mtimeMs
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (candidates.length === 0) {
    throw new Error("没有找到已安装的 Codex Desktop。先安装官方 Codex，或设置 CODEX_APP_ROOT。");
  }

  validateCodexAppRoot(candidates[0].path);
  return candidates[0].path;
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("import:codex-windows-source 只能在 Windows 上运行。");
  }

  const sourceAppRoot = findInstalledCodexAppRoot();
  const targetAppRoot = resolveProjectPath(config.windows.sourceAppRoot);
  const manifestPath = resolveProjectPath(config.windows.sourceManifestPath);

  log(`导入 Codex Desktop 源：${sourceAppRoot}`);
  fs.rmSync(targetAppRoot, { recursive: true, force: true });
  await fsExtra.copy(sourceAppRoot, targetAppRoot);

  const manifest = {
    source: "OpenAI Codex Desktop",
    packageVersion: parsePackageVersion(sourceAppRoot),
    importedAt: new Date().toISOString(),
    sourceAppRoot,
    targetAppRoot: path.relative(projectRoot, targetAppRoot).replaceAll(path.sep, "/"),
    files: {
      "resources/app.asar": fileInfo(path.join(targetAppRoot, "resources", "app.asar")),
      [config.windows.sourceExeName]: fileInfo(path.join(targetAppRoot, config.windows.sourceExeName))
    }
  };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`固定源 manifest 已写入：${manifestPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
