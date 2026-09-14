import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fsExtra from "fs-extra";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import {
  applyWindowsAsarOverrides,
  codexClientVersionFromExe,
  copyWindowsPrerequisites,
  copyWindowsResourceOverrides,
  patchDesktopAuthAllowedUrls,
  patchWindowsHelpDocumentationLinks,
  patchWindowsSidebarWhatsNewLink,
  patchOpenAIBundledPluginDescriptions,
  patchBrowserNativePipeDiagnostics,
  patchBrowserNativePipePeerAuthorization,
  patchBrowserUseIabOpenStability,
  patchChatGptConversationArchiveFallback,
  patchChatGptArchivedThreadsFallback,
  patchChatGptSettingsArchivedThreadsFallback,
  patchChatGptLanguageSwitching,
  patchChatGptConversationBranchFallback,
  patchNativeKeymapBindingsFallbackSource,
  patchNativePluginAuthCompatibilitySource,
  patchNativeUsageSettingsVisibilitySource,
  patchPluginSkillLocalListFallback,
  patchTrustedBrowserClientHashes,
  refreshWindowsAsarBuildMetadata,
  validateRuizhiRuntimeBundle,
  writeOwlUserDataDirectoryName,
  writeRuntimeModelCatalog
} from "./windows-asar-overrides.mjs";
import { patchCodexLoginSuccessBinary } from "./codex-login-success-branding.mjs";
import { patchCodexAuthIssuerSource } from "./codex-auth-issuer-source.mjs";
import { patchCodexEnterprisePluginSource } from "./codex-enterprise-plugins-source.mjs";
import { pageEnhanceRendererInstallerSource } from "./page-enhance-source.mjs";

const require = createRequire(import.meta.url);
const rceditModule = require("rcedit");
const rcedit = rceditModule.rcedit ?? rceditModule.default ?? rceditModule;
const asar = require("asar");

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
const defaultChatModelPrefixes = ["glm-", "deepseek-", "kimi-", "ray"];

function ruijieChatModelPrefixesConfig() {
  const configured = config.openai?.chatModelPrefixes;
  if (!Array.isArray(configured) || configured.length === 0) {
    return [...defaultChatModelPrefixes];
  }
  const merged = [];
  const seen = new Set();
  for (const prefix of [...configured, ...defaultChatModelPrefixes]) {
    const value = String(prefix ?? "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    merged.push(value);
  }
  return merged;
}
const buildOpenAIBaseUrl = resolveBuildEndpoint("RUIZHI_BUILD_API_BASE_URL", config.openai.baseUrl);
const buildProviderBaseUrl = resolveBuildEndpoint(
  "RUIZHI_BUILD_PROVIDER_BASE_URL",
  config.openai.providerBaseUrl ?? buildOpenAIBaseUrl
);
const buildChatGptLoginBaseUrl = resolveBuildEndpoint(
  "RUIZHI_BUILD_CHATGPT_LOGIN_BASE_URL",
  config.openai.chatGptLoginBaseUrl ?? "https://gptauth.ruijie.com.cn"
);
const appVersion = process.env.RUIZHI_BUILD_VERSION ?? config.version;
const runtimeConfig = config.runtime ?? {};
const ruizhiHomeEnvName = runtimeConfig.homeEnv ?? "RUIZHI_HOME";
const ruizhiDefaultHomeDirName = resolveBuildDirectoryName(
  "RUIZHI_BUILD_HOME_DIR_NAME",
  runtimeConfig.defaultHomeDirName ?? ".ruizhi"
);
const electronUserDataDirName = resolveBuildDirectoryName(
  "RUIZHI_BUILD_ELECTRON_USER_DATA_DIR_NAME",
  runtimeConfig.electronUserDataDirName ?? "Codex"
);
const buildConfig = {
  ...config,
  runtime: {
    ...runtimeConfig,
    defaultHomeDirName: ruizhiDefaultHomeDirName,
    electronUserDataDirName
  }
};
const imageGenerationConfig = config.imageGeneration ?? {};
const apiKeyTestConfig = config.apiKeyTest ?? {};
const modelBridgeConfig = config.modelBridge ?? {};
const openAIBundledPluginDefinitions = [
  { name: "browser", path: "./plugins/browser", category: "Engineering" },
  { name: "chrome", path: "./plugins/chrome", category: "Productivity" },
  { name: "computer-use", path: "./plugins/computer-use", category: "Productivity" },
  { name: "latex", path: "./plugins/latex", category: "Research" }
];

function windowsTaskManagerName() {
  return config.windows?.taskManagerName ?? config.productName;
}

function log(message) {
  console.log(`[ruizhi] ${message}`);
}

function resolveBuildEndpoint(envName, configuredValue) {
  const candidate = String(process.env[envName] || configuredValue || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${envName} 无效：${candidate}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${envName} 必须是无账号、查询和锚点的 HTTP/HTTPS 地址：${candidate}`);
  }
  return candidate;
}

function resolveBuildDirectoryName(envName, configuredValue) {
  const override = process.env[envName];
  const candidate = String(override === undefined ? configuredValue : override).trim();
  if (
    !candidate
    || candidate === "."
    || candidate === ".."
    || path.isAbsolute(candidate)
    || candidate.includes("/")
    || candidate.includes("\\")
    || candidate.includes("\0")
  ) {
    throw new Error(`${envName} 必须是单个安全目录名：${candidate}`);
  }
  return candidate;
}

function ruizhiBuildDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function ruizhiShortBuildDate() {
  return ruizhiBuildDate().replaceAll("-", "").slice(2);
}

function ruizhiBuildVersionLabel() {
  return `${appVersion}-${ruizhiShortBuildDate()}`;
}

function ruizhiBuildDateLabel() {
  return ruizhiBuildVersionLabel();
}

function assertInsideProject(targetPath) {
  const resolvedRoot = path.resolve(projectRoot).toLowerCase();
  const resolvedTarget = path.resolve(targetPath).toLowerCase();
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`拒绝删除项目外路径：${targetPath}`);
  }
}

function resolveProjectPath(targetPath) {
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  assertInsideProject(resolvedTarget);
  return resolvedTarget;
}

function cleanDir(targetPath) {
  assertInsideProject(targetPath);
  fs.mkdirSync(targetPath, { recursive: true });
  for (const entry of fs.readdirSync(targetPath)) {
    fs.rmSync(path.join(targetPath, entry), { recursive: true, force: true });
  }
}

function windowsIconPath() {
  const configured = config.windows?.iconPath;
  if (!configured) {
    throw new Error("缺少 windows.iconPath 配置。");
  }
  const resolved = resolveProjectPath(configured);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Windows 图标文件不存在：${resolved}`);
  }
  return resolved;
}

function electronBuilderCliPath() {
  return require.resolve("electron-builder/cli.js");
}

function electronRuntimeVersion() {
  const versionPath = path.join(appOutRoot, "version");
  if (!fs.existsSync(versionPath)) {
    const manifestName = fs.readdirSync(appOutRoot).find((name) => /^\d+\.\d+\.\d+\.\d+\.manifest$/.test(name));
    if (manifestName) {
      const chromiumMajor = Number(manifestName.split(".")[0]);
      const electronMajor = chromiumMajor - 116;
      if (Number.isInteger(electronMajor) && electronMajor > 0) {
        const inferred = `${electronMajor}.0.0`;
        log(`缺少 Electron version 文件，按 Chromium ${chromiumMajor} 推断 Electron ${inferred}`);
        return inferred;
      }
    }
    throw new Error(`缺少 Electron runtime version 文件：${versionPath}`);
  }
  const version = fs.readFileSync(versionPath, "utf8").trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Electron runtime version 格式异常：${version}`);
  }
  return version;
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

function codexCliBuildConfig() {
  return {
    ...(config.codexCli ?? {}),
    tag: process.env.RUIZHI_CODEX_CLI_TAG?.trim() || config.codexCli?.tag
  };
}

function modelCatalogEnabled() {
  return config.models?.enabled !== false;
}

function modelBridgeEnabled() {
  return modelCatalogEnabled() && modelBridgeConfig.enabled === true;
}

function brandingEnabled() {
  return config.branding?.enabled !== false;
}

function modelBridgeHost() {
  return modelBridgeConfig.host ?? "127.0.0.1";
}

function modelBridgePort() {
  const port = modelBridgeConfig.port ?? 17888;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`modelBridge.port 无效：${port}`);
  }
  return port;
}

function modelProviderBaseUrl() {
  if (!modelBridgeEnabled()) {
    return buildProviderBaseUrl;
  }
  return `http://${modelBridgeHost()}:${modelBridgePort()}/v1`;
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

function modelBridgeRoutes() {
  return modelBridgeConfig.routes && typeof modelBridgeConfig.routes === "object"
    ? modelBridgeConfig.routes
    : {};
}

function pageEnhanceEnabled() {
  return config.pageEnhance?.enabled !== false;
}

function pageEnhanceFeatures() {
  return {
    menu: false,
    pluginEntryUnlock: true,
    forcePluginInstall: true,
    sessionDelete: false,
    markdownExport: true,
    projectMove: false,
    timeline: true,
    threadScrollRestore: true,
    threadSort: true,
    modelWhitelistUnlock: false,
    zedRemoteOpen: false,
    upstreamWorktreeCreate: false,
    serviceTierControls: false,
    ...(config.pageEnhance?.features && typeof config.pageEnhance.features === "object" ? config.pageEnhance.features : {})
  };
}

function pageEnhanceBootstrapConfig() {
  return {
    enabled: pageEnhanceEnabled(),
    features: pageEnhanceFeatures(),
    appVersion,
    appDisplayVersion: ruizhiBuildVersionLabel(),
    rendererResourcePath: ["renderer", "ruizhi-page-enhance.js"],
    serviceResourcePath: ["bridge", "ruizhi-enhance-service.cjs"]
  };
}

function imageGenHelperExeName() {
  return imageGenerationConfig.helperExeName ?? "ruizhi-imagegen.exe";
}

function builtInAllowPrefixRules() {
  const configuredRules = Array.isArray(config.execPolicy?.allowPrefixRules)
    ? config.execPolicy.allowPrefixRules
    : [];
  const imageGenHelperPath = path.join("bin", imageGenHelperExeName());
  return [
    ...configuredRules,
    {
      commandResourcePath: imageGenHelperPath,
      prefix: ["generate"]
    },
    {
      commandResourcePath: imageGenHelperPath,
      prefix: ["generate-batch"]
    }
  ];
}

function imageGenSkillSourcePath() {
  return resolveProjectPath(path.join("resources", "skills", "imagegen", "SKILL.md"));
}

function systemSkillsSourceRoot() {
  return resolveProjectPath(path.join("resources", "skills"));
}

const hiddenSystemSkillNames = ["openai-docs"];
const hiddenSystemSkillNameSet = new Set(hiddenSystemSkillNames);

function listSystemSkillSourceDirs() {
  const sourceRoot = systemSkillsSourceRoot();
  return fs.readdirSync(sourceRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillName) => !hiddenSystemSkillNameSet.has(skillName))
    .filter((skillName) => fs.existsSync(path.join(sourceRoot, skillName, "SKILL.md")))
    .sort((left, right) => left.localeCompare(right));
}

const workRoot = resolveProjectPath(process.env.RUIZHI_WINDOWS_WORK_SUBDIR ?? path.join(".work", "windows"));
const distRoot = resolveProjectPath(process.env.RUIZHI_WINDOWS_DIST_SUBDIR ?? path.join(".work", "windows-app-out"));
const appOutRoot = distRoot;
const extractedDir = path.join(workRoot, "app");
const codexSourceRoot = path.join(projectRoot, ".work", "codex-source");
const installerInputRoot = resolveProjectPath(process.env.RUIZHI_WINDOWS_INSTALLER_INPUT_SUBDIR ?? path.join(".work", "windows-installer-input"));
const installerOutDir = resolveProjectPath(process.env.RUIZHI_WINDOWS_INSTALLER_OUT_SUBDIR ?? path.join("dist", "installer"));
const testAppOutDir = resolveProjectPath(process.env.RUIZHI_WINDOWS_TEST_APP_SUBDIR ?? path.join("dist", windowsTestAppDirName()));
let pinnedCodexAppRoot = "";

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

function verifyWindowsSourceManifest(appRoot) {
  const manifestConfigPath = config.windows.sourceManifestPath;
  if (!manifestConfigPath) {
    throw new Error("缺少 windows.sourceManifestPath 配置。");
  }

  const manifestPath = resolveProjectPath(manifestConfigPath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`缺少固定 Codex Desktop 源 manifest：${manifestPath}。请先运行 npm run import:codex-windows-source。`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const files = manifest.files ?? {};

  for (const relativePath of ["resources/app.asar", config.windows.sourceExeName]) {
    const expected = files[relativePath]?.sha256;
    if (!expected) {
      throw new Error(`固定 Codex Desktop 源 manifest 缺少 ${relativePath} 校验值。请重新运行 npm run import:codex-windows-source。`);
    }

    const actualPath = path.join(appRoot, ...relativePath.split("/"));
    const actual = sha256File(actualPath);
    if (actual !== expected) {
      throw new Error(`固定 Codex Desktop 源已变化：${relativePath}。请确认来源后重新运行 npm run import:codex-windows-source。`);
    }
  }

  return manifest;
}

function findPinnedCodexAppRoot() {
  if (process.env.RUIZHI_WINDOWS_SOURCE_APP_ROOT) {
    const appRoot = path.resolve(process.env.RUIZHI_WINDOWS_SOURCE_APP_ROOT);
    const appAsarPath = path.join(appRoot, "resources", "app.asar");
    const sourceExePath = path.join(appRoot, config.windows.sourceExeName);
    if (!fs.existsSync(appAsarPath) || !fs.existsSync(sourceExePath)) {
      throw new Error(`外部 Codex Desktop 源不存在或不完整：${appRoot}`);
    }
    log(`使用外部 Codex Desktop 源：${appRoot}`);
    return appRoot;
  }

  const configured = config.windows.sourceAppRoot;
  if (!configured) {
    throw new Error("缺少 windows.sourceAppRoot 配置。");
  }

  const appRoot = resolveProjectPath(configured);
  const appAsarPath = path.join(appRoot, "resources", "app.asar");
  const sourceExePath = path.join(appRoot, config.windows.sourceExeName);

  if (!fs.existsSync(appAsarPath) || !fs.existsSync(sourceExePath)) {
    throw new Error(`固定 Codex Desktop 源不存在或不完整：${appRoot}。请先运行 npm run import:codex-windows-source。`);
  }

  const manifest = verifyWindowsSourceManifest(appRoot);
  log(`固定源版本：${manifest.packageVersion ?? "unknown"}`);
  return appRoot;
}

function findOneFile(dir, pattern, label) {
  const matches = fs.readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));

  if (matches.length !== 1) {
    throw new Error(`${label} 匹配数量异常：${matches.length}`);
  }

  return matches[0];
}

function findOneFileByContent(dir, filePattern, contentPattern, label) {
  const matches = fs.readdirSync(dir)
    .filter((name) => filePattern.test(name))
    .map((name) => path.join(dir, name))
    .filter((filePath) => {
      try {
        return contentPattern.test(fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
        throw error;
      }
    });

  if (matches.length !== 1) {
    throw new Error(`${label} 匹配数量异常：${matches.length}`);
  }

  return matches[0];
}

function replaceExact(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`补丁点不存在：${label}`);
  }
  return source.replace(from, to);
}

function replaceRegex(source, pattern, to, label) {
  if (!pattern.test(source)) {
    throw new Error(`补丁点不存在：${label}`);
  }
  return source.replace(pattern, to);
}

function replaceRegexAll(source, pattern, to, label) {
  const next = source.replace(pattern, to);
  if (next === source) {
    throw new Error(`补丁点不存在：${label}`);
  }
  return next;
}

function replaceAllIfPresent(source, from, to) {
  return source.split(from).join(to);
}

function replaceAnyExact(source, replacements, label) {
  let next = source;
  let changed = false;

  for (const [from, to] of replacements) {
    if (next.includes(from)) {
      next = next.replace(from, to);
      changed = true;
    }
  }

  if (!changed) {
    throw new Error(`补丁点不存在：${label}`);
  }

  return next;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writePatchedFile(filePath, transform) {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = transform(original);
  if (patched === original) {
    throw new Error(`文件没有发生变化：${filePath}`);
  }
  fs.writeFileSync(filePath, patched);
}

function writePatchedFileIfChanged(filePath, transform) {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = transform(original);
  if (patched === original) {
    log(`跳过未变化文件：${path.basename(filePath)}`);
    return false;
  }
  fs.writeFileSync(filePath, patched);
  return true;
}

function writeUtf8BomFile(filePath, content) {
  fs.writeFileSync(filePath, `\uFEFF${content}`, "utf8");
}

function execLogged(command, args, options = {}) {
  log([command, ...args].join(" "));
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitConfigPath(value) {
  return String(value).split(/[\\/]+/).filter(Boolean);
}

function pluginMarketplaces() {
  return Array.isArray(config.pluginMarketplaces) ? config.pluginMarketplaces : [];
}

function marketplaceSourceToken(name) {
  return `__RUIZHI_MARKETPLACE_SOURCE_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}__`;
}

function patchPluginAccountGate() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const pluginAccountGatePattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return e!==`chatgpt`(?:&&e!==`apikey`&&e!==`amazonBedrock`(?:\/\*ruizhiPluginAuthCompatibility\*\/)?){0,1}\}/;
  const gradientFile = findOneFileByContent(
    assetsDir,
    /\.js$/,
    pluginAccountGatePattern,
    "插件账号模式 gate bundle"
  );

  const source = fs.readFileSync(gradientFile, "utf8");
  const patched = patchNativePluginAuthCompatibilitySource(source);
  if (patched === source) {
    log(`插件已原生支持 ChatGPT/API key 账号：${path.basename(gradientFile)}`);
    return;
  }
  fs.writeFileSync(gradientFile, patched, "utf8");
  log(`已补丁插件账号兼容范围：${path.basename(gradientFile)}`);
}

function patchNativeWebviewFeatureGates() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const statsigGateSourcePattern = /function Ue\(e\)\{return ([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),e\)\}/;
  const statsigFile = findOneFileByContent(assetsDir, /^statsig-.*\.js$/, statsigGateSourcePattern, "Statsig webview gate bundle");
  const nativeGateCode = "const ruizhiNativeFeatureGates=new Set([`3075919032`,`4166894088`,`410262010`,`3903563814`,`410065390`]);function ruizhiNativeFeatureGateValue(e){return ruizhiNativeFeatureGates.has(String(e))}";
  const source = fs.readFileSync(statsigFile, "utf8");
  if (source.includes("ruizhiNativeFeatureGateValue")) {
    log("已存在 Codex 原生 webview gate 补丁");
    return;
  }
  const targetGateMatch = source.match(statsigGateSourcePattern);
  if (!targetGateMatch) {
    throw new Error("Codex 原生 webview gate 补丁点不存在");
  }
  const initHook = targetGateMatch[1];
  const gateHook = targetGateMatch[2];
  const gateStore = targetGateMatch[3];
  const patched = source.replace(
    statsigGateSourcePattern,
    `${nativeGateCode}function Ue(e){return ${initHook}(),ruizhiNativeFeatureGateValue(e)||${gateHook}(${gateStore},e)}`
  );
  fs.writeFileSync(statsigFile, patched, "utf8");
  log(`已打开 Codex 原生 webview gate：${path.basename(statsigFile)}`);
}

function patchNativeStatsigNetwork() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const statsigNetworkPattern = /networkConfig:\{api:([A-Za-z_$][\w$]*),logEventUrl:([A-Za-z_$][\w$]*),sdkExceptionUrl:([A-Za-z_$][\w$]*),networkOverrideFunc:([A-Za-z_$][\w$]*)\}/;
  const statsigFile = findOneFileByContent(assetsDir, /^.+\.js$/, /https:\/\/ab\.chatgpt\.com\/v1|preventAllNetworkTraffic:!0/, "Statsig network bundle");
  const source = fs.readFileSync(statsigFile, "utf8");
  if (source.includes("preventAllNetworkTraffic:!0")) {
    log(`已存在 Codex 原生 Statsig 初始化网络禁用补丁：${path.basename(statsigFile)}`);
    return;
  }
  writePatchedFile(statsigFile, (source) =>
    replaceRegex(source, statsigNetworkPattern, "networkConfig:{api:$1,logEventUrl:$2,sdkExceptionUrl:$3,preventAllNetworkTraffic:!0}", "Statsig 初始化网络禁用")
  );
  log(`已禁用 Codex 原生 Statsig 初始化网络：${path.basename(statsigFile)}`);
}

function patchNativeStatsigBootstrap() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const statsigBootstrapPattern = /async function ([A-Za-z_$][\w$]*)\(\{appSessionId:([A-Za-z_$][\w$]*),appVersion:([A-Za-z_$][\w$]*),buildFlavor:([A-Za-z_$][\w$]*),locale:([A-Za-z_$][\w$]*),stableId:([A-Za-z_$][\w$]*),systemName:([A-Za-z_$][\w$]*),systemVersion:([A-Za-z_$][\w$]*),windowType:([A-Za-z_$][\w$]*)\}\)\{let ([A-Za-z_$][\w$]*)=null;try\{let\{statsigPayload:([A-Za-z_$][\w$]*)\}=await Promise\.race\(\[[\s\S]*?Timed out while fetching post-login Statsig bootstrap[\s\S]*?\]\),\{user:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\.parse\(JSON\.parse\(([A-Za-z_$][\w$]*)\)\);return\{statsigPayload:([A-Za-z_$][\w$]*),user:([A-Za-z_$][\w$]*)\}\}finally\{([A-Za-z_$][\w$]*)!=null&&globalThis\.clearTimeout\(([A-Za-z_$][\w$]*)\)\}\}/;
  const statsigFile = findOneFileByContent(assetsDir, /^.+\.js$/, /Timed out while fetching post-login Statsig bootstrap|ruizhiCreateStatsigBootstrapPayload/, "Statsig bootstrap bundle");
  const source = fs.readFileSync(statsigFile, "utf8");
  if (source.includes("ruizhiCreateStatsigBootstrapPayload")) {
    log(`已存在 Codex 原生 Statsig post-login bootstrap 补丁：${path.basename(statsigFile)}`);
    return;
  }
  writePatchedFile(statsigFile, (source) => {
    const match = source.match(statsigBootstrapPattern);
    if (!match) {
      throw new Error("补丁点不存在：Statsig post-login bootstrap 等待禁用");
    }
    const functionName = match[1];
    const appSessionId = match[2];
    const appVersion = match[3];
    const locale = match[5];
    const stableId = match[6];
    const validator = match[13];
    const localBootstrapCode = "function ruizhiCreateStatsigBootstrapPayload(e){return JSON.stringify({has_updates:!0,response_format:`init-v2`,time:Date.now(),feature_gates:{},dynamic_configs:{},layer_configs:{},param_stores:{},values:{},exposures:{},sdk_flags:{},user:{userID:e.stableId||e.appSessionId||`ruizhi-local`,customIDs:{stableID:e.stableId},locale:e.locale,appVersion:e.appVersion}})}";
    return source.replace(
      statsigBootstrapPattern,
      `${localBootstrapCode}async function ${functionName}({appSessionId:${appSessionId},appVersion:${appVersion},buildFlavor:${match[4]},locale:${locale},stableId:${stableId},systemName:${match[7]},systemVersion:${match[8]},windowType:${match[9]}}){let ${match[11]}=ruizhiCreateStatsigBootstrapPayload({appSessionId:${appSessionId},appVersion:${appVersion},locale:${locale},stableId:${stableId}}),{user:${match[12]}}=${validator}.parse(JSON.parse(${match[11]}));return{statsigPayload:${match[11]},user:${match[12]}}}`
    );
  });
  log(`已禁用 Codex 原生 Statsig post-login bootstrap 等待：${path.basename(statsigFile)}`);
}

function patchNativeCesAnalyticsNetwork() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const cesEndpointPattern = /([A-Za-z_$][\w$]*)=`https:\/\/chatgpt\.com\/ces\/v1\/rgstr`,([A-Za-z_$][\w$]*)=`https:\/\/chatgpt\.com\/ces\/v1`/;
  const cesEnabledPattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)&&([A-Za-z_$][\w$]*)===`success`&&([A-Za-z_$][\w$]*)===!0/;
  const cesFile = findOneFileByContent(assetsDir, /^.+\.js$/, /https:\/\/chatgpt\.com\/ces\/v1|ruizhi-disabled:\/\/ces\/v1/, "CES analytics bundle");
  const source = fs.readFileSync(cesFile, "utf8");
  if (source.includes("ruizhi-disabled://ces/v1")) {
    log(`已存在 Codex 原生 CES 分析上报禁用补丁：${path.basename(cesFile)}`);
    return;
  }
  writePatchedFile(cesFile, (source) => {
    let next = replaceRegex(source, cesEndpointPattern, "$1=`ruizhi-disabled://ces/v1/rgstr`,$2=`ruizhi-disabled://ces/v1`", "CES 分析上报端点禁用");
    next = replaceRegex(next, cesEnabledPattern, "$1=!1&&$2&&$3===`success`&&$4===!0", "CES 分析上报初始化禁用");
    return next;
  });
  log(`已禁用 Codex 原生 CES 分析上报：${path.basename(cesFile)}`);
}

