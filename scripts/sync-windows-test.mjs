import fs from "node:fs";
import path from "node:path";
import {
  applyWindowsAsarOverrides,
  cleanDir,
  codexClientVersionFromExe,
  copyUpdaterRuntimeDependenciesTo,
  copyWindowsPrerequisites,
  copyWindowsResourceOverrides,
  createAsar,
  extractAsar,
  patchOpenAIBundledPluginDescriptions,
  patchWindowsHelpDocumentationLinks,
  projectRoot,
  refreshWindowsAsarBuildMetadata,
  resolveProjectPath,
  validateRuizhiRuntimeBundle,
  writeOwlUserDataDirectoryName,
  windowsResourceOverridesRoot,
  windowsAsarOverridesRoot,
  writeRuntimeModelCatalog
} from "./windows-asar-overrides.mjs";

const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
const appVersion = process.env.RUIZHI_BUILD_VERSION ?? config.version;
const developmentConfig = config.development ?? {};
const developmentHomeDirName = process.env.RUIZHI_DEV_HOME_DIR_NAME
  ?? developmentConfig.defaultHomeDirName
  ?? ".ruizhi-dev";
const developmentUserDataDirName = process.env.RUIZHI_DEV_ELECTRON_USER_DATA_DIR_NAME
  ?? developmentConfig.electronUserDataDirName
  ?? "Ruizhi-Dev";
const developmentModelBridgePort = Number(
  process.env.RUIZHI_DEV_MODEL_BRIDGE_PORT
  ?? developmentConfig.modelBridgePort
  ?? 18888
);
if (!Number.isInteger(developmentModelBridgePort) || developmentModelBridgePort <= 0 || developmentModelBridgePort > 65535) {
  throw new Error(`开发版 model bridge 端口无效：${developmentModelBridgePort}`);
}
const testConfig = {
  ...config,
  runtime: {
    ...(config.runtime ?? {}),
    defaultHomeDirName: developmentHomeDirName,
    electronUserDataDirName: developmentUserDataDirName
  },
  modelBridge: {
    ...(config.modelBridge ?? {}),
    port: developmentModelBridgePort
  }
};
const modelBridgeConfig = testConfig.modelBridge ?? {};
const workRoot = resolveProjectPath(path.join(".work", "windows-test-sync"));
const testAppRoot = resolveProjectPath(process.env.RUIZHI_WINDOWS_TEST_APP_SUBDIR ?? path.join("dist", windowsTestAppDirName()));
const watchMode = process.argv.includes("--watch");