function patchNativeProfileVisibility() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const profileVisibilityFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /2478676115[\s\S]*3503973010[\s\S]*show_dropdown_entry_point/,
    "profile visibility bundle"
  );
  const source = fs.readFileSync(profileVisibilityFile, "utf8");
  if (source.includes("ruizhiProfileVisibility()")) {
    log("已存在 Codex 个人资料入口补丁");
    return;
  }
  let patched = source.replace(
    /function l\(\)\{let e=\(0,a\.c\)\(3\),\{authMethod:r,isLoading:s\}=i\(\),c=t\(\),l=n\(o\),u=s\|\|r===`chatgpt`&&c,d=r===`chatgpt`&&l,f;return e\[0\]!==u\|\|e\[1\]!==d\?\(f=\{isProfileVisibilityLoading:u,isProfileVisible:d\},e\[0\]=u,e\[1\]=d,e\[2\]=f\):f=e\[2\],f\}/,
    "function ruizhiProfileVisibility(){return {isProfileVisibilityLoading:false,isProfileVisible:true}}function l(){return ruizhiProfileVisibility()}"
  );
  patched = patched.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),\{authMethod:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\5\|\|\4===`chatgpt`&&\7,([A-Za-z_$][\w$]*)=\4===`chatgpt`&&\9,([A-Za-z_$][\w$]*);return \2\[0\]!==\12\|\|\2\[1\]!==\13\?\(\14=\{isProfileVisibilityLoading:\12,isProfileVisible:\13\},\2\[0\]=\12,\2\[1\]=\13,\2\[2\]=\14\):\14=\2\[2\],\14\}/,
    "function ruizhiProfileVisibility(){return {isProfileVisibilityLoading:false,isProfileVisible:true}}function $1(){return ruizhiProfileVisibility()}"
  );
  patched = patched.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(13\),\{accountId:([A-Za-z_$][\w$]*),authMethod:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*),planAtLogin:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),[\s\S]{0,2200}?return \2\[10\]!==([A-Za-z_$][\w$]*)\|\|\2\[11\]!==([A-Za-z_$][\w$]*)\?\(([A-Za-z_$][\w$]*)=\{isProfileVisibilityLoading:\9,isProfileVisible:\10\},\2\[10\]=\9,\2\[11\]=\10,\2\[12\]=\11\):\11=\2\[12\],\11\}/,
    "function ruizhiProfileVisibility(){return {isProfileVisibilityLoading:false,isProfileVisible:true}}function $1(){return ruizhiProfileVisibility()}"
  );
  patched = patched.replace(
    /function u\(\)\{let e=\(0,a\.c\)\(3\),\{authMethod:t\}=i\(\),l=n\(o\),u=r\(s\);if\(t!==`chatgpt`\)return!1;let d;return e\[0\]!==l\|\|e\[1\]!==u\?\(d=l&&u\.get\(c,!1\),e\[0\]=l,e\[1\]=u,e\[2\]=d\):d=e\[2\],d\}/,
    "function ruizhiProfileDropdownEntryPoint(){return true}function u(){return ruizhiProfileDropdownEntryPoint()}"
  );
  patched = patched.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),\{authMethod:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\);if\(\4!==`chatgpt`\)return!1;let ([A-Za-z_$][\w$]*);return \2\[0\]!==\6\|\|\2\[1\]!==\9\?\(\12=\6&&\9\.get\(([A-Za-z_$][\w$]*),!1\),\2\[0\]=\6,\2\[1\]=\9,\2\[2\]=\12\):\12=\2\[2\],\12\}/,
    "function ruizhiProfileDropdownEntryPoint(){return true}function $1(){return ruizhiProfileDropdownEntryPoint()}"
  );
  patched = patched.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),\{isProfileVisible:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*);return \2\[0\]!==\4\|\|\2\[1\]!==\6\?\(\9=\4&&\6\.get\(([A-Za-z_$][\w$]*),!1\),\2\[0\]=\4,\2\[1\]=\6,\2\[2\]=\9\):\9=\2\[2\],\9\}/,
    "function ruizhiProfileDropdownEntryPoint(){return true}function $1(){return ruizhiProfileDropdownEntryPoint()}"
  );
  if (!patched.includes("ruizhiProfileVisibility()") || !patched.includes("ruizhiProfileDropdownEntryPoint()")) {
    throw new Error("Codex 个人资料入口补丁点不存在");
  }
  fs.writeFileSync(profileVisibilityFile, patched, "utf8");
  log(`已打开 Codex 个人资料入口：${path.basename(profileVisibilityFile)}`);
}

function patchNativeUsageSettingsVisibility() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const usageAccessFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /(?:enable_free_go_usage_settings[\s\S]*isUsageSettingsVisible|isUsageSettingsVisible[\s\S]*enable_free_go_usage_settings)/,
    "usage settings access bundle"
  );
  const source = fs.readFileSync(usageAccessFile, "utf8");
  if (source.includes("ruizhiUsageSettingsAlwaysVisible")) {
    log("已存在 Codex 使用情况设置入口补丁");
    return;
  }
  const patched = patchNativeUsageSettingsVisibilitySource(source);
  fs.writeFileSync(usageAccessFile, patched, "utf8");
  log(`已打开 Codex 使用情况设置入口：${path.basename(usageAccessFile)}`);
}

function patchNativeKeymapBindingsFallback() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  let keymapFile;
  try {
    keymapFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /\?\.bindings\.filter\([A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\.command===/,
      "keymap bindings bundle"
    );
  } catch (error) {
    log(`已跳过 Codex 快捷键 bindings 兜底补丁：${error.message}`);
    return;
  }
  const source = fs.readFileSync(keymapFile, "utf8");
  if (source.includes("ruizhiKeymapBindingsFallback")) {
    log("已存在 Codex 快捷键 bindings 兜底补丁");
    return;
  }
  const patched = patchNativeKeymapBindingsFallbackSource(source);
  fs.writeFileSync(keymapFile, patched, "utf8");
  log(`已补丁 Codex 快捷键 bindings 兜底：${path.basename(keymapFile)}`);
}

function patchNativeProfileDropdownUsageVisibility() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const profileDropdownFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /\{isUsageSettingsVisible:[A-Za-z_$][\w$]*,isUsageSettingsAccessLoading:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*\(\)[\s\S]*codex\.profileDropdown\.apiKeyAuth[\s\S]*codex\.profileDropdown\.usage/,
    "profile dropdown usage bundle"
  );
  const source = fs.readFileSync(profileDropdownFile, "utf8");
  if (source.includes("ruizhiProfileDropdownUsageForAllAuth")) {
    log("已存在 Codex 头像菜单使用情况入口补丁");
    return;
  }

  const usageAccessMatch = source.match(/\{isUsageSettingsVisible:([A-Za-z_$][\w$]*),isUsageSettingsAccessLoading:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\)/);
  if (!usageAccessMatch) {
    throw new Error("Codex 头像菜单使用情况入口补丁点不存在：账号态变量");
  }
  const [, usageVisibleVar, usageLoadingVar] = usageAccessMatch;
  const usageConditionPattern = new RegExp(
    `,([A-Za-z_$][\\w$]*)=([^,;]*&&${escapeRegExp(usageVisibleVar)}&&[^,;]*),([A-Za-z_$][\\w$]*=[A-Za-z_$][\\w$]*\\(\\),)`
  );
  const patched = source.replace(
    usageConditionPattern,
    `,$1=($2)||!${usageLoadingVar}/*ruizhiProfileDropdownUsageForAllAuth*/,$3`
  );
  if (!patched.includes("ruizhiProfileDropdownUsageForAllAuth")) {
    throw new Error("Codex 头像菜单使用情况入口补丁点不存在：显示条件");
  }
  fs.writeFileSync(profileDropdownFile, patched, "utf8");
  log(`已打开 Codex 头像菜单使用情况入口：${path.basename(profileDropdownFile)}`);
}

function patchNativeProfileUsageFallback() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const profileQueriesFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /\/wham\/profiles\/me/,
    "profile queries bundle"
  );
  const source = fs.readFileSync(profileQueriesFile, "utf8");
  if (source.includes("/profile/usage")) {
    log("已存在 Codex 个人资料 Token 活动本地兜底补丁");
    return;
  }
  const patched = source.replace(
    /let e=await ([A-Za-z_$][\w$]*)\.safeGet\(`\/wham\/profiles\/me`\);return\{/,
    "let e,ruizhiProfilePayloadValid=e=>!!(e&&typeof e===`object`&&e.profile&&e.stats&&e.metadata);try{console.info(`[ruizhi][profile] GET /wham/profiles/me start`);e=await $1.safeGet(`/wham/profiles/me`);if(!ruizhiProfilePayloadValid(e))throw new Error(`invalid profile payload`);console.info(`[ruizhi][profile] GET /wham/profiles/me success`,{hasProfile:!!e?.profile,hasStats:!!e?.stats,hasDailyBuckets:Array.isArray(e?.stats?.daily_usage_buckets)})}catch(t){console.warn(`[ruizhi][profile] GET /wham/profiles/me failed, trying local fallback`,{message:String(t?.message||t)});let n=globalThis.ruizhiDesktop?.enhance?.call;if(typeof n===`function`)try{let r=await n(`/profile/usage`,{});if(r?.status===`ok`&&ruizhiProfilePayloadValid(r)){console.info(`[ruizhi][profile] local /profile/usage success`,{hasProfile:!!r?.profile,hasStats:!!r?.stats,hasDailyBuckets:Array.isArray(r?.stats?.daily_usage_buckets)});e=r}}catch(r){console.warn(`[ruizhi][profile] local /profile/usage failed`,{message:String(r?.message||r)})}if(!ruizhiProfilePayloadValid(e)){console.warn(`[ruizhi][profile] using empty local profile fallback`);e={profile:{display_name:`锐智用户`,profile_picture_url:null,username:null},stats:{lifetime_tokens:0,peak_daily_tokens:0,longest_running_turn_sec:null,current_streak_days:0,longest_streak_days:0,daily_usage_buckets:[],fast_mode_usage_percentage:null,top_invocations:[],most_used_reasoning_effort:null,most_used_reasoning_effort_percentage:null,unique_skills_used:null,total_skills_used:null,total_threads:0},metadata:{stats_error:String(t?.message||t||``)}}}}return{"
  );
  if (!patched.includes("/profile/usage") || !patched.includes("[ruizhi][profile] GET /wham/profiles/me start")) {
    throw new Error("Codex 个人资料 Token 活动本地兜底/日志补丁点不存在");
  }
  fs.writeFileSync(profileQueriesFile, patched, "utf8");
  log(`已补丁 Codex 个人资料 Token 活动本地兜底与调用日志：${path.basename(profileQueriesFile)}`);
}

function patchNativePlatformUsageFallback() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const usageQueriesFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /safeGet\(`\/wham\/usage`/,
    "usage queries bundle"
  );
  const source = fs.readFileSync(usageQueriesFile, "utf8");
  if (source.includes("/usage/platform")) {
    log("已存在锐鉴 API 用量兜底补丁");
    return;
  }
  const patched = source.replace(
    /queryFn:async\(\)=>\{try\{return await ([A-Za-z_$][\w$]*)\.safeGet\(`\/wham\/usage`,\{parameters:\{query:\{supports_rewardless_invites:!0\}\}\}\)\}catch\(e\)\{if\(e instanceof ([A-Za-z_$][\w$]*)&&\(e\.status===401\|\|e\.status===403\|\|e\.status===404\)\)return null;throw e\}\}/,
    "queryFn:async()=>{let t=globalThis.ruizhiDesktop?.enhance?.call;if(typeof t===`function`)try{let n=await t(`/usage/platform`,{});if(n?.status===`ok`&&n?.data?.rate_limit?.primary_window)return n.data}catch(e){console.warn(`[ruizhi][usage] local platform usage failed`,{message:String(e?.message||e)})}try{let e=await $1.safeGet(`/wham/usage`,{parameters:{query:{supports_rewardless_invites:!0}}});if(!e?.rate_limit?.primary_window)throw new Error(`incompatible usage response`);return e}catch(e){if(e instanceof $2&&(e.status===401||e.status===403||e.status===404))return null;throw e}}/*ruizhiPlatformUsageBridgeFirst*/"
  );
  if (!patched.includes("/usage/platform") || !patched.includes("ruizhiPlatformUsageBridgeFirst")) {
    throw new Error("锐鉴 API 用量兜底补丁点不存在");
  }
  fs.writeFileSync(usageQueriesFile, patched, "utf8");
  log(`已补丁锐鉴 API 真实剩余用量：${path.basename(usageQueriesFile)}`);
}

function patchNativeWalletUsagePresentation() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const rateLimitFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /windowDurationMins\?\?0\)>0/,
    "rate limit presentation bundle"
  );
  let source = fs.readFileSync(rateLimitFile, "utf8");
  if (source.includes("ruizhiWalletQuotaWindow")) {
    log("已存在锐捷钱包额度展示补丁");
  }
  source = source.replace(
    /function ([A-Za-z_$][\w$]*)\(e\)\{return e!=null&&\(e\.windowDurationMins\?\?0\)>0\}/,
    "function $1(e){return e!=null&&((e.windowDurationMins??0)>0||e.windowDurationMins===-1)/*ruizhiWalletQuotaWindow*/}"
  );
  source = source.replace(
    /function ([A-Za-z_$][\w$]*)\(\{intl:e,minutes:t,variant:n=`summary`\}\)\{let r=t\?\?0,/,
    "function $1({intl:e,minutes:t,variant:n=`summary`}){if(t===-1)return e.formatMessage({id:n===`summary`?`ruizhi.walletBalance.title`:`ruizhi.walletQuota.sentence`,defaultMessage:n===`summary`?`账户余额`:`账户额度`});let r=t??0,"
  );
  if (!source.includes("ruizhiWalletQuotaWindow") || !source.includes("ruizhi.walletBalance.title")) {
    throw new Error("锐捷钱包额度展示补丁点不存在");
  }
  fs.writeFileSync(rateLimitFile, source, "utf8");
  const resetModalFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /\?\.credits\.filter\([A-Za-z_$][\w$]*\)\?\?(?:\[\]|null)/,
    "rate limit reset modal bundle"
  );
  let resetModalSource = fs.readFileSync(resetModalFile, "utf8");
  resetModalSource = resetModalSource.replace(
    /([A-Za-z_$][\w$]*)\?\.credits\.filter\(([A-Za-z_$][\w$]*)\)\?\?(\[\]|null)/g,
    "Array.isArray($1?.credits)?$1.credits.filter($2):$3/*ruizhiUsageCreditsFallback*/"
  );
  if (!resetModalSource.includes("ruizhiUsageCreditsFallback")) {
    throw new Error("Codex ???? credits ????????");
  }
  fs.writeFileSync(resetModalFile, resetModalSource, "utf8");
  const usageSettingsFile = findOneFileByContent(
    assetsDir,
    /^.+\.js$/,
    /Generic label for a usage limit row/,
    "usage settings bundle"
  );
  let usageSettingsSource = fs.readFileSync(usageSettingsFile, "utf8");
  usageSettingsSource = usageSettingsSource.replace(
    /function ([A-Za-z_$][\w$]*)\(e\)\{let t=e\.bucket\.windowDurationMins\?\?0;return/,
    "function $1(e){let t=e.bucket.windowDurationMins??0;return t===-1?`账户额度`/*ruizhiWalletQuotaSettingsLabel*/:"
  );
  if (!usageSettingsSource.includes("ruizhiWalletQuotaSettingsLabel")) {
    throw new Error("锐捷钱包设置页标签补丁点不存在");
  }
  fs.writeFileSync(usageSettingsFile, usageSettingsSource, "utf8");
  log(`已补丁锐捷钱包额度展示：${path.basename(rateLimitFile)}`);
}

function patchNativeProfileApiCallLogging() {
  const mainBuildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFileByContent(
    mainBuildDir,
    /^main-.*\.js$/,
    /CODEX_API_BASE_URL[\s\S]*?prodApiBaseUrl/,
    "main API base bundle"
  );
  const source = fs.readFileSync(mainFile, "utf8");
  if (source.includes("[ruizhi][profile-api]")) {
    log("已存在 Codex /wham/profiles/me 主进程调用日志补丁");
    return;
  }
  const patched = source.replace(
    /function ([A-Za-z_$][\w$]*)\(e,t\)\{return`\$\{([A-Za-z_$][\w$]*)\(e\)\}\/\$\{t\.replace\(\/\^\\\/\+\/,``\)\}`\}/,
    "function $1(e,t){let n=`${$2(e)}/${t.replace(/^\\/+/,``)}`;try{String(t).replace(/^\\/+/,``)===`wham/profiles/me`&&console.info(`[ruizhi][profile-api] GET /wham/profiles/me`,{url:n,apiBase:$2(e)})}catch{}return n}"
  );
  if (!patched.includes("[ruizhi][profile-api]")) {
    throw new Error("Codex /wham/profiles/me 主进程调用日志补丁点不存在");
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已补丁 Codex /wham/profiles/me 主进程调用日志：${path.basename(mainFile)}`);
}

function patchNativeBrowserDesktopFeatureAvailabilitySource(source) {
  if (source.includes("function ruizhiNativeBrowserDesktopFeatureAvailability(")) {
    return source;
  }

  const helper = "function ruizhiBrowserNativePipeLog(e,t){try{console.info(`[ruizhi][browser] ${e}`,t)}catch{}}function ruizhiNativeBrowserDesktopFeatureAvailability(e){let t={...e,browserPane:!0,inAppBrowserUse:!0,inAppBrowserUseAllowed:!0,computerUse:!0,computerUseNodeRepl:!0};return ruizhiBrowserNativePipeLog(`desktopFeatureAvailability`,{before:{browserPane:e.browserPane,inAppBrowserUse:e.inAppBrowserUse,inAppBrowserUseAllowed:e.inAppBrowserUseAllowed,computerUse:e.computerUse,computerUseNodeRepl:e.computerUseNodeRepl},after:{browserPane:t.browserPane,inAppBrowserUse:t.inAppBrowserUse,inAppBrowserUseAllowed:t.inAppBrowserUseAllowed,computerUse:t.computerUse,computerUseNodeRepl:t.computerUseNodeRepl}}),t}";
  const nativeBrowserDesktopFeatureAvailabilityPattern = /function ([A-Za-z_$][\w$]*)\(e,\{buildFlavor:[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\.resolve\(\),env:[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.default\.env,platform:[A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\.default\.platform\}=\{\}\)\{let [\s\S]*?CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE[\s\S]*?return /;
  const availabilityMatch = source.match(nativeBrowserDesktopFeatureAvailabilityPattern);
  if (availabilityMatch) {
    const functionEnd = source.indexOf("}function ", availabilityMatch.index + availabilityMatch[0].length);
    if (functionEnd === -1) {
      throw new Error("补丁点不存在：Codex 原生 Browser 桌面能力函数边界");
    }
    const originalFunction = source.slice(availabilityMatch.index, functionEnd + 1);
    const returnExpression = source.slice(availabilityMatch.index + availabilityMatch[0].length, functionEnd);
    return source.replace(originalFunction, `${helper}${availabilityMatch[0]}ruizhiNativeBrowserDesktopFeatureAvailability(${returnExpression})}`);
  }
  return replaceAnyExact(
    source,
    [
      [
        "function xe(e,{buildFlavor:n=t.O.resolve(),env:r=f.default.env,platform:i=f.default.platform}={}){let a=i===`win32`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...e,computerUse:!0,computerUseNodeRepl:!0}:e,o=n===t.O.Dev?Se(r):null;return o==null?a:{...a,...o}}",
        `${helper}function xe(e,{buildFlavor:n=t.O.resolve(),env:r=f.default.env,platform:i=f.default.platform}={}){let a=i===\`win32\`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...e,computerUse:!0,computerUseNodeRepl:!0}:e,o=n===t.O.Dev?Se(r):null;return ruizhiNativeBrowserDesktopFeatureAvailability(o==null?a:{...a,...o})}`
      ],
      [
        "function ve(e,{env:t=process.env,platform:n=process.platform}={}){return n!==`win32`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}",
        `${helper}function ve(e,{env:t=process.env,platform:n=process.platform}={}){let r=n!==\`win32\`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==\`1\`?e:{...e,computerUse:!0,computerUseNodeRepl:!0};return ruizhiNativeBrowserDesktopFeatureAvailability(r)}`
      ]
    ],
    "Codex 原生 Browser 桌面能力"
  );
}

function patchNativeBrowserDesktopFeatureAvailability() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchNativeBrowserDesktopFeatureAvailabilitySource(source);
  if (patched === source) {
    log(`已存在 Codex 原生 Browser 桌面能力补丁：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已打开 Codex 原生 Browser 桌面能力：${path.basename(mainFile)}`);
}

function patchChatGptAuthExternalBrowserSource(source) {
  if (source.includes("function ruizhiIsChatGptAuthUrl(")) {
    return source;
  }

  const helper = "function ruizhiIsChatGptAuthUrl(e){try{if(typeof e!==`string`)return!1;let t=new URL(e);return(t.protocol===`https:`||t.protocol===`http:`)&&t.pathname===`/oauth/authorize`&&t.searchParams.get(`client_id`)===`app_EMoamEEZ73f0CkXaXp7hrann`}catch{return!1}}";
  const openInBrowserPattern = /case`open-in-browser`:\{let\{url:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*);if\(typeof \1==`string`&&this\.windowManager\.queueCodexDeepLinkUrl\(\1,\2\.originHostId\)\)break;if\(\2\.useExternalBrowser===!0\)\{/;
  if (!openInBrowserPattern.test(source)) {
    throw new Error("补丁点不存在：ChatGPT 认证链接外部浏览器打开");
  }

  return source.replace(openInBrowserPattern, (match, urlName, messageName) => {
    return `${helper}case\`open-in-browser\`:{let{url:${urlName}}=${messageName};if(ruizhiIsChatGptAuthUrl(${urlName}))${messageName}={...${messageName},useExternalBrowser:!0};if(typeof ${urlName}==\`string\`&&this.windowManager.queueCodexDeepLinkUrl(${urlName},${messageName}.originHostId))break;if(${messageName}.useExternalBrowser===!0){`;
  });
}

function patchChatGptAuthExternalBrowser() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchChatGptAuthExternalBrowserSource(source);
  if (patched === source) {
    log(`已存在 ChatGPT 认证链接外部浏览器补丁：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已强制 ChatGPT 认证链接使用系统浏览器：${path.basename(mainFile)}`);
}

function replaceLocaleMessage(source, key, value) {
  const pattern = new RegExp(`("${escapeRegExp(key)}":)\`[^\`]*\``);
  if (!pattern.test(source)) {
    throw new Error(`找不到中文翻译键：${key}`);
  }
  return source.replace(pattern, `$1\`${value}\``);
}

function patchWebviewLocales() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const localeFiles = fs.readdirSync(assetsDir)
    .filter((name) => /^zh-(CN|HK|TW)-.*\.js$/.test(name))
    .map((name) => path.join(assetsDir, name));

  if (localeFiles.length === 0) {
    throw new Error("找不到中文 webview locale bundle");
  }

  const replacements = new Map([
    ["electron.onboarding.login.chatgpt.continue", "使用锐捷继续"],
    ["electron.onboarding.login.chatgpt.signIn.streamlined", "使用锐捷继续"],
    ["electron.onboarding.login.includedPlans.welcomeV2", ruizhiBuildDateLabel()]
  ]);

  for (const localeFile of localeFiles) {
    const changed = writePatchedFileIfChanged(localeFile, (source) => {
      let next = source;
      for (const [key, value] of replacements) {
        next = replaceLocaleMessage(next, key, value);
      }
      return next;
    });
    if (changed) log(`已补丁中文翻译：${path.basename(localeFile)}`);
  }
}

function patchPackageMetadata() {
  const packagePath = path.join(extractedDir, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  packageJson.name = "ruizhi-desktop";
  packageJson.productName = windowsTaskManagerName();
  packageJson.version = appVersion;
  packageJson.description = "锐捷桌面端";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  log("已补丁 package 元数据");
}

function patchWebviewHtml() {
  const htmlPath = path.join(extractedDir, "webview", "index.html");
  writePatchedFile(htmlPath, (source) =>
    replaceExact(source, "<title>Codex</title>", `<title>${windowsTaskManagerName()}</title>`, "窗口标题")
  );
  log("已补丁 webview HTML 标题");
}

function patchDefaultLocale() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const localeResolverFile = findOneFile(assetsDir, /^locale-resolver-.*\.js$/, "locale resolver bundle");

  writePatchedFile(localeResolverFile, (source) =>
    replaceExact(source, "var t=`en-US`", `var t=\`${config.locale}\``, "默认语言")
  );

  log(`已补丁默认语言：${path.basename(localeResolverFile)}`);
}

function templateLiteralValuePattern() {
  return /`((?:\\.|[^`\\])*)`/g;
}

function shortProductName() {
  return (config.shortProductName ?? config.productName.replace(/Codex.*$/u, "").trim()) || config.productName;
}

function codingProductName() {
  return config.productModes?.coding ?? `${shortProductName()} 编码`;
}

function replaceBrandInVisibleText(value) {
  let sourceValue = String(value);
  const productPrefix = config.productName.replace(/Codex.*$/u, "").trim();
  if (productPrefix) {
    sourceValue = sourceValue.replace(new RegExp(`(?:${escapeRegExp(productPrefix)}){2,}(?=Codex)`, "gu"), productPrefix);
  }
  return sourceValue.replace(/ChatGPT|Codex/g, (match, offset, source) => {
    const before = source.slice(Math.max(0, offset - 16), offset);
    if (match === "Codex" && (/GPT-[0-9A-Za-z_. -]*$/i.test(before) || (productPrefix && before.endsWith(productPrefix)))) {
      return match;
    }
    return config.productName;
  });
}

function replaceLocalizedVisibleText(id, value) {
  if (id === "sidebarElectron.productMode.chatGptWork") {
    return `<chatGpt>${shortProductName()}</chatGpt> <work>工作</work>`;
  }
  if (id === "sidebarElectron.productMode.chatGptWork.plainText") {
    return `${shortProductName()} 工作`;
  }
  if (id === "sidebarElectron.productMode.codex") {
    return codingProductName();
  }
  return replaceBrandInVisibleText(value);
}

function localeBundlePattern(locale) {
  return new RegExp(`^${escapeRegExp(locale)}-.*\\.js$`);
}

function loadLocaleMessages(locale) {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const localeFile = findOneFile(assetsDir, localeBundlePattern(locale), `${locale} locale bundle`);
  const source = fs.readFileSync(localeFile, "utf8");
  const messages = new Map();
  const pattern = /"((?:\\.|[^"\\])+)":`((?:\\.|[^`\\])*)`/g;

  for (const match of source.matchAll(pattern)) {
    messages.set(match[1], replaceLocalizedVisibleText(match[1], match[2]));
  }

  if (messages.size === 0) {
    throw new Error(`${locale} locale bundle 为空：${localeFile}`);
  }

  return { localeFile, messages };
}

function patchTemplateLiteralValues(source, transform) {
  return source.replace(templateLiteralValuePattern(), (literal, value) => {
    const next = transform(value);
    return next === value ? literal : `\`${next}\``;
  });
}

function patchLocaleBundleBrandText(localeFile) {
  const original = fs.readFileSync(localeFile, "utf8");
  const patchedMessages = original.replace(
    /"((?:\\.|[^"\\])+)":`((?:\\.|[^`\\])*)`/g,
    (match, id, value) => `"${id}":\`${replaceLocalizedVisibleText(id, value)}\``
  );
  const patched = patchTemplateLiteralValues(patchedMessages, replaceBrandInVisibleText);
  if (patched !== original) {
    fs.writeFileSync(localeFile, patched, "utf8");
  }
}

function listWebviewTextFiles() {
  const webviewRoot = path.join(extractedDir, "webview");
  const allowedExtensions = new Set([".js", ".html"]);
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && allowedExtensions.has(path.extname(entry.name))) {
        files.push(fullPath);
      }
    }
  }

  walk(webviewRoot);
  return files;
}

function patchFrontendDefaultMessages() {
  const { localeFile, messages } = loadLocaleMessages(config.locale);
  let changedFiles = 0;
  let changedMessages = 0;

  patchLocaleBundleBrandText(localeFile);

  for (const filePath of listWebviewTextFiles()) {
    if (filePath === localeFile) {
      continue;
    }
    const original = fs.readFileSync(filePath, "utf8");
    const patched = original.replace(
      /id:`([^`]+)`,defaultMessage:`((?:\\.|[^`\\])*)`/g,
      (match, id, defaultMessage) => {
        const localized = messages.get(id);
        const nextMessage = localized ?? replaceLocalizedVisibleText(id, defaultMessage);
        if (nextMessage === defaultMessage) {
          return match;
        }
        changedMessages += 1;
        return `id:\`${id}\`,defaultMessage:\`${nextMessage}\``;
      }
    );

    if (patched !== original) {
      fs.writeFileSync(filePath, patched, "utf8");
      changedFiles += 1;
    }
  }

  log(`已补丁前端默认中文文案：${changedMessages} 条，${changedFiles} 个文件`);
}

function patchAppSunsetGate() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const appSunsetFile = findOneFileByContent(
    assetsDir,
    /\.js$/,
    /appSunset\.title[\s\S]*`2929582856`/,
    "app sunset gate bundle"
  );

  writePatchedFile(appSunsetFile, (source) =>
    replaceRegex(
      source,
      /if\(([A-Za-z_$][\w$]*)\(`2929582856`\)\)\{/,
      "if(false&&$1(`2929582856`)){",
      "禁用远端 app sunset 强制更新拦截"
    )
  );
  log(`已禁用 app sunset 强制更新拦截：${path.basename(appSunsetFile)}`);
}

function patchModelAvailabilityAllowlist() {
  if (!modelCatalogEnabled()) {
    log("跳过模型白名单补丁：自定义模型目录已关闭");
    return;
  }

  const assetsDir = path.join(extractedDir, "webview", "assets");
  const modelAvailabilityAllowlistPattern = /[A-Za-z_$][\w$]*(?:\.useHiddenModels)?&&[A-Za-z_$][\w$]*!==`amazonBedrock`/;
  const modelSettingsFile = findOneFileByContent(
    assetsDir,
    /\.js$/,
    modelAvailabilityAllowlistPattern,
    "model settings bundle"
  );

  writePatchedFile(modelSettingsFile, (source) =>
    replaceRegex(
      source,
      modelAvailabilityAllowlistPattern,
      "!1",
      "禁用官方模型 available_models 白名单过滤"
    )
  );

  log(`已禁用模型白名单过滤：${path.basename(modelSettingsFile)}`);
}

function patchListModelsForHostFromUserCache() {
  if (!modelCatalogEnabled()) {
    log("跳过模型缓存列表补丁：自定义模型目录已关闭");
    return;
  }

  const assetsDir = path.join(extractedDir, "webview", "assets");
  const modelListQueryFnPattern = /queryFn:\(\)=>([A-Za-z_$][\w$]*)\(`list-models-for-host`,\{hostId:([A-Za-z_$][\w$]*),includeHidden:!0,cursor:null,limit:([A-Za-z_$][\w$]*)\}\)/;
  const modelQueriesFile = findOneFileByContent(assetsDir, /\.js$/, modelListQueryFnPattern, "model queries bundle");

  writePatchedFile(modelQueriesFile, (source) => {
    const normalizeModelListResult = `ruizhiNormalizeModel=ruizhiModel=>{let ruizhiLevels=Array.isArray(ruizhiModel?.supported_reasoning_levels)?ruizhiModel.supported_reasoning_levels:[],ruizhiEfforts=Array.isArray(ruizhiModel?.supportedReasoningEfforts)?ruizhiModel.supportedReasoningEfforts:[];if(ruizhiLevels.length===0)ruizhiLevels=ruizhiEfforts.map(ruizhiEntry=>({effort:ruizhiEntry.reasoningEffort,description:ruizhiEntry.description??ruizhiEntry.reasoningEffort}));if(ruizhiEfforts.length===0)ruizhiEfforts=ruizhiLevels.map(ruizhiEntry=>({reasoningEffort:ruizhiEntry.effort,description:ruizhiEntry.description??ruizhiEntry.effort}));let ruizhiModalities=[...new Set([...(Array.isArray(ruizhiModel?.input_modalities)?ruizhiModel.input_modalities:[]),...(Array.isArray(ruizhiModel?.inputModalities)?ruizhiModel.inputModalities:[])])];return {...ruizhiModel,supported_reasoning_levels:ruizhiLevels,supportedReasoningEfforts:ruizhiEfforts,input_modalities:ruizhiModalities,inputModalities:ruizhiModalities}},ruizhiNormalizeResult=ruizhiResult=>({...ruizhiResult,data:Array.isArray(ruizhiResult?.data)?ruizhiResult.data.map(ruizhiNormalizeModel):[]})`;
    const modelListQueryFnReplacement = (rpcCall, hostId, limit) =>
      `queryFn:()=>{let ruizhiArgs={hostId:${hostId},includeHidden:!0,cursor:null,limit:${limit}},ruizhiNormalizeModelsResult=ruizhiResult=>{let ruizhiModels=Array.isArray(ruizhiResult?.data)?ruizhiResult.data:[];for(let ruizhiModel of ruizhiModels){if(!ruizhiModel||typeof ruizhiModel!==\`object\`)continue;ruizhiModel.input_modalities=[\`text\`,\`image\`];ruizhiModel.inputModalities=ruizhiModel.input_modalities;let ruizhiEfforts=Array.isArray(ruizhiModel.supported_reasoning_efforts)?ruizhiModel.supported_reasoning_efforts.filter(Boolean):[],ruizhiDesktopEfforts=Array.isArray(ruizhiModel.supportedReasoningEfforts)?ruizhiModel.supportedReasoningEfforts.map(e=>typeof e===\`string\`?e:e?.reasoningEffort||e?.effort).filter(Boolean):[],ruizhiLevels=Array.isArray(ruizhiModel.supported_reasoning_levels)?ruizhiModel.supported_reasoning_levels.map(e=>typeof e===\`string\`?e:e?.effort||e?.reasoningEffort).filter(Boolean):[];let ruizhiFinalEfforts=ruizhiEfforts.length?ruizhiEfforts:ruizhiDesktopEfforts.length?ruizhiDesktopEfforts:ruizhiLevels.length?ruizhiLevels:[\`minimal\`,\`low\`,\`medium\`,\`high\`,\`xhigh\`];ruizhiModel.supported_reasoning_efforts=ruizhiFinalEfforts;ruizhiModel.supportedReasoningEfforts=ruizhiFinalEfforts.map(e=>({reasoningEffort:e,description:e}));if(typeof ruizhiModel.defaultReasoningEffort!==\`string\`||!ruizhiModel.defaultReasoningEffort)ruizhiModel.defaultReasoningEffort=ruizhiModel.default_reasoning_level||\`medium\`;if(typeof ruizhiModel.default_reasoning_level!==\`string\`||!ruizhiModel.default_reasoning_level)ruizhiModel.default_reasoning_level=ruizhiModel.defaultReasoningEffort}return {...ruizhiResult,data:ruizhiModels}},ruizhiCall=globalThis.ruizhiDesktop?.enhance?.call;if(typeof ruizhiCall!==\`function\`)return ${rpcCall}(\`list-models-for-host\`,ruizhiArgs).then(ruizhiNormalizeModelsResult);return ruizhiCall(\`/models/list\`,ruizhiArgs).then(ruizhiResult=>{if(ruizhiResult?.status===\`ok\`&&Array.isArray(ruizhiResult.data))return ruizhiNormalizeModelsResult({data:ruizhiResult.data,nextCursor:null});return ${rpcCall}(\`list-models-for-host\`,ruizhiArgs).then(ruizhiNormalizeModelsResult)})}`;
    const forceFreshModelListQuery = (next) =>
      next.replace(
        /staleTime:[^,}]+,(queryFn:\(\)=>\{let (?:ruizhiArgs|ruizhiNormalizeModel)=)/,
        "staleTime:0,$1"
      );
    if (source.includes("ruizhiNormalizeModel=")) return forceFreshModelListQuery(source);
    if (source.includes("ruizhiCall=globalThis.ruizhiDesktop?.enhance?.call")) {
      throw new Error("补丁点未知：旧版用户 models_cache.json 前端字段适配补丁");
    }
    const legacyModelListQueryFnPattern = /function ruizhiListModelsForHostFromUserCache\(e\)\{let t=globalThis\.ruizhiDesktop\?\.enhance\?\.call;if\(typeof t!==`function`\)return ([A-Za-z_$][\w$]*)\(`list-models-for-host`,e\);return t\(`\/models\/list`,e\)\.then\(t=>\{if\(t\?\.status===`ok`&&Array\.isArray\(t\.data\)\)\{let models=t\.data;return \{data:models,nextCursor:null\}\}return [A-Za-z_$][\w$]*\(`list-models-for-host`,e\)\}\)\}queryFn:\(\)=>ruizhiListModelsForHostFromUserCache\(\{hostId:([A-Za-z_$][\w$]*),includeHidden:!0,cursor:null,limit:([A-Za-z_$][\w$]*)\}\)/;
    const legacyMatch = source.match(legacyModelListQueryFnPattern);
    if (legacyMatch) {
      return forceFreshModelListQuery(replaceRegex(
        source,
        legacyModelListQueryFnPattern,
        modelListQueryFnReplacement(legacyMatch[1], legacyMatch[2], legacyMatch[3]),
        "修复旧版用户 models_cache.json 模型列表补丁"
      ));
    }
    if (source.includes("function ruizhiListModelsForHostFromUserCache(")) {
      throw new Error("补丁点未知：旧版用户 models_cache.json 模型列表补丁");
    }
    const match = source.match(modelListQueryFnPattern);
    if (!match) {
      throw new Error("补丁点不存在：改用用户 models_cache.json 作为模型列表数据源");
    }
    const rpcCall = match[1];
    const hostId = match[2];
    const limit = match[3];
    return forceFreshModelListQuery(replaceRegex(
      source,
      modelListQueryFnPattern,
      modelListQueryFnReplacement(rpcCall, hostId, limit),
      "改用用户 models_cache.json 作为模型列表数据源"
    ));
  });

  log(`已改用用户模型缓存列表：${path.basename(modelQueriesFile)}`);
}

function patchOfficialUpdateLogic() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");

  writePatchedFile(mainFile, (source) =>
    replaceRegex(
      source,
      /([A-Za-z_$][\w$]*)=t\.[A-Za-z_$][\w$]*\.shouldIncludeSparkle\(([A-Za-z_$][\w$]*),process\.platform,process\.env\),([A-Za-z_$][\w$]*)=t\.[A-Za-z_$][\w$]*\.shouldIncludeUpdater\(\2,process\.platform,process\.env\)/,
      "$1=!1,$3=!1",
      "禁用 Codex 官方 Sparkle/updater 能力"
    )
  );

  log(`已禁用 Codex 官方更新逻辑：${path.basename(mainFile)}`);
}

function patchOnboardingWindowMode() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");

  writePatchedFile(mainFile, (source) =>
    replaceRegex(
      source,
      /function ([A-Za-z_$][\w$]*)\(e\)\{return e\.mode===`onboarding`\?e\.onboardingVariant===`v2`\?\{width:[A-Za-z_$][\w$]*,height:[A-Za-z_$][\w$]*\}:\{width:[A-Za-z_$][\w$]*,height:[A-Za-z_$][\w$]*\}:null\}/,
      "function $1(e){return null}",
      "禁用 onboarding 紧凑窗口尺寸，登录页沿用主窗口尺寸"
    )
  );

  log(`已禁用 onboarding 紧凑窗口尺寸：${path.basename(mainFile)}`);
}

function jsonLiteral(value) {
  return JSON.stringify(value);
}