function log(message) {
  console.log(`[ruizhi] ${message}`);
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

function officialAsarPath() {
  const appRoot = resolveProjectPath(config.windows.sourceAppRoot);
  return path.join(appRoot, "resources", "app.asar");
}

function testAppAsarPath() {
  return path.join(testAppRoot, "resources", "app.asar");
}

function modelCatalogPath() {
  const configured = config.models?.catalogPath;
  if (!configured) {
    throw new Error("缺少 models.catalogPath 配置。");
  }
  const resolved = resolveProjectPath(configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(`锐捷模型目录不存在：${resolved}`);
  }
  return resolved;
}

function modelCatalogEnabled() {
  return config.models?.enabled !== false;
}

function modelBridgeEnabled() {
  return modelCatalogEnabled() && modelBridgeConfig.enabled === true;
}

function modelBridgeRuntimeSourcePath() {
  const configured = modelBridgeConfig.runtimeScriptPath ?? "resources/bridge/ruizhi-responses-bridge.cjs";
  const resolved = resolveProjectPath(configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(`模型协议 bridge 脚本不存在：${resolved}`);
  }
  return resolved;
}

function modelBridgeRuntimeResourcePath() {
  return path.join("bridge", path.basename(modelBridgeRuntimeSourcePath()));
}

function splitConfigPath(value) {
  return String(value).split(/[\\/]+/).filter(Boolean);
}

function pluginMarketplaces() {
  return Array.isArray(config.pluginMarketplaces) ? config.pluginMarketplaces : [];
}

function copyPluginMarketplaces(resourcesDir) {
  for (const marketplace of pluginMarketplaces()) {
    const sourceRoot = resolveProjectPath(marketplace.sourcePath);
    const targetRoot = path.join(resourcesDir, ...splitConfigPath(marketplace.resourcePath));
    const marketplaceJson = path.join(sourceRoot, ".agents", "plugins", "marketplace.json");
    const versionManifest = path.join(sourceRoot, ...splitConfigPath(marketplace.versionManifestPath));

    if (!fs.existsSync(marketplaceJson)) {
      throw new Error(`插件 marketplace 缺少 marketplace.json：${marketplaceJson}`);
    }
    if (!fs.existsSync(versionManifest)) {
      throw new Error(`插件 marketplace 缺少版本清单：${versionManifest}`);
    }

    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.cpSync(sourceRoot, targetRoot, { recursive: true });
    log(`已同步插件 marketplace：${marketplace.displayName ?? marketplace.name}`);
  }
}

function writeRuntimeEnvironmentMarker(targetRoot, environment) {
  const resourcesDir = path.join(targetRoot, "resources");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.writeFileSync(
    path.join(resourcesDir, "ruizhi-environment.json"),
    `${JSON.stringify({
      environment,
      version: appVersion,
      executableName: config.windows.appExeName,
      builtAt: new Date().toISOString(),
      isolation: {
        defaultHomeDirName: developmentHomeDirName,
        electronUserDataDirName: developmentUserDataDirName,
        modelBridgePort: developmentModelBridgePort
      }
    }, null, 2)}\n`,
    "utf8"
  );
}

function imageGenSkillSourcePath() {
  return resolveProjectPath(path.join("resources", "skills", "imagegen", "SKILL.md"));
}

function systemSkillsSourceRoot() {
  return resolveProjectPath(path.join("resources", "skills"));
}

const hiddenSystemSkillNames = ["openai-docs"];
const hiddenSystemSkillNameSet = new Set(hiddenSystemSkillNames);

function syncRuntimeSystemSkills(resourcesDir) {
  const sourceRoot = systemSkillsSourceRoot();
  const targetRoot = path.join(resourcesDir, "skills", ".system");
  for (const skillName of hiddenSystemSkillNames) {
    fs.rmSync(path.join(targetRoot, skillName), { recursive: true, force: true });
  }
  const skillDirs = fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) => !hiddenSystemSkillNameSet.has(skillName))
    .filter((skillName) => fs.existsSync(path.join(sourceRoot, skillName, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right));

  for (const skillName of skillDirs) {
    const targetDir = path.join(targetRoot, skillName);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(path.join(sourceRoot, skillName, "SKILL.md"), path.join(targetDir, "SKILL.md"));
  }
  log(`已同步运行态系统 skills：${skillDirs.length} 个`);
}

function syncRuntimeResources() {
  const resourcesDir = path.join(testAppRoot, "resources");
  writeOwlUserDataDirectoryName(testAppRoot, testConfig, { log });
  const codexExePath = path.join(resourcesDir, "codex.exe");
  const modelTargetDir = path.join(resourcesDir, "models");
  if (modelCatalogEnabled()) {
    let codexClientVersion = process.env.RUIZHI_CODEX_CLIENT_VERSION;
    if (!codexClientVersion) {
      const existingCatalogPath = path.join(modelTargetDir, "ruizhi-model-catalog.json");
      if (fs.existsSync(existingCatalogPath)) {
        try {
          const existingCatalog = JSON.parse(fs.readFileSync(existingCatalogPath, "utf8"));
          codexClientVersion = existingCatalog.codexClientVersion ?? existingCatalog.client_version;
        } catch {
        }
      }
    }
    codexClientVersion ??= codexClientVersionFromExe(codexExePath);
    writeRuntimeModelCatalog(
      modelCatalogPath(),
      path.join(modelTargetDir, "ruizhi-model-catalog.json"),
      codexClientVersion,
      { log }
    );
  } else {
    fs.rmSync(modelTargetDir, { recursive: true, force: true });
    log("已关闭运行态自定义模型目录");
  }
  syncRuntimeSystemSkills(resourcesDir);
  copyPluginMarketplaces(resourcesDir);
  if (modelBridgeEnabled()) {
    const bridgeTargetPath = path.join(resourcesDir, modelBridgeRuntimeResourcePath());
    fs.mkdirSync(path.dirname(bridgeTargetPath), { recursive: true });
    fs.copyFileSync(modelBridgeRuntimeSourcePath(), bridgeTargetPath);
    log(`已同步模型协议 bridge：${path.relative(projectRoot, bridgeTargetPath)}`);
  } else {
    fs.rmSync(path.join(resourcesDir, "bridge"), { recursive: true, force: true });
    log("已关闭模型协议 bridge");
  }
  copyWindowsPrerequisites(resourcesDir, { log });
  copyWindowsResourceOverrides(resourcesDir, {
    log,
    pageEnhanceEnabled: config.pageEnhance?.enabled !== false
  });
  patchOpenAIBundledPluginDescriptions(resourcesDir, { log });
}