function bootstrapInitCode() {
  const imageGenHelper = imageGenHelperExeName();
  const marketplaceSpecs = pluginMarketplaces().map((marketplace) => ({
    name: marketplace.name,
    resourcePath: splitConfigPath(marketplace.resourcePath),
    installPath: splitConfigPath(marketplace.installPath),
    versionManifestPath: splitConfigPath(marketplace.versionManifestPath),
    sourceToken: marketplaceSourceToken(marketplace.name),
    online: marketplace.online && marketplace.online.enabled !== false
      ? {
          name: marketplace.online.name || `${marketplace.name}-online`,
          source: marketplace.online.source,
          ref: marketplace.online.ref,
          sparse: Array.isArray(marketplace.online.sparse) ? marketplace.online.sparse : [],
          autoUpgrade: marketplace.online.autoUpgrade === true
        }
      : null
  }));
  marketplaceSpecs.push({
    name: "openai-bundled",
    resourcePath: ["plugins", "openai-bundled"],
    installPath: [".tmp", "bundled-marketplaces", "openai-bundled"],
    versionManifestPath: [".agents", "plugins", "marketplace.json"],
    sourceToken: marketplaceSourceToken("openai-bundled"),
    alwaysCopy: true,
    hardcodedPlugins: true
  });
  const execPolicyConfig = config.execPolicy ?? {};
  const managedRulesFileName = execPolicyConfig.managedRulesFileName ?? "ruizhi-managed.rules";
  const allowPrefixRules = builtInAllowPrefixRules();

  return `
async function ruizhiInit(){
  try{
    const fs=require("node:fs");
    const os=require("node:os");
    const path=require("node:path");
    const productName=${jsonLiteral(config.productName)};
    const electronUserDataDirName=${jsonLiteral(electronUserDataDirName)};
    const locale=${jsonLiteral(config.locale)};
    const ruizhiHomeEnvName=${jsonLiteral(ruizhiHomeEnvName)};
    const ruizhiDefaultHomeDirName=${jsonLiteral(ruizhiDefaultHomeDirName)};
    const openaiBaseUrl=${jsonLiteral(buildOpenAIBaseUrl)};
    const ruijieProviderBaseUrl=${jsonLiteral(buildProviderBaseUrl)};
    const ruijieChatGptLoginBaseUrl=${jsonLiteral(buildChatGptLoginBaseUrl)};
    const ruijieChatModelPrefixes=${jsonLiteral(ruijieChatModelPrefixesConfig())};
    const chatGptBackendApiBaseUrl=${jsonLiteral(buildChatGptLoginBaseUrl)};
    const modelProviderBaseUrl=${jsonLiteral(modelProviderBaseUrl())};
    const modelBridgeConfig=${jsonLiteral({
      enabled: modelBridgeEnabled(),
      host: modelBridgeHost(),
      port: modelBridgePort(),
      scriptResourcePath: splitConfigPath(modelBridgeRuntimeResourcePath()),
      routes: modelBridgeRoutes()
    })};
    const modelCatalogEnabled=${jsonLiteral(modelCatalogEnabled())};
    const imageGenHelper=${jsonLiteral(imageGenHelper)};
    const modelCatalogFile="ruizhi-model-catalog.json";
    const userModelCatalogFile="models_cache.json";
    const systemSkillsRoot=["skills",".system"];
    const hiddenSystemSkillNames=${jsonLiteral(hiddenSystemSkillNames)};
    const managedRulesFileName=${jsonLiteral(managedRulesFileName)};
    const allowPrefixRules=${jsonLiteral(allowPrefixRules)};
    const home=os.homedir();
    const resourcesRoot=process.resourcesPath||path.dirname(process.execPath);
    function defaultUserDataPath(){
      if(process.platform==="win32"){
        return path.join(process.env.APPDATA||path.join(home,"AppData","Roaming"),electronUserDataDirName);
      }
      if(process.platform==="darwin"){
        return path.join(home,"Library","Application Support",electronUserDataDirName);
      }
      return path.join(process.env.XDG_CONFIG_HOME||path.join(home,".config"),electronUserDataDirName);
    }
    const explicitRuizhiHome=(process.env[ruizhiHomeEnvName]||"").trim();
    const codexHome=explicitRuizhiHome||path.join(home,ruizhiDefaultHomeDirName);
    const userData=(process.env.CODEX_ELECTRON_USER_DATA_PATH||"").trim()||defaultUserDataPath();
    function stableModelBridgePort(basePort,seed){
      let hash=0;
      for(const char of String(seed||"")){
        hash=(hash*31+char.charCodeAt(0))>>>0;
      }
      return basePort+1+(hash%997);
    }
    modelBridgeConfig.port=stableModelBridgePort(modelBridgeConfig.port,resourcesRoot);
    function ensureLoopbackNoProxy(){
      const required=["127.0.0.1","localhost","::1"];
      const existing=[process.env.NO_PROXY,process.env.no_proxy].filter(value=>typeof value==="string"&&value.trim()).join(",");
      const parts=existing.split(",").map(value=>value.trim()).filter(Boolean);
      const lower=new Set(parts.map(value=>value.toLowerCase()));
      for(const host of required){
        if(!lower.has(host.toLowerCase()))parts.push(host);
      }
      const next=parts.join(",");
      process.env.NO_PROXY=next;
      process.env.no_proxy=next;
    }
    ensureLoopbackNoProxy();
    function startModelBridge(){
      if(!modelBridgeConfig.enabled)return null;
      const scriptPath=path.join(resourcesRoot,...modelBridgeConfig.scriptResourcePath);
      const bridge=require(scriptPath).startRuizhiResponsesBridge({
        host:modelBridgeConfig.host,
        port:modelBridgeConfig.port,
        upstreamBaseUrl:openaiBaseUrl,
        authHome:codexHome,
        catalogPath:path.join(codexHome,userModelCatalogFile),
        routes:modelBridgeConfig.routes
      });
      return bridge.baseUrl;
    }
    fs.mkdirSync(codexHome,{recursive:true});
    fs.mkdirSync(userData,{recursive:true});
    syncModelCache();
    watchModelCatalogCache();
    const runtimeBridgeBaseUrl=startModelBridge();
    const runtimeModelProviderBaseUrl=runtimeBridgeBaseUrl||modelProviderBaseUrl;
    process.env[ruizhiHomeEnvName]=codexHome;
    process.env.CODEX_HOME=codexHome;
    process.env.CODEX_ELECTRON_USER_DATA_PATH=userData;
    process.env.CODEX_API_BASE_URL=chatGptBackendApiBaseUrl;
    process.env.RUIZHI_PLATFORM_BASE_URL=chatGptBackendApiBaseUrl;
    process.env.RUIZHI_OPENAI_BASE_URL=openaiBaseUrl;
    process.env.RUIZHI_MODEL_PROVIDER_BASE_URL=runtimeModelProviderBaseUrl;
    process.env.RUIZHI_IMAGEGEN_EXE=path.join(resourcesRoot,"bin",imageGenHelper);
    syncRuijieUniApiKeyEnvFromAuth();
    process.env.RUIZHI_DEFAULT_LOCALE=locale;

    function copyIfChanged(source,target){
      if(!fs.existsSync(source))return false;
      let changed=true;
      try{
        changed=!fs.existsSync(target)||fs.readFileSync(source).compare(fs.readFileSync(target))!==0;
      }catch{
        changed=true;
      }
      if(changed){
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.copyFileSync(source,target);
      }
      return changed;
    }
    function syncModelCache(){
      if(!modelCatalogEnabled)return false;
      return syncBundledModelCatalogCache();
    }
    function bundledModelCatalogPath(){
      return path.join(resourcesRoot,"models",modelCatalogFile);
    }
    function syncBundledModelCatalogCache(){
      const target=path.join(codexHome,userModelCatalogFile);
      try{
        return writeModelCatalogCacheFromSource(bundledModelCatalogPath(),target);
      }catch(error){
        console.warn("ruizhi bundled model catalog sync failed",error);
        return false;
      }
    }
    function normalizeExistingModelCatalogCache(target){
      try{
        if(!fs.existsSync(target))return false;
        validateModelCatalogFile(target);
        return true;
      }catch(error){
        console.warn("ruizhi existing model catalog cache invalid, falling back to bundled catalog",error);
        return false;
      }
    }
    function writeModelCatalogCacheFromSource(source,target){
      const temp=path.join(codexHome,\`.model-catalog.\${Date.now()}.\${Math.random().toString(16).slice(2)}.tmp\`);
      try{
        if(!fs.existsSync(source))throw new Error("内置模型目录不存在："+source);
        fs.mkdirSync(path.dirname(temp),{recursive:true});
        fs.copyFileSync(source,temp);
        validateModelCatalogFile(temp);
        normalizeModelCatalogFile(temp);
        const changed=!fs.existsSync(target)||fs.readFileSync(temp).compare(fs.readFileSync(target))!==0;
        if(!changed){
          fs.rmSync(temp,{force:true});
          return false;
        }
        backupExistingModelCatalog(target);
        fs.renameSync(temp,target);
        return true;
      }catch(error){
        fs.rmSync(temp,{force:true});
        throw error;
      }
    }
    function validateModelCatalogFile(filePath){
      const catalog=JSON.parse(fs.readFileSync(filePath,"utf8"));
      if(!catalog||typeof catalog!=="object"||!Array.isArray(catalog.models)||catalog.models.length===0){
        throw new Error("模型目录格式无效");
      }
      const requiredFields=["slug","display_name","supported_reasoning_levels","shell_type","visibility","supported_in_api","priority","base_instructions","supports_reasoning_summaries","support_verbosity","truncation_policy","supports_parallel_tool_calls","experimental_supported_tools"];
      for(const model of catalog.models){
        const missing=requiredFields.filter(field=>!Object.prototype.hasOwnProperty.call(model,field));
        if(missing.length>0)throw new Error("模型目录条目 "+String(model?.slug||model?.id||"<unknown>")+" 缺少 Codex 必填字段："+missing.join(", "));
      }
      return catalog;
    }
    function applyRuizhiModelCatalogCompatibilityPatches(catalog){
      if(!catalog||typeof catalog!=="object"||!Array.isArray(catalog.models))return catalog;
      catalog.models=catalog.models.filter(model=>!isNonChatModelCatalogEntry(model));
      const guidance="\\n\\n## Codex Desktop Plugin Control\\n- When the user invokes \`[@浏览器]\` or \`plugin://browser@openai-bundled\`, use the Browser plugin's trusted runtime through the \`mcp__node_repl__js\` tool and select the \`iab\` browser. Do not use \`exec_command\`, \`node -e\`, standalone Playwright, or a system browser for this plugin.\\n- Browser plugin native-pipe authorization depends on Codex turn metadata in \`nodeRepl.requestMeta\`; a separate shell process cannot provide the required \`session_id\` / \`turn_id\` and will fail as not trusted.";
      const append=value=>{
        if(typeof value!=="string"||value.length===0)return value;
        if(value.includes("plugin://browser@openai-bundled")&&value.includes("mcp__node_repl__js"))return value;
        return value.trimEnd()+guidance;
      };
      const defaultReasoningLevels=()=>[
        {effort:"minimal",description:"最少推理"},
        {effort:"low",description:"轻量推理"},
        {effort:"medium",description:"标准推理"},
        {effort:"high",description:"深度推理"},
        {effort:"xhigh",description:"最高推理"}
      ];
      const ensureTextAndImageInputModalities=value=>{
        const modalities=Array.isArray(value)?value.filter(item=>typeof item==="string"&&item.length>0):[];
        for(const modality of ["text","image"]){
          if(!modalities.includes(modality))modalities.push(modality);
        }
        return modalities;
      };
      for(const model of catalog.models){
        if(!model||typeof model!=="object")continue;
        model.input_modalities=["text","image"];
        model.inputModalities=model.input_modalities;
        if(!Array.isArray(model.supported_reasoning_levels)||model.supported_reasoning_levels.length===0)model.supported_reasoning_levels=defaultReasoningLevels();
        if(typeof model.default_reasoning_level!=="string"||model.default_reasoning_level.length===0)model.default_reasoning_level="medium";
        if(!Array.isArray(model.supported_reasoning_efforts)||model.supported_reasoning_efforts.length===0)model.supported_reasoning_efforts=["minimal","low","medium","high","xhigh"];
        model.supportedReasoningEfforts=model.supported_reasoning_levels.map(entry=>({reasoningEffort:entry.effort,description:entry.description??entry.effort}));
        model.defaultReasoningEffort=model.default_reasoning_level;
        if(typeof model.slug==="string"&&/^qwen/i.test(model.slug)){
          model.base_instructions=append(model.base_instructions);
          if(model.model_messages&&typeof model.model_messages==="object"){
            model.model_messages.instructions_template=append(model.model_messages.instructions_template);
          }
        }
      }
      return catalog;
    }
    function isNonChatModelCatalogEntry(model){
      const id=[model?.slug,model?.id,model?.name,model?.display_name,model?.displayName].map(value=>String(value??"").trim().toLowerCase()).filter(Boolean).join(" ");
      if(!id)return false;
      return /(^|[\\s/_-])(?:gpt-)?image\\d*(?=$|[\\s/_-])/.test(id)||/(^|[\\s/_-])dall-e(?=$|[\\s/_-])/.test(id)||/(^|[\\s/_-])(?:text-)?embedding(?=$|[\\s/_-])/.test(id)||/(^|[\\s/_-])(?:realtime|rerank|reranker)(?=$|[\\s/_-])/.test(id);
    }
    function normalizeModelCatalogFile(filePath){
      const catalog=validateModelCatalogFile(filePath);
      applyRuizhiModelCatalogCompatibilityPatches(catalog);
      fs.writeFileSync(filePath,JSON.stringify(catalog,null,2)+"\\n","utf8");
      return catalog;
    }
    function normalizeUserModelCatalogCache(){
      const target=path.join(codexHome,userModelCatalogFile);
      try{
        if(!fs.existsSync(target))return false;
        const original=fs.readFileSync(target,"utf8");
        const catalog=validateModelCatalogFile(target);
        applyRuizhiModelCatalogCompatibilityPatches(catalog);
        const next=JSON.stringify(catalog,null,2)+"\\n";
        if(next===original)return false;
        const temp=path.join(codexHome,".model-catalog-normalize."+Date.now()+"."+Math.random().toString(16).slice(2)+".tmp");
        try{
          fs.writeFileSync(temp,next,"utf8");
          validateModelCatalogFile(temp);
          backupExistingModelCatalog(target);
          fs.renameSync(temp,target);
          return true;
        }finally{fs.rmSync(temp,{force:true});}
      }catch(error){
        console.warn("ruizhi model catalog post-refresh normalize failed",error);
        try{return writeModelCatalogCacheFromSource(bundledModelCatalogPath(),target);}catch(fallbackError){console.warn("ruizhi bundled model catalog recovery failed",fallbackError);}
        return false;
      }
    }
    function watchModelCatalogCache(){
      if(!modelCatalogEnabled)return;
      const target=path.join(codexHome,userModelCatalogFile);
      let timer=null;
      const schedule=()=>{
        if(timer)clearTimeout(timer);
        timer=setTimeout(()=>{
          timer=null;
          normalizeUserModelCatalogCache();
        },750);
      };
      try{
        normalizeUserModelCatalogCache();
        fs.watchFile(target,{interval:1000},(current,previous)=>{
          if(current.mtimeMs!==previous.mtimeMs||current.size!==previous.size)schedule();
        });
      }catch(error){
        console.warn("ruizhi model catalog watcher failed",error);
      }
    }
    function backupExistingModelCatalog(target){
      if(!fs.existsSync(target))return;
      const stamp=new Date().toISOString().replace(/[:.]/g,"-");
      fs.copyFileSync(target,\`\${target}.bak-\${stamp}\`);
    }
    function syncSystemSkills(){
      const sourceRoot=path.join(resourcesRoot,...systemSkillsRoot);
      const targetRoot=path.join(codexHome,...systemSkillsRoot);
      for(const skillName of hiddenSystemSkillNames){
        fs.rmSync(path.join(targetRoot,skillName),{recursive:true,force:true});
      }
      if(!fs.existsSync(sourceRoot))return;
      for(const skillName of fs.readdirSync(sourceRoot)){
        if(hiddenSystemSkillNames.includes(skillName))continue;
        const source=path.join(sourceRoot,skillName,"SKILL.md");
        if(!fs.existsSync(source))continue;
        copyIfChanged(source,path.join(targetRoot,skillName,"SKILL.md"));
      }
    }
    function copyDirectoryEntriesIfMissing(sourceRoot,targetRoot){
      if(!fs.existsSync(sourceRoot))return 0;
      let copied=0;
      fs.mkdirSync(targetRoot,{recursive:true});
      for(const entry of fs.readdirSync(sourceRoot,{withFileTypes:true})){
        if(entry.name.startsWith(".")||entry.name==="openai-docs")continue;
        const source=path.join(sourceRoot,entry.name);
        const target=path.join(targetRoot,entry.name);
        if(fs.existsSync(target))continue;
        fs.cpSync(source,target,{recursive:true});
        copied+=1;
      }
      return copied;
    }
    function syncLegacyCodexGlobalSkills(){
      try{
        copyDirectoryEntriesIfMissing(path.join(home,".codex","skills"),path.join(home,".agents","skills"));
      }catch(error){
        console.error("ruizhi legacy skill migration failed",error);
      }
    }
    syncSystemSkills();
    syncLegacyCodexGlobalSkills();

    const marketplaceSpecs=${jsonLiteral(marketplaceSpecs)};
    const hardcodedOpenAIBundledPlugins=${jsonLiteral(openAIBundledPluginDefinitions)};
    function assertInside(base,target){
      const relative=path.relative(path.resolve(base),path.resolve(target));
      if(!relative||relative.startsWith("..")||path.isAbsolute(relative)){
        throw new Error("拒绝覆盖锐捷目录外的 marketplace："+target);
      }
    }
    function readMarketplaceVersion(root,spec){
      const manifestPath=path.join(root,...spec.versionManifestPath);
      if(!fs.existsSync(manifestPath))return null;
      const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
      return [manifest.name||"",manifest.version||""].join("@");
    }
    function readMarketplaceManifest(root){
      const manifestPath=path.join(root,".agents","plugins","marketplace.json");
      if(!fs.existsSync(manifestPath))return null;
      const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
      return Array.isArray(manifest.plugins)?manifest:null;
    }
    function marketplaceNeedsRefresh(sourceRoot,targetRoot){
      const sourceManifest=readMarketplaceManifest(sourceRoot);
      const targetManifest=readMarketplaceManifest(targetRoot);
      if(!sourceManifest||!targetManifest)return true;
      const targetNames=new Set(targetManifest.plugins.map(plugin=>plugin&&plugin.name).filter(Boolean));
      if(targetNames.size<sourceManifest.plugins.length)return true;
      for(const plugin of sourceManifest.plugins){
        if(!plugin||typeof plugin.name!=="string"||plugin.name.length===0)return true;
        if(!targetNames.has(plugin.name))return true;
      }
      return false;
    }
    function hardcodedOpenAIBundledMarketplace(){
      return {
        name:"openai-bundled",
        interface:{displayName:"OpenAI"},
        plugins:hardcodedOpenAIBundledPlugins.map(plugin=>({
          name:plugin.name,
          source:{source:"local",path:plugin.path},
          policy:{installation:"AVAILABLE",authentication:"ON_INSTALL"},
          category:plugin.category
        }))
      };
    }
    function writeHardcodedOpenAIBundledMarketplace(root){
      const missing=[];
      for(const plugin of hardcodedOpenAIBundledPlugins){
        const pluginRoot=path.join(root,"plugins",plugin.name);
        const manifestPath=path.join(pluginRoot,".codex-plugin","plugin.json");
        if(!fs.existsSync(manifestPath))missing.push(plugin.name);
      }
      if(missing.length>0){
        throw new Error("内置 OpenAI 插件资源缺失："+missing.join(", "));
      }
      const marketplacePath=path.join(root,".agents","plugins","marketplace.json");
      fs.mkdirSync(path.dirname(marketplacePath),{recursive:true});
      fs.writeFileSync(marketplacePath,JSON.stringify(hardcodedOpenAIBundledMarketplace(),null,2)+"\\n","utf8");
    }
    function copyMarketplaceDirectory(sourceRoot,targetRoot,spec){
      const stagingRoot=targetRoot+".staging-"+process.pid+"-"+Date.now();
      assertInside(codexHome,targetRoot);
      assertInside(codexHome,stagingRoot);
      fs.rmSync(stagingRoot,{recursive:true,force:true});
      try{
        fs.mkdirSync(path.dirname(stagingRoot),{recursive:true});
        fs.cpSync(sourceRoot,stagingRoot,{recursive:true});
        if(spec.hardcodedPlugins)writeHardcodedOpenAIBundledMarketplace(stagingRoot);
        fs.rmSync(targetRoot,{recursive:true,force:true});
        fs.renameSync(stagingRoot,targetRoot);
      }catch(error){
        fs.rmSync(stagingRoot,{recursive:true,force:true});
        throw error;
      }
    }
    function syncMarketplaces(){
      const tokenValues={};
      for(const spec of marketplaceSpecs){
        const sourceRoot=path.join(resourcesRoot,...spec.resourcePath);
        const targetRoot=path.join(codexHome,...spec.installPath);
        tokenValues[spec.sourceToken]=targetRoot;
        try{
          const sourceVersion=readMarketplaceVersion(sourceRoot,spec);
          if(!sourceVersion)throw new Error("缺少 marketplace 版本清单："+sourceRoot);
          const targetVersion=readMarketplaceVersion(targetRoot,spec);
          if(spec.alwaysCopy||sourceVersion!==targetVersion||marketplaceNeedsRefresh(sourceRoot,targetRoot)){
            copyMarketplaceDirectory(sourceRoot,targetRoot,spec);
          }else if(spec.hardcodedPlugins){
            writeHardcodedOpenAIBundledMarketplace(targetRoot);
          }
        }catch(error){
          console.error("ruizhi marketplace sync failed",spec.name,error);
        }
      }
      return tokenValues;
    }
    function tomlString(value){
      return JSON.stringify(String(value??""));
    }
    function managedMarketplaceSpecs(){
      return marketplaceSpecs.filter(spec=>spec.hardcodedPlugins!==true&&spec.alwaysCopy!==true);
    }
    function marketplaceConfigBlock(spec,source){
      const online=spec.online;
      if(online&&online.source&&online.autoUpgrade===true){
        const lines=[
          "[marketplaces."+spec.name+"]",
          "source_type = "+tomlString("git"),
          "source = "+tomlString(online.source)
        ];
        if(online.ref)lines.push("ref = "+tomlString(online.ref));
        if(Array.isArray(online.sparse)&&online.sparse.length>0)lines.push("sparse = "+JSON.stringify(online.sparse.map(item=>String(item))));
        lines.push("");
        return lines.join("\\n");
      }
      return [
        "[marketplaces."+spec.name+"]",
        "source_type = "+tomlString("local"),
        "source = "+tomlString(source),
        ""
      ].join("\\n");
    }
    function upsertTomlTable(source,tableName,block){
      const header="["+tableName+"]";
      const lines=String(source??"").split("\\n");
      let start=-1;
      for(let index=0;index<lines.length;index+=1){
        if(lines[index].trim()===header){start=index;break;}
      }
      if(start>=0){
        let end=lines.length;
        for(let index=start+1;index<lines.length;index+=1){
          if(/^\\s*\\[[^\\]]+\\]\\s*$/.test(lines[index])){end=index;break;}
        }
        const replacement=block.replace(/\\n$/,"").split("\\n");
        lines.splice(start,end-start,...replacement);
        return lines.join("\\n").replace(/\\n*$/,"\\n");
      }
      const prefix=String(source??"").replace(/\\n*$/,"");
      return prefix+(prefix.trim().length>0?"\\n\\n":"")+block.replace(/\\n*$/,"\\n");
    }
    function syncManagedMarketplaceConfig(marketplaceSources){
      const specs=managedMarketplaceSpecs();
      if(specs.length===0)return;
      const configPath=path.join(codexHome,"config.toml");
      let next=fs.existsSync(configPath)?fs.readFileSync(configPath,"utf8"):"";
      let changed=false;
      for(const spec of specs){
        const source=marketplaceSources[spec.sourceToken];
        if(!source||!fs.existsSync(path.join(source,".agents","plugins","marketplace.json")))continue;
        const tableName="marketplaces."+spec.name;
        const block=marketplaceConfigBlock(spec,source);
        const updated=upsertTomlTable(next,tableName,block);
        if(updated!==next){next=updated;changed=true;}
      }
      if(changed){
        fs.mkdirSync(path.dirname(configPath),{recursive:true});
        fs.writeFileSync(configPath,next,"utf8");
      }
    }
    function tomlLines(source){
      return String(source??"").split("\\n");
    }
    function joinTomlLines(lines){
      return lines.join("\\n").replace(/\\n*$/,"\\n");
    }
    function tomlKeyLine(key,value){
      return key+" = "+JSON.stringify(String(value));
    }
    function isTomlHeader(line){
      const trimmed=String(line??"").trim();
      return trimmed.startsWith("[")&&trimmed.endsWith("]");
    }
    function tomlKey(line){
      const trimmed=String(line??"").trimStart();
      const equals=trimmed.indexOf("=");
      if(equals<0)return null;
      const key=trimmed.slice(0,equals).trim();
      return /^[A-Za-z0-9_.-]+$/.test(key)?key:null;
    }
    function tomlStringArrayValue(line){
      const raw=String(line??"");
      const equals=raw.indexOf("=");
      if(equals<0)return [];
      const value=raw.slice(equals+1).split("#")[0].trim();
      try{
        const parsed=JSON.parse(value);
        return Array.isArray(parsed)?parsed.map(item=>String(item)):[];
      }catch{return [];}
    }
    function tomlStringValue(line){
      const raw=String(line??"");
      const equals=raw.indexOf("=");
      if(equals<0)return "";
      const value=raw.slice(equals+1).split("#")[0].trim();
      try{
        const parsed=JSON.parse(value);
        return typeof parsed==="string"?parsed.trim():"";
      }catch{
        const quote=value[0];
        if((quote==="'"||quote==='"')&&value.endsWith(quote))return value.slice(1,-1).trim();
        return value.trim();
      }
    }
    function findTomlTable(lines,header){
      let start=-1;
      for(let index=0;index<lines.length;index+=1){
        if((()=>{const value=String(lines[index]).trim();return value.charCodeAt(0)===65279?value.slice(1):value;})()===header){start=index;break;}
      }
      if(start<0)return null;
      let end=lines.length;
      for(let index=start+1;index<lines.length;index+=1){
        if(isTomlHeader(lines[index])){end=index;break;}
      }
      return {start,end};
    }
    function insertTopLevelTomlKeyIfMissing(source,key,value){
      const lines=tomlLines(source);
      const next=tomlKeyLine(key,value);
      let firstTable=lines.length;
      for(let index=0;index<lines.length;index+=1){
        if(isTomlHeader(lines[index])){firstTable=index;break;}
      }
      for(let index=0;index<firstTable;index+=1){
        if(tomlKey(lines[index])===key){
          return joinTomlLines(lines);
        }
      }
      let insertAt=firstTable;
      while(insertAt>0&&String(lines[insertAt-1]).trim()==="")insertAt-=1;
      lines.splice(insertAt,0,next);
      return joinTomlLines(lines);
    }
    function patchRuijieProviderConfig(source){
      const header="[model_providers.ruijie-uniapi]";
      const lines=tomlLines(source);
      let table=findTomlTable(lines,header);
      if(!table){
        const block=[
          header,
          tomlKeyLine("name","ruijie-uniapi"),
          tomlKeyLine("env_key","RUIJIE_UNIAPI_KEY"),
          tomlKeyLine("base_url",ruijieProviderBaseUrl),
          tomlKeyLine("wire_api","responses"),
          "requires_openai_auth = true",
          "chat_model_prefixes = "+JSON.stringify(ruijieChatModelPrefixes.map(item=>String(item))),
          ""
        ].join("\\n");
        const prefix=String(source??"").replace(/\\n*$/,"\\n");
        return prefix+(prefix.trim().length>0?"\\n":"")+block;
      }
      let {start,end}=table;
      const requiredFields={
        name:tomlKeyLine("name","ruijie-uniapi"),
        env_key:tomlKeyLine("env_key","RUIJIE_UNIAPI_KEY"),
        wire_api:tomlKeyLine("wire_api","responses"),
        requires_openai_auth:"requires_openai_auth = true"
      };
      for(const [key,line] of Object.entries(requiredFields)){
        let found=false;
        for(let index=start+1;index<end;index+=1){
          if(tomlKey(lines[index])===key){found=true;break;}
        }
        if(!found){lines.splice(end,0,line);end+=1;}
      }
      let baseUrlPatched=false;
      for(let index=start+1;index<end;index+=1){
        if(tomlKey(lines[index])==="base_url"){
          const replacement=tomlKeyLine("base_url",ruijieProviderBaseUrl);
          if(lines[index]!==replacement)lines[index]=replacement;
          baseUrlPatched=true;
          break;
        }
      }
      if(!baseUrlPatched){
        let insertAt=end;
        for(let index=start+1;index<end;index+=1){
          const key=tomlKey(lines[index]);
          if(key==="api_key"||key==="env_key")insertAt=index+1;
        }
        lines.splice(insertAt,0,tomlKeyLine("base_url",ruijieProviderBaseUrl));
        end+=1;
      }
      const requiredChatModelPrefixes=Array.isArray(ruijieChatModelPrefixes)?ruijieChatModelPrefixes.map(item=>String(item)):[];
      if(requiredChatModelPrefixes.length===0)return joinTomlLines(lines);
      const prefixLine="chat_model_prefixes = "+JSON.stringify(requiredChatModelPrefixes);
      let insertAt=end;
      for(let index=end-1;index>start;index-=1){
        const key=tomlKey(lines[index]);
        if(key==="chat_model_prefixes"){
          insertAt=index;
          lines.splice(index,1);
          end-=1;
        }
      }
      if(insertAt>end)insertAt=end;
      if(insertAt===end){
        for(let index=start+1;index<end;index+=1){
          if(tomlKey(lines[index])==="requires_openai_auth"){insertAt=index+1;break;}
        }
      }
      lines.splice(insertAt,0,prefixLine);
      return joinTomlLines(lines);
    }
    function syncRuijieProviderConfig(){
      const configPath=path.join(codexHome,"config.toml");
      const existing=fs.existsSync(configPath)?fs.readFileSync(configPath,"utf8"):"";
      const withLoginBase=insertTopLevelTomlKeyIfMissing(existing,"chatgpt_login_base_url",ruijieChatGptLoginBaseUrl);
      const withModelCatalog=insertTopLevelTomlKeyIfMissing(withLoginBase,"model_catalog_json",path.join(codexHome,"models_cache.json"));
      const next=patchRuijieProviderConfig(withModelCatalog);
      if(next!==existing){
        fs.mkdirSync(path.dirname(configPath),{recursive:true});
        fs.writeFileSync(configPath,next,"utf8");
      }
    }
    function syncRuijieUniApiKeyEnvFromAuth(){
      const authFile=path.join(codexHome,"auth.json");
      try{
        const auth=fs.existsSync(authFile)?JSON.parse(fs.readFileSync(authFile,"utf8")):{};
        const configPath=path.join(codexHome,"config.toml");
        const configSource=fs.existsSync(configPath)?fs.readFileSync(configPath,"utf8"):"";
        const configLines=tomlLines(configSource);
        const providerTable=findTomlTable(configLines,"[model_providers.ruijie-uniapi]");
        let legacyApiKey="";
        if(providerTable){
          for(let index=providerTable.start+1;index<providerTable.end;index+=1){
            if(tomlKey(configLines[index])==="api_key"){legacyApiKey=tomlStringValue(configLines[index]);break;}
          }
        }
        const explicitCandidates=[auth?.RUIJIE_UNIAPI_KEY,auth?.RUIZHI_API_KEY,auth?.OPENAI_API_KEY,legacyApiKey];
        const explicitKey=String(explicitCandidates.find(value=>String(value??"").trim().length>0)??"").trim();
        const oauthKey=String(auth?.tokens?.access_token||auth?.access_token||"").trim();
        const providerKey=explicitKey||oauthKey;
        if(!providerKey)return;
        if(!String(process.env.RUIJIE_UNIAPI_KEY||"").trim())process.env.RUIJIE_UNIAPI_KEY=providerKey;
        if(!String(process.env.RUIZHI_API_KEY||"").trim())process.env.RUIZHI_API_KEY=providerKey;
        if(!String(process.env.OPENAI_API_KEY||"").trim())process.env.OPENAI_API_KEY=providerKey;/*ruizhiProviderKeyMirrorsOpenAiApiKey*/
      }catch(error){
        console.warn("ruizhi auth env sync failed",error);
      }
    }
    function readPluginVersion(root){
      const manifestPath=path.join(root,".codex-plugin","plugin.json");
      if(!fs.existsSync(manifestPath))return null;
      const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
      return String(manifest.version||"").trim()||null;
    }
    function copyPluginCacheFiles(pluginName,sourceRoot,targetRoot){
      const runtimePluginNames=new Set(["browser","chrome","computer-use"]);
      const entries=[
        {name:".codex-plugin",parts:[".codex-plugin"]},
        {name:"assets",parts:["assets"]},
        {name:"skills",parts:["skills"]},
        {name:"scripts",parts:["scripts"]}
      ];
      for(const entry of entries){
        if(entry.name==="scripts"&&runtimePluginNames.has(pluginName)===false)continue;
        const source=path.join(sourceRoot,...entry.parts);
        if(!fs.existsSync(source))continue;
        const target=path.join(targetRoot,...entry.parts);
        fs.mkdirSync(path.dirname(target),{recursive:true});
        fs.cpSync(source,target,{recursive:true,force:true});
      }
    }
    function ensureOpenAIBundledPluginCache(sourceRoot,cacheRoot,pluginName,version){
      const pluginCacheRoot=path.join(cacheRoot,pluginName);
      const targetRoot=path.join(pluginCacheRoot,version);
      fs.mkdirSync(pluginCacheRoot,{recursive:true});
      copyPluginCacheFiles(pluginName,sourceRoot,targetRoot);
    }
    function syncInstalledOpenAIBundledPluginCache(){
      const sourcePluginsRoot=path.join(codexHome,".tmp","bundled-marketplaces","openai-bundled","plugins");
      const cacheRoot=path.join(codexHome,"plugins","cache","openai-bundled");
      if(!fs.existsSync(sourcePluginsRoot))return;
      for(const entry of fs.readdirSync(sourcePluginsRoot,{withFileTypes:true})){
        if(!entry.isDirectory())continue;
        try{
          const sourceRoot=path.join(sourcePluginsRoot,entry.name);
          const version=readPluginVersion(sourceRoot);
          if(!version)continue;
          ensureOpenAIBundledPluginCache(sourceRoot,cacheRoot,entry.name,version);
        }catch(error){
          console.error("ruizhi OpenAI plugin cache sync failed",entry.name,error);
        }
      }
    }
    function readMarketplaceManifest(root){
      const manifestPath=path.join(root,".agents","plugins","marketplace.json");
      if(!fs.existsSync(manifestPath))return null;
      const manifest=JSON.parse(fs.readFileSync(manifestPath,"utf8"));
      return Array.isArray(manifest.plugins)?manifest:null;
    }
    function isPathInside(root,candidate){
      const base=path.resolve(root);
      const target=path.resolve(candidate);
      const normalizedBase=process.platform==="win32"?base.toLowerCase():base;
      const normalizedTarget=process.platform==="win32"?target.toLowerCase():target;
      return normalizedTarget===normalizedBase||normalizedTarget.startsWith(normalizedBase+path.sep);
    }
    function pluginSourceRoot(marketplaceRoot,plugin){
      const sourcePath=plugin&&plugin.source&&typeof plugin.source.path==="string"?plugin.source.path:null;
      if(!sourcePath)return null;
      const sourceRoot=path.resolve(marketplaceRoot,sourcePath);
      return isPathInside(marketplaceRoot,sourceRoot)?sourceRoot:null;
    }
    function copyManagedPluginCacheFiles(sourceRoot,targetRoot){
      const stagingRoot=targetRoot+".staging-"+process.pid+"-"+Date.now();
      fs.rmSync(stagingRoot,{recursive:true,force:true});
      try{
        fs.mkdirSync(path.dirname(stagingRoot),{recursive:true});
        fs.cpSync(sourceRoot,stagingRoot,{recursive:true,force:true});
        fs.rmSync(targetRoot,{recursive:true,force:true});
        fs.renameSync(stagingRoot,targetRoot);
      }catch(error){
        fs.rmSync(stagingRoot,{recursive:true,force:true});
        throw error;
      }
    }
    function managedMarketplacePluginConfigBlock(marketplaceName,pluginName){
      return [
        "[plugins."+tomlString(pluginName+"@"+marketplaceName)+"]",
        "enabled = false",
        ""
      ].join("\\n");
    }
    function ensureManagedMarketplacePluginState(source,tableName,block){
      const header="["+tableName+"]";
      const lines=tomlLines(source);
      const table=findTomlTable(lines,header);
      if(!table)return upsertTomlTable(source,tableName,block);
      for(let index=table.start+1;index<table.end;index++){
        if(tomlKey(lines[index])==="enabled")return source;
      }
      lines.splice(table.end,0,"enabled = false");
      return joinTomlLines(lines);
    }
    function syncManagedMarketplacePluginInstall(marketplaceSources){
      const specs=managedMarketplaceSpecs();
      if(specs.length===0)return;
      const configPath=path.join(codexHome,"config.toml");
      let next=fs.existsSync(configPath)?fs.readFileSync(configPath,"utf8"):"";
      let changed=false;
      for(const spec of specs){
        const marketplaceRoot=marketplaceSources[spec.sourceToken];
        if(!marketplaceRoot)continue;
        let manifest=null;
        try{
          manifest=readMarketplaceManifest(marketplaceRoot);
        }catch(error){
          console.error("ruizhi managed marketplace manifest read failed",spec.name,error);
          continue;
        }
        if(!manifest)continue;
        const cacheRoot=path.join(codexHome,"plugins","cache",spec.name);
        for(const plugin of manifest.plugins){
          if(!plugin||typeof plugin.name!=="string"||plugin.name.length===0)continue;
          try{
            const sourceRoot=pluginSourceRoot(marketplaceRoot,plugin);
            if(!sourceRoot)continue;
            const version=readPluginVersion(sourceRoot);
            if(!version)continue;
            copyManagedPluginCacheFiles(sourceRoot,path.join(cacheRoot,plugin.name,version));
            const tableName="plugins."+tomlString(plugin.name+"@"+spec.name);
            const updated=ensureManagedMarketplacePluginState(next,tableName,managedMarketplacePluginConfigBlock(spec.name,plugin.name));
            if(updated!==next){next=updated;changed=true;}
          }catch(error){
            console.error("ruizhi managed marketplace plugin install failed",spec.name,plugin.name,error);
          }
        }
      }
      if(changed){
        fs.mkdirSync(path.dirname(configPath),{recursive:true});
        fs.writeFileSync(configPath,next,"utf8");
      }
    }
    function marketplaceRoot(name,marketplaceSources){
      const spec=marketplaceSpecs.find(item=>item.name===name);
      return spec?marketplaceSources[spec.sourceToken]:null;
    }
    function splitRulePath(value){
      return String(value??"").split(/[\\\\/]+/).filter(Boolean);
    }
    function resolveRulePath(rule,marketplaceSources){
      if(rule.marketplace&&rule.path){
        const root=marketplaceRoot(rule.marketplace,marketplaceSources);
        return root?path.join(root,...splitRulePath(rule.path)):null;
      }
      if(rule.homePath){
        return path.join(home,...splitRulePath(rule.homePath));
      }
      if(rule.codexHomePath){
        return path.join(codexHome,...splitRulePath(rule.codexHomePath));
      }
      if(rule.resourcePath){
        return path.join(resourcesRoot,...splitRulePath(rule.resourcePath));
      }
      return null;
    }
    function resolveRuleCommandPath(rule,marketplaceSources){
      if(rule.commandMarketplace&&rule.commandPath){
        const root=marketplaceRoot(rule.commandMarketplace,marketplaceSources);
        return root?path.join(root,...splitRulePath(rule.commandPath)):null;
      }
      if(rule.commandHomePath){
        return path.join(home,...splitRulePath(rule.commandHomePath));
      }
      if(rule.commandCodexHomePath){
        return path.join(codexHome,...splitRulePath(rule.commandCodexHomePath));
      }
      if(rule.commandResourcePath){
        return path.join(resourcesRoot,...splitRulePath(rule.commandResourcePath));
      }
      return null;
    }
    function syncExecPolicyRules(marketplaceSources){
      if(!Array.isArray(allowPrefixRules)||allowPrefixRules.length===0)return;
      const lines=[];
      for(const rule of allowPrefixRules){
        const prefix=Array.isArray(rule.prefix)?rule.prefix.filter(item=>typeof item==="string"&&item.length>0):[];
        const commandPath=resolveRuleCommandPath(rule,marketplaceSources);
        if(prefix.length===0&&!commandPath)continue;
        const resolvedPath=resolveRulePath(rule,marketplaceSources);
        const pattern=commandPath?[commandPath,...prefix]:(resolvedPath?[...prefix,resolvedPath]:prefix);
        lines.push("prefix_rule(pattern="+JSON.stringify(pattern)+", decision=\\"allow\\")");
      }
      if(lines.length===0)return;
      const rulesPath=path.join(codexHome,"rules",managedRulesFileName);
      const next=lines.join("\\n")+"\\n";
      const existing=fs.existsSync(rulesPath)?fs.readFileSync(rulesPath,"utf8"):"";
      if(existing!==next){
        fs.mkdirSync(path.dirname(rulesPath),{recursive:true});
        fs.writeFileSync(rulesPath,next,"utf8");
      }
    }

    const configPath=path.join(codexHome,"config.toml");
    const existingRuizhiConfig=fs.existsSync(configPath);
    syncRuijieUniApiKeyEnvFromAuth();
    const marketplaceSources=syncMarketplaces();
    syncManagedMarketplaceConfig(marketplaceSources);
    syncManagedMarketplacePluginInstall(marketplaceSources);
    syncRuijieProviderConfig();
    syncInstalledOpenAIBundledPluginCache();
    syncExecPolicyRules(marketplaceSources);

    process.env.RUIZHI_EXISTING_CONFIG=existingRuizhiConfig?"1":"0";
  }catch(e){
    console.error("ruizhi bootstrap init failed",e);
  }
}
ruizhiInit();
`;
}

function bootstrapLegacyUpdateCode() {
  const updates = config.updates ?? {};
  const updateConfig = {
    enabled: updates.enabled !== false,
    manifestUrl: process.env.RUIZHI_UPDATE_MANIFEST_URL ?? updates.manifestUrl ?? "",
    requestTimeoutMs: updates.requestTimeoutMs ?? 8000,
    downloadTimeoutMs: updates.downloadTimeoutMs ?? 600000,
    downloadConcurrency: updates.downloadConcurrency ?? 8,
    downloadChunkSizeBytes: updates.downloadChunkSizeBytes ?? 4194304,
    currentVersion: appVersion
  };
  const authConfig = {
    productName: config.productName,
    ruizhiHomeEnvName,
    ruizhiDefaultHomeDirName,
    baseUrl: buildOpenAIBaseUrl,
    testModel: apiKeyTestConfig.model ?? "qwen3.6-flash",
    testTimeoutMs: apiKeyTestConfig.timeoutMs ?? 15000
  };
  const enhanceConfig = pageEnhanceBootstrapConfig();

  return `
function ruizhiStartBackgroundUpdateCheck(){
  const updateConfig=${jsonLiteral(updateConfig)};
  const authConfig=${jsonLiteral(authConfig)};
  const pageEnhanceConfig=${jsonLiteral(enhanceConfig)};
  if(process.platform!=="win32"||!n.app.isPackaged)return;
  const fs=require("node:fs");
  const os=require("node:os");
  const path=require("node:path");
  const crypto=require("node:crypto");
  const childProcess=require("node:child_process");
  const http=require("node:http");
  const https=require("node:https");
  const stream=require("node:stream");
  const streamPromises=require("node:stream/promises");
  function readRuizhiEnvironment(){
    const markerPath=path.join(process.resourcesPath,"ruizhi-environment.json");
    if(!fs.existsSync(markerPath))return {name:"production"};
    try{
      const marker=JSON.parse(fs.readFileSync(markerPath,"utf8"));
      const name=String(marker.environment||"production").trim()||"production";
      return {name};
    }catch(error){
      console.warn("ruizhi environment marker invalid",error);
      return {name:"production"};
    }
  }
  const ruizhiEnvironment=readRuizhiEnvironment();
  function ruizhiVersionLabel(){
    const base=updateConfig.currentVersion||n.app.getVersion();
    return ruizhiEnvironment.name==="production"?base:base+"-"+ruizhiEnvironment.name;
  }
  let pendingInstaller=null;
  let checking=false;
  let installing=false;
  let installWatcherStarted=false;
  let updateState={
    status:"idle",
    currentVersion:ruizhiVersionLabel(),
    environment:ruizhiEnvironment.name,
    version:null,
    progress:0,
    downloadedBytes:0,
    totalBytes:0,
    message:""
  };
  let lastProgressEmit=0;

  function publicUpdateState(){
    return {...updateState};
  }
  function broadcastUpdateState(force=false){
    const now=Date.now();
    if(!force&&now-lastProgressEmit<250)return;
    lastProgressEmit=now;
    const snapshot=publicUpdateState();
    for(const win of n.BrowserWindow.getAllWindows()){
      if(!win.isDestroyed())win.webContents.send("ruizhi:update:state-changed",snapshot);
    }
  }
  function setUpdateState(patch,force=false){
    updateState={...updateState,...patch};
    broadcastUpdateState(force);
  }

  function compareVersions(left,right){
    const parse=value=>String(value??"").split(/[^0-9]+/).filter(Boolean).map(part=>Number(part));
    const a=parse(left),b=parse(right),length=Math.max(a.length,b.length);
    for(let index=0;index<length;index+=1){
      const diff=(a[index]??0)-(b[index]??0);
      if(diff!==0)return diff;
    }
    return 0;
  }
  function updateReadyWindow(){
    let win=null,lastVersion="";
    const html="<html><head><meta charset='utf-8'><style>body{margin:0;font-family:'Microsoft YaHei',sans-serif;background:#101418;color:#f4f7fb;display:flex;align-items:center;justify-content:center;height:100vh}main{width:360px}.title{font-size:18px;font-weight:600;margin-bottom:12px}.message{font-size:13px;color:#b8c2cc;line-height:1.7}.version{color:#fff;font-weight:600}.actions{margin-top:20px;text-align:right}button{border:0;border-radius:8px;background:#43b883;color:#07110c;font-size:13px;font-weight:600;padding:8px 18px;cursor:pointer}button:hover{background:#56d396}</style></head><body><main><div class='title'>锐捷更新已就绪</div><div class='message'>新版本 <span id='version' class='version'></span> 已下载，退出锐捷后将自动安装。</div><div class='actions'><button id='ok'>知道了</button></div></main><script>document.getElementById('ok').addEventListener('click',()=>window.close());</script></body></html>";
    function applyVersion(){
      if(win==null||win.isDestroyed())return;
      win.webContents.executeJavaScript("(()=>{const v=document.getElementById('version');if(v)v.textContent="+JSON.stringify(lastVersion)+";})()",true).catch(()=>{});
    }
    return {
      show(version){
        lastVersion=String(version??"");
        if(win==null||win.isDestroyed()){
          win=new n.BrowserWindow({width:460,height:190,resizable:false,maximizable:false,minimizable:false,alwaysOnTop:false,show:false,title:"锐捷更新已就绪",webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
          win.setMenu(null);
          win.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(html)).catch(()=>{});
          win.webContents.once("did-finish-load",applyVersion);
          win.once("ready-to-show",()=>{win!=null&&!win.isDestroyed()&&win.show()});
        }else{
          applyVersion();
          win.show();
          win.focus();
        }
      }
    };
  }
  function requestUrl(url,timeoutMs,responseHandler,options={}){
    const parsed=new URL(url);
    if(parsed.protocol!=="https:"&&parsed.protocol!=="http:")throw new Error("更新 URL 协议不受支持："+parsed.protocol);
    const transport=parsed.protocol==="https:"?https:http;
    const redirectCount=Number(options.redirectCount)||0;
    const headers={...options.headers};
    return new Promise((resolve,reject)=>{
      let settled=false;
      function settle(error,value){
        if(settled)return;
        settled=true;
        if(error)reject(error);
        else resolve(value);
      }
      const body=options.body;
      const request=transport.request(parsed,{method:options.method||"GET",headers:{"Cache-Control":"no-store","User-Agent":"Ruizhi-Updater/"+n.app.getVersion(),...headers}},response=>{
        const status=response.statusCode??0;
        if([301,302,303,307,308].includes(status)&&response.headers.location){
          response.resume();
          if(redirectCount>=3){
            settle(new Error("更新请求重定向过多"));
            return;
          }
          let nextUrl;
          try{
            nextUrl=new URL(response.headers.location,parsed).toString();
          }catch(error){
            settle(error);
            return;
          }
          requestUrl(nextUrl,timeoutMs,responseHandler,{redirectCount:redirectCount+1,headers}).then(value=>settle(null,value),settle);
          return;
        }
        Promise.resolve(responseHandler(response,status)).then(value=>settle(null,value),settle);
      });
      request.on("error",settle);
      request.setTimeout(timeoutMs,()=>request.destroy(new Error("更新请求超时："+url)));
      if(body!=null)request.write(body);
      request.end();
    });
  }
  async function readResponseText(response){
    const chunks=[];
    for await(const chunk of response){
      chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  function delay(ms){
    return new Promise(resolve=>setTimeout(resolve,ms));
  }
  function sha256Path(filePath){
    const hash=crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex").toLowerCase();
  }
  function authHome(){
    const home=os.homedir();
    const explicit=(process.env[authConfig.ruizhiHomeEnvName]||"").trim();
    return explicit||path.join(home,authConfig.ruizhiDefaultHomeDirName);
  }
  function authPath(){
    return path.join(authHome(),"auth.json");
  }
  function ruizhiConfigPath(){
    return path.join(authHome(),"config.toml");
  }
  function hasExistingRuizhiConfig(){
    const marker=process.env.RUIZHI_EXISTING_CONFIG;
    if(marker==="1")return true;
    if(marker==="0")return false;
    const filePath=ruizhiConfigPath();
    try{
      return fs.existsSync(filePath)&&fs.statSync(filePath).isFile();
    }catch{
      return false;
    }
  }
  function maskApiKey(key){
    const value=String(key||"").trim();
    if(!value)return "";
    if(value.length<=18)return value.slice(0,4)+"*******"+value.slice(-4);
    return value.slice(0,10)+"*******"+value.slice(-7);
  }
  function readAuthJson(){
    const filePath=authPath();
    if(!fs.existsSync(filePath))return null;
    const auth=JSON.parse(fs.readFileSync(filePath,"utf8"));
    return auth&&typeof auth==="object"?auth:null;
  }
  function readApiKeyStatus(){
    const existingConfig=hasExistingRuizhiConfig();
    try{
      const auth=readAuthJson();
      const key=String(
        process.env.RUIJIE_UNIAPI_KEY
        || auth?.RUIJIE_UNIAPI_KEY
        || auth?.RUIZHI_API_KEY
        || auth?.OPENAI_API_KEY
        || auth?.tokens?.access_token
        || auth?.access_token
        || ""
      ).trim();
      const authMode=auth&&typeof auth.auth_mode==="string"?auth.auth_mode:null;
      const configuredBy=authMode&&key.length>0?"auth-json:"+authMode:key.length>0?"runtime-auth":existingConfig?"ruizhi-config":"none";
      return {configured:key.length>0,masked:maskApiKey(key),configuredBy,authMode,version:n.app.getVersion()};
    }catch(error){
      return {configured:false,masked:"",configuredBy:"none",error:String(error?.message||error),version:n.app.getVersion()};
    }
  }
  function writeApiKey(key){
    const filePath=authPath();
    fs.mkdirSync(path.dirname(filePath),{recursive:true});
    fs.writeFileSync(filePath,JSON.stringify({auth_mode:"apikey",OPENAI_API_KEY:key},null,2)+"\\n","utf8");
    process.env.OPENAI_API_KEY=key;
    process.env.RUIZHI_API_KEY=key;
  }
  function normalizeApiKey(input){
    const value=String(input??"").trim().replace(/[\\s\\uFEFF]+/g,"");
    if(value&&/[^\\x21-\\x7E]/.test(value)){
      throw new Error("APIKey 包含无效字符，请重新复制完整 APIKey");
    }
    return value;
  }
  function resetAuthToLogin(){
    const filePath=authPath();
    let removed=false;
    let backupPath=null;
    if(fs.existsSync(filePath)){
      backupPath=filePath+".before-api-key-change."+Date.now()+".bak";
      try{
        fs.copyFileSync(filePath,backupPath);
      }catch(error){
        console.warn("ruizhi auth backup failed",error);
        backupPath=null;
      }
      fs.rmSync(filePath,{force:true});
      removed=true;
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.RUIZHI_API_KEY;
    delete process.env.RUIJIE_UNIAPI_KEY;
    return {removed,backupPath};
  }
  function relaunchCurrentApp(){
    const child=childProcess.spawn(process.execPath,process.argv.slice(1),{
      cwd:path.dirname(process.execPath),
      detached:true,
      stdio:"ignore",
      env:process.env
    });
    child.unref();
    n.app.exit(0);
  }
  async function testApiKey(key){
    const baseUrl=String(authConfig.baseUrl||"").replace(/\\/+$/,"");
    if(!baseUrl)throw new Error("缺少 API Base URL");
    const url=baseUrl+"/chat/completions";
    const payload=JSON.stringify({
      model:authConfig.testModel,
      messages:[{role:"user",content:"ping"}],
      max_tokens:1,
      stream:false
    });
    await requestUrl(url,authConfig.testTimeoutMs,async(response,status)=>{
      const text=await readResponseText(response);
      if(status<200||status>=300){
        let detail=text.slice(0,500);
        try{
          const json=JSON.parse(text);
          detail=json.error?.message||json.message||detail;
        }catch{}
        throw new Error("APIKey 校验失败："+status+" "+(response.statusMessage||"")+" "+detail);
      }
      return true;
    },{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key,"Content-Length":Buffer.byteLength(payload)},body:payload});
  }
  function vcRedistInstallerPath(){
    return path.join(process.resourcesPath||path.dirname(process.execPath),"prerequisites","vc_redist.x64.exe");
  }
  function vcRedistLaunchLogPath(){
    return path.join(os.tmpdir(),"ruizhi-vc-redist-launch.log");
  }
  function vcRedistInstallerScriptPath(){
    return path.join(os.tmpdir(),"ruizhi-install-vc-redist.ps1");
  }
  function vcRedistAppWorkingDirectory(){
    return path.dirname(process.execPath);
  }
  function windowsPowerShellPath(){
    const systemRoot=process.env.SystemRoot||process.env.windir||"C:\\Windows";
    return path.join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe");
  }
  function writeVcRedistInstallerScript(scriptPath){
    const script=[
      "param([string]$Installer,[string]$RedistLog,[string]$LaunchLog,[string]$AppExe,[string]$WorkingDirectory,[int]$ParentPid)",
      "$ErrorActionPreference = 'Stop'",
      "function Write-LaunchLog([string]$Message) {",
      "  $stamp = Get-Date -Format o",
      "  Add-Content -LiteralPath $LaunchLog -Value ($stamp + ' ' + $Message) -Encoding UTF8",
      "}",
      "try {",
      "  Write-LaunchLog ('installer=' + $Installer)",
      "  Write-LaunchLog ('redistLog=' + $RedistLog)",
      "  if (!(Test-Path -LiteralPath $Installer)) { throw ('installer not found: ' + $Installer) }",
      "  $arguments = @('/install','/passive','/norestart','/log',$RedistLog)",
      "  Write-LaunchLog 'starting vc_redist with UAC'",
      "  $process = Start-Process -FilePath $Installer -ArgumentList $arguments -Verb RunAs -Wait -PassThru",
      "  $exitCode = $process.ExitCode",
      "  if ($null -eq $exitCode) { $exitCode = 0 }",
      "  Write-LaunchLog ('vc_redist_exit=' + $exitCode)",
      "  if ($exitCode -eq 0 -or $exitCode -eq 3010 -or $exitCode -eq 1638) {",
      "    Write-LaunchLog 'vc_redist_success'",
      "    exit 0",
      "  }",
      "  exit $exitCode",
    "} catch {",
      "  Write-LaunchLog ('failed=' + $_.Exception.Message)",
      "  exit 1",
      "}"
    ].join("\r\n");
    fs.writeFileSync(scriptPath,script,"utf8");
  }
  function installVcRedist(){
    if(process.platform!=="win32")return {ok:false,error:"仅 Windows 需要安装该依赖"};
    const installerPath=vcRedistInstallerPath();
    const logPath=path.join(os.tmpdir(),"ruizhi-vc-redist.log");
    const launchLogPath=vcRedistLaunchLogPath();
    const scriptPath=vcRedistInstallerScriptPath();
    const workingDirectory=vcRedistAppWorkingDirectory();
    const powershellPath=windowsPowerShellPath();
    if(!fs.existsSync(installerPath))return {ok:false,error:"缺少内置运行依赖安装包",logPath,launchLogPath};
    if(!fs.existsSync(powershellPath))return {ok:false,error:"未找到 Windows PowerShell："+powershellPath,logPath,launchLogPath};
    try{
      writeVcRedistInstallerScript(scriptPath);
      fs.appendFileSync(launchLogPath,new Date().toISOString()+" launch requested installer="+installerPath+" cwd="+workingDirectory+"\n","utf8");
    }catch(error){
      return {ok:false,error:String(error?.message||error),logPath,launchLogPath};
    }
    return new Promise(resolve=>{
      let settled=false;
      const finish=result=>{if(settled)return;settled=true;resolve(result)};
      const child=childProcess.spawn(powershellPath,["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath,"-Installer",installerPath,"-RedistLog",logPath,"-LaunchLog",launchLogPath,"-AppExe",process.execPath,"-WorkingDirectory",workingDirectory,"-ParentPid",String(process.pid)],{detached:true,windowsHide:true,stdio:"ignore"});
      child.on("error",error=>finish({ok:false,error:String(error?.message||error),logPath,launchLogPath}));
      child.on("close",code=>{
        const exitCode=typeof code==="number"?code:null;
        const ok=exitCode===0||exitCode===3010||exitCode===1638;
        finish({ok,exitCode,logPath,launchLogPath,...ok?{launched:true}:{error:"VC++ 运行库安装启动失败："+String(exitCode)}});
        if(ok)setTimeout(relaunchCurrentApp,300);
      });
    });
  }
  function registerRuizhiEnhanceIpc(){
    if(global.__RUIZHI_ENHANCE_IPC_REGISTERED__)return;
    global.__RUIZHI_ENHANCE_IPC_REGISTERED__=true;
    try{
      const servicePath=path.join(process.resourcesPath||path.dirname(process.execPath),...pageEnhanceConfig.serviceResourcePath);
      if(!fs.existsSync(servicePath))throw new Error("页面增强服务脚本不存在："+servicePath);
      const service=require(servicePath).createRuizhiEnhanceService({
        codexHome:authHome(),
        resourcesRoot:process.resourcesPath||path.dirname(process.execPath),
        platformBaseUrl:process.env.RUIZHI_PLATFORM_BASE_URL,
        config:{pageEnhance:pageEnhanceConfig}
      });
      n.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>service.call(route,payload||{}));
    }catch(error){
      console.error("ruizhi enhance ipc register failed",error);
      n.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>({
        status:"failed",
        session_id:String(payload?.session_id||""),
        message:String(error?.message||error)
      }));
    }
  }
  function registerRuizhiIpc(){
    n.ipcMain.handle("ruizhi:update:get-state",()=>publicUpdateState());
    n.ipcMain.handle("ruizhi:update:install-now",()=>{
      if(!pendingInstaller||!fs.existsSync(pendingInstaller.path))return {ok:false,error:"没有已下载的更新包"};
      setUpdateState({status:"installing",message:"正在退出并安装更新"},true);
      installing=true;
      startInstallerAfterExit(pendingInstaller.path);
      return {ok:true};
    });
    n.ipcMain.on("ruizhi:auth:get-sync",event=>{event.returnValue=readApiKeyStatus();});
    n.ipcMain.handle("ruizhi:auth:get",()=>readApiKeyStatus());
    n.ipcMain.handle("ruizhi:auth:set-and-test",async(_event,key)=>{
      try{
        const value=normalizeApiKey(key);
        if(value.length<20)return {ok:false,error:"APIKey 长度不正确",status:readApiKeyStatus()};
        await testApiKey(value);
        writeApiKey(value);
        return {ok:true,apiKey:value,status:readApiKeyStatus()};
      }catch(error){
        return {ok:false,error:String(error?.message||error),status:readApiKeyStatus()};
      }
    });
    n.ipcMain.handle("ruizhi:auth:reset-to-login",async()=>{
      const result=resetAuthToLogin();
      setImmediate(relaunchCurrentApp);
      return {ok:true,...result};
    });
    n.ipcMain.handle("ruizhi:runtime:install-vc-redist",()=>installVcRedist());
    registerRuizhiEnhanceIpc();
  }
  async function fetchManifest(){
    const cacheBusted=new URL(updateConfig.manifestUrl);
    if(cacheBusted.protocol!=="https:"&&cacheBusted.protocol!=="http:")throw new Error("更新清单 URL 协议不受支持："+cacheBusted.protocol);
    cacheBusted.searchParams.set("_",String(Date.now()));
    const text=await requestUrl(cacheBusted.toString(),updateConfig.requestTimeoutMs,async(response,status)=>{
      if(status<200||status>=300){
        response.resume();
        throw new Error("更新清单请求失败："+status+" "+(response.statusMessage||""));
      }
      return await readResponseText(response);
    });
    const trimmed=text.trimStart();
    if(trimmed.startsWith("{"))return JSON.parse(text);
    const manifest={files:[]};
    let currentFile=null;
    function stripYamlScalar(rawValue){
      const value=String(rawValue??"").trim();
      if(!value)return "";
      if((value.startsWith("'")&&value.endsWith("'"))||(value.startsWith('"')&&value.endsWith('"')))return value.slice(1,-1);
      return value;
    }
    for(const line of text.split(/\\r?\\n/)){
      if(!line.trim())continue;
      const fileUrlMatch=line.match(/^\\s*-\\s+url:\\s*(.+)$/);
      if(fileUrlMatch){
        currentFile={url:stripYamlScalar(fileUrlMatch[1])};
        manifest.files.push(currentFile);
        continue;
      }
      const nestedMatch=line.match(/^\\s{4}([A-Za-z0-9_]+):\\s*(.+)$/);
      if(nestedMatch&&currentFile){
        currentFile[nestedMatch[1]]=stripYamlScalar(nestedMatch[2]);
        continue;
      }
      const topLevelMatch=line.match(/^([A-Za-z0-9_]+):\\s*(.+)$/);
      if(topLevelMatch){
        manifest[topLevelMatch[1]]=stripYamlScalar(topLevelMatch[2]);
      }
    }
    return manifest;
  }
  function resolveInstaller(manifest){
    const platformAsset=manifest.windows&&typeof manifest.windows==="object"?manifest.windows:manifest;
    const firstFile=Array.isArray(platformAsset.files)&&platformAsset.files.length>0&&platformAsset.files[0]&&typeof platformAsset.files[0]==="object"?platformAsset.files[0]:null;
    const rawUrl=platformAsset.url||platformAsset.installerUrl||platformAsset.path||firstFile?.url;
    if(!rawUrl)throw new Error("更新清单缺少 windows.url");
    const resolved=new URL(rawUrl,updateConfig.manifestUrl);
    if(resolved.protocol!=="https:"&&resolved.protocol!=="http:")throw new Error("更新包 URL 协议不受支持："+resolved.protocol);
    return {url:resolved.toString(),sha256:platformAsset.sha256||manifest.sha256||firstFile?.sha256||"",size:platformAsset.size||manifest.size||firstFile?.size||null};
  }
  async function downloadInstaller(asset,targetPath,onProgress){
    fs.mkdirSync(path.dirname(targetPath),{recursive:true});
    const partialPath=targetPath+".download";
    let downloadedBytes=0;
    function reportProgress(delta,total){
      downloadedBytes+=delta;
      if(typeof onProgress==="function")onProgress(downloadedBytes,total);
    }
    async function downloadSequential(){
      downloadedBytes=0;
      await requestUrl(asset.url,updateConfig.downloadTimeoutMs,async(response,status)=>{
        if(status<200||status>=300){
          response.resume();
          throw new Error("更新包下载失败："+status+" "+(response.statusMessage||""));
        }
        const total=Number(asset.size)||Number(response.headers["content-length"])||0;
        const meter=new stream.Transform({
          transform(chunk,encoding,callback){
            reportProgress(chunk.length,total);
            callback(null,chunk);
          }
        });
        await streamPromises.pipeline(response,meter,fs.createWriteStream(partialPath,{mode:0o755}));
      });
    }
    async function downloadRange(start,end){
      await requestUrl(asset.url,updateConfig.downloadTimeoutMs,async(response,status)=>{
        const fullBodyOk=start===0&&Number(asset.size)===end+1&&status===200;
        if(status!==206&&!fullBodyOk){
          response.resume();
          throw new Error("更新包分片下载失败："+status+" "+(response.statusMessage||"")+" range="+start+"-"+end);
        }
        let written=0;
        const meter=new stream.Transform({
          transform(chunk,encoding,callback){
            written+=chunk.length;
            reportProgress(chunk.length,Number(asset.size)||0);
            callback(null,chunk);
          }
        });
        await streamPromises.pipeline(response,meter,fs.createWriteStream(partialPath,{flags:"r+",start}));
        const expected=end-start+1;
        if(written!==expected)throw new Error("更新包分片大小不匹配，range="+start+"-"+end+" expected="+expected+" actual="+written);
      },{headers:{Range:"bytes="+start+"-"+end,"Accept-Encoding":"identity"}});
    }
    async function downloadRangeWithRetry(start,end){
      let lastError=null;
      for(let attempt=0;attempt<3;attempt+=1){
        try{
          await downloadRange(start,end);
          return;
        }catch(error){
          lastError=error;
          await delay(1000*(attempt+1));
        }
      }
      throw lastError;
    }
    async function supportsRangeDownloads(){
      return await requestUrl(asset.url,updateConfig.requestTimeoutMs,async(response,status)=>{
        response.resume();
        return status===206;
      },{headers:{Range:"bytes=0-0","Accept-Encoding":"identity"}});
    }
    async function downloadInRanges(){
      const total=Number(asset.size);
      if(!Number.isSafeInteger(total)||total<=0){
        await downloadSequential();
        return;
      }
      if(!await supportsRangeDownloads()){
        await downloadSequential();
        return;
      }
      const chunkSize=Math.max(262144,Number(updateConfig.downloadChunkSizeBytes)||4194304);
      const concurrency=Math.min(16,Math.max(1,Number(updateConfig.downloadConcurrency)||8));
      const fd=fs.openSync(partialPath,"w",0o755);
      try{
        fs.ftruncateSync(fd,total);
      }finally{
        fs.closeSync(fd);
      }
      const ranges=[];
      for(let start=0;start<total;start+=chunkSize){
        ranges.push({start,end:Math.min(total-1,start+chunkSize-1)});
      }
      let nextIndex=0;
      async function worker(){
        for(;;){
          const range=ranges[nextIndex++];
          if(range==null)return;
          await downloadRangeWithRetry(range.start,range.end);
        }
      }
      await Promise.all(Array.from({length:Math.min(concurrency,ranges.length)},()=>worker()));
    }
    try{
      await downloadInRanges();
    }catch(error){
      fs.rmSync(partialPath,{force:true});
      throw error;
    }
    const digest=sha256Path(partialPath);
    if(asset.sha256&&digest!==String(asset.sha256).toLowerCase()){
      fs.rmSync(partialPath,{force:true});
      throw new Error("更新包校验失败，期望 "+asset.sha256+"，实际 "+digest);
    }
    fs.renameSync(partialPath,targetPath);
  }
  function psQuote(value){
    return "'"+String(value).replace(/'/g,"''")+"'";
  }
  function spawnInstallerAfterExit(installerPath){
    if(installWatcherStarted)return;
    installWatcherStarted=true;
    const installDir=path.dirname(process.execPath);
    const scriptPath=path.join(os.tmpdir(),"ruizhi-update-install-"+Date.now()+".ps1");
    const logPath=path.join(os.tmpdir(),"ruizhi-update-install-"+Date.now()+".log");
    const script=[
      "$ErrorActionPreference = 'Stop'",
      "$logPath = "+psQuote(logPath),
      "function Write-UpdateLog([string]$message) { Add-Content -LiteralPath $logPath -Value ((Get-Date -Format o) + ' ' + $message) -Encoding UTF8 }",
      "$installer = "+psQuote(installerPath),
      "$installDir = "+psQuote(installDir),
      "$appPid = "+String(process.pid),
      "try {",
      "  Write-UpdateLog ('started installer=' + $installer + ' installDir=' + $installDir + ' appPid=' + $appPid)",
      "  if (-not (Test-Path -LiteralPath $installer)) { throw ('installer missing: ' + $installer) }",
      "  try { Wait-Process -Id $appPid -ErrorAction SilentlyContinue } catch { Start-Sleep -Milliseconds 800 }",
      "  Start-Sleep -Milliseconds 500",
      "  Write-UpdateLog 'app exited; launching installer'",
      "  $process = Start-Process -FilePath $installer -ArgumentList @('/S',('/D=' + $installDir)) -Wait -PassThru -WindowStyle Hidden",
      "  Write-UpdateLog ('installer exitCode=' + $process.ExitCode)",
      "  if ($process.ExitCode -ne 0) { exit $process.ExitCode }",
      "} catch {",
      "  Write-UpdateLog ('failed: ' + $_.Exception.Message)",
      "  exit 1",
      "}"
    ].join("\\n");
    fs.writeFileSync(scriptPath,script,"utf8");
    const child=childProcess.spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath],{detached:true,stdio:"ignore",windowsHide:true});
    child.unref();
  }
  function startInstallerAfterExit(installerPath){
    setUpdateState({status:"installing",message:"正在退出并安装更新"},true);
    spawnInstallerAfterExit(installerPath);
    n.app.exit(0);
  }
  function registerInstallOnQuit(){
    n.app.on("before-quit",event=>{
      if(installing||pendingInstaller==null)return;
      if(!fs.existsSync(pendingInstaller.path)){
        pendingInstaller=null;
        return;
      }
      installing=true;
      event.preventDefault();
      console.info("ruizhi update will install on quit",pendingInstaller.version);
      startInstallerAfterExit(pendingInstaller.path);
    });
  }
  async function checkAndDownloadUpdate(){
    if(checking)return;
    checking=true;
    try{
      setUpdateState({status:"checking",message:"正在检查更新",progress:0,downloadedBytes:0,totalBytes:0},true);
      const manifest=await fetchManifest();
      if(!manifest||typeof manifest!=="object"||!manifest.version){
        console.error("ruizhi update manifest is invalid",manifest);
        setUpdateState({status:"idle",message:""},true);
        return;
      }
      if(compareVersions(manifest.version,n.app.getVersion())<=0){
        setUpdateState({status:"idle",version:null,progress:0,downloadedBytes:0,totalBytes:0,message:""},true);
        return;
      }
      const asset=resolveInstaller(manifest);
      const targetPath=path.join(os.tmpdir(),"ruizhi-update-"+manifest.version+"-"+Date.now()+".exe");
      setUpdateState({status:"downloading",version:String(manifest.version),progress:0,downloadedBytes:0,totalBytes:Number(asset.size)||0,message:"正在下载更新"},true);
      await downloadInstaller(asset,targetPath,(downloaded,total)=>{
        const safeTotal=Number(total)||0;
        const progress=safeTotal>0?Math.max(0,Math.min(100,Math.floor(downloaded/safeTotal*100))):0;
        setUpdateState({status:"downloading",version:String(manifest.version),progress,downloadedBytes:downloaded,totalBytes:safeTotal,message:"正在下载更新"});
      });
      pendingInstaller={path:targetPath,version:String(manifest.version)};
      console.info("ruizhi update downloaded; install is deferred until quit",pendingInstaller.version);
      setUpdateState({status:"ready",version:pendingInstaller.version,progress:100,downloadedBytes:Number(asset.size)||0,totalBytes:Number(asset.size)||0,message:"更新已下载"},true);
    }catch(error){
      console.error("ruizhi update check failed",error);
      setUpdateState({status:"error",message:String(error?.message||error)},true);
    }finally{
      checking=false;
    }
  }
  try{
    registerRuizhiIpc();
    registerInstallOnQuit();
    n.app.whenReady().then(()=>{
      broadcastUpdateState(true);
      if(ruizhiEnvironment.name!=="production")return;
      if(!updateConfig.enabled||!updateConfig.manifestUrl)return;
      const timer=setTimeout(()=>{checkAndDownloadUpdate().catch(error=>console.error("ruizhi update check failed",error));},15000);
      timer.unref?.();
    }).catch(error=>console.error("ruizhi update scheduling failed",error));
  }catch(error){
    console.error("ruizhi update bootstrap failed",error);
  }
}
`;
}