async function syncWindowsTestApp() {
  const targetAsar = testAppAsarPath();
  if (!fs.existsSync(targetAsar)) {
    throw new Error(`测试程序不存在：${targetAsar}。请先运行 npm run build:windows。`);
  }
  syncRuntimeResources();

  const extractedDir = path.join(workRoot, "app");
  const patchedAsarPath = path.join(workRoot, "app.patched.asar");

  cleanDir(workRoot);
  log("解包官方 asar");
  extractAsar(officialAsarPath(), extractedDir);
  applyWindowsAsarOverrides(extractedDir, { log });
  refreshWindowsAsarBuildMetadata(extractedDir, testConfig, appVersion, { log, resourcesDir: path.join(testAppRoot, "resources") });
  patchWindowsHelpDocumentationLinks(extractedDir, testConfig, { log });
  copyUpdaterRuntimeDependenciesTo(extractedDir, { log });

  log("重新打包测试 asar");
  await createAsar(extractedDir, patchedAsarPath);
  fs.copyFileSync(patchedAsarPath, targetAsar);
  writeRuntimeEnvironmentMarker(testAppRoot, "test");
  validateRuizhiRuntimeBundle(testAppRoot, testConfig, {
    log,
    label: "Windows 测试程序目录",
    expectedVersion: appVersion,
    expectedEnvironment: "test"
  });
  log(`测试程序已同步：${targetAsar}`);
  log(`请重启 ${path.join(testAppRoot, config.windows.appExeName)} 查看效果`);
}

function watchOverrides() {
  let timer = null;
  let running = false;
  let pending = false;

  const queue = () => {
    pending = true;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(async () => {
      if (running) {
        return;
      }
      running = true;
      pending = false;
      try {
        await syncWindowsTestApp();
      } catch (error) {
        console.error(error);
      } finally {
        running = false;
        if (pending) {
          queue();
        }
      }
    }, 250);
  };

  fs.mkdirSync(windowsAsarOverridesRoot, { recursive: true });
  fs.watch(windowsAsarOverridesRoot, { recursive: true }, queue);
  log(`监听覆盖层：${windowsAsarOverridesRoot}`);

  if (modelCatalogEnabled()) {
    fs.watchFile(modelCatalogPath(), { interval: 500 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        queue();
      }
    });
    log(`监听模型目录：${modelCatalogPath()}`);
  }

  fs.watch(systemSkillsSourceRoot(), { recursive: true }, queue);
  log(`监听系统 skills：${systemSkillsSourceRoot()}`);

  if (modelBridgeEnabled()) {
    fs.watchFile(modelBridgeRuntimeSourcePath(), { interval: 500 }, (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
        queue();
      }
    });
    log(`监听模型协议 bridge：${modelBridgeRuntimeSourcePath()}`);
  }

  fs.mkdirSync(windowsResourceOverridesRoot, { recursive: true });
  fs.watch(windowsResourceOverridesRoot, { recursive: true }, queue);
  log(`监听资源覆盖层：${windowsResourceOverridesRoot}`);
}

await syncWindowsTestApp();

if (watchMode) {
  watchOverrides();
}