function bootstrapForceUpdateCode() {
  const updates = config.updates ?? {};
  const updateConfig = {
    enabled: updates.enabled !== false,
    feedUrl: process.env.RUIZHI_UPDATE_DOWNLOAD_BASE_URL ?? updates.downloadBaseUrl ?? "",
    currentVersion: appVersion
  };
  const authConfig = {
    productName: config.productName,
    ruizhiHomeEnvName,
    ruizhiDefaultHomeDirName,
    baseUrl: buildOpenAIBaseUrl,
    testModel: apiKeyTestConfig.model ?? "qwen3.6-flash",
    testTimeoutMs: apiKeyTestConfig.timeoutMs ?? 15000
  };
  const enhanceConfig = pageEnhanceBootstrapConfig();

  return `
function ruizhiStartBackgroundUpdateCheck(){
  const updateConfig=${jsonLiteral(updateConfig)};
  const authConfig=${jsonLiteral(authConfig)};
  const pageEnhanceConfig=${jsonLiteral(enhanceConfig)};
  if(!n.app.isPackaged)return;
  const fs=require("node:fs");
  const os=require("node:os");
  const path=require("node:path");
  const childProcess=require("node:child_process");
  const http=require("node:http");
  const https=require("node:https");
  function readRuizhiEnvironment(){
    const markerPath=path.join(process.resourcesPath,"ruizhi-environment.json");
    if(!fs.existsSync(markerPath))return {name:"production"};
    try{
      const marker=JSON.parse(fs.readFileSync(markerPath,"utf8"));
      const name=String(marker.environment||"production").trim()||"production";
      return {name};
    }catch(error){
      console.warn("ruizhi environment marker invalid",error);
      return {name:"production"};
    }
  }
  const ruizhiEnvironment=readRuizhiEnvironment();
  function ruizhiVersionLabel(){
    const base=updateConfig.currentVersion||n.app.getVersion();
    return ruizhiEnvironment.name==="production"?base:base+"-"+ruizhiEnvironment.name;
  }
  let autoUpdater=null;
  let updateReady=false;
  let updateState={
    status:"idle",
    currentVersion:ruizhiVersionLabel(),
    environment:ruizhiEnvironment.name,
    version:null,
    progress:0,
    downloadedBytes:0,
    totalBytes:0,
    message:""
  };
  let lastProgressEmit=0;

  function publicUpdateState(){
    return {...updateState};
  }
  function broadcastUpdateState(force=false){
    const now=Date.now();
    if(!force&&now-lastProgressEmit<250)return;
    lastProgressEmit=now;
    const snapshot=publicUpdateState();
    for(const win of n.BrowserWindow.getAllWindows()){
      if(!win.isDestroyed())win.webContents.send("ruizhi:update:state-changed",snapshot);
    }
  }
  function setUpdateState(patch,force=false){
    updateState={...updateState,...patch};
    broadcastUpdateState(force);
  }
  function requestUrl(url,timeoutMs,responseHandler,options={}){
    const parsed=new URL(url);
    if(parsed.protocol!=="https:"&&parsed.protocol!=="http:")throw new Error("请求 URL 协议不受支持："+parsed.protocol);
    const transport=parsed.protocol==="https:"?https:http;
    const redirectCount=Number(options.redirectCount)||0;
    const headers={...options.headers};
    return new Promise((resolve,reject)=>{
      let settled=false;
      function settle(error,value){
        if(settled)return;
        settled=true;
        if(error)reject(error);
        else resolve(value);
      }
      const body=options.body;
      const request=transport.request(parsed,{method:options.method||"GET",headers:{"Cache-Control":"no-store","User-Agent":"Ruizhi/"+n.app.getVersion(),...headers}},response=>{
        const status=response.statusCode??0;
        if([301,302,303,307,308].includes(status)&&response.headers.location){
          response.resume();
          if(redirectCount>=3){
            settle(new Error("请求重定向过多"));
            return;
          }
          let nextUrl;
          try{
            nextUrl=new URL(response.headers.location,parsed).toString();
          }catch(error){
            settle(error);
            return;
          }
          requestUrl(nextUrl,timeoutMs,responseHandler,{...options,redirectCount:redirectCount+1}).then(value=>settle(null,value),settle);
          return;
        }
        Promise.resolve(responseHandler(response,status)).then(value=>settle(null,value),settle);
      });
      request.on("error",settle);
      request.setTimeout(timeoutMs,()=>request.destroy(new Error("请求超时："+url)));
      if(body!=null)request.write(body);
      request.end();
    });
  }
  async function readResponseText(response){
    const chunks=[];
    for await(const chunk of response){
      chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  function authHome(){
    const home=os.homedir();
    const explicit=(process.env[authConfig.ruizhiHomeEnvName]||"").trim();
    return explicit||path.join(home,authConfig.ruizhiDefaultHomeDirName);
  }
  function authPath(){
    return path.join(authHome(),"auth.json");
  }
  function ruizhiConfigPath(){
    return path.join(authHome(),"config.toml");
  }
  function hasExistingRuizhiConfig(){
    const marker=process.env.RUIZHI_EXISTING_CONFIG;
    if(marker==="1")return true;
    if(marker==="0")return false;
    const filePath=ruizhiConfigPath();
    try{
      return fs.existsSync(filePath)&&fs.statSync(filePath).isFile();
    }catch{
      return false;
    }
  }
  function maskApiKey(key){
    const value=String(key||"").trim();
    if(!value)return "";
    if(value.length<=18)return value.slice(0,4)+"*******"+value.slice(-4);
    return value.slice(0,10)+"*******"+value.slice(-7);
  }
  function readAuthJson(){
    const filePath=authPath();
    if(!fs.existsSync(filePath))return null;
    const auth=JSON.parse(fs.readFileSync(filePath,"utf8"));
    return auth&&typeof auth==="object"?auth:null;
  }
  function readApiKeyStatus(){
    const existingConfig=hasExistingRuizhiConfig();
    try{
      const auth=readAuthJson();
      const key=String(
        process.env.RUIJIE_UNIAPI_KEY
        || auth?.RUIJIE_UNIAPI_KEY
        || auth?.RUIZHI_API_KEY
        || auth?.OPENAI_API_KEY
        || auth?.tokens?.access_token
        || auth?.access_token
        || ""
      ).trim();
      const authMode=auth&&typeof auth.auth_mode==="string"?auth.auth_mode:null;
      const configuredBy=authMode&&key.length>0?"auth-json:"+authMode:key.length>0?"runtime-auth":existingConfig?"ruizhi-config":"none";
      return {configured:key.length>0,masked:maskApiKey(key),configuredBy,authMode,version:n.app.getVersion()};
    }catch(error){
      return {configured:false,masked:"",configuredBy:"none",error:String(error?.message||error),version:n.app.getVersion()};
    }
  }
  function writeApiKey(key){
    const filePath=authPath();
    fs.mkdirSync(path.dirname(filePath),{recursive:true});
    fs.writeFileSync(filePath,JSON.stringify({auth_mode:"apikey",OPENAI_API_KEY:key},null,2)+"\\n","utf8");
    process.env.OPENAI_API_KEY=key;
    process.env.RUIZHI_API_KEY=key;
  }
  function normalizeApiKey(input){
    const value=String(input??"").trim().replace(/[\\s\\uFEFF]+/g,"");
    if(value&&/[^\\x21-\\x7E]/.test(value)){
      throw new Error("APIKey 包含无效字符，请重新复制完整 APIKey");
    }
    return value;
  }
  function resetAuthToLogin(){
    const filePath=authPath();
    let removed=false;
    let backupPath=null;
    if(fs.existsSync(filePath)){
      backupPath=filePath+".before-api-key-change."+Date.now()+".bak";
      try{
        fs.copyFileSync(filePath,backupPath);
      }catch(error){
        console.warn("ruizhi auth backup failed",error);
        backupPath=null;
      }
      fs.rmSync(filePath,{force:true});
      removed=true;
    }
    delete process.env.OPENAI_API_KEY;
    delete process.env.RUIZHI_API_KEY;
    delete process.env.RUIJIE_UNIAPI_KEY;
    return {removed,backupPath};
  }
  function relaunchCurrentApp(){
    const child=childProcess.spawn(process.execPath,process.argv.slice(1),{
      cwd:path.dirname(process.execPath),
      detached:true,
      stdio:"ignore",
      env:process.env
    });
    child.unref();
    n.app.exit(0);
  }
  async function testApiKey(key){
    const baseUrl=String(authConfig.baseUrl||"").replace(/\\/+$/,"");
    if(!baseUrl)throw new Error("缺少 API Base URL");
    const url=baseUrl+"/chat/completions";
    const payload=JSON.stringify({
      model:authConfig.testModel,
      messages:[{role:"user",content:"ping"}],
      max_tokens:1,
      stream:false
    });
    await requestUrl(url,authConfig.testTimeoutMs,async(response,status)=>{
      const text=await readResponseText(response);
      if(status<200||status>=300){
        let detail=text.slice(0,500);
        try{
          const json=JSON.parse(text);
          detail=json.error?.message||json.message||detail;
        }catch{}
        throw new Error("APIKey 校验失败："+status+" "+(response.statusMessage||"")+" "+detail);
      }
      return true;
    },{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+key,"Content-Length":String(Buffer.byteLength(payload))},body:payload});
  }
  function vcRedistInstallerPath(){
    return path.join(process.resourcesPath||path.dirname(process.execPath),"prerequisites","vc_redist.x64.exe");
  }
  function vcRedistLaunchLogPath(){
    return path.join(os.tmpdir(),"ruizhi-vc-redist-launch.log");
  }
  function vcRedistInstallerScriptPath(){
    return path.join(os.tmpdir(),"ruizhi-install-vc-redist.ps1");
  }
  function vcRedistAppWorkingDirectory(){
    return path.dirname(process.execPath);
  }
  function windowsPowerShellPath(){
    const systemRoot=process.env.SystemRoot||process.env.windir||"C:\\Windows";
    return path.join(systemRoot,"System32","WindowsPowerShell","v1.0","powershell.exe");
  }
  function writeVcRedistInstallerScript(scriptPath){
    const script=[
      "param([string]$Installer,[string]$RedistLog,[string]$LaunchLog,[string]$AppExe,[string]$WorkingDirectory,[int]$ParentPid)",
      "$ErrorActionPreference = 'Stop'",
      "function Write-LaunchLog([string]$Message) {",
      "  $stamp = Get-Date -Format o",
      "  Add-Content -LiteralPath $LaunchLog -Value ($stamp + ' ' + $Message) -Encoding UTF8",
      "}",
      "try {",
      "  Write-LaunchLog ('installer=' + $Installer)",
      "  Write-LaunchLog ('redistLog=' + $RedistLog)",
      "  if (!(Test-Path -LiteralPath $Installer)) { throw ('installer not found: ' + $Installer) }",
      "  $arguments = @('/install','/passive','/norestart','/log',$RedistLog)",
      "  Write-LaunchLog 'starting vc_redist with UAC'",
      "  $process = Start-Process -FilePath $Installer -ArgumentList $arguments -Verb RunAs -Wait -PassThru",
      "  $exitCode = $process.ExitCode",
      "  if ($null -eq $exitCode) { $exitCode = 0 }",
      "  Write-LaunchLog ('vc_redist_exit=' + $exitCode)",
      "  if ($exitCode -eq 0 -or $exitCode -eq 3010 -or $exitCode -eq 1638) {",
      "    Write-LaunchLog 'vc_redist_success'",
      "    exit 0",
      "  }",
      "  exit $exitCode",
    "} catch {",
      "  Write-LaunchLog ('failed=' + $_.Exception.Message)",
      "  exit 1",
      "}"
    ].join("\r\n");
    fs.writeFileSync(scriptPath,script,"utf8");
  }
  function installVcRedist(){
    if(process.platform!=="win32")return {ok:false,error:"仅 Windows 需要安装该依赖"};
    const installerPath=vcRedistInstallerPath();
    const logPath=path.join(os.tmpdir(),"ruizhi-vc-redist.log");
    const launchLogPath=vcRedistLaunchLogPath();
    const scriptPath=vcRedistInstallerScriptPath();
    const workingDirectory=vcRedistAppWorkingDirectory();
    const powershellPath=windowsPowerShellPath();
    if(!fs.existsSync(installerPath))return {ok:false,error:"缺少内置运行依赖安装包",logPath,launchLogPath};
    if(!fs.existsSync(powershellPath))return {ok:false,error:"未找到 Windows PowerShell："+powershellPath,logPath,launchLogPath};
    try{
      writeVcRedistInstallerScript(scriptPath);
      fs.appendFileSync(launchLogPath,new Date().toISOString()+" launch requested installer="+installerPath+" cwd="+workingDirectory+"\n","utf8");
    }catch(error){
      return {ok:false,error:String(error?.message||error),logPath,launchLogPath};
    }
    return new Promise(resolve=>{
      let settled=false;
      const finish=result=>{if(settled)return;settled=true;resolve(result)};
      const child=childProcess.spawn(powershellPath,["-NoProfile","-ExecutionPolicy","Bypass","-File",scriptPath,"-Installer",installerPath,"-RedistLog",logPath,"-LaunchLog",launchLogPath,"-AppExe",process.execPath,"-WorkingDirectory",workingDirectory,"-ParentPid",String(process.pid)],{detached:true,windowsHide:true,stdio:"ignore"});
      child.on("error",error=>finish({ok:false,error:String(error?.message||error),logPath,launchLogPath}));
      child.on("close",code=>{
        const exitCode=typeof code==="number"?code:null;
        const ok=exitCode===0||exitCode===3010||exitCode===1638;
        finish({ok,exitCode,logPath,launchLogPath,...ok?{launched:true}:{error:"VC++ 运行库安装启动失败："+String(exitCode)}});
        if(ok)setTimeout(relaunchCurrentApp,300);
      });
    });
  }
  function registerRuizhiEnhanceIpc(){
    if(global.__RUIZHI_ENHANCE_IPC_REGISTERED__)return;
    global.__RUIZHI_ENHANCE_IPC_REGISTERED__=true;
    try{
      const servicePath=path.join(process.resourcesPath||path.dirname(process.execPath),...pageEnhanceConfig.serviceResourcePath);
      if(!fs.existsSync(servicePath))throw new Error("页面增强服务脚本不存在："+servicePath);
      const service=require(servicePath).createRuizhiEnhanceService({
        codexHome:authHome(),
        resourcesRoot:process.resourcesPath||path.dirname(process.execPath),
        platformBaseUrl:process.env.RUIZHI_PLATFORM_BASE_URL,
        config:{pageEnhance:pageEnhanceConfig}
      });
      n.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>service.call(route,payload||{}));
    }catch(error){
      console.error("ruizhi enhance ipc register failed",error);
      n.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>({
        status:"failed",
        session_id:String(payload?.session_id||""),
        message:String(error?.message||error)
      }));
    }
  }
  function registerRuizhiIpc(){
    n.ipcMain.handle("ruizhi:update:get-state",()=>publicUpdateState());
    n.ipcMain.handle("ruizhi:update:install-now",()=>{
      if(!autoUpdater||!updateReady)return {ok:false,error:"没有已下载的更新包"};
      setUpdateState({status:"installing",message:"正在重启并安装更新"},true);
      setImmediate(()=>autoUpdater.quitAndInstall(true,true));
      return {ok:true};
    });
    n.ipcMain.on("ruizhi:auth:get-sync",event=>{event.returnValue=readApiKeyStatus();});
    n.ipcMain.handle("ruizhi:auth:get",()=>readApiKeyStatus());
    n.ipcMain.handle("ruizhi:auth:set-and-test",async(_event,key)=>{
      try{
        const value=normalizeApiKey(key);
        if(value.length<20)return {ok:false,error:"APIKey 长度不正确",status:readApiKeyStatus()};
        await testApiKey(value);
        writeApiKey(value);
        return {ok:true,apiKey:value,status:readApiKeyStatus()};
      }catch(error){
        return {ok:false,error:String(error?.message||error),status:readApiKeyStatus()};
      }
    });
    n.ipcMain.handle("ruizhi:auth:reset-to-login",async()=>{
      const result=resetAuthToLogin();
      setImmediate(relaunchCurrentApp);
      return {ok:true,...result};
    });
    n.ipcMain.handle("ruizhi:runtime:install-vc-redist",()=>installVcRedist());
    registerRuizhiEnhanceIpc();
  }
  function configureUpdater(){
    if(process.platform!=="win32")return false;
    try{
      autoUpdater=require("electron-updater").autoUpdater;
    }catch(error){
      console.error("ruizhi electron-updater load failed",error);
      setUpdateState({status:"error",message:"更新模块加载失败："+String(error?.message||error)},true);
      return false;
    }
    autoUpdater.logger=console;
    autoUpdater.autoDownload=true;
    autoUpdater.autoInstallOnAppQuit=true;
    autoUpdater.allowDowngrade=false;
    autoUpdater.allowPrerelease=false;
    autoUpdater.disableWebInstaller=true;
    autoUpdater.installDirectory=path.dirname(process.execPath);
    if(updateConfig.feedUrl){
      autoUpdater.setFeedURL({provider:"generic",url:updateConfig.feedUrl,useMultipleRangeRequest:false});
    }
    autoUpdater.on("checking-for-update",()=>{
      updateReady=false;
      setUpdateState({status:"checking",version:null,progress:0,downloadedBytes:0,totalBytes:0,message:"正在检查更新"},true);
    });
    autoUpdater.on("update-available",info=>{
      updateReady=false;
      setUpdateState({status:"downloading",version:String(info?.version||""),progress:0,downloadedBytes:0,totalBytes:0,message:"正在下载更新"},true);
    });
    autoUpdater.on("download-progress",progress=>{
      const percent=Math.max(0,Math.min(100,Math.floor(Number(progress?.percent)||0)));
      setUpdateState({
        status:"downloading",
        version:updateState.version,
        progress:percent,
        downloadedBytes:Number(progress?.transferred)||0,
        totalBytes:Number(progress?.total)||0,
        message:"正在下载更新"
      });
    });
    autoUpdater.on("update-downloaded",info=>{
      updateReady=true;
      setUpdateState({status:"ready",version:String(info?.version||updateState.version||""),progress:100,message:"更新已下载"},true);
    });
    autoUpdater.on("update-not-available",()=>{
      updateReady=false;
      setUpdateState({status:"idle",version:null,progress:0,downloadedBytes:0,totalBytes:0,message:""},true);
    });
    autoUpdater.on("error",error=>{
      updateReady=false;
      console.error("ruizhi update failed",error);
      setUpdateState({status:"error",message:String(error?.message||error)},true);
    });
    return true;
  }
  try{
    registerRuizhiIpc();
    const updaterReady=ruizhiEnvironment.name==="production"&&configureUpdater();
    n.app.whenReady().then(()=>{
      broadcastUpdateState(true);
      if(!updateConfig.enabled||!updaterReady)return;
      const timer=setTimeout(()=>{autoUpdater.checkForUpdates().catch(error=>{
        console.error("ruizhi update check failed",error);
        setUpdateState({status:"error",message:String(error?.message||error)},true);
      });},15000);
      timer.unref?.();
    }).catch(error=>console.error("ruizhi update scheduling failed",error));
  }catch(error){
    console.error("ruizhi update bootstrap failed",error);
  }
}
`;
}

function preloadIntegrationCode() {
  return `
${pageEnhanceRendererInstallerSource()}
;(()=>{try{
  const electron=require("electron");
  const ipcRenderer=electron.ipcRenderer;
  const contextBridge=electron.contextBridge;
  const appVersion=${jsonLiteral(appVersion)};
  const pageEnhanceConfig=${jsonLiteral(pageEnhanceBootstrapConfig())};
  const integrationKey="__RUIZHI_DESKTOP_INTEGRATION__";
  const previous=globalThis[integrationKey];
  if(previous&&typeof previous.dispose==="function")previous.dispose();
  const cleanup=[];
  let disposed=false;
  function addCleanup(fn){cleanup.push(fn);}
  function dispose(){
    if(disposed)return;
    disposed=true;
    while(cleanup.length){
      const fn=cleanup.pop();
      try{fn()}catch{}
    }
  }
  globalThis[integrationKey]={dispose};
  let updateState={status:"idle",currentVersion:appVersion,version:null,progress:0,message:""};
  const cachedAuthStatus=(()=>{try{return ipcRenderer.sendSync("ruizhi:auth:get-sync");}catch{return {configured:false,masked:"",configuredBy:"unavailable",version:appVersion};}})();

  const api={
    update:{
      getState:()=>ipcRenderer.invoke("ruizhi:update:get-state"),
      installNow:()=>ipcRenderer.invoke("ruizhi:update:install-now")
    },
    auth:{
      getCached:()=>cachedAuthStatus,
      get:()=>ipcRenderer.invoke("ruizhi:auth:get"),
      setAndTest:key=>ipcRenderer.invoke("ruizhi:auth:set-and-test",key),
      resetToLogin:()=>ipcRenderer.invoke("ruizhi:auth:reset-to-login")
    },
    runtime:{
      installVcRedist:()=>ipcRenderer.invoke("ruizhi:runtime:install-vc-redist")
    },
    enhance:{
      call:(route,payload)=>ipcRenderer.invoke("ruizhi:enhance:call",route,payload||{}),
      getSettings:()=>ipcRenderer.invoke("ruizhi:enhance:call","/settings/get",{}),
      setSettings:patch=>ipcRenderer.invoke("ruizhi:enhance:call","/settings/set",patch||{})
    }
  };
  try{globalThis.ruizhiDesktop=api}catch{}
  try{contextBridge.exposeInMainWorld("ruizhiDesktop",api)}catch{}

  function onReady(fn){
    if(document.readyState==="loading"){
      const listener=()=>{if(!disposed)fn();};
      document.addEventListener("DOMContentLoaded",listener,{once:true});
      addCleanup(()=>document.removeEventListener("DOMContentLoaded",listener));
    }else if(!disposed)fn();
  }
  function injectRuizhiWalletDetails(){
    if(window.__RUIZHI_WALLET_DETAILS_SCRIPT_INJECTED__)return;
    try{
      const installer=globalThis.__RUIZHI_INSTALL_WALLET_DETAILS__;
      if(typeof installer!=="function")throw new Error("额度明细 installer 不可用");
      const runtime=installer({window,document,ruizhiDesktop:api});
      window.__RUIZHI_WALLET_DETAILS_SCRIPT_INJECTED__=true;
      addCleanup(()=>runtime?.dispose?.());
    }catch(error){
      console.error("ruizhi wallet details inject failed",error);
    }
  }
  function injectRuizhiPageEnhance(){
    if(!pageEnhanceConfig.enabled||window.__RUIZHI_PAGE_ENHANCE_SCRIPT_INJECTED__)return;
    window.__RUIZHI_PAGE_ENHANCE_SCRIPT_INJECTED__=true;
    try{
      const installer=globalThis.__RUIZHI_INSTALL_PAGE_ENHANCE__;
      if(typeof installer!=="function")throw new Error("页面增强 installer 不可用");
      installer({window,document,ruizhiDesktop:api,config:pageEnhanceConfig});
    }catch(error){
      console.error("ruizhi page enhance inject failed",error);
    }
  }
  onReady(injectRuizhiWalletDetails);
  onReady(injectRuizhiPageEnhance);

  function onUpdateStateChanged(_event,next){
    if(disposed)return;
    updateState={...updateState,...next};
  }
  ipcRenderer.on("ruizhi:update:state-changed",onUpdateStateChanged);
  addCleanup(()=>ipcRenderer.removeListener("ruizhi:update:state-changed",onUpdateStateChanged));
  onReady(()=>{
    ipcRenderer.invoke("ruizhi:update:get-state").then(next=>{updateState={...updateState,...next};}).catch(()=>{});
  });
}catch(error){console.error("ruizhi preload integration failed",error)}})();
`;
}

function patchPreloadIntegration() {
  const preloadPath = path.join(extractedDir, ".vite", "build", "preload.js");
  writePatchedFile(preloadPath, (source) =>
    replaceExact(
      source,
      "\n//# sourceMappingURL=preload.js.map",
      `${preloadIntegrationCode()}\n//# sourceMappingURL=preload.js.map`,
      "注入锐捷 preload bridge"
    )
  );
  log("已补丁 preload 锐捷 UI 集成");
}

function nodeModuleTargetDir(targetNodeModules, packageName) {
  return path.join(targetNodeModules, ...packageName.split("/"));
}

function copyRuntimeNodePackage(packageName, targetNodeModules, seen = new Set(), fromDir = projectRoot) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths: [fromDir] });
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const packageKey = `${packageJson.name ?? packageName}@${packageJson.version ?? "0.0.0"}`;
  if (seen.has(packageKey)) {
    return;
  }
  seen.add(packageKey);

  const targetDir = nodeModuleTargetDir(targetNodeModules, packageName);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fsExtra.copySync(packageDir, targetDir, {
    filter(sourcePath) {
      const relative = path.relative(packageDir, sourcePath);
      if (!relative) {
        return true;
      }
      return !relative.split(path.sep).includes("node_modules");
    }
  });

  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    copyRuntimeNodePackage(dependencyName, targetNodeModules, seen, packageDir);
  }
}

function patchBootstrap() {
  const bootstrapPath = path.join(extractedDir, ".vite", "build", "bootstrap.js");

  writePatchedFile(bootstrapPath, (source) => {
    let next = source;
    next = replaceRegex(
      next,
      /var v=\{"install-update":`Install Update`,"check-for-updates":`Check for Updates`,quit:`Quit`\};async function y\(e\)\{[\s\S]*?\}\}var b=/,
      `${bootstrapInitCode()}var v={quit:\`Quit\`};async function y(e){await n.dialog.showMessageBox({type:\`error\`,buttons:[v.quit],defaultId:0,cancelId:0,message:\`${'${n.app.getName()}'} failed to start.\`,detail:e instanceof Error?e.message:\`The main desktop app failed during startup.\`,noLink:!0});n.app.quit();return}var b=`,
      "移除 Codex 官方更新失败入口并注入锐捷启动逻辑"
    );
    next = replaceExact(
      next,
      "await i.initialize();try{",
      "await i.initialize();try{",
      "禁用 Codex 官方 updater 初始化"
    );
    next = replaceRegex(
      next,
      /n\.app\.setName\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\)/,
      `n.app.setName(${jsonLiteral(windowsTaskManagerName())})`,
      "应用名称"
    );
    next = replaceRegex(
      next,
      /process\.platform===`win32`&&n\.app\.setAppUserModelId\([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\)/,
      "process.platform===`win32`&&n.app.setAppUserModelId(`cn.ruizhi.desktop`)",
      "Windows AppUserModelID"
    );
    return next;
  });

  log("已补丁 Electron bootstrap 初始化");
}

function applyLegacyAsarPatches() {
  patchPluginAccountGate();
  patchNativeWebviewFeatureGates();
  patchNativeStatsigNetwork();
  patchNativeStatsigBootstrap();
  patchNativeCesAnalyticsNetwork();
  patchNativeProfileVisibility();
  patchNativeUsageSettingsVisibility();
  patchNativeKeymapBindingsFallback();
  patchNativeProfileDropdownUsageVisibility();
  patchNativeProfileUsageFallback();
  patchNativePlatformUsageFallback();
  patchNativeWalletUsagePresentation();
  patchNativeProfileApiCallLogging();
  patchPluginSkillLocalListFallback(extractedDir, { log });
  patchChatGptConversationArchiveFallback(extractedDir, { log });
  patchChatGptArchivedThreadsFallback(extractedDir, { log });
  patchChatGptSettingsArchivedThreadsFallback(extractedDir, { log });
  patchChatGptLanguageSwitching(extractedDir, { log });
  patchChatGptConversationBranchFallback(extractedDir, { log });
  patchNativeBrowserDesktopFeatureAvailability();
  patchChatGptAuthExternalBrowser();
  patchBrowserNativePipeDiagnostics(extractedDir, { log });
  patchBrowserNativePipePeerAuthorization(extractedDir, { log });
  patchBrowserUseIabOpenStability(extractedDir, { log });
  patchTrustedBrowserClientHashes(extractedDir, path.join(appOutRoot, "resources"), { log });
  if (brandingEnabled()) {
    patchWebviewLocales();
    patchPackageMetadata();
    patchWebviewHtml();
    patchDefaultLocale();
    patchFrontendDefaultMessages();
  } else {
    log("已跳过界面品牌化补丁");
  }
  patchAppSunsetGate();
  if (modelCatalogEnabled()) {
    patchModelAvailabilityAllowlist();
    patchListModelsForHostFromUserCache();
  } else {
    log("已跳过模型优化补丁");
  }
  patchOfficialUpdateLogic();
  patchOnboardingWindowMode();
  if (brandingEnabled()) {
    patchWindowsHelpDocumentationLinks(extractedDir, config, { log });
    patchWindowsSidebarWhatsNewLink(extractedDir, config, { log });
  }
  patchBootstrap();
  patchPreloadIntegration();
}

async function repackAppAsar() {
  const resourcesDir = path.join(appOutRoot, "resources");
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const patchedAsarPath = path.join(workRoot, "app.patched.asar");

  cleanDir(workRoot);
  log("解包 app.asar");
  asar.uncache?.(appAsarPath);
  asar.extractAll(appAsarPath, extractedDir);

  if (process.env.RUIZHI_WINDOWS_USE_LEGACY_PATCHES === "1") {
    log("使用旧版字符串补丁生成 asar");
    applyLegacyAsarPatches();
  } else {
    if (brandingEnabled()) {
      applyWindowsAsarOverrides(extractedDir, { log });
      patchPluginSkillLocalListFallback(extractedDir, { log });
      patchChatGptConversationArchiveFallback(extractedDir, { log });
      patchChatGptArchivedThreadsFallback(extractedDir, { log });
      patchChatGptSettingsArchivedThreadsFallback(extractedDir, { log });
      patchChatGptLanguageSwitching(extractedDir, { log });
      patchChatGptConversationBranchFallback(extractedDir, { log });
    } else {
      log("已跳过 Windows asar 品牌化覆盖层");
    }
    refreshWindowsAsarBuildMetadata(extractedDir, buildConfig, appVersion, { log, resourcesDir });
    validatePatchedBootstrapSyntax();
    if (brandingEnabled()) {
      patchWindowsHelpDocumentationLinks(extractedDir, config, { log });
      patchWindowsSidebarWhatsNewLink(extractedDir, config, { log });
    }
  }

  patchDesktopAuthAllowedUrls(extractedDir, buildChatGptLoginBaseUrl, { log });

  fs.rmSync(patchedAsarPath, { force: true });
  log("重新打包 app.asar");
  asar.uncache?.(patchedAsarPath);
  await asar.createPackage(extractedDir, patchedAsarPath);
  asar.uncache?.(patchedAsarPath);
  fs.copyFileSync(patchedAsarPath, appAsarPath);
  asar.uncache?.(appAsarPath);
}

function validatePatchedBootstrapSyntax() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const targets = fs.readdirSync(buildDir)
    .filter((name) => /^(?:early-)?bootstrap(?:-[A-Za-z0-9_]+)?\.js$/.test(name))
    .map((name) => path.join(buildDir, name));
  if (targets.length === 0) {
    throw new Error("Windows 打包产物缺少 bootstrap JavaScript");
  }
  for (const target of targets) {
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
  }
  log(`已校验 bootstrap JavaScript 语法：${targets.length} 个文件`);
}

async function patchFuses() {
  const exePath = path.join(appOutRoot, config.windows.sourceExeName);
  fs.chmodSync(exePath, 0o755);

  log("关闭 app.asar 完整性校验 fuse");
  try {
    await flipFuses(exePath, {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
      [FuseV1Options.WasmTrapHandlers]: true
    });
  } catch (error) {
    if (String(error?.message || error).includes("Could not find sentinel")) {
      log("跳过 Electron fuse 补丁：主程序不包含 Electron fuse sentinel");
      return;
    }
    throw error;
  }
}

function ensureCodexSource() {
  const cliConfig = codexCliBuildConfig();
  if (!cliConfig?.sourceRepo || !cliConfig?.tag) {
    throw new Error("缺少 codexCli.sourceRepo 或 codexCli.tag 配置");
  }

  if (!fs.existsSync(path.join(codexSourceRoot, ".git"))) {
    fs.rmSync(codexSourceRoot, { recursive: true, force: true });
    execLogged("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      cliConfig.sourceRepo,
      codexSourceRoot
    ]);
  }

  execLogged("git", [
    "-C",
    codexSourceRoot,
    "fetch",
    "--depth=1",
    "origin",
    `refs/tags/${cliConfig.tag}:refs/tags/${cliConfig.tag}`
  ]);
  execLogged("git", ["-C", codexSourceRoot, "checkout", "--force", cliConfig.tag]);
}

function patchCodexWindowsWorkspaceSource() {
  const manifestPath = path.join(codexSourceRoot, "codex-rs", "Cargo.toml");
  writePatchedFile(manifestPath, (source) => {
    const patched = source.replace(/    "realtime-webrtc",\r?\n/, "");
    if (patched === source && !source.includes('"realtime-webrtc"')) return source;
    return patched;
  });
  log("Windows CLI ????????? realtime-webrtc workspace ??");
}

function patchCodexCliSource() {
  patchCodexWindowsWorkspaceSource();
  patchCodexHomeSource();
  patchCodexLoginCallbackPortSource();
  patchCodexBundledModels();
  patchCodexImageGenSkillSource();
  const authIssuerPatch = patchCodexAuthIssuerSource(
    codexSourceRoot,
    buildChatGptLoginBaseUrl
  );
  const enterprisePluginPatch = patchCodexEnterprisePluginSource(codexSourceRoot);
  log(`已补丁 Codex OAuth issuer：${authIssuerPatch.issuer}`);
  log(`已补丁 Codex 插件目录：企业版本地市场${enterprisePluginPatch.changed ? "（已更新源码）" : ""}`);

  if (config.codexCli?.disableOpenAIWebSockets) {
    const providerInfoPath = path.join(
      codexSourceRoot,
      "codex-rs",
      "model-provider-info",
      "src",
      "lib.rs"
    );

    const original = fs.readFileSync(providerInfoPath, "utf8");
    const patched = original.replace(
      /(pub fn create_openai_provider\([\s\S]*?requires_openai_auth: true,[\s\S]*?)supports_websockets: true,/,
      "$1supports_websockets: false,"
    );
    if (patched !== original) {
      fs.writeFileSync(providerInfoPath, patched);
      log("已补丁内置 OpenAI provider：禁用 Responses WebSocket");
    } else if (original.includes("supports_websockets: false")) {
      log("内置 OpenAI provider 已禁用 Responses WebSocket");
    } else {
      throw new Error("补丁点不存在：OpenAI provider Responses WebSocket");
    }
  }
}

function patchCodexLoginCallbackPortSource() {
  const serverPath = path.join(codexSourceRoot, "codex-rs", "login", "src", "server.rs");
  writePatchedFile(serverPath, (source) => {
    const patched = source
      .replace("const DEFAULT_PORT: u16 = 1455;", "const DEFAULT_PORT: u16 = 1457;")
      .replace("const FALLBACK_PORT: u16 = 1457;", "const FALLBACK_PORT: u16 = 1455;");
    if (patched === source) {
      if (source.includes("const DEFAULT_PORT: u16 = 1457;") && source.includes("const FALLBACK_PORT: u16 = 1455;")) return source;
      throw new Error("??????????");
    }
    return patched;
  });
  log("??? Codex OAuth ????????1457?????? 1455");
}

function patchCodexHomeSource() {
  const homeDirPath = path.join(codexSourceRoot, "codex-rs", "utils", "home-dir", "src", "lib.rs");
  writePatchedFile(homeDirPath, (source) => {
    let next = source;
    next = next.replace(
      /let codex_home_env = std::env::var\("CODEX_HOME"\)\r?\n        \.ok\(\)\r?\n        \.filter\(\|val\| !val\.is_empty\(\)\);\r?\n    find_codex_home_from_env\(codex_home_env\.as_deref\(\)\)/,
      `let codex_home_env = std::env::var("RUIZHI_HOME")
        .ok()
        .filter(|val| !val.is_empty())
        .or_else(|| {
            std::env::var("CODEX_HOME")
                .ok()
                .filter(|val| !val.is_empty())
        });
    find_codex_home_from_env(codex_home_env.as_deref())`
    );
    if (next === source) {
      throw new Error("补丁点不存在：锐捷 home 环境变量解析");
    }
    return next;
  });
  log("已补丁 Codex home 解析：RUIZHI_HOME 优先，锐捷默认使用 ~/.ruizhi");
}

function patchCodexBundledModels() {
  if (!modelCatalogEnabled()) {
    log("跳过 Codex 内置模型目录替换：自定义模型目录已关闭");
    return;
  }

  const sourcePath = modelCatalogPath();
  const raw = fs.readFileSync(sourcePath, "utf8");
  const catalog = JSON.parse(raw);
  if (!Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error("锐捷模型目录为空或格式无效。");
  }
  const targetPath = path.join(codexSourceRoot, "codex-rs", "models-manager", "models.json");
  fs.copyFileSync(sourcePath, targetPath);
  log(`已替换 Codex 内置模型目录：${catalog.models.length} 个模型`);
}

function patchCodexImageGenSkillSource() {
  const skillPath = path.join(
    codexSourceRoot,
    "codex-rs",
    "skills",
    "src",
    "assets",
    "samples",
    "imagegen",
    "SKILL.md"
  );
  const content = fs.readFileSync(imageGenSkillSourcePath(), "utf8");
  fs.writeFileSync(skillPath, content, "utf8");
  log("已补丁内置 imagegen skill：默认使用锐擎生图 helper");
}

function buildPatchedCodexCli() {
  const cliConfig = codexCliBuildConfig();
  const shouldBuild = process.env.RUIZHI_BUILD_CODEX === "0" ? false : process.env.RUIZHI_BUILD_CODEX === "1" || cliConfig?.rebuildByDefault === true;
  if (!shouldBuild) {
    log("跳过 Codex.exe 重编；默认使用前端/运行态覆盖。需要 Rust 侧补丁时设置 RUIZHI_BUILD_CODEX=1。");
    return;
  }

  ensureCodexSource();
  patchCodexCliSource();

  const codexRsRoot = path.join(codexSourceRoot, "codex-rs");
  const cargoEnv = {
    ...process.env,
    ...(cliConfig.rustupToolchain ? { RUSTUP_TOOLCHAIN: cliConfig.rustupToolchain } : {}),
    CARGO_PROFILE_RELEASE_LTO: "false",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "16",
    CARGO_PROFILE_RELEASE_INCREMENTAL: process.env.CARGO_PROFILE_RELEASE_INCREMENTAL ?? "true",
    CARGO_PROFILE_RELEASE_DEBUG: process.env.CARGO_PROFILE_RELEASE_DEBUG ?? "0",
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "6",
    CARGO_NET_GIT_FETCH_WITH_CLI: process.env.CARGO_NET_GIT_FETCH_WITH_CLI ?? "true"
  };
  execLogged("cargo", ["build", "--release", "-p", "codex-cli", "--bin", "codex"], {
    cwd: codexRsRoot,
    env: cargoEnv
  });

  const builtExePath = path.join(codexRsRoot, "target", "release", "codex.exe");
  const targetExePath = path.join(appOutRoot, "resources", "codex.exe");
  if (!fs.existsSync(builtExePath)) {
    throw new Error(`没有找到编译后的 codex.exe：${builtExePath}`);
  }

  fs.copyFileSync(builtExePath, targetExePath);
  const sourceCodexClientVersion = codexClientVersionFromExe(
    path.join(pinnedCodexAppRoot, "resources", "codex.exe")
  );
  const builtCodexClientVersion = codexClientVersionFromExe(targetExePath);
  if (builtCodexClientVersion !== sourceCodexClientVersion) {
    throw new Error(
      `重编 Codex CLI 版本不匹配：桌面端=${sourceCodexClientVersion}，重编=${builtCodexClientVersion}`
    );
  }
  log("已替换 resources\\codex.exe：内置 OpenAI provider 默认禁用 WebSocket");
}

function copyPluginMarketplaces() {
  const resourcesDir = path.join(appOutRoot, "resources");

  for (const marketplace of pluginMarketplaces()) {
    const sourceRoot = path.join(projectRoot, ...splitConfigPath(marketplace.sourcePath));
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
    fsExtra.copySync(sourceRoot, targetRoot);
    log(`已内置插件 marketplace：${marketplace.displayName ?? marketplace.name}`);
  }
}

function patchRuntimeResourceText() {
  const resourcesDir = path.join(appOutRoot, "resources");
  copyWindowsResourceOverrides(resourcesDir, {
    log,
    pageEnhanceEnabled: pageEnhanceEnabled()
  });
  if (brandingEnabled()) {
    patchOpenAIBundledPluginDescriptions(resourcesDir, { log, sourceAppRoot: pinnedCodexAppRoot });
  } else {
    log("已跳过插件资源品牌化文案补丁");
  }
}

function copyRuntimeOverrides() {
  const resourcesDir = path.join(appOutRoot, "resources");

  fs.copyFileSync(windowsIconPath(), path.join(resourcesDir, "icon.ico"));
  log("已替换资源目录图标：icon.ico");

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
    codexClientVersion ??= codexClientVersionFromExe(path.join(pinnedCodexAppRoot, "resources", "codex.exe"));
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
  copyWindowsPrerequisites(resourcesDir, { log });

  if (modelBridgeEnabled()) {
    const bridgeTargetPath = path.join(resourcesDir, modelBridgeRuntimeResourcePath());
    fs.mkdirSync(path.dirname(bridgeTargetPath), { recursive: true });
    fs.copyFileSync(modelBridgeRuntimeSourcePath(), bridgeTargetPath);
    log(`已内置模型协议 bridge：${path.relative(projectRoot, bridgeTargetPath)}`);
  }

  const systemSkillNames = listSystemSkillSourceDirs();
  for (const skillName of systemSkillNames) {
    const skillTargetDir = path.join(resourcesDir, "skills", ".system", skillName);
    fs.mkdirSync(skillTargetDir, { recursive: true });
    fs.copyFileSync(
      path.join(systemSkillsSourceRoot(), skillName, "SKILL.md"),
      path.join(skillTargetDir, "SKILL.md")
    );
  }
  log(`已内置运行态系统 skills 覆盖：${systemSkillNames.length} 个`);
}

function writeAppUpdateConfig() {
}

function renameElectronExe() {
  const source = path.join(appOutRoot, config.windows.sourceExeName);
  const target = path.join(appOutRoot, config.windows.appExeName);
  if (path.resolve(source).toLowerCase() === path.resolve(target).toLowerCase()) {
    if (!fs.existsSync(source)) {
      throw new Error(`没有找到主程序：${source}`);
    }
    log(`保留主程序文件名：${config.windows.appExeName}`);
    return;
  }
  fs.rmSync(target, { force: true });
  fs.renameSync(source, target);
  log(`已重命名主程序：${config.windows.appExeName}`);
}

async function patchElectronExeIcon() {
  if (process.env.RUIZHI_SKIP_EXE_ICON_PATCH === "1") {
    log("跳过主程序图标替换：RUIZHI_SKIP_EXE_ICON_PATCH=1");
    return;
  }

  const target = path.join(appOutRoot, config.windows.appExeName);
  const icon = windowsIconPath();
  let lastError;
  for (const delayMs of [0, 1000, 2500]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }
    try {
      await rcedit(target, { icon });
      log(`已替换主程序图标：${path.basename(icon)}`);
      return;
    } catch (error) {
      lastError = error;
      log(`主程序图标替换失败，准备重试：${error.message}`);
    }
  }
  throw lastError;
}

function buildGoIconSyso(packageDir, iconPath) {
  const sysoPath = path.join(packageDir, "zz_build_icon_windows_amd64.syso");
  fs.rmSync(sysoPath, { force: true });
  execFileSync(
    "go",
    ["run", "github.com/akavel/rsrc@v0.10.2", "-ico", iconPath, "-o", sysoPath],
    { stdio: "inherit" }
  );
  return sysoPath;
}

function buildGoExe(outputPath, packageDir, label, extraLdflags = []) {
  fs.rmSync(outputPath, { force: true });
  log(`编译${label}`);

  const ldflags = ["-H=windowsgui", "-s", "-w", ...extraLdflags].join(" ");
  const iconPath = windowsIconPath();
  const sysoPath = buildGoIconSyso(packageDir, iconPath);
  try {
    execFileSync(
      "go",
      [
        "build",
        "-ldflags",
        ldflags,
        "-o",
        outputPath,
        packageDir
      ],
      { stdio: "inherit" }
    );
  } finally {
    fs.rmSync(sysoPath, { force: true });
  }
}

function buildGoConsoleExe(outputPath, packageDir, label) {
  fs.rmSync(outputPath, { force: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  log(`编译${label}`);
  execFileSync(
    "go",
    [
      "build",
      "-ldflags",
      "-s -w",
      "-o",
      outputPath,
      packageDir
    ],
    { stdio: "inherit" }
  );
}

function buildImageGenHelper() {
  buildGoConsoleExe(
    path.join(appOutRoot, "resources", "bin", imageGenHelperExeName()),
    path.join(projectRoot, "cmd", "ruizhi-imagegen"),
    "锐捷生图工具"
  );
}

function windowsZipName() {
  const name = renderArtifactName(config.windows.zipName ?? `ruizhi-windows-\${version}.\${ext}`, "zip");
  if (path.basename(name) !== name || !name.toLowerCase().endsWith(".zip")) {
    throw new Error(`Windows zip 文件名无效：${name}`);
  }
  return name;
}

function assertVersionFilePart(version) {
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
    throw new Error(`版本号不能用于产物文件名：${version}`);
  }
}

function windowsTestAppDirName(version = appVersion) {
  assertVersionFilePart(version);
  return `test-app-${version}`;
}

function windowsLatestYmlPath() {
  return path.join(installerOutDir, "latest.yml");
}

function versionedWindowsLatestYmlPath(version = appVersion) {
  assertVersionFilePart(version);
  return path.join(installerOutDir, `latest-${version}.yml`);
}

function readElectronUpdaterManifestVersion(manifestPath) {
  const content = fs.readFileSync(manifestPath, "utf8");
  const match = content.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  if (!match) {
    throw new Error(`无法从 electron-updater 清单读取版本号：${manifestPath}`);
  }
  return match[1];
}

function preserveExistingWindowsLatestYml() {
  const latestPath = windowsLatestYmlPath();
  if (!fs.existsSync(latestPath)) {
    return;
  }

  const version = readElectronUpdaterManifestVersion(latestPath);
  const versionedPath = versionedWindowsLatestYmlPath(version);
  fs.copyFileSync(latestPath, versionedPath);
  log(`已保留历史 Windows 更新清单：${versionedPath}`);
}

function writeVersionedWindowsLatestYml() {
  const latestPath = windowsLatestYmlPath();
  if (!fs.existsSync(latestPath)) {
    throw new Error(`缺少 Windows electron-updater 清单：${latestPath}`);
  }

  const versionedPath = versionedWindowsLatestYmlPath();
  fs.copyFileSync(latestPath, versionedPath);
  log(`Windows 版本更新清单已输出：${versionedPath}`);
}

function ensureWindowsLatestYmlFromInstaller() {
  const latestPath = windowsLatestYmlPath();
  const installerName = updateArtifactName();
  const installerPath = path.join(installerOutDir, installerName);
  if (!fs.existsSync(installerPath)) {
    throw new Error(`缺少 Windows NSIS 安装包：${installerPath}`);
  }

  const data = fs.readFileSync(installerPath);
  const sha512 = createHash("sha512").update(data).digest("base64");
  const size = fs.statSync(installerPath).size;
  const releaseDate = new Date().toISOString();
  const manifest = [
    `version: ${appVersion}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    ""
  ].join("\n");
  fs.writeFileSync(latestPath, manifest, "utf8");
  writeVersionedWindowsLatestYml();
}

function isSamePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function removeLegacyArtifact(artifactPath, options = {}) {
  assertInsideProject(artifactPath);
  try {
    fs.rmSync(artifactPath, { force: true, ...options });
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EBUSY") {
      throw new Error(`历史产物被占用，无法清理：${artifactPath}。请先关闭正在运行的旧版锐捷/Codex 进程后重新构建。`);
    }
    throw error;
  }
}

function cleanLegacyWindowsArtifacts() {
  const distDir = path.join(projectRoot, "dist");
  const legacyArtifacts = [
    path.join(distDir, "锐捷Codex-Setup.exe"),
    path.join(distDir, "ruizhi-latest.json"),
    path.join(distDir, "ruizhi-windows.zip"),
    path.join(distDir, windowsZipName())
  ];

  for (const artifactPath of legacyArtifacts) {
    removeLegacyArtifact(artifactPath);
  }

  if (!fs.existsSync(distDir)) {
    return;
  }

  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || (entry.name !== "windows" && !entry.name.startsWith("windows-"))) {
      continue;
    }

    const windowsDistDir = path.join(distDir, entry.name);
    if (isSamePath(windowsDistDir, distRoot)) {
      continue;
    }

    removeLegacyArtifact(windowsDistDir, { recursive: true });
  }
}

function createZip() {
  const zipPath = path.join(installerOutDir, windowsZipName());
  fs.mkdirSync(installerOutDir, { recursive: true });
  fs.rmSync(zipPath, { force: true });

  log("压缩 Windows 产物到 installer 目录");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -Path '${distRoot.replaceAll("'", "''")}\\*' -DestinationPath '${zipPath.replaceAll("'", "''")}' -Force`
    ],
    { stdio: "inherit" }
  );
  log(`zip 已输出：${zipPath}`);
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
      builtAt: new Date().toISOString()
    }, null, 2)}\n`,
    "utf8"
  );
}

function createTestApp() {
  try {
    cleanDir(testAppOutDir);
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EBUSY") {
      throw new Error(`测试程序目录被占用，无法清理：${testAppOutDir}。请先关闭正在运行的测试版锐捷/Codex 进程后重新构建。`);
    }
    throw error;
  }

  fsExtra.copySync(appOutRoot, testAppOutDir);
  writeRuntimeEnvironmentMarker(testAppOutDir, "test");

  const exePath = path.join(testAppOutDir, config.windows.appExeName);
  if (!fs.existsSync(exePath)) {
    throw new Error(`测试程序缺少主程序：${exePath}`);
  }

  log(`测试环境可直接启动：${exePath}`);
}

function renderArtifactName(template, ext = "exe") {
  return template
    .replaceAll("${productName}", config.productName)
    .replaceAll("${version}", appVersion)
    .replaceAll("${ext}", ext);
}

function windowsInstallerArtifactTemplate() {
  return config.updates?.artifactName ?? `Ruizhi-Setup-\${version}.\${ext}`;
}

function updateArtifactName() {
  const name = renderArtifactName(windowsInstallerArtifactTemplate());
  if (path.basename(name) !== name) {
    throw new Error(`更新包文件名不能包含路径分隔符：${name}`);
  }
  return name;
}

function updatePublishUrl() {
  return "";
}

function builderArtifactName() {
  return windowsInstallerArtifactTemplate();
}

function legacyWindowsAppExeNames() {
  const configured = config.windows?.previousAppExeNames ?? [];
  const currentExeName = config.windows.appExeName.toLowerCase();
  const seen = new Set();
  const result = [];

  for (const name of configured) {
    if (typeof name !== "string" || !name.trim()) {
      throw new Error(`windows.previousAppExeNames 包含无效文件名：${name}`);
    }

    if (path.basename(name) !== name || name.includes("\\") || name.includes("/") || name.includes('"') || name.includes("$")) {
      throw new Error(`历史 Windows 主程序名只能是普通 exe 文件名：${name}`);
    }

    if (!name.toLowerCase().endsWith(".exe")) {
      throw new Error(`历史 Windows 主程序名必须以 .exe 结尾：${name}`);
    }

    const normalized = name.toLowerCase();
    if (normalized === currentExeName || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    result.push(name);
  }

  return result;
}

function writeNsisInstallerInclude() {
  const includePath = path.join(workRoot, "installer.nsh");
  const legacyExeNames = legacyWindowsAppExeNames();
  const currentExeName = config.windows.appExeName;
  const findCurrentAppByPath = `$$target = Join-Path '$INSTDIR' '${currentExeName}'; $$matches = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals($$target, [System.StringComparison]::OrdinalIgnoreCase) })`;
  const lines = [
    "!macro customCheckAppRunning",
    `  nsExec::Exec \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "${findCurrentAppByPath}; if ($$matches.Count -gt 0) { exit 0 } else { exit 1 }"\``,
    "  Pop $R0",
    "  ${if} $R0 == 0",
    `    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "检测到锐捷Codex正在运行。确认后只会关闭当前锐捷安装目录中的 ${currentExeName}，不会关闭官方 Codex。" /SD IDCANCEL IDOK ruizhiStopCurrentApp`,
    "    Quit",
    "    ruizhiStopCurrentApp:",
    `    nsExec::Exec \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "${findCurrentAppByPath}; $$matches | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 500; ${findCurrentAppByPath}; if ($$matches.Count -eq 0) { exit 0 } else { exit 1 }"\``,
    "    Pop $R0",
    "    ${if} $R0 != 0",
    "      MessageBox MB_OK|MB_ICONEXCLAMATION \"锐捷Codex无法自动关闭，请手动退出锐捷Codex后重新安装。官方 Codex 无需退出。\"",
    "      Quit",
    "    ${endIf}",
    "  ${endIf}",
    "!macroend",
    "",
    "!macro customInit"
  ];

  for (const exeName of legacyExeNames) {
    lines.push(
      `  nsExec::Exec \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$$target = Join-Path '$INSTDIR' '${exeName}'; if (Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.ExecutablePath.Equals($$target, [System.StringComparison]::OrdinalIgnoreCase) }) { exit 0 } else { exit 1 }"\``,
      "  Pop $R0",
      "  ${if} $R0 == 0",
      `    MessageBox MB_OK|MB_ICONEXCLAMATION "检测到旧版 ${exeName} 正在运行，请先退出锐捷后再安装。"`,
      "    Quit",
      "  ${endIf}"
    );
  }

  lines.push("!macroend", "", "!macro customInstall");

  for (const exeName of legacyExeNames) {
    lines.push(
      `  Delete "$INSTDIR\\${exeName}"`,
      `  IfFileExists "$INSTDIR\\${exeName}" 0 +3`,
      `  MessageBox MB_OK|MB_ICONEXCLAMATION "旧版 ${exeName} 删除失败。请确认旧版锐捷已完全退出后重新安装。"`,
      "  Quit"
    );
  }

  if (legacyExeNames.length > 0) {
    lines.push("  ClearErrors");
  }

  lines.push("!macroend", "");
  fs.mkdirSync(workRoot, { recursive: true });
  fs.writeFileSync(includePath, lines.join("\n"));
  return includePath;
}

function electronBuilderConfig() {
  const publishUrl = updatePublishUrl();
  return {
    appId: "cn.ruizhi.desktop",
    productName: config.productName,
    electronVersion: electronRuntimeVersion(),
    publish: publishUrl ? [{ provider: "generic", url: publishUrl, useMultipleRangeRequest: false }] : null,
    copyright: `Copyright © ${new Date().getFullYear()} ${config.productName}`,
    directories: {
      output: installerOutDir
    },
    extraMetadata: {
      name: "ruizhi-desktop",
      productName: config.productName,
      version: appVersion
    },
    win: {
      icon: windowsIconPath(),
      executableName: path.basename(config.windows.appExeName, ".exe"),
      target: [
        {
          target: "nsis",
          arch: ["x64"]
        }
      ],
      artifactName: builderArtifactName()
    },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: config.windows.shortcutName ?? config.productName,
      include: writeNsisInstallerInclude(),
      uninstallDisplayName: config.productName,
      deleteAppDataOnUninstall: false,
      runAfterFinish: true
    }
  };
}

function createInstallerExe() {
  cleanLegacyWindowsArtifacts();
  fs.mkdirSync(installerOutDir, { recursive: true });
  removeLegacyArtifact(path.join(installerOutDir, updateArtifactName()));
  removeLegacyArtifact(path.join(installerOutDir, `${updateArtifactName()}.blockmap`));
  cleanDir(installerInputRoot);
  fsExtra.copySync(appOutRoot, installerInputRoot);
  validateRuizhiRuntimeBundle(installerInputRoot, config, {
    log,
    label: "Windows 安装包输入目录",
    expectedVersion: appVersion
  });

  const builderConfigPath = path.join(workRoot, "electron-builder.json");
  fs.writeFileSync(builderConfigPath, `${JSON.stringify(electronBuilderConfig(), null, 2)}\n`);

  const electronBuilderCache = process.env.ELECTRON_BUILDER_CACHE || path.join(workRoot, "electron-builder-cache");
  fs.mkdirSync(electronBuilderCache, { recursive: true });

  log("生成 NSIS 安装包");
  execLogged(process.execPath, [
    electronBuilderCliPath(),
    "--win",
    "nsis",
    "--x64",
    "--prepackaged",
    installerInputRoot,
    "--config",
    builderConfigPath,
    "--publish",
    "never"
  ], {
    env: { ...process.env, ELECTRON_BUILDER_CACHE: electronBuilderCache }
  });

  const versionedInstallerPath = path.join(installerOutDir, updateArtifactName());
  if (!fs.existsSync(versionedInstallerPath)) {
    throw new Error(`没有找到 NSIS 安装包：${versionedInstallerPath}`);
  }

  fs.rmSync(path.join(installerOutDir, "builder-debug.yml"), { force: true });
  ensureWindowsLatestYmlFromInstaller();
  log(`NSIS 安装包已输出：${versionedInstallerPath}`);
}

function cleanDistCopyLogs(appRoot) {
  const logsDir = path.join(appRoot, "Logs");
  if (fs.existsSync(logsDir)) {
    const logCount = fs.readdirSync(logsDir, { recursive: true }).length;
    fs.rmSync(logsDir, { recursive: true, force: true });
    log(`已清理日志目录：${logCount} 个文件`);
  }
}

function shouldCopyPinnedCodexAppEntry(sourcePath) {
  const relativeParts = path.relative(pinnedCodexAppRoot, sourcePath).split(path.sep).filter(Boolean);
  if (relativeParts.length > 0 && relativeParts[0].toLowerCase() === "logs") {
    return false;
  }
  return true;
}

function validateDistCopyNoAbsolutePaths(appRoot, sourceRoot) {
  const searchDirs = [".vite/build", "webview/assets"];
  for (const subdir of searchDirs) {
    const dir = path.join(appRoot, subdir);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir, { recursive: true }).filter((entry) => {
      const full = path.join(dir, entry);
      return fs.statSync(full).isFile() && /\.(js|html|json|css)$/.test(entry);
    });
    const sourcePathPattern = sourceRoot.replace(/\\/g, "\\\\");
    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), "utf8");
      if (content.includes(sourceRoot) || content.includes(sourcePathPattern)) {
        throw new Error(`分发产物包含绝对路径：${path.join(subdir, file)}`);
      }
    }
  }
  log("已验证分发产物无源绝对路径");
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("build:windows 只能在 Windows 上运行。");
  }

  const installedAppRoot = findPinnedCodexAppRoot();
  pinnedCodexAppRoot = installedAppRoot;
  log(`使用固定 Codex Desktop 源：${installedAppRoot}`);

  cleanDir(distRoot);
  log("复制 Codex Desktop 文件");
  await fsExtra.copy(installedAppRoot, appOutRoot, { filter: shouldCopyPinnedCodexAppEntry });
  writeOwlUserDataDirectoryName(appOutRoot, config, { log });

  cleanDistCopyLogs(appOutRoot);
  validateDistCopyNoAbsolutePaths(appOutRoot, installedAppRoot);

  buildPatchedCodexCli();
  try {
    const loginSuccessPatch = patchCodexLoginSuccessBinary(
      path.join(appOutRoot, "resources", "codex.exe"),
      config.loginSuccessPage,
    );
    log(`已补丁 Codex OAuth 成功页：${JSON.stringify(loginSuccessPatch.replacements)}`);
  } catch (error) {
    if (process.env.RUIZHI_BUILD_CODEX === "0") {
      log(`跳过 Codex OAuth 成功页补丁：${error.message}`);
    } else {
      throw error;
    }
  }
  copyRuntimeOverrides();
  copyPluginMarketplaces();
  patchRuntimeResourceText();
  buildImageGenHelper();
  await repackAppAsar();
  await patchFuses();
  renameElectronExe();
  await patchElectronExeIcon();
  validateRuizhiRuntimeBundle(appOutRoot, config, {
    log,
    label: "Windows 打包运行目录",
    expectedVersion: appVersion
  });
  createZip();
  createTestApp();
  validateRuizhiRuntimeBundle(testAppOutDir, config, {
    log,
    label: "Windows 测试程序目录",
    expectedVersion: appVersion,
    expectedEnvironment: "test"
  });
  createInstallerExe();
  writeRuntimeEnvironmentMarker(appOutRoot, "development");

  log("构建完成");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
