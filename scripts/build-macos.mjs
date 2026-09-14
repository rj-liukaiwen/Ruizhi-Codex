import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fsExtra from "fs-extra";
import { flipFuses, FuseVersion, FuseV1Options } from "@electron/fuses";
import {
  patchBrowserUseIabOpenStability,
  codexClientVersionFromExe,
  patchDesktopAuthAllowedUrls,
  patchNativeKeymapBindingsFallbackSource,
  patchNativePluginAuthCompatibilitySource,
  patchNativeUsageSettingsVisibilitySource,
  patchPluginSkillLocalListFallback,
  writeRuntimeModelCatalog
} from "./windows-asar-overrides.mjs";
import { patchCodexLoginSuccessBinary } from "./codex-login-success-branding.mjs";
import { patchCodexAuthIssuerSource } from "./codex-auth-issuer-source.mjs";
import { patchCodexEnterprisePluginSource } from "./codex-enterprise-plugins-source.mjs";
import { pageEnhanceRendererInstallerSource, pageEnhanceRendererSources } from "./page-enhance-source.mjs";

const require = createRequire(import.meta.url);
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
const updatesConfig = config.updates ?? {};
const macosUpdateConfig = updatesConfig.macos ?? {};
const macosBuildArch = normalizeMacosBuildArch(process.env.RUIZHI_MACOS_ARCH ?? process.arch);
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
const imageGenerationConfig = config.imageGeneration ?? {};
const modelBridgeConfig = config.modelBridge ?? {};
const openAIBundledPluginDefinitions = [
  { name: "browser", path: "./plugins/browser", category: "Engineering" },
  { name: "chrome", path: "./plugins/chrome", category: "Productivity" },
  { name: "computer-use", path: "./plugins/computer-use", category: "Productivity" },
  { name: "latex", path: "./plugins/latex", category: "Research" }
];
const browserRuntimePluginNames = ["browser", "chrome"];

const distDir = resolveProjectPath("dist");
const macDistDir = resolveProjectPath(path.join("dist", "macos"));
const appOutRoot = path.join(macDistDir, `${config.productName}.app`);
const workRoot = path.join(projectRoot, ".work", "macos");
const codexSourceRoot = path.join(projectRoot, ".work", "codex-source");
const dmgStagingDir = path.join(workRoot, "dmg");
const sourceWorkDir = path.join(workRoot, "source");
const downloadCacheDir = path.join(projectRoot, ".work", "download-cache", "macos");
const extractedDir = path.join(workRoot, "app");
const updateManifestPath = path.join(distDir, "ruizhi-latest-macos.json");
const archUpdateManifestPath = path.join(distDir, `ruizhi-latest-macos-${macosBuildArch}.json`);
const latestMacYmlPath = path.join(distDir, "latest-mac.yml");
const legacyLatestMacYmlPath = path.join(distDir, "latest.yml");
const archLatestMacYmlPath = path.join(distDir, `latest-mac-${macosBuildArch}.yml`);

function log(message) {
  console.log(`[ruizhi:macos] ${message}`);
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

function ruizhiBuildDateLabel() {
  return `锐捷构建日期：${ruizhiBuildDate()}`;
}

function ruizhiShortBuildDate() {
  return ruizhiBuildDate().replaceAll("-", "").slice(2);
}

function ruizhiBuildVersionLabel() {
  return `${appVersion}-${ruizhiShortBuildDate()}`;
}

function assertInsideProject(targetPath) {
  const resolvedRoot = path.resolve(projectRoot).toLowerCase();
  const resolvedTarget = path.resolve(targetPath).toLowerCase();
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`拒绝访问项目外路径：${targetPath}`);
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

function execLogged(command, args, options = {}) {
  log([command, ...args].join(" "));
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function execBestEffort(command, args, label) {
  try {
    execLogged(command, args);
  } catch (error) {
    log(`${label} 失败，继续构建：${error?.message ?? error}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execSensitive(command, args, label, options = {}) {
  log(label);
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function execOutput(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

function execOutputBestEffort(command, args, options = {}) {
  try {
    return execOutput(command, args, options);
  } catch {
    return "";
  }
}

function jsonLiteral(value) {
  return JSON.stringify(value);
}

function splitConfigPath(value) {
  return String(value).split(/[\\/]+/).filter(Boolean);
}

function pluginMarketplaces() {
  return Array.isArray(config.pluginMarketplaces) ? config.pluginMarketplaces : [];
}

function macosUpdatesEnabled() {
  return macosUpdateConfig.enabled ?? updatesConfig.enabled !== false;
}

function macosUpdateDownloadBaseUrl() {
  return process.env.RUIZHI_MACOS_UPDATE_DOWNLOAD_BASE_URL
    ?? process.env.RUIZHI_UPDATE_DOWNLOAD_BASE_URL
    ?? macosUpdateConfig.downloadBaseUrl
    ?? "";
}

function joinUrl(baseUrl, fileName) {
  if (!baseUrl) {
    return fileName;
  }
  return new URL(fileName, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function renderArtifactName(template, filePath) {
  const ext = path.extname(filePath).replace(/^\./, "") || "zip";
  return String(template)
    .replace(/\$\{version\}/g, appVersion)
    .replace(/\$\{arch\}/g, macosBuildArch)
    .replace(/\$\{ext\}/g, ext);
}

function macosUpdateArtifactName(filePath) {
  const template = macosUpdateConfig.artifactName ?? "Ruizhi-macos-${version}-${arch}.${ext}";
  return renderArtifactName(template, filePath);
}

function macosDmgArtifactName() {
  return macosUpdateArtifactName("app.dmg");
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function normalizeMacosBuildArch(value) {
  const arch = String(value ?? "").trim().toLowerCase();
  if (["arm64", "aarch64"].includes(arch)) {
    return "arm64";
  }
  if (["x64", "x86", "x86_64", "amd64", "intel"].includes(arch)) {
    return "x64";
  }
  throw new Error(`不支持的 macOS 架构：${value}`);
}

function macosMachArch(value = macosBuildArch) {
  return value === "x64" ? "x86_64" : value;
}

function macosGoArch(value = macosBuildArch) {
  return value === "x64" ? "amd64" : value;
}

function assertVersionFilePart(version) {
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
    throw new Error(`版本号不能用于产物文件名：${version}`);
  }
}

function versionedLatestMacYmlPath(version = appVersion, arch = macosBuildArch) {
  assertVersionFilePart(version);
  assertVersionFilePart(arch);
  return path.join(distDir, `latest-mac-${version}-${arch}.yml`);
}

function versionedMacUpdateManifestPath(version = appVersion, arch = macosBuildArch) {
  assertVersionFilePart(version);
  assertVersionFilePart(arch);
  return path.join(distDir, `ruizhi-latest-macos-${version}-${arch}.json`);
}

function readElectronUpdaterManifestVersion(manifestPath) {
  const content = fs.readFileSync(manifestPath, "utf8");
  const match = content.match(/^version:\s*['"]?([^'"\s]+)['"]?\s*$/m);
  if (!match) {
    throw new Error(`无法从 electron-updater 清单读取版本号：${manifestPath}`);
  }
  return match[1];
}

function readJsonManifestVersion(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`无法从 JSON 更新清单读取版本号：${manifestPath}`);
  }
  return manifest.version;
}

function preserveExistingMacUpdateManifests() {
  if (fs.existsSync(latestMacYmlPath)) {
    const version = readElectronUpdaterManifestVersion(latestMacYmlPath);
    const versionedPath = versionedLatestMacYmlPath(version);
    fs.copyFileSync(latestMacYmlPath, versionedPath);
    log(`已保留历史 macOS electron-updater 清单：${versionedPath}`);
  } else if (fs.existsSync(legacyLatestMacYmlPath)) {
    const version = readElectronUpdaterManifestVersion(legacyLatestMacYmlPath);
    const versionedPath = versionedLatestMacYmlPath(version);
    fs.copyFileSync(legacyLatestMacYmlPath, versionedPath);
    log(`已保留历史 macOS legacy electron-updater 清单：${versionedPath}`);
  }

  if (fs.existsSync(updateManifestPath)) {
    const version = readJsonManifestVersion(updateManifestPath);
    const versionedPath = versionedMacUpdateManifestPath(version);
    fs.copyFileSync(updateManifestPath, versionedPath);
    log(`已保留历史 macOS 更新清单：${versionedPath}`);
  }
}

function marketplaceSourceToken(name) {
  return `__RUIZHI_MARKETPLACE_SOURCE_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}__`;
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

function pageEnhanceServiceSourcePath() {
  return resolveProjectPath(path.join("resources", "bridge", "ruizhi-enhance-service.cjs"));
}

function imageGenHelperName() {
  return (imageGenerationConfig.helperDarwinName ?? imageGenerationConfig.helperExeName ?? "ruizhi-imagegen")
    .replace(/\.exe$/i, "");
}

function builtInAllowPrefixRules() {
  const configuredRules = Array.isArray(config.execPolicy?.allowPrefixRules)
    ? config.execPolicy.allowPrefixRules
    : [];
  const imageGenHelperPath = path.join("bin", imageGenHelperName());
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

function findOptionalFile(dir, pattern, label) {
  const matches = fs.readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dir, name));

  if (matches.length === 0) {
    log(`跳过缺失文件：${label}`);
    return null;
  }
  if (matches.length > 1) {
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

function replaceExactIfPresent(source, from, to, label) {
  if (!source.includes(from)) {
    log(`跳过补丁点：${label}`);
    return source;
  }
  return source.replace(from, to);
}

function replaceRegex(source, pattern, to, label) {
  if (!pattern.test(source)) {
    throw new Error(`补丁点不存在：${label}`);
  }
  return source.replace(pattern, to);
}

function replaceAllIfPresent(source, from, to) {
  return source.split(from).join(to);
}

function walkFiles(root) {
  if (!fs.existsSync(root)) {
    return [];
  }

  const result = [];
  const visit = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        result.push(fullPath);
      }
    }
  };

  visit(root);
  return result;
}

function configuredWebsiteUrl(key, label) {
  const configured = String(config.website?.[key] ?? "").trim();
  if (!configured) {
    throw new Error(`缺少 website.${key} 配置，无法补丁${label}链接`);
  }
  return configured;
}

function homeUrl() {
  return configuredWebsiteUrl("homeUrl", "帮助首页");
}

function docsUrl(hash = "") {
  const configured = configuredWebsiteUrl("docsUrl", "帮助文档");
  return hash ? `${configured.split("#")[0]}#${hash}` : configured;
}

function patchHelpDocumentationLinks() {
  const helpHomeUrl = homeUrl();
  const helpHomePattern = /\{label:`Codex Documentation`,click:\(\)=>\{([A-Za-z_$][\w$]*)\.shell\.openExternal\(`https:\/\/developers\.openai\.com\/codex\/app`\)\}\}/g;
  const replacements = [
    ["https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan#h_8dd84c836b", `${buildChatGptLoginBaseUrl}/dashboard/overview`],
    ["https://developers.openai.com/codex/app/worktrees#option-1-working-on-the-worktree", docsUrl("workspace")],
    ["https://developers.openai.com/codex/app/local-environments", docsUrl("terminal")],
    ["https://developers.openai.com/codex/app/troubleshooting", docsUrl("faq")],
    ["https://developers.openai.com/codex/app/automations", docsUrl("automation")],
    ["https://developers.openai.com/codex/app/worktrees", docsUrl("workspace")],
    ["https://developers.openai.com/codex/changelog", docsUrl("install")],
    ["https://developers.openai.com/codex/skills", docsUrl("skills")],
    ["https://developers.openai.com/codex/mcp", docsUrl("skills")],
    ["https://developers.openai.com/codex/agent-approvals-security#automatic-approval-reviews", docsUrl("best-practices")],
    ["https://developers.openai.com/codex/memories/chronicle", docsUrl("rules")],
    ["https://developers.openai.com/codex/memories", docsUrl("rules")],
    ["https://developers.openai.com/codex/pricing", docsUrl("intro")],
    ["https://developers.openai.com/codex/app", docsUrl()]
  ];

  let changedFiles = 0;
  let replacementCount = 0;
  const files = walkFiles(extractedDir).filter((filePath) => /\.(js|html|json)$/i.test(filePath));
  for (const filePath of files) {
    let source = fs.readFileSync(filePath, "utf8");
    let next = source;
    const helpHomeMatches = next.match(helpHomePattern);
    if (helpHomeMatches) {
      next = next.replace(
        helpHomePattern,
        `{label:\`Codex Documentation\`,click:()=>{$1.shell.openExternal(\`${helpHomeUrl}\`)}}`
      );
      replacementCount += helpHomeMatches.length;
    }
    for (const [from, to] of replacements) {
      const before = next;
      next = next.split(from).join(to);
      if (next !== before) {
        replacementCount += before.split(from).length - 1;
      }
    }
    if (next !== source) {
      fs.writeFileSync(filePath, next, "utf8");
      changedFiles += 1;
    }
  }

  if (replacementCount === 0) {
    throw new Error("未找到 Codex 帮助文档链接补丁点");
  }

  log(`已补丁帮助文档链接：${changedFiles} 个文件，${replacementCount} 处`);
}

function patchAccountSettingsLinks() {
  const accountUrl = `${buildChatGptLoginBaseUrl}/`;
  const accountSettingsPattern = /https:\/\/chatgpt\.com\/#settings(?:\/[A-Za-z]+)?/g;
  const accountSecurityPattern = /https:\/\/chatgpt\.com\/open-security-settings/g;
  let changedFiles = 0;
  let replacementCount = 0;
  const files = walkFiles(extractedDir).filter((filePath) => /\.(js|html|json)$/i.test(filePath));

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    let next = source;
    for (const pattern of [accountSettingsPattern, accountSecurityPattern]) {
      const matches = next.match(pattern);
      if (matches) {
        replacementCount += matches.length;
        next = next.replace(pattern, accountUrl);
      }
    }
    if (next !== source) {
      fs.writeFileSync(filePath, next, "utf8");
      changedFiles += 1;
    }
  }

  if (replacementCount === 0) {
    throw new Error("未找到 ChatGPT 账户设置链接补丁点");
  }

  log(`已补丁账户设置链接：${changedFiles} 个文件，${replacementCount} 处`);
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

function appResourcesDir() {
  return path.join(appOutRoot, "Contents", "Resources");
}

function validateMacAppRoot(appRoot) {
  const asarPath = path.join(appRoot, "Contents", "Resources", "app.asar");
  if (!fs.existsSync(asarPath)) {
    throw new Error(`不是有效的 Codex.app：${appRoot}`);
  }
}

function findMacApps(root) {
  const results = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > 5 || !fs.existsSync(current.dir)) {
      continue;
    }
    for (const entry of fs.readdirSync(current.dir, { withFileTypes: true })) {
      const fullPath = path.join(current.dir, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.endsWith(".app") && fs.existsSync(path.join(fullPath, "Contents", "Resources", "app.asar"))) {
        results.push(fullPath);
      } else {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }
  return results;
}

function sourceAppFromLocalInstall() {
  const candidates = [
    "/Applications/Codex.app",
    path.join(process.env.HOME ?? "", "Applications", "Codex.app")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "Contents", "Resources", "app.asar"))) {
      return candidate;
    }
  }
  return null;
}

function downloadFile(url, targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const partialPath = `${targetPath}.partial`;
  const allowResume = process.env.RUIZHI_CODEX_DOWNLOAD_RESUME === "1";
  if (!allowResume) fs.rmSync(partialPath, { force: true });
  const resumeArgs = allowResume && fs.existsSync(partialPath) ? ["--continue-at", "-"] : [];
  try {
    execLogged("curl", ["-L", "--fail", "--retry", "3", "--retry-all-errors", ...resumeArgs, "--output", partialPath, url]);
    if (/\.dmg$/i.test(targetPath)) {
      execLogged("hdiutil", ["verify", partialPath]);
    }
    fs.renameSync(partialPath, targetPath);
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  }
}

function downloadCacheMaxAgeMs() {
  const configured = Number(process.env.RUIZHI_CODEX_DOWNLOAD_CACHE_MAX_AGE_MS ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(configured) && configured >= 0 ? configured : 6 * 60 * 60 * 1000;
}

function cachedDownloadPath(url, fileName) {
  const cacheKey = createHash("sha256").update(url).digest("hex").slice(0, 16);
  return path.join(downloadCacheDir, `${cacheKey}-${fileName}`);
}

function canReuseCachedDownload(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const stat = fs.statSync(filePath);
  return stat.isFile()
    && stat.size > 0
    && downloadCacheMaxAgeMs() > 0
    && Date.now() - stat.mtimeMs <= downloadCacheMaxAgeMs();
}

function defaultCodexMacosAppUrl() {
  return "https://persistent.oaistatic.com/codex-app-prod/Codex.dmg";
}

function extractZip(zipPath, targetDir) {
  cleanDir(targetDir);
  execLogged("ditto", ["-x", "-k", zipPath, targetDir]);
}

function copyAppFromDmg(dmgPath, targetDir) {
  cleanDir(targetDir);
  const output = execOutput("hdiutil", ["attach", "-nobrowse", "-readonly", dmgPath]);
  const mountPoint = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.match(/\/Volumes\/.+$/)?.[0])
    .find(Boolean);

  if (!mountPoint) {
    throw new Error(`无法挂载 DMG：${dmgPath}`);
  }

  try {
    const apps = findMacApps(mountPoint);
    if (apps.length === 0) {
      throw new Error(`DMG 中找不到带 app.asar 的 .app：${dmgPath}`);
    }
    fsExtra.copySync(apps[0], path.join(targetDir, path.basename(apps[0])));
  } finally {
    execLogged("hdiutil", ["detach", mountPoint]);
  }
}

function sourceAppFromUrl() {
  const url = process.env.CODEX_MACOS_APP_URL?.trim() || defaultCodexMacosAppUrl();
  if (!url) {
    return null;
  }

  cleanDir(sourceWorkDir);
  const parsed = new URL(url);
  const fileName = path.basename(parsed.pathname) || "codex-app-download";
  const downloadPath = cachedDownloadPath(url, fileName);
  if (canReuseCachedDownload(downloadPath)) {
    log(`复用已缓存的 Codex 基包：${downloadPath}`);
  } else {
    fs.rmSync(downloadPath, { force: true });
    downloadFile(url, downloadPath);
  }

  const extractDir = path.join(sourceWorkDir, "extracted");
  if (/\.zip$/i.test(fileName)) {
    extractZip(downloadPath, extractDir);
  } else if (/\.dmg$/i.test(fileName)) {
    copyAppFromDmg(downloadPath, extractDir);
  } else {
    throw new Error("CODEX_MACOS_APP_URL 只支持 .zip 或 .dmg。");
  }

  const apps = findMacApps(extractDir);
  if (apps.length === 0) {
    throw new Error(`下载产物中找不到带 app.asar 的 .app：${url}`);
  }
  return apps[0];
}

function findSourceAppRoot() {
  if (process.env.CODEX_APP_ROOT) {
    const explicit = path.resolve(process.env.CODEX_APP_ROOT);
    validateMacAppRoot(explicit);
    return explicit;
  }

  const local = sourceAppFromLocalInstall();
  if (local) {
    validateMacAppRoot(local);
    return local;
  }

  const fromUrl = sourceAppFromUrl();
  if (fromUrl) {
    validateMacAppRoot(fromUrl);
    return fromUrl;
  }

  throw new Error("没有找到 Codex.app。请先安装到 /Applications/Codex.app，或设置 CODEX_APP_ROOT。");
}

function patchPluginAccountGate() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const pluginAccountGatePattern = /function ([A-Za-z_$][\w$]*)\(e\)\{return e!==`chatgpt`(?:&&e!==`apikey`&&e!==`amazonBedrock`(?:\/\*ruizhiPluginAuthCompatibility\*\/)?){0,1}\}/;
  const gateFile = findOneFileByContent(
    assetsDir,
    /\.js$/,
    pluginAccountGatePattern,
    "插件账号兼容 gate bundle"
  );
  const source = fs.readFileSync(gateFile, "utf8");
  const patched = patchNativePluginAuthCompatibilitySource(source);
  if (patched === source) {
    log(`插件已原生支持 ChatGPT/API key 账号：${path.basename(gateFile)}`);
    return;
  }
  fs.writeFileSync(gateFile, patched, "utf8");
  log(`已补丁插件账号兼容范围：${path.basename(gateFile)}`);
}

function patchNativeWebviewFeatureGates() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const statsigGateSourcePattern =
    /function ([A-Za-z_$][\w$]*)\(e\)\{return ([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),e\)\}/;
  const statsigGateIds = [
    "614250066",
    "2327881676",
    "1823130936",
    "3075919032",
    "3789238711",
    "3765605143",
    "1404955983",
    "567837310",
    "3207467860",
    "1823918333",
    "410065390",
    "824038554",
    "3839945238",
    "3909937021",
    "2761268526",
    "875176429",
    "1378180112",
    "1258561229",
    "505458",
    "3025044430",
    "1907601843",
    "2425897452",
    "1857002365",
    "12346831",
    "262557526",
    "663642302",
    "2929582856",
    "1488233300",
    "1848317837",
    "459748632",
    "2171042036",
    "1645387566",
    "1244621283",
    "1372061905",
    "3264431617",
    "4100906017",
    "4080277432",
    "2423536643",
    "1304276663",
    "2484414311",
    "188145323",
    "3079718369",
    "637432221",
    "1834314516",
    "1397824675",
    "2212532336",
    "2791276931",
    "2957382457",
    "4167858931",
    "1256703444",
    "1529702798",
    "1840974662",
    "4166894088",
    "410262010",
    "3903563814",
  ];
  const statsigFiles = walkFiles(assetsDir)
    .filter((filePath) => /\.js$/.test(filePath))
    .filter((filePath) => {
      const basename = path.basename(filePath);
      const source = fs.readFileSync(filePath, "utf8");
      if (!statsigGateSourcePattern.test(source)) {
        return false;
      }
      return (
        /^statsig-.*\.js$/.test(basename) ||
        source.includes("useStatsigClient") ||
        source.includes("useFeatureGate") ||
        source.includes("410262010")
      );
    });
  const statsigFile = statsigFiles[0];
  if (!statsigFile) {
    log("跳过补丁点：Statsig webview gate（模块已变更）");
    return;
  }
  if (statsigFiles.length > 1) {
    throw new Error(`Statsig webview gate bundle 匹配数量异常：${statsigFiles.length}`);
  }
  const nativeGateCode = `const ruizhiNativeFeatureGates=new Set(${JSON.stringify(statsigGateIds)});function ruizhiNativeFeatureGateValue(e){return ruizhiNativeFeatureGates.has(String(e))}`;
  const source = fs.readFileSync(statsigFile, "utf8");
  if (source.includes("ruizhiNativeFeatureGateValue")) {
    log("已存在 Codex 原生 webview gate 补丁");
    return;
  }
  const targetGateMatch = source.match(statsigGateSourcePattern);
  if (!targetGateMatch) {
    throw new Error("Codex 原生 webview gate 补丁点不存在");
  }
  const gateFunction = targetGateMatch[1];
  const initHook = targetGateMatch[2];
  const gateHook = targetGateMatch[3];
  const gateStore = targetGateMatch[4];
  const patched = source.replace(
    statsigGateSourcePattern,
    `${nativeGateCode}function ${gateFunction}(e){return ${initHook}(),ruizhiNativeFeatureGateValue(e)||${gateHook}(${gateStore},e)}`
  );
  fs.writeFileSync(statsigFile, patched, "utf8");
  log(`已打开 Codex 原生 webview gate：${path.basename(statsigFile)} (${statsigGateIds.length} 个)`);
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
  const match = source.match(statsigBootstrapPattern);
  if (!match) {
    log("跳过补丁点：Statsig post-login bootstrap（结构已变更）");
    return;
  }
  const functionName = match[1];
  const appSessionId = match[2];
  const appVersion = match[3];
  const locale = match[5];
  const stableId = match[6];
  const validator = match[13];
  const localBootstrapCode = "function ruizhiCreateStatsigBootstrapPayload(e){return JSON.stringify({has_updates:!0,response_format:`init-v2`,time:Date.now(),feature_gates:{},dynamic_configs:{},layer_configs:{},param_stores:{},values:{},exposures:{},sdk_flags:{},user:{userID:e.stableId||e.appSessionId||`ruizhi-local`,customIDs:{stableID:e.stableId},locale:e.locale,appVersion:e.appVersion}})}";
  const patched = source.replace(
    statsigBootstrapPattern,
    `${localBootstrapCode}async function ${functionName}({appSessionId:${appSessionId},appVersion:${appVersion},buildFlavor:${match[4]},locale:${locale},stableId:${stableId},systemName:${match[7]},systemVersion:${match[8]},windowType:${match[9]}}){let ${match[11]}=ruizhiCreateStatsigBootstrapPayload({appSessionId:${appSessionId},appVersion:${appVersion},locale:${locale},stableId:${stableId}}),{user:${match[12]}}=${validator}.parse(JSON.parse(${match[11]}));return{statsigPayload:${match[11]},user:${match[12]}}}`
  );
  fs.writeFileSync(statsigFile, patched, "utf8");
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
  let profileVisibilityFile;
  try {
    profileVisibilityFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /2478676115[\s\S]*3503973010[\s\S]*show_dropdown_entry_point/,
      "profile visibility bundle"
    );
  } catch (error) {
    log(`已跳过 Codex 个人资料入口补丁：${error.message}`);
    return;
  }
  const source = fs.readFileSync(profileVisibilityFile, "utf8");
  if (source.includes("ruizhiProfileVisibility()")) {
    log("已存在 Codex 个人资料入口补丁");
    return;
  }
  let patched = source.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(3\),\{authMethod:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(\),([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)=\5\|\|\4===`chatgpt`&&\7,([A-Za-z_$][\w$]*)=\4===`chatgpt`&&\9,([A-Za-z_$][\w$]*);return \2\[0\]!==\12\|\|\2\[1\]!==\13\?\(\14=\{isProfileVisibilityLoading:\12,isProfileVisible:\13\},\2\[0\]=\12,\2\[1\]=\13,\2\[2\]=\14\):\14=\2\[2\],\14\}/,
    "function ruizhiProfileVisibility(){return {isProfileVisibilityLoading:false,isProfileVisible:true}}function $1(){return ruizhiProfileVisibility()}"
  );
  patched = patched.replace(
    /function ([A-Za-z_$][\w$]*)\(\)\{let ([A-Za-z_$][\w$]*)=\(0,([A-Za-z_$][\w$]*)\.c\)\(13\),\{accountId:([A-Za-z_$][\w$]*),authMethod:([A-Za-z_$][\w$]*),isLoading:([A-Za-z_$][\w$]*),planAtLogin:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*)\(\),[\s\S]{0,2200}?return \2\[10\]!==([A-Za-z_$][\w$]*)\|\|\2\[11\]!==([A-Za-z_$][\w$]*)\?\(([A-Za-z_$][\w$]*)=\{isProfileVisibilityLoading:\9,isProfileVisible:\10\},\2\[10\]=\9,\2\[11\]=\10,\2\[12\]=\11\):\11=\2\[12\],\11\}/,
    "function ruizhiProfileVisibility(){return {isProfileVisibilityLoading:false,isProfileVisible:true}}function $1(){return ruizhiProfileVisibility()}"
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
    log("已跳过 Codex 个人资料入口补丁：当前 Desktop 结构不匹配");
    return;
  }
  fs.writeFileSync(profileVisibilityFile, patched, "utf8");
  log(`已打开 Codex 个人资料入口：${path.basename(profileVisibilityFile)}`);
}

function patchNativeUsageSettingsVisibility() {
  if (process.env.RUIZHI_SKIP_USAGE_SETTINGS_PATCH === "1") {
    log("已跳过 Codex 使用情况设置入口补丁（RUIZHI_SKIP_USAGE_SETTINGS_PATCH=1）");
    return;
  }
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
  let profileDropdownFile;
  try {
    profileDropdownFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /\{isUsageSettingsVisible:[A-Za-z_$][\w$]*,isUsageSettingsAccessLoading:[A-Za-z_$][\w$]*\}=[A-Za-z_$][\w$]*\(\)[\s\S]*codex\.profileDropdown\.apiKeyAuth[\s\S]*codex\.profileDropdown\.usage/,
      "profile dropdown usage bundle"
    );
  } catch (error) {
    log(`已跳过 Codex 头像菜单使用情况入口补丁：${error.message}`);
    return;
  }
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
  if (patched.includes("ruizhiProfileDropdownUsageForAllAuth")) {
    fs.writeFileSync(profileDropdownFile, patched, "utf8");
    log(`已打开 Codex 头像菜单使用情况入口：${path.basename(profileDropdownFile)}`);
    return;
  }

  const compactUsageConditionPattern = new RegExp(
    `(,([A-Za-z_$][\\w$]*)=([^,;]{0,160}&&${escapeRegExp(usageVisibleVar)}&&[^,;]{0,160}),([A-Za-z_$][\\w$]*=![A-Za-z_$][\\w$]*&&))`
  );
  const compactPatched = source.replace(
    compactUsageConditionPattern,
    `,$2=($3)||!${usageLoadingVar}/*ruizhiProfileDropdownUsageForAllAuth*/,$4`
  );
  if (!compactPatched.includes("ruizhiProfileDropdownUsageForAllAuth")) {
    throw new Error("Codex 头像菜单使用情况入口补丁点不存在：显示条件");
  }
  fs.writeFileSync(profileDropdownFile, compactPatched, "utf8");
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
  let usageQueriesFile;
  try {
    usageQueriesFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /safeGet\(`\/wham\/usage`/,
      "usage queries bundle"
    );
  } catch (error) {
    log(`已跳过锐鉴 API 用量兜底补丁：${error.message}`);
    return;
  }
  const source = fs.readFileSync(usageQueriesFile, "utf8");
  if (source.includes("/usage/platform")) {
    log("已存在锐鉴 API 用量兜底补丁");
    return;
  }
  const patched = source.replace(
    /queryFn:async\(\)=>\{try\{return await ([A-Za-z_$][\w$]*)\.safeGet\(`\/wham\/usage`(?:,\{parameters:\{query:\{supports_rewardless_invites:!0\}\}\})?\)\}catch\(e\)\{if\(e instanceof ([A-Za-z_$][\w$]*)&&\(e\.status===401\|\|e\.status===403\|\|e\.status===404\)\)return null;throw e\}\}/,
    "queryFn:async()=>{let t=globalThis.ruizhiDesktop?.enhance?.call;if(typeof t===`function`)try{let n=await t(`/usage/platform`,{});if(n?.status===`ok`&&n?.data?.rate_limit?.primary_window)return n.data}catch(e){console.warn(`[ruizhi][usage] local platform usage failed`,{message:String(e?.message||e)})}try{let e=await $1.safeGet(`/wham/usage`,{parameters:{query:{supports_rewardless_invites:!0}}});if(!e?.rate_limit?.primary_window)throw new Error(`incompatible usage response`);return e}catch(e){if(e instanceof $2&&(e.status===401||e.status===403||e.status===404))return null;throw e}}/*ruizhiPlatformUsageBridgeFirst*/"
  );
  if (!patched.includes("/usage/platform") || !patched.includes("ruizhiPlatformUsageBridgeFirst")) {
    log("已跳过锐鉴 API 用量兜底补丁：当前 Desktop 结构不匹配");
    return;
  }
  fs.writeFileSync(usageQueriesFile, patched, "utf8");
  log(`已补丁锐鉴 API 真实剩余用量：${path.basename(usageQueriesFile)}`);
}

function patchNativeWalletUsagePresentation() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  let rateLimitFile;
  try {
    rateLimitFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /windowDurationMins\?\?0\)>0/,
      "rate limit presentation bundle"
    );
  } catch (error) {
    log(`已跳过锐捷钱包额度展示补丁：${error.message}`);
    return;
  }
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
    log("已跳过锐捷钱包额度展示补丁：当前 Desktop 结构不匹配");
    return;
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

function patchNativeExternalLinkHrefFallback() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  let linkIconFile;
  try {
    linkIconFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /openLocalUrlInTargetPreference[\s\S]{0,2500}url:[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)/,
      "external link icon target bundle"
    );
  } catch (error) {
    log(`已跳过外部链接图标 href 兜底补丁：${error.message}`);
    return;
  }
  let source = fs.readFileSync(linkIconFile, "utf8");
  if (source.includes("ruizhiExternalLinkHrefFallback") && source.includes("ruizhiEmptyExternalLinkHidden")) {
    log("已存在外部链接图标 href 兜底补丁");
    return;
  }
  source = source.replace(
    /url:([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\),useExternalBrowser:/,
    "url:$2==null?``:$1($2),useExternalBrowser:/*ruizhiExternalLinkHrefFallback*/"
  );
  source = source.replace(
    /(function [A-Za-z_$][\w$]*\(e\)\{let [A-Za-z_$][\w$]*=\(0,[A-Za-z_$][\w$]*\.c\)\(\d+\),\{className:[A-Za-z_$][\w$]*,ExternalIcon:[A-Za-z_$][\w$]*,href:([A-Za-z_$][\w$]*),isBrowserSidebarEnabled:[A-Za-z_$][\w$]*,openTarget:[A-Za-z_$][\w$]*,PrimaryIcon:[A-Za-z_$][\w$]*,useExternalBrowser:[A-Za-z_$][\w$]*\}=e,[\s\S]{0,1600}?)(let [A-Za-z_$][\w$]*;return )/,
    "$1if($2==null)return null;/*ruizhiEmptyExternalLinkHidden*/$3"
  );
  if (!source.includes("ruizhiExternalLinkHrefFallback") || !source.includes("ruizhiEmptyExternalLinkHidden")) {
    log("已跳过外部链接图标 href 兜底补丁：当前 Desktop 结构不匹配");
    return;
  }
  fs.writeFileSync(linkIconFile, source, "utf8");
  log(`已补丁外部链接图标 href 兜底：${path.basename(linkIconFile)}`);
}

function patchNativeProfileDropdownUsageUpsell() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  let profileDropdownFile;
  try {
    profileDropdownFile = findOneFileByContent(
      assetsDir,
      /^.+\.js$/,
      /composer\.mode\.rateLimit\.heading[\s\S]*profile_dropdown_upgrade_cta/,
      "profile dropdown usage bundle"
    );
  } catch (error) {
    log(`已跳过个人菜单用量 upsell 隐藏补丁：${error.message}`);
    return;
  }
  let source = fs.readFileSync(profileDropdownFile, "utf8");
  if (source.includes("ruizhiProfileUsageUpsellHidden")) {
    log("已存在个人菜单用量 upsell 隐藏补丁");
    return;
  }
  source = source.replace(
    /![A-Za-z_$][\w$]*&&\(0,[A-Za-z_$][\w$]*\.jsx\)\([A-Za-z_$][\w$]*,\{planType:[A-Za-z_$][\w$]*,className:[\s\S]{0,220}?onRequestLimitIncreaseClick:[A-Za-z_$][\w$]*\}\)/,
    "null/*ruizhiProfileUsageUpsellHidden*/"
  );
  if (!source.includes("ruizhiProfileUsageUpsellHidden")) {
    log("已跳过个人菜单用量 upsell 隐藏补丁：当前 Desktop 结构不匹配");
    return;
  }
  fs.writeFileSync(profileDropdownFile, source, "utf8");
  log(`已隐藏个人菜单用量 upsell 空白项：${path.basename(profileDropdownFile)}`);
}

function patchNativeProfileApiCallLogging() {
  const mainBuildDir = path.join(extractedDir, ".vite", "build");
  let mainFile;
  try {
    mainFile = findOneFileByContent(
      mainBuildDir,
      /^main-.*\.js$/,
      /CODEX_API_BASE_URL[\s\S]*?prodApiBaseUrl/,
      "main API base bundle"
    );
  } catch (error) {
    log(`已跳过 Codex /wham/profiles/me 主进程调用日志补丁：${error.message}`);
    return;
  }
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
    log("已跳过 Codex /wham/profiles/me 主进程调用日志补丁：当前 Desktop 结构不匹配");
    return;
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
  const replacements = [
    [
      "function xe(e,{buildFlavor:n=t.O.resolve(),env:r=f.default.env,platform:i=f.default.platform}={}){let a=i===`win32`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...e,computerUse:!0,computerUseNodeRepl:!0}:e,o=n===t.O.Dev?Se(r):null;return o==null?a:{...a,...o}}",
      `${helper}function xe(e,{buildFlavor:n=t.O.resolve(),env:r=f.default.env,platform:i=f.default.platform}={}){let a=i===\`win32\`&&r.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===\`1\`?{...e,computerUse:!0,computerUseNodeRepl:!0}:e,o=n===t.O.Dev?Se(r):null;return ruizhiNativeBrowserDesktopFeatureAvailability(o==null?a:{...a,...o})}`
    ],
    [
      "function ve(e,{env:t=process.env,platform:n=process.platform}={}){return n!==`win32`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==`1`?e:{...e,computerUse:!0,computerUseNodeRepl:!0}}",
      `${helper}function ve(e,{env:t=process.env,platform:n=process.platform}={}){let r=n!==\`win32\`||t.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE!==\`1\`?e:{...e,computerUse:!0,computerUseNodeRepl:!0};return ruizhiNativeBrowserDesktopFeatureAvailability(r)}`
    ]
  ];

  for (const [from, to] of replacements) {
    if (source.includes(from)) {
      return source.replace(from, to);
    }
  }

  throw new Error("补丁点不存在：Codex 原生 Browser 桌面能力");
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
  const openInBrowserPattern = /case`open-in-browser`:\{let\{url:([A-Za-z_$][\w$]*)\}=([A-Za-z_$][\w$]*);if\(typeof \1==`string`&&this\.windowManager\.queueCodexDeepLinkUrl\(\1,\2\.originHostId\)\)break;if\(\2\.useExternalBrowser===!0(\|\|\2\.openTarget===`external-browser`)?\)\{/;
  if (!openInBrowserPattern.test(source)) {
    return null; // 结构已变更，无法补丁
  }

  return source.replace(openInBrowserPattern, (match, urlName, messageName, openTargetSuffix = "") => {
    return `${helper}case\`open-in-browser\`:{let{url:${urlName}}=${messageName};if(ruizhiIsChatGptAuthUrl(${urlName}))${messageName}={...${messageName},useExternalBrowser:!0};if(typeof ${urlName}==\`string\`&&this.windowManager.queueCodexDeepLinkUrl(${urlName},${messageName}.originHostId))break;if(${messageName}.useExternalBrowser===!0${openTargetSuffix}){`;
  });
}

function patchChatGptAuthExternalBrowser() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchChatGptAuthExternalBrowserSource(source);
  if (patched === null) {
    log("跳过补丁点：ChatGPT 认证链接外部浏览器（结构已变更）");
    return;
  }
  if (patched === source) {
    log(`已存在 ChatGPT 认证链接外部浏览器补丁：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已强制 ChatGPT 认证链接使用系统浏览器：${path.basename(mainFile)}`);
}

function patchBrowserNativePipeDiagnosticsSource(source) {
  if (source.includes("ruizhiBrowserNativePipeEnabled")) {
    return source;
  }
  const pattern = /function ([A-Za-z_$][\w$]*)\(\{setBrowserUseNativePipeEnabled:([A-Za-z_$][\w$]*)\}\)\{return\{setDesktopFeatureAvailability:([A-Za-z_$][\w$]*)=>\{\3\.inAppBrowserUse!=null&&\2\(\3\.inAppBrowserUse\)\},dispose:\(\)=>\{\2\(!1\)\}\}\}/;
  if (!pattern.test(source)) {
    throw new Error("补丁点不存在：Browser nativePipe 诊断日志");
  }
  return source.replace(pattern, (match, functionName, setterName, availabilityName) => {
    return `function ${functionName}({setBrowserUseNativePipeEnabled:${setterName}}){let ruizhiSetNativePipe=${availabilityName}=>{try{console.info(\`[ruizhi][browser] ruizhiBrowserNativePipeEnabled\`,{enabled:${availabilityName}})}catch{}${setterName}(${availabilityName})};return{setDesktopFeatureAvailability:${availabilityName}=>{${availabilityName}.inAppBrowserUse!=null&&ruizhiSetNativePipe(${availabilityName}.inAppBrowserUse)},dispose:()=>{ruizhiSetNativePipe(!1)}}}`;
  });
}

function patchBrowserNativePipeDiagnostics() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchBrowserNativePipeDiagnosticsSource(source);
  if (patched === source) {
    log(`已存在 Browser nativePipe 诊断日志：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已注入 Browser nativePipe 诊断日志：${path.basename(mainFile)}`);
}

function browserNativePipePeerAuthorizerLoggerName(source) {
  const markerIndex = source.indexOf("browser-use-native-pipe-peer-authorizer");
  if (markerIndex < 0) {
    return null;
  }
  const nearbySource = source.slice(Math.max(0, markerIndex - 240), markerIndex + 120);
  const match = nearbySource.match(/var ([A-Za-z_$][\w$]*)=[^;]*`browser-use-native-pipe-peer-authorizer`/);
  return match?.[1] ?? null;
}

function patchBrowserNativePipePeerAuthorizationSource(source) {
  if (source.includes("ruizhiBrowserNativePipePeerAuthorizationDisabled")) {
    return source;
  }

  const pattern = /function ([A-Za-z_$][\w$]*)\(\)\{if\(process\.platform!==`darwin`\)return\(\)=>\(\{authorized:!0\}\);[\s\S]*?(?=function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\{let [A-Za-z_$][\w$]*=[A-Za-z_$][\w$]*\._handle\?\.fd;)/;
  if (!pattern.test(source)) {
    throw new Error("补丁点不存在：Browser nativePipe peer authorization");
  }

  const loggerName = browserNativePipePeerAuthorizerLoggerName(source);
  return source.replace(pattern, (match, functionName) => {
    const logCall = loggerName
      ? `try{${loggerName}().info(\`browser-use native pipe peer authorization disabled by Ruizhi\`,{safe:{reason:\`ruizhiBrowserNativePipePeerAuthorizationDisabled\`},sensitive:{}})}catch{}`
      : "";
    return `function ${functionName}(){${logCall}return()=>({authorized:!0})}`;
  });
}

function patchBrowserNativePipePeerAuthorization() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchBrowserNativePipePeerAuthorizationSource(source);
  if (patched === source) {
    log(`已存在 Browser nativePipe peer authorization 补丁：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已禁用 Browser nativePipe peer authorization 签名门禁：${path.basename(mainFile)}`);
}

function patchTrustedBrowserClientHashesSource(source, hashes) {
  const normalizedHashes = [...new Set(hashes.map((hash) => String(hash).trim().toLowerCase()))].sort();
  if (normalizedHashes.length === 0) {
    throw new Error("缺少 Browser client nativePipe 信任哈希");
  }
  for (const hash of normalizedHashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`Browser client nativePipe 信任哈希无效：${hash}`);
    }
  }

  const literal = normalizedHashes.map((hash) => `\`${hash}\``).join(",");
  const defaultParamMatch = source.match(/trustedBrowserClientSha256s:([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)/);
  const hashVariableFromDefault = defaultParamMatch?.[2];
  const trustedHashArrayPatterns = [
    ...(hashVariableFromDefault
      ? [new RegExp(`var (${escapeRegExp(hashVariableFromDefault)})=\\[(?:\\\`[a-f0-9]{64}\\\`(?:,)?)*\\]`, "g")]
      : []),
    /var ([A-Za-z_$][\w$]*)=\[(?:`[a-f0-9]{64}`(?:,)?)*\],([A-Za-z_$][\w$]*)=class/g,
  ];

  let replaced = false;
  let patched = source;
  for (const pattern of trustedHashArrayPatterns) {
    patched = patched.replace(pattern, (match, hashVariable, classVariable) => {
      replaced = true;
      const suffix = typeof classVariable === "string" && /^[A-Za-z_$][\w$]*$/.test(classVariable)
        ? `,${classVariable}=class`
        : "";
      return `var ${hashVariable}=[${literal}]${suffix}`;
    });
    if (replaced) {
      break;
    }
  }

  if (!replaced) {
    throw new Error("补丁点不存在：Browser client nativePipe 信任哈希");
  }

  return patched;
}

function browserClientHashesFromResourcesDir(resourcesDir) {
  const hashes = [];
  for (const pluginName of browserRuntimePluginNames) {
    const clientPath = path.join(
      resourcesDir,
      "plugins",
      "openai-bundled",
      "plugins",
      pluginName,
      "scripts",
      "browser-client.mjs"
    );
    if (fs.existsSync(clientPath)) {
      hashes.push(sha256File(clientPath));
    }
  }
  if (hashes.length === 0) {
    throw new Error(`运行态缺少 Browser client 脚本：${path.join(resourcesDir, "plugins", "openai-bundled")}`);
  }
  return [...new Set(hashes)].sort();
}

function patchTrustedBrowserClientHashes() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const hashes = browserClientHashesFromResourcesDir(appResourcesDir());
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchTrustedBrowserClientHashesSource(source, hashes);
  const hashSummary = hashes.map((hash) => hash.slice(0, 12)).join(",");
  if (patched === source) {
    log(`已存在 Browser client nativePipe 信任哈希：${hashSummary}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已更新 Browser client nativePipe 信任哈希：${hashSummary}`);
}

function patchBrowserUseIabCdpNoTargetRetrySource(source) {
  if (source.includes("ruizhiBrowserUseIabCdpNoTargetRetry")) {
    return source;
  }

  const pattern =
    /async sendDebuggerCommand\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)=\{\}\)\{let ([A-Za-z_$][\w$]*)=\4\.sessionId\?\?\(\4\.targetId==null\?void 0:this\.debuggerSessionIdForTarget\(\1,\4\.targetId\)\?\?void 0\);if\(\4\.targetId!=null&&\4\.targetId!==([A-Za-z_$][\w$]*)\(\1\)&&\5==null\)throw Error\(`No in-app browser debugger session is attached for target \$\{\4\.targetId\}`\);return await ([A-Za-z_$][\w$]*)\(\1\.webContents\.debugger\.sendCommand\(\2,\3,\5\),this\.cdpCommandTimeoutMs,`Timed out running CDP command "\$\{\2\}" for tab \$\{\1\.cdpTabId\}`\)\}/;
  if (!pattern.test(source)) {
    throw new Error("补丁点不存在：Browser Use IAB CDP No target 重试");
  }

  return source.replace(pattern, (match, tabName, methodName, paramsName, targetName, sessionName, ownTargetFnName, timeoutFnName) => {
    return `async sendDebuggerCommand(${tabName},${methodName},${paramsName},${targetName}={}){let ${sessionName}=${targetName}.sessionId??(${targetName}.targetId==null?void 0:this.debuggerSessionIdForTarget(${tabName},${targetName}.targetId)??void 0);if(${targetName}.targetId!=null&&${targetName}.targetId!==${ownTargetFnName}(${tabName})&&${sessionName}==null)throw Error(\`No in-app browser debugger session is attached for target \${${targetName}.targetId}\`);try{return await ${timeoutFnName}(${tabName}.webContents.debugger.sendCommand(${methodName},${paramsName},${sessionName}),this.cdpCommandTimeoutMs,\`Timed out running CDP command "\${${methodName}}" for tab \${${tabName}.cdpTabId}\`)}catch(ruizhiError){let ruizhiMessage=ruizhiError instanceof Error?ruizhiError.message:String(ruizhiError);if(!ruizhiMessage.includes(\`No target available\`))throw ruizhiError;try{console.warn(\`[ruizhi][browser] ruizhiBrowserUseIabCdpNoTargetRetry\`,{method:${methodName},tabId:${tabName}.cdpTabId,webContentsId:${tabName}.webContents.id})}catch{}await this.detachTab(${tabName});await PX(50);await this.attachTab(${tabName});return await ${timeoutFnName}(${tabName}.webContents.debugger.sendCommand(${methodName},${paramsName},${sessionName}),this.cdpCommandTimeoutMs,\`Timed out running CDP command "\${${methodName}}" for tab \${${tabName}.cdpTabId}\`)}}`;
  });
}

function patchBrowserUseIabCdpNoTargetRetry() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  const source = fs.readFileSync(mainFile, "utf8");
  const patched = patchBrowserUseIabCdpNoTargetRetrySource(source);
  if (patched === source) {
    log(`已存在 Browser Use IAB CDP No target 重试补丁：${path.basename(mainFile)}`);
    return;
  }
  fs.writeFileSync(mainFile, patched, "utf8");
  log(`已补丁 Browser Use IAB CDP No target 重试：${path.basename(mainFile)}`);
}

function replaceLocaleMessage(source, key, value) {
  const pattern = new RegExp(`("${escapeRegExp(key)}":)\`[^\`]*\``);
  if (!pattern.test(source)) {
    log(`跳过中文翻译键（不存在）：${key}`);
    return null;
  }
  return source.replace(pattern, `$1\`${value}\``);
}

function patchWebviewLocales() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const localeFiles = fs.readdirSync(assetsDir)
    .filter((name) => /^zh-(CN|HK|TW)-.*\.js$/.test(name))
    .map((name) => path.join(assetsDir, name));
  const globalReplacements = new Map([
    ["electron.onboarding.login.includedPlans.welcomeV2", ruizhiBuildDateLabel()],
    ["electron.onboarding.welcomeV2.role.subtitle", ruizhiBuildDateLabel()],
    ["electron.onboarding.welcomeV2.role.subtitle.chatgpt", ruizhiBuildDateLabel()]
  ]);
  const allLocaleFiles = fs.readdirSync(assetsDir)
    .filter((name) => /\.js$/.test(name))
    .map((name) => path.join(assetsDir, name))
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return [...globalReplacements.keys()].some((key) =>
        new RegExp(`"${escapeRegExp(key)}":\``).test(source)
      );
    });

  if (localeFiles.length === 0) {
    throw new Error("找不到中文 webview locale bundle");
  }
  if (allLocaleFiles.length === 0) {
    log("跳过补丁点：webview locale 全局替换（key 已变更）");
    // 仍然继续处理 localeFiles 的中文翻译
  }

  for (const localeFile of allLocaleFiles) {
    const changed = writePatchedFileIfChanged(localeFile, (source) => {
      let next = source;
      for (const [key, value] of globalReplacements) {
        const r = replaceLocaleMessage(next, key, value);
        if (r !== null) next = r;
      }
      return next;
    });
    if (changed) log(`已补丁通用翻译：${path.basename(localeFile)}`);
  }

  const replacements = new Map([
    ["electron.onboarding.login.chatgpt.continue", "使用锐捷继续"],
    ["electron.onboarding.login.chatgpt.signIn", "使用锐捷继续"],
    ["electron.onboarding.login.chatgpt.signIn.streamlined", "使用锐捷继续"],
    ["electron.onboarding.welcomeV2.continue", "使用锐捷继续"]
  ]);

  for (const localeFile of localeFiles) {
    const changed = writePatchedFileIfChanged(localeFile, (source) => {
      let next = source;
      for (const [key, value] of replacements) {
        const r = replaceLocaleMessage(next, key, value);
        if (r !== null) next = r;
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
  packageJson.productName = config.productName;
  packageJson.version = appVersion;
  packageJson.description = "锐捷桌面端";
  fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  log("已补丁 package 元数据");
}

function patchWebviewHtml() {
  const htmlPath = path.join(extractedDir, "webview", "index.html");
  writePatchedFile(htmlPath, (source) =>
    replaceExact(source, "<title>Codex</title>", `<title>${config.productName}</title>`, "窗口标题")
  );
  log("已补丁 webview HTML 标题");
}

function patchDefaultLocale() {
  const assetsDir = path.join(extractedDir, "webview", "assets");
  const resolverFiles = fs.readdirSync(assetsDir).filter((name) => /^locale-resolver-.*\.js$/.test(name));
  if (resolverFiles.length === 0) {
    log("跳过补丁点：locale-resolver（模块已变更）");
    return;
  }
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
  writePatchedFileIfChanged(mainFile, (source) =>
    replaceExactIfPresent(
      source,
      "d=t.C.shouldIncludeSparkle(a,process.platform,process.env),f=t.C.shouldIncludeUpdater(a,process.platform,process.env)",
      "d=!1,f=!1",
      "禁用 Codex 官方 Sparkle/updater 能力"
    )
  );
  log(`已禁用 Codex 官方更新逻辑：${path.basename(mainFile)}`);
}

function applicationMenuPatchSource() {
  return `function ruizhiTranslateApplicationMenu(e){const t=new Map(Object.entries({"File":"文件","Edit":"编辑","View":"视图","Window":"窗口","Help":"帮助","Settings":"设置","Settings…":"设置…","Preferences":"偏好设置","Account":"账户","Log Out":"退出登录","Quit":"退出","About":"关于","Services":"服务","Hide":"隐藏","Hide Others":"隐藏其他","Show All":"全部显示","New Chat":"新聊天","Quick Chat":"快速对话","New Window":"新窗口","Open Folder…":"打开文件夹…","Close":"关闭","Reload Window":"重新加载窗口","Toggle Sidebar":"切换侧边栏","Toggle Terminal":"切换终端","Toggle File Tree":"切换文件树","Open Browser Tab":"打开浏览器标签页","Toggle Browser Panel":"切换浏览器面板","Toggle Side Panel":"切换侧边面板","Find":"查找","Previous Chat":"上一个对话","Next Chat":"下一个对话","Back":"后退","Forward":"前进","Zoom In":"放大","Zoom Out":"缩小","Actual Size":"实际大小","Toggle Full Screen":"切换全屏","Codex Documentation":"帮助首页","What's new":"更新内容","Automations":"自动化","Usage":"使用情况","Library":"资料库","Pull Request":"拉取请求","Pull Requests":"拉取请求","Local Environments":"本地环境","Worktrees":"工作树","Skills":"技能","Model Context Protocol":"MCP","Troubleshooting":"故障排查","Send Feedback":"发送反馈","Keyboard Shortcuts":"键盘快捷键"}));function r(e){let r=String(e||"").replace(/&/g,"").replace(/\\.\\.\\.$/,"…").trim();if(t.has(r))return t.get(r);let n=r.replace(/…$/,"").trim();if(t.has(n))return t.get(n);if(r.startsWith("About "))return r.replace(/^About /,"关于 ");if(r.startsWith("Hide "))return r.replace(/^Hide /,"隐藏 ");if(r.startsWith("Quit "))return r.replace(/^Quit /,"退出 ");return e}function i(e){if(!e)return;if(typeof e.label==="string"&&e.label.length>0)e.label=r(e.label);let t=e.submenu?.items;if(Array.isArray(t))for(const e of t)i(e)}if(Array.isArray(e?.items))for(const t of e.items)i(t);return e}function ruizhiEnsureNativeMenuItems({menu:e,MenuItem:t,ensureWindow:n,navigate:r,settingsRoute:i,shell:j}){let a=o=>String(o?.label||"").replace(/&/g,"").replace(/\\.\\.\\.$/,"…").trim(),o=[];function s(e){if(!e)return;let t=e.items??e.submenu?.items;if(!Array.isArray(t))return;for(const e of t)o.push(e),s(e.submenu)}s(e);let c=e=>{if(e){e.visible=!0;e.enabled=!0}},v=e=>{if(e){e.visible=!1;e.enabled=!1}},l=e=>{let t=o.find(t=>e.test(a(t)));return t&&c(t),t},u=l(/^(Settings|设置|Preferences|偏好设置)/),d=async()=>{try{let e=await n();if(!e)return;try{await r(e,i)}catch(t){console.error(\`锐捷设置菜单跳转失败\`,t);await r(e,\`/settings/general-settings\`)}}catch(e){console.error(\`锐捷设置菜单打开失败\`,e)}},f=e?.items?.[0]?.submenu,A=async()=>{try{await j?.openExternal?.(\`https://gptauth.ruijie.com.cn/\`)}catch(e){console.error(\`锐捷账户菜单跳转失败\`,e)}},B=async()=>{try{let e=await n();e&&await r(e,\`/settings/usage\`)}catch(e){console.error(\`锐捷使用情况菜单打开失败\`,e)}};function q(){for(const e of o)if(/^(Library|Libraries|资料库|Pull Request|Pull Requests|拉取请求)$/.test(a(e)))v(e)}if(u)u.click=d;else if(f?.insert){let e=new t({label:\`设置…\`,accelerator:\`CmdOrCtrl+,\`,click:d});f.insert(Math.min(2,f.items.length),e)}let U=l(/^(Usage|使用情况)$/);if(U)U.click=B;else if(f?.insert){let e=new t({label:\`使用情况\`,click:B});f.insert(Math.min(3,f.items.length),e)}let p=l(/^(Automations|自动化)$/),m=async()=>{let e=await n();e&&r(e,\`/automations\`)};if(p)p.click=m;else{let n=e?.items?.find(e=>/^(Help|帮助)$/.test(a(e)))?.submenu??f;if(n?.insert){let e=new t({label:\`自动化\`,click:m});n.insert(Math.min(2,n.items.length),e)}}let g=l(/^(Account|账户)$/);g&&(g.click=A);q()}`;
}

function patchApplicationMenu() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const mainFile = findOneFile(buildDir, /^main-.*\.js$/, "Electron main bundle");
  writePatchedFileIfChanged(mainFile, (source) => {
    let next = source;
    if (!next.includes("function ruizhiTranslateApplicationMenu(")) {
      next = replaceRegex(
        next,
        /function ([A-Za-z_$][\w$]*)\(\{buildFlavor:/,
        `${applicationMenuPatchSource().replaceAll("https://gptauth.ruijie.com.cn/", `${buildChatGptLoginBaseUrl}/`)}function $1({buildFlavor:`,
        "注入 macOS 顶部菜单修复函数"
      );
    } else {
      const helperStart = next.indexOf("function ruizhiTranslateApplicationMenu(");
      const afterHelper = next.slice(helperStart + 1);
      const helperEndMatch = afterHelper.match(/function [A-Za-z_$][\w$]*\(\{buildFlavor:/);
      if (!helperEndMatch) {
        throw new Error("补丁点不存在：刷新 macOS 顶部菜单修复函数");
      }
      const helperEnd = helperStart + 1 + helperEndMatch.index;
      const helperSource = next.slice(helperStart, helperEnd);
      if (!helperSource.includes("/settings/usage") || !helperSource.includes('"Usage":"使用情况"')) {
        next = `${next.slice(0, helperStart)}${applicationMenuPatchSource().replaceAll("https://gptauth.ruijie.com.cn/", `${buildChatGptLoginBaseUrl}/`)}${next.slice(helperEnd)}`;
      }
    }

    const settingsMenuMatch = next.match(/\{\.\.\.[A-Za-z_$][\w$]*\(`settings`\),click:async\(\)=>\{let e=await ([A-Za-z_$][\w$]*)\(\);e&&([A-Za-z_$][\w$]*)\(e,([A-Za-z_$][\w$]*)\)\}\}/);
    if (!settingsMenuMatch) {
      throw new Error("补丁点不存在：捕获 macOS 设置菜单导航变量");
    }
    const [, ensureWindowName, navigateName, settingsRouteName] = settingsMenuMatch;
    const setApplicationMenuMatch = next.match(/([A-Za-z_$][\w$]*)\.Menu\.setApplicationMenu\(([A-Za-z_$][\w$]*)\),([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)/);
    if (!setApplicationMenuMatch) {
      throw new Error("补丁点不存在：挂载 macOS 顶部菜单修复");
    }
    const [, electronName, menuName, afterSetApplicationMenuName, afterSetApplicationMenuArg] = setApplicationMenuMatch;

    next = next.replace(
      new RegExp(`\\{label:\\\`Automations\\\`,click:\\(\\)=>\\{${escapeRegExp(electronName)}\\.shell\\.openExternal\\(\\\`[^\\\`]+\\\`\\)\\}\\}`),
      `{label:\`Automations\`,click:async()=>{let e=await ${ensureWindowName}();e&&${navigateName}(e,\`/automations\`)}}`
    );
    if (!next.includes(`ruizhiEnsureNativeMenuItems({menu:${menuName}`)) {
      next = next.replace(
        setApplicationMenuMatch[0],
        `try{ruizhiEnsureNativeMenuItems({menu:${menuName},MenuItem:${electronName}.MenuItem,ensureWindow:${ensureWindowName},navigate:${navigateName},settingsRoute:${settingsRouteName},shell:${electronName}.shell});ruizhiTranslateApplicationMenu(${menuName})}catch(e){console.error(\`锐捷菜单修复失败\`,e)}${electronName}.Menu.setApplicationMenu(${menuName}),${afterSetApplicationMenuName}(${afterSetApplicationMenuArg})`
      );
    }
    return next;
  });
  log(`已补丁 macOS 顶部菜单：${path.basename(mainFile)}`);
}

function bootstrapInitCode(electronName) {
  const posixLocale = config.locale.replace("-", "_");
  const imageGenHelper = imageGenHelperName();
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
function ruizhiInit(){
  try{
    const fs=require("node:fs");
    const os=require("node:os");
    const path=require("node:path");
    const productName=${jsonLiteral(config.productName)};
    const electronUserDataDirName=${jsonLiteral(electronUserDataDirName)};
    const locale=${jsonLiteral(config.locale)};
    const posixLocale=${jsonLiteral(posixLocale)};
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
    const imageGenSkillPath=["skills",".system","imagegen","SKILL.md"];
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
    try{${electronName}.app.commandLine.appendSwitch("user-data-dir",userData)}catch{}
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
    process.env.LANG=${jsonLiteral(`${posixLocale}.UTF-8`)};
    process.env.LANGUAGE=posixLocale;
    process.env.LC_ALL=${jsonLiteral(`${posixLocale}.UTF-8`)};
    try{${electronName}.app.commandLine.appendSwitch("lang",locale)}catch{}

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
      if(!modelCatalogEnabled){
        return;
      }
      const target=path.join(codexHome,userModelCatalogFile);
      syncBundledModelCatalogCache();
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
    function syncImageGenSkill(){
      copyIfChanged(path.join(resourcesRoot,...imageGenSkillPath),path.join(codexHome,...imageGenSkillPath));
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
    syncImageGenSkill();
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
          if(spec.alwaysCopy||sourceVersion!==targetVersion){
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
        if(key==="api_key"||key==="chat_model_prefixes"){
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
      if(!fs.existsSync(configPath))return;
      const existing=fs.readFileSync(configPath,"utf8");
      const withLoginBase=insertTopLevelTomlKeyIfMissing(existing,"chatgpt_login_base_url",ruijieChatGptLoginBaseUrl);
      const next=patchRuijieProviderConfig(withLoginBase);
      if(next!==existing)fs.writeFileSync(configPath,next,"utf8");
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
        "enabled = true",
        ""
      ].join("\\n");
    }
    function ensureManagedMarketplacePluginEnabled(source,tableName,block){
      const header="["+tableName+"]";
      const lines=tomlLines(source);
      const table=findTomlTable(lines,header);
      if(!table)return upsertTomlTable(source,tableName,block);
      let found=false;
      for(let index=table.start+1;index<table.end;index++){
        if(tomlKey(lines[index])!=="enabled")continue;
        found=true;
        if(!/^enabled\s*=\s*true\s*$/i.test(String(lines[index]).trim())){
          lines[index]="enabled = true";
        }
        break;
      }
      if(!found)lines.splice(table.end,0,"enabled = true");
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
            const updated=ensureManagedMarketplacePluginEnabled(next,tableName,managedMarketplacePluginConfigBlock(spec.name,plugin.name));
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

function bootstrapForceUpdateCode(electronName) {
  const updateConfig = {
    enabled: macosUpdatesEnabled(),
    feedUrl: macosUpdateDownloadBaseUrl(),
    currentVersion: appVersion
  };
  const enhanceConfig = pageEnhanceBootstrapConfig();

  return `
async function ruizhiForceUpdateIfAvailable(){
  ruizhiStartBackgroundUpdateCheck();
}
function ruizhiStartBackgroundUpdateCheck(){
  const updateConfig=${jsonLiteral(updateConfig)};
  const pageEnhanceConfig=${jsonLiteral(enhanceConfig)};
  if(process.platform!=="darwin"||!${electronName}.app.isPackaged)return;
  const fs=require("node:fs");
  const os=require("node:os");
  const path=require("node:path");
  let autoUpdater=null;
  let updateReady=false;
  let updateState={
    status:"idle",
    currentVersion:updateConfig.currentVersion||${electronName}.app.getVersion(),
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
    for(const win of ${electronName}.BrowserWindow.getAllWindows()){
      if(!win.isDestroyed())win.webContents.send("ruizhi:update:state-changed",snapshot);
    }
  }
  function setUpdateState(patch,force=false){
    updateState={...updateState,...patch};
    broadcastUpdateState(force);
  }
  function notifyUpdateReady(version){
    try{
      if(${electronName}.Notification?.isSupported?.()){
        new ${electronName}.Notification({title:"锐捷更新已就绪",body:"新版本 "+String(version||"")+" 已下载，退出锐捷后将自动安装。"}).show();
      }
    }catch(error){
      console.error("ruizhi update notification failed",error);
    }
  }
  function ruizhiEnhanceCodexHome(){
    const home=os.homedir();
    const explicit=(process.env[${jsonLiteral(ruizhiHomeEnvName)}]||"").trim();
    return explicit||path.join(home,${jsonLiteral(ruizhiDefaultHomeDirName)});
  }
  function authHome(){
    return ruizhiEnhanceCodexHome();
  }
  function authPath(){
    return path.join(authHome(),"auth.json");
  }
  function ruizhiConfigPath(){
    return path.join(ruizhiEnhanceCodexHome(),"config.toml");
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
      const key=String(auth?.OPENAI_API_KEY||"").trim();
      const authMode=auth&&typeof auth.auth_mode==="string"?auth.auth_mode:null;
      const authConfigured=authMode!=null||key.length>0;
      const configuredBy=authMode?"auth-json:"+authMode:key.length>0?"api-key":existingConfig?"ruizhi-config":"none";
      return {configured:authConfigured||existingConfig,masked:maskApiKey(key),configuredBy,authMode,version:${electronName}.app.getVersion()};
    }catch(error){
      return {configured:existingConfig,masked:"",configuredBy:existingConfig?"ruizhi-config":"none",error:String(error?.message||error),version:${electronName}.app.getVersion()};
    }
  }
  function registerRuizhiAuthIpc(){
    ${electronName}.ipcMain.on("ruizhi:auth:get-sync",event=>{event.returnValue=readApiKeyStatus();});
    ${electronName}.ipcMain.handle("ruizhi:auth:get",()=>readApiKeyStatus());
  }
  function registerRuizhiEnhanceIpc(){
    if(global.__RUIZHI_ENHANCE_IPC_REGISTERED__)return;
    global.__RUIZHI_ENHANCE_IPC_REGISTERED__=true;
    try{
      const resourcesRoot=process.resourcesPath||path.dirname(process.execPath);
      const servicePath=path.join(resourcesRoot,...pageEnhanceConfig.serviceResourcePath);
      if(!fs.existsSync(servicePath))throw new Error("页面增强服务脚本不存在："+servicePath);
      const service=require(servicePath).createRuizhiEnhanceService({
        codexHome:ruizhiEnhanceCodexHome(),
        resourcesRoot,
        platformBaseUrl:process.env.RUIZHI_PLATFORM_BASE_URL,
        config:{pageEnhance:pageEnhanceConfig}
      });
      ${electronName}.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>service.call(route,payload||{}));
    }catch(error){
      console.error("ruizhi enhance ipc register failed",error);
      ${electronName}.ipcMain.handle("ruizhi:enhance:call",async(_event,route,payload)=>({
        status:"failed",
        session_id:String(payload?.session_id||""),
        message:String(error?.message||error)
      }));
    }
  }
  function registerRuizhiIpc(){
    ${electronName}.ipcMain.handle("ruizhi:update:get-state",()=>publicUpdateState());
    ${electronName}.ipcMain.handle("ruizhi:update:install-now",()=>{
      if(!autoUpdater||!updateReady)return {ok:false,error:"没有已下载的更新包"};
      setUpdateState({status:"installing",message:"正在重启并安装更新"},true);
      setImmediate(()=>autoUpdater.quitAndInstall());
      return {ok:true};
    });
    registerRuizhiAuthIpc();
    registerRuizhiEnhanceIpc();
  }
  function configureUpdater(){
    if(!updateConfig.enabled)return false;
    if(!updateConfig.feedUrl){
      setUpdateState({status:"error",message:"缺少 macOS 更新下载地址"},true);
      return false;
    }
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
    autoUpdater.setFeedURL({provider:"generic",url:updateConfig.feedUrl});
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
      const version=String(info?.version||updateState.version||"");
      setUpdateState({status:"ready",version,progress:100,message:"更新已下载"},true);
      notifyUpdateReady(version);
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
    const updaterReady=configureUpdater();
    ${electronName}.app.whenReady().then(()=>{
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
      get:()=>ipcRenderer.invoke("ruizhi:auth:get")
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
      "注入锐捷 macOS preload bridge"
    )
  );
  log("已补丁 preload 锐捷 bridge");
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

function copyUpdaterRuntimeDependencies() {
  const targetNodeModules = path.join(extractedDir, "node_modules");
  fs.mkdirSync(targetNodeModules, { recursive: true });
  copyRuntimeNodePackage("electron-updater", targetNodeModules);
  log("已内置 electron-updater 运行时依赖");
}

function patchAppProtocolAsarFileLoading() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const candidates = fs.readdirSync(buildDir)
    .filter((name) => /\.js$/.test(name))
    .map((name) => path.join(buildDir, name))
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes("protocol.handle(`app`") && source.includes("pathToFileURL");
    });

  if (candidates.length === 0) {
    throw new Error("找不到 app:// 协议处理 bundle");
  }

  let patched = 0;
  for (const filePath of candidates) {
    writePatchedFileIfChanged(filePath, (source) => {
      const pattern = /return ([A-Za-z_$][\w$]*)\?([A-Za-z_$][\w$]*)\(\1\)\?([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),\1\):process\.platform===`win32`\?([A-Za-z_$][\w$]*)\.net\.fetch\(\(0,([A-Za-z_$][\w$]*)\.pathToFileURL\)\(\1\)\.toString\(\)\):([A-Za-z_$][\w$]*)\(\1\):new Response\(null,\{status:404,statusText:`Not Found`\}\)/;
      if (!pattern.test(source)) {
        return source;
      }
      patched += 1;
      return source.replace(
        pattern,
        "return $1?$2($1)?$3($4,$1):$5.net.fetch((0,$6.pathToFileURL)($1).toString()):new Response(null,{status:404,statusText:`Not Found`})"
      );
    });
  }

  if (patched === 0) {
    throw new Error("补丁点不存在：app:// 协议普通文件加载切换为 net.fetch");
  }
  log(`已补丁 app:// asar 文件加载：${patched} 个文件`);
}

function patchBootstrap() {
  const buildDir = path.join(extractedDir, ".vite", "build");
  const bootstrapCandidates = fs.readdirSync(buildDir)
    .filter(name => /^bootstrap.*\.js$/.test(name) && name !== "early-bootstrap.js");
  if (bootstrapCandidates.length === 0) {
    throw new Error("找不到 bootstrap 入口文件（新版 Codex.app 可能再次重命名）");
  }
  const bootstrapPath = path.join(buildDir, bootstrapCandidates[0]);

  writePatchedFile(bootstrapPath, (source) => {
    let next = source;
    const bootstrapFailureHandlerPattern = /var ([A-Za-z_$][\w$]*)=\{"install-update":`Install Update`,"check-for-updates":`Check for Updates`,quit:`Quit`\};async function ([A-Za-z_$][\w$]*)\(e\)\{[\s\S]*?message:`\$\{([A-Za-z_$][\w$]*)\.app\.getName\(\)\} failed to start\.`[\s\S]*?\}\}var ([A-Za-z_$][\w$]*)=/;
    const bootstrapFailureHandlerMatch = next.match(bootstrapFailureHandlerPattern);
    if (!bootstrapFailureHandlerMatch) {
      throw new Error("补丁点不存在：移除 Codex 官方更新失败入口并注入锐捷启动逻辑");
    }
    const [, labelsName, failureHandlerName, electronName, nextVarName] = bootstrapFailureHandlerMatch;
    next = next.replace(
      bootstrapFailureHandlerPattern,
      `${bootstrapInitCode(electronName)}${bootstrapForceUpdateCode(electronName)}var ${labelsName}={quit:\`Quit\`};async function ${failureHandlerName}(e){await ${electronName}.dialog.showMessageBox({type:\`error\`,buttons:[${labelsName}.quit],defaultId:0,cancelId:0,message:${electronName}.app.getName()+\` failed to start.\`,detail:e instanceof Error?e.message:\`The main desktop app failed during startup.\`,noLink:!0});${electronName}.app.quit();return}var ${nextVarName}=`
    );
    const updaterInitializePattern = /await [A-Za-z_$][\w$]*\.initialize\(\);try\{let\{runMainAppStartup:/;
    next = replaceRegex(
      next,
      updaterInitializePattern,
      "await ruizhiForceUpdateIfAvailable();try{let{runMainAppStartup:",
      "禁用 Codex 官方 updater 初始化，改为锐捷启动逻辑"
    );
    const setNameBeforeUserDataPattern = new RegExp(
      `${escapeRegExp(electronName)}\\.app\\.setName\\([\\s\\S]*?\\)\\s*,\\s*${escapeRegExp(electronName)}\\.app\\.setPath\\(\\s*\`userData\``
    );
    next = replaceRegex(
      next,
      setNameBeforeUserDataPattern,
      `${electronName}.app.setName(${jsonLiteral(config.productName)}),${electronName}.app.setPath(\`userData\``,
      "应用名称和 userData 单实例隔离"
    );
    const singleInstanceExitPattern = new RegExp(
      `if\\s*\\(!\\s*\\(!\\s*[A-Za-z_$][\\w$]*\\s*\\|\\|\\s*${escapeRegExp(electronName)}\\.app\\.requestSingleInstanceLock\\(\\)\\s*\\)\\s*\\)`
    );
    next = replaceRegex(
      next,
      singleInstanceExitPattern,
      "if(false)",
      "允许锐捷与 ChatGPT/Codex 并行启动"
    );
    next = replaceAllIfPresent(next, "process.platform===`win32`&&n.app.setAppUserModelId(t.v(x))", "process.platform===`win32`&&n.app.setAppUserModelId(`cn.ruizhi.desktop`)");
    return next;
  });

  log("已补丁 Electron bootstrap 初始化");
}

async function repackAppAsar() {
  const resourcesDir = appResourcesDir();
  const appAsarPath = path.join(resourcesDir, "app.asar");
  const patchedAsarPath = path.join(workRoot, "app.patched.asar");

  fs.rmSync(extractedDir, { recursive: true, force: true });
  log("解包 app.asar");
  asar.extractAll(appAsarPath, extractedDir);

  patchPluginAccountGate();
  patchNativeWebviewFeatureGates();
  patchNativeStatsigNetwork();
  patchNativeStatsigBootstrap();
  patchNativeCesAnalyticsNetwork();
  patchNativeProfileVisibility();
  patchNativeUsageSettingsVisibility();
  patchNativeKeymapBindingsFallback();
  if (process.env.RUIZHI_SKIP_PROFILE_DROPDOWN_USAGE === "1") {
    log("已跳过 Codex 头像菜单使用情况入口补丁（RUIZHI_SKIP_PROFILE_DROPDOWN_USAGE=1）");
  } else {
    patchNativeProfileDropdownUsageVisibility();
  }
  patchNativeProfileUsageFallback();
  patchNativePlatformUsageFallback();
  patchNativeWalletUsagePresentation();
  patchNativeExternalLinkHrefFallback();
  patchNativeProfileDropdownUsageUpsell();
  patchDesktopAuthAllowedUrls(extractedDir, buildChatGptLoginBaseUrl, { log });
  patchNativeProfileApiCallLogging();
  try {
    patchPluginSkillLocalListFallback(extractedDir, { log });
  } catch (error) {
    log(`已跳过插件/技能本地列表兜底补丁：${error.message}`);
  }
  patchNativeBrowserDesktopFeatureAvailability();
  patchChatGptAuthExternalBrowser();
  try {
    patchBrowserNativePipeDiagnostics();
  } catch (error) {
    log(`已跳过 Browser nativePipe 诊断日志补丁：${error.message}`);
  }
  patchBrowserNativePipePeerAuthorization();
  patchBrowserUseIabOpenStability(extractedDir, { log });
  try {
    patchTrustedBrowserClientHashes();
  } catch (error) {
    log(`已跳过 Browser client nativePipe 信任哈希补丁：${error.message}`);
  }
  patchBrowserUseIabCdpNoTargetRetry();
  patchWebviewLocales();
  patchPackageMetadata();
  patchWebviewHtml();
  patchDefaultLocale();
  patchFrontendDefaultMessages();
  patchAppSunsetGate();
  patchModelAvailabilityAllowlist();
  patchListModelsForHostFromUserCache();
  patchOfficialUpdateLogic();
  patchApplicationMenu();
  patchAccountSettingsLinks();
  patchHelpDocumentationLinks();
  copyUpdaterRuntimeDependencies();
  patchAppProtocolAsarFileLoading();
  patchBootstrap();
  patchPreloadIntegration();

  fs.rmSync(patchedAsarPath, { force: true });
  log("重新打包 app.asar");
  await asar.createPackage(extractedDir, patchedAsarPath);
  fs.copyFileSync(patchedAsarPath, appAsarPath);
}

function findMainExecutable() {
  const macosDir = path.join(appOutRoot, "Contents", "MacOS");
  const plist = path.join(appOutRoot, "Contents", "Info.plist");
  const executableName = execOutput("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]).trim();
  const plistExecutablePath = path.join(macosDir, executableName);
  const wrappedExecutablePath = `${plistExecutablePath}.bin`;
  if (fs.existsSync(plistExecutablePath)) {
    return fs.existsSync(wrappedExecutablePath) ? wrappedExecutablePath : plistExecutablePath;
  }
  const executables = fs.readdirSync(macosDir)
    .map((name) => path.join(macosDir, name))
    .filter((candidate) => fs.statSync(candidate).isFile());
  if (executables.length === 0) {
    throw new Error(`找不到 macOS 主程序：${macosDir}`);
  }
  return executables[0];
}

function findElectronFrameworkExecutable() {
  const frameworksDir = path.join(appOutRoot, "Contents", "Frameworks");
  const candidates = fs.readdirSync(frameworksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && / Framework\.framework$/.test(entry.name))
    .map((entry) => {
      const frameworkName = entry.name.replace(/\.framework$/, "");
      return path.join(frameworksDir, entry.name, frameworkName);
    })
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());

  if (candidates.length !== 1) {
    throw new Error(`Electron framework binary 匹配数量异常：${candidates.length}`);
  }
  return candidates[0];
}

async function patchFuses() {
  const executable = findMainExecutable();
  const frameworkExecutable = findElectronFrameworkExecutable();
  const temporaryFuseExecutable = path.join(workRoot, "fuses", path.basename(frameworkExecutable));
  fs.chmodSync(executable, 0o755);
  fs.chmodSync(frameworkExecutable, 0o755);
  fs.mkdirSync(path.dirname(temporaryFuseExecutable), { recursive: true });
  fs.copyFileSync(frameworkExecutable, temporaryFuseExecutable);
  fs.chmodSync(temporaryFuseExecutable, 0o755);

  log("关闭 app.asar 完整性校验 fuse");
  await flipFuses(temporaryFuseExecutable, {
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
  fs.copyFileSync(temporaryFuseExecutable, frameworkExecutable);
}

function patchInfoPlist() {
  const plist = path.join(appOutRoot, "Contents", "Info.plist");
  // Electron derives the macOS helper app names from CFBundleName.
  // Keep this aligned with Codex Helper.app while branding via CFBundleDisplayName.
  execLogged("plutil", ["-replace", "CFBundleName", "-string", "Codex", plist]);
  execLogged("plutil", ["-replace", "CFBundleDisplayName", "-string", config.productName, plist]);
  execLogged("plutil", ["-replace", "CFBundleIdentifier", "-string", "cn.ruizhi.desktop", plist]);
  execLogged("plutil", ["-replace", "CFBundleShortVersionString", "-string", appVersion, plist]);
  execLogged("plutil", ["-replace", "CFBundleVersion", "-string", appVersion, plist]);
  log("已补丁 Info.plist 元数据");
}

function assertAppBinaryArchMatchesHost() {
  const executablePath = findMainExecutable();
  const archs = execOutput("lipo", ["-archs", executablePath]).trim().split(/\s+/);
  assertMacosBuildArch(archs);
  log(`已确认 macOS app 主程序包含目标架构 ${macosBuildArch}：${archs.join(", ")}`);
  return archs;
}

function wrapMacosExecutableWithRuizhiUserData() {
  const plist = path.join(appOutRoot, "Contents", "Info.plist");
  const executableName = execOutput("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", plist]).trim();
  const macosDir = path.join(appOutRoot, "Contents", "MacOS");
  const executablePath = path.join(macosDir, executableName);
  const wrappedExecutableName = `${executableName}.bin`;
  const wrappedExecutablePath = path.join(macosDir, wrappedExecutableName);
  if (!fs.existsSync(wrappedExecutablePath)) {
    fs.renameSync(executablePath, wrappedExecutablePath);
  }
  const wrapper = `#!/bin/sh
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
USER_DATA_DIR="\${CODEX_ELECTRON_USER_DATA_PATH:-$HOME/Library/Application Support/${electronUserDataDirName}}"
HAS_USER_DATA_DIR=0
for ARG in "$@"; do
  case "$ARG" in
    --user-data-dir|--user-data-dir=*) HAS_USER_DATA_DIR=1 ;;
  esac
done
if [ "$HAS_USER_DATA_DIR" = "1" ]; then
  exec "$APP_DIR/${wrappedExecutableName}" "$@"
else
  exec "$APP_DIR/${wrappedExecutableName}" --user-data-dir="$USER_DATA_DIR" "$@"
fi
`;
  fs.writeFileSync(executablePath, wrapper, { mode: 0o755 });
  fs.chmodSync(executablePath, 0o755);
  log(`已包装 macOS 主程序以隔离原生 user-data-dir：${executableName} -> ${wrappedExecutableName}`);
}

function copyPluginMarketplaces() {
  const resourcesDir = appResourcesDir();

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

function copyRuntimeOverrides(codexClientVersion) {
  const resourcesDir = appResourcesDir();

  const modelTargetDir = path.join(resourcesDir, "models");
  if (modelCatalogEnabled()) {
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

  if (modelBridgeEnabled()) {
    const bridgeTargetPath = path.join(resourcesDir, modelBridgeRuntimeResourcePath());
    fs.mkdirSync(path.dirname(bridgeTargetPath), { recursive: true });
    fs.copyFileSync(modelBridgeRuntimeSourcePath(), bridgeTargetPath);
    log(`已内置模型协议 bridge：${path.relative(projectRoot, bridgeTargetPath)}`);
  }

  for (const { fileName, sourcePath } of pageEnhanceRendererSources) {
    const enhanceRendererTarget = path.join(resourcesDir, "renderer", fileName);
    fs.mkdirSync(path.dirname(enhanceRendererTarget), { recursive: true });
    fs.copyFileSync(sourcePath, enhanceRendererTarget);
  }

  const enhanceServiceTarget = path.join(resourcesDir, "bridge", "ruizhi-enhance-service.cjs");
  fs.mkdirSync(path.dirname(enhanceServiceTarget), { recursive: true });
  fs.copyFileSync(pageEnhanceServiceSourcePath(), enhanceServiceTarget);
  log("已内置页面增强 renderer 与 bridge 服务");

  const skillTargetDir = path.join(resourcesDir, "skills", ".system", "imagegen");
  fs.mkdirSync(skillTargetDir, { recursive: true });
  fs.copyFileSync(imageGenSkillSourcePath(), path.join(skillTargetDir, "SKILL.md"));
  log("已内置运行态 imagegen skill 覆盖");
}

function writeAppUpdateConfig() {
  const appUpdatePath = path.join(appResourcesDir(), "app-update.yml");
  if (!macosUpdatesEnabled()) {
    fs.rmSync(appUpdatePath, { force: true });
    log("macOS 更新已禁用，已移除 app-update.yml");
    return;
  }

  const publishUrl = macosUpdateDownloadBaseUrl();
  if (!publishUrl) {
    throw new Error("macOS 自动更新已启用，但缺少 updates.macos.downloadBaseUrl。");
  }

  fs.writeFileSync(
    appUpdatePath,
    `provider: generic\nurl: ${yamlString(publishUrl)}\nupdaterCacheDirName: ruizhi-desktop-updater\n`,
    "utf8"
  );
  log(`已写入 macOS electron-updater 配置：${appUpdatePath}`);
}

function buildImageGenHelper() {
  const outputPath = path.join(appResourcesDir(), "bin", imageGenHelperName());
  fs.rmSync(outputPath, { force: true });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  log("编译锐捷生图工具");
  execLogged("go", [
    "build",
    "-trimpath",
    "-ldflags",
    "-s -w",
    "-o",
    outputPath,
    path.join(projectRoot, "cmd", "ruizhi-imagegen")
  ], {
    env: {
      ...process.env,
      GOOS: "darwin",
      GOARCH: macosGoArch()
    }
  });
  fs.chmodSync(outputPath, 0o755);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha512File(filePath) {
  const hash = createHash("sha512");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

function artifactManifestInfo(filePath, downloadBaseUrl) {
  const fileName = path.basename(filePath);
  return {
    fileName,
    url: joinUrl(downloadBaseUrl, fileName),
    sha256: sha256File(filePath),
    sha512: sha512File(filePath),
    size: fs.statSync(filePath).size
  };
}

function assertMacosBuildArch(appArchs) {
  const hostArch = normalizeMacosBuildArch(process.arch);
  if (hostArch !== macosBuildArch) {
    throw new Error(`当前 macOS 构建机是 ${hostArch}，但目标打包架构是 ${macosBuildArch}。请使用对应原生 runner。`);
  }
  const expectedMachArch = macosMachArch();
  if (!appArchs.includes(expectedMachArch)) {
    throw new Error(`目标架构是 ${expectedMachArch}，但 app 主程序架构是 ${appArchs.join(", ") || "unknown"}。`);
  }
}

function createZip() {
  const updateZipPath = path.join(distDir, macosUpdateArtifactName("app.zip"));
  fs.rmSync(updateZipPath, { force: true });
  log("压缩 macOS 产物");
  execLogged("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appOutRoot, updateZipPath]);
  log(`macOS zip 已输出：${updateZipPath}`);
  return updateZipPath;
}

function signDmg(dmgPath, signingState) {
  if (!signingState.signed || !process.env.MACOS_CODESIGN_IDENTITY?.trim()) {
    return;
  }
  const signArgs = ["--force", "--sign", process.env.MACOS_CODESIGN_IDENTITY, dmgPath];
  if (useTestSigningCertificate()) {
    signArgs.splice(1, 0, "--timestamp=none");
  } else {
    signArgs.splice(1, 0, "--timestamp");
  }
  execLogged("codesign", signArgs);
  execLogged("codesign", ["--verify", "--verbose=2", dmgPath]);
}

function createDmg(signingState) {
  const dmgPath = path.join(distDir, macosDmgArtifactName());
  const volumeName = `${config.productName} ${appVersion}`;

  fs.rmSync(dmgPath, { force: true });
  cleanDir(dmgStagingDir);
  fsExtra.copySync(appOutRoot, path.join(dmgStagingDir, `${config.productName}.app`));
  fs.symlinkSync("/Applications", path.join(dmgStagingDir, "Applications"));

  log("生成 macOS DMG 安装包");
  execLogged("hdiutil", [
    "create",
    "-volname",
    volumeName,
    "-srcfolder",
    dmgStagingDir,
    "-ov",
    "-format",
    "UDZO",
    dmgPath
  ]);
  signDmg(dmgPath, signingState);
  log(`macOS DMG 已输出：${dmgPath}`);
  return dmgPath;
}

function createTestKit(signingState) {
  const kitRoot = path.join(macDistDir, `${config.productName}-macos-test-kit`);
  const kitApp = path.join(kitRoot, `${config.productName}.app`);
  const commandPath = path.join(kitRoot, `打开${config.productName}.command`);
  const installScriptPath = path.join(kitRoot, "install.sh");
  const installCommandPath = path.join(kitRoot, `安装${config.productName}.command`);
  const readmePath = path.join(kitRoot, "README-先看这里.txt");
  const kitZipPath = path.join(distDir, `${config.productName}-macos-test-kit-${appVersion}.zip`);
  const shouldRepairAdHocSignature = !signingState.signed;

  fs.rmSync(kitRoot, { recursive: true, force: true });
  fs.mkdirSync(kitRoot, { recursive: true });
  fsExtra.copySync(appOutRoot, kitApp);

  const command = `#!/bin/zsh
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$KIT_DIR"
APP="./${config.productName}.app"
echo "准备打开 ${config.productName}..."
if [[ ! -d "$APP" ]]; then
  echo "找不到 $APP，请确认这个脚本和 ${config.productName}.app 在同一个目录。"
  read -k 1 "?按任意键退出..."
  exit 1
fi
xattr -cr "$KIT_DIR" 2>/dev/null || true
find "$APP/Contents" -path "*/Contents/MacOS/*" -type f -exec chmod +x {} \\; 2>/dev/null || true
if [[ "${shouldRepairAdHocSignature ? "1" : "0"}" == "1" ]]; then
  echo "刷新本机 ad-hoc 签名..."
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict --verbose=2 "$APP"
open "$APP"
echo "已发送启动命令。如果 macOS 仍提示拦截，请右键 ${config.productName}.app，选择打开。"
`;

  const installScript = `#!/bin/zsh
set -euo pipefail
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$KIT_DIR"

APP_NAME="${config.productName}.app"
APP_SOURCE="./$APP_NAME"
SYSTEM_TARGET="/Applications/$APP_NAME"
USER_TARGET="$HOME/Applications/$APP_NAME"

echo "准备安装 ${config.productName}..."
if [[ ! -d "$APP_SOURCE" ]]; then
  echo "找不到 $APP_SOURCE，请确认安装脚本和 ${config.productName}.app 在同一个目录。"
  exit 1
fi

TARGET="$SYSTEM_TARGET"
if [[ ! -w "/Applications" ]]; then
  mkdir -p "$HOME/Applications"
  TARGET="$USER_TARGET"
fi

echo "安装目标：$TARGET"
xattr -cr "$KIT_DIR" 2>/dev/null || true
find "$APP_SOURCE/Contents" -path "*/Contents/MacOS/*" -type f -exec chmod +x {} \\; 2>/dev/null || true
if [[ "${shouldRepairAdHocSignature ? "1" : "0"}" == "1" ]]; then
  echo "刷新本机 ad-hoc 签名..."
  codesign --force --deep --sign - "$APP_SOURCE"
fi
codesign --verify --deep --strict --verbose=2 "$APP_SOURCE"
rm -rf "$TARGET"
ditto "$APP_SOURCE" "$TARGET"
xattr -cr "$TARGET" 2>/dev/null || true
if [[ "${shouldRepairAdHocSignature ? "1" : "0"}" == "1" ]]; then
  codesign --force --deep --sign - "$TARGET"
fi
codesign --verify --deep --strict --verbose=2 "$TARGET"
open "$TARGET"
echo "安装完成，已尝试启动 ${config.productName}。"
`;

  const installCommand = `#!/bin/zsh
set -e
cd "$(dirname "$0")"
"./install.sh"
`;

  const readme = `这是 ${config.productName} macOS 测试包。

没有 Apple Developer ID 和 notarization，所以不能做到普通用户双击完全无拦截。这个包只用于测试能不能在 Mac 上跑。

推荐方式：
1. 解压这个 zip。
2. 命令行安装：在 Terminal 里进入解压目录后执行：

   chmod +x install.sh
   ./install.sh

3. 或者双击“安装${config.productName}.command”。
4. 如果只想原地启动、不安装到 Applications，双击“打开${config.productName}.command”。

备用方式：

   xattr -dr com.apple.quarantine .
   chmod +x "安装${config.productName}.command"
   ./"安装${config.productName}.command"

如果系统提示“应用已损坏”，这通常是 Gatekeeper 对未公证测试包的拦截文案。当前测试包会自动清理扩展属性，并在 ad-hoc 签名包上刷新本机签名。

如果系统 Applications 不可写，安装脚本会自动改装到：

   ~/Applications/${config.productName}.app

这不是正式签名包。正式分发仍然需要 Apple Developer ID 和 notarization。
`;

  fs.writeFileSync(commandPath, command, { mode: 0o755 });
  fs.writeFileSync(installScriptPath, installScript, { mode: 0o755 });
  fs.writeFileSync(installCommandPath, installCommand, { mode: 0o755 });
  fs.writeFileSync(readmePath, readme, "utf8");
  fs.rmSync(kitZipPath, { force: true });
  log("压缩 macOS 测试包");
  execLogged("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", kitRoot, kitZipPath]);
  log(`测试包已输出：${kitZipPath}`);
  return kitZipPath;
}

function hasDeveloperSigningConfig() {
  return Boolean(
    process.env.MACOS_CERTIFICATE_P12_BASE64?.trim() &&
    process.env.MACOS_CERTIFICATE_PASSWORD?.trim() &&
    process.env.MACOS_CODESIGN_IDENTITY?.trim()
  );
}

function useTestSigningCertificate() {
  return process.env.RUIZHI_MACOS_SIGNING_STYLE === "test"
    || process.env.RUIZHI_MACOS_TEST_CERTIFICATE === "1";
}

function hasNotarizationConfig() {
  return Boolean(
    process.env.APP_STORE_CONNECT_KEY_ID?.trim() &&
    process.env.APP_STORE_CONNECT_ISSUER_ID?.trim() &&
    (process.env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64?.trim() || process.env.APP_STORE_CONNECT_PRIVATE_KEY?.trim())
  );
}

function importDeveloperCertificate() {
  const keychainPassword = `ruizhi-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const keychainPath = path.join(workRoot, "ruizhi-signing.keychain-db");
  const certificatePath = path.join(workRoot, "developer-id.p12");
  const trustCertificatePath = path.join(workRoot, "codesign-trust.cer");

  fs.writeFileSync(
    certificatePath,
    Buffer.from(process.env.MACOS_CERTIFICATE_P12_BASE64.trim(), "base64")
  );
  if (useTestSigningCertificate() && process.env.MACOS_CERTIFICATE_CER_BASE64?.trim()) {
    fs.writeFileSync(
      trustCertificatePath,
      Buffer.from(process.env.MACOS_CERTIFICATE_CER_BASE64.trim(), "base64")
    );
  }

  execSensitive("security", ["create-keychain", "-p", keychainPassword, keychainPath], "security create-keychain");
  execLogged("security", ["set-keychain-settings", "-lut", "21600", keychainPath]);
  execSensitive("security", ["unlock-keychain", "-p", keychainPassword, keychainPath], "security unlock-keychain");
  execSensitive("security", [
    "import",
    certificatePath,
    "-k",
    keychainPath,
    "-P",
    process.env.MACOS_CERTIFICATE_PASSWORD,
    "-T",
    "/usr/bin/codesign",
    "-T",
    "/usr/bin/productsign"
  ], "security import Developer ID certificate");
  if (useTestSigningCertificate() && fs.existsSync(trustCertificatePath)) {
    execLogged("security", ["add-trusted-cert", "-r", "trustRoot", "-p", "codeSign", "-k", keychainPath, trustCertificatePath]);
  }
  execSensitive("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:,codesign:",
    "-s",
    "-k",
    keychainPassword,
    keychainPath
  ], "security set-key-partition-list");
  execLogged("security", ["list-keychains", "-d", "user", "-s", keychainPath, "login.keychain-db"]);
  log("已导入 Developer ID 证书到临时 keychain");
}

function verifyCodeSignature() {
  execLogged("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appOutRoot]);
}

function signEmbeddedCodex(identity) {
  const codexPath = path.join(appOutRoot, "Contents", "Resources", "codex");
  const signingDir = path.join(appOutRoot, "Contents", "Resources", ".codex-signing");
  const signingPath = path.join(signingDir, "codex");
  const originalMode = fs.statSync(codexPath).mode;
  fs.rmSync(signingDir, { recursive: true, force: true });
  fs.mkdirSync(signingDir, { recursive: true });
  fs.copyFileSync(codexPath, signingPath);
  fs.chmodSync(signingPath, originalMode);

  const signArgs = ["--force", "--sign", identity];
  if (identity === "-" || useTestSigningCertificate()) {
    signArgs.push("--timestamp=none");
  } else {
    signArgs.push("--options", "runtime", "--timestamp");
  }
  signArgs.push(signingPath);
  try {
    execLogged("codesign", signArgs);
    execLogged("codesign", ["--verify", "--strict", "--verbose=2", signingPath]);
    fs.renameSync(signingPath, codexPath);
  } finally {
    fs.rmSync(signingDir, { recursive: true, force: true });
  }
  execLogged("codesign", ["--verify", "--strict", "--verbose=2", codexPath]);
}

function signApp() {
  execLogged("/usr/bin/xattr", ["-cr", appOutRoot]);

  if (!hasDeveloperSigningConfig()) {
    log("未配置 Developer ID 签名 secrets，使用 ad-hoc 签名");
    signEmbeddedCodex("-");
    execLogged("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appOutRoot]);
    verifyCodeSignature();
    return { signed: false, notarized: false };
  }

  importDeveloperCertificate();
  signEmbeddedCodex(process.env.MACOS_CODESIGN_IDENTITY);
  const signArgs = [
    "--force",
    "--deep",
    "--sign",
    process.env.MACOS_CODESIGN_IDENTITY,
    appOutRoot
  ];
  if (useTestSigningCertificate()) {
    signArgs.splice(2, 0, "--timestamp=none");
  } else {
    signArgs.splice(2, 0, "--options", "runtime", "--timestamp");
  }
  execLogged("codesign", signArgs);
  verifyCodeSignature();
  log(useTestSigningCertificate() ? "已使用测试证书签名 macOS app" : "已使用 Developer ID 签名 macOS app");
  return { signed: true, notarized: false, testSigned: useTestSigningCertificate() };
}

function notaryPrivateKeyContent() {
  if (process.env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64?.trim()) {
    return Buffer.from(process.env.APP_STORE_CONNECT_PRIVATE_KEY_BASE64.trim(), "base64").toString("utf8");
  }
  return process.env.APP_STORE_CONNECT_PRIVATE_KEY.replace(/\\n/g, "\n");
}

function notarizeAndStaple(zipPath) {
  if (!hasNotarizationConfig()) {
    log("未配置 App Store Connect notary secrets，跳过 notarization");
    return false;
  }

  const keyPath = path.join(workRoot, "AuthKey.p8");
  fs.writeFileSync(keyPath, notaryPrivateKeyContent(), { mode: 0o600 });

  execLogged("xcrun", [
    "notarytool",
    "submit",
    zipPath,
    "--key",
    keyPath,
    "--key-id",
    process.env.APP_STORE_CONNECT_KEY_ID,
    "--issuer",
    process.env.APP_STORE_CONNECT_ISSUER_ID,
    "--wait"
  ]);
  execLogged("xcrun", ["stapler", "staple", appOutRoot]);
  execLogged("spctl", ["-a", "-vv", "--type", "execute", appOutRoot]);
  log("已完成 notarization 并 staple 到 app");
  return true;
}

function adHocSignApp() {
  signApp();
  log("已使用 ad-hoc 签名 macOS app");
}

function writeUpdateManifest(zipPath, signingState) {
  preserveExistingMacUpdateManifests();

  const downloadBaseUrl = macosUpdateDownloadBaseUrl();
  const updateArtifact = artifactManifestInfo(zipPath, downloadBaseUrl);
  const manifest = {
    version: appVersion,
    arch: macosBuildArch,
    mandatory: false,
    macos: {
      arch: macosBuildArch,
      ...updateArtifact,
      signed: Boolean(signingState.signed),
      notarized: Boolean(signingState.notarized)
    },
    manualDownload: {
      platform: "macos",
      arch: macosBuildArch,
      kind: "app",
      ...updateArtifact
    }
  };

  fs.writeFileSync(updateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`macOS 更新清单已输出：${updateManifestPath}`);
  fs.writeFileSync(archUpdateManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`macOS 架构更新清单已输出：${archUpdateManifestPath}`);
  fs.writeFileSync(versionedMacUpdateManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
  log(`macOS 版本更新清单已输出：${versionedMacUpdateManifestPath()}`);

  const latestMacYml = [
    `version: ${yamlString(appVersion)}`,
    "files:",
    `  - url: ${yamlString(updateArtifact.fileName)}`,
    `    sha512: ${yamlString(updateArtifact.sha512)}`,
    `    size: ${updateArtifact.size}`,
    `path: ${yamlString(updateArtifact.fileName)}`,
    `sha512: ${yamlString(updateArtifact.sha512)}`,
    `releaseDate: ${yamlString(new Date().toISOString())}`,
    ""
  ].join("\n");
  fs.writeFileSync(latestMacYmlPath, latestMacYml, "utf8");
  log(`macOS electron-updater 清单已输出：${latestMacYmlPath}`);
  fs.writeFileSync(legacyLatestMacYmlPath, latestMacYml, "utf8");
  log(`macOS legacy electron-updater 清单已输出：${legacyLatestMacYmlPath}`);
  fs.writeFileSync(archLatestMacYmlPath, latestMacYml, "utf8");
  log(`macOS 架构 electron-updater 清单已输出：${archLatestMacYmlPath}`);
  fs.writeFileSync(versionedLatestMacYmlPath(), latestMacYml, "utf8");
  log(`macOS 版本 electron-updater 清单已输出：${versionedLatestMacYmlPath()}`);
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

  const cachedTag = execOutputBestEffort("git", [
    "-C",
    codexSourceRoot,
    "tag",
    "-l",
    cliConfig.tag
  ]).trim();
  if (cachedTag === cliConfig.tag) {
    log(`已复用本地 Codex CLI tag：${cliConfig.tag}`);
  } else {
    execLogged("git", [
      "-C",
      codexSourceRoot,
      "fetch",
      "--depth=1",
      "origin",
      `refs/tags/${cliConfig.tag}:refs/tags/${cliConfig.tag}`
    ]);
  }
  execLogged("git", ["-C", codexSourceRoot, "checkout", "--force", cliConfig.tag]);
}

function patchCodexCliSource() {
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
      fs.writeFileSync(providerInfoPath, patched, "utf8");
      log("已补丁内置 OpenAI provider：禁用 Responses WebSocket");
    } else if (!original.includes("supports_websockets: false")) {
      throw new Error("补丁点不存在：OpenAI provider Responses WebSocket");
    }
  }
}

function buildPatchedCodexCli(expectedCodexClientVersion) {
  const cliConfig = codexCliBuildConfig();
  if (process.env.RUIZHI_SKIP_CODEX_CLI_BUILD === "1") {
    log("已跳过 Codex CLI 重编（RUIZHI_SKIP_CODEX_CLI_BUILD=1）");
    return;
  }
  const shouldBuild = process.env.RUIZHI_BUILD_CODEX === "1" || cliConfig?.rebuildByDefault === true;
  if (!shouldBuild) {
    throw new Error("锐捷 OAuth 依赖重编 Codex CLI，不能跳过 RUIZHI_BUILD_CODEX");
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

  const builtCodexPath = path.join(codexRsRoot, "target", "release", "codex");
  const targetCodexPath = path.join(appOutRoot, "Contents", "Resources", "codex");
  if (!fs.existsSync(builtCodexPath)) {
    throw new Error(`没有找到编译后的 Codex CLI：${builtCodexPath}`);
  }
  // Validate the standalone build before copying it into the still-signed app bundle.
  // On macOS, launching a modified nested executable before the bundle is re-signed can
  // block in dyld/Gatekeeper long enough to look like a version-read timeout.
  const builtCodexClientVersion = codexClientVersionFromExe(builtCodexPath);
  if (builtCodexClientVersion !== expectedCodexClientVersion) {
    throw new Error(
      `重编 Codex CLI 版本不匹配：桌面端=${expectedCodexClientVersion}，重编=${builtCodexClientVersion}`
    );
  }
  fs.copyFileSync(builtCodexPath, targetCodexPath);
  fs.chmodSync(targetCodexPath, 0o755);
  log(`已替换 Contents/Resources/codex：OAuth issuer=${buildChatGptLoginBaseUrl}`);
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("build:macos 必须在 macOS 上运行。本地 Windows 不要硬搓 .app，没那个命。");
  }

  fs.mkdirSync(distDir, { recursive: true });
  cleanDir(macDistDir);
  cleanDir(workRoot);

  const sourceAppRoot = findSourceAppRoot();
  const sourceCodexClientVersion = process.env.RUIZHI_CODEX_CLIENT_VERSION?.trim()
    || codexClientVersionFromExe(
      path.join(sourceAppRoot, "Contents", "Resources", "codex"),
    );
  log(`目标 macOS 架构：${macosBuildArch}`);
  log(`使用 Codex.app：${sourceAppRoot}`);

  log("复制 Codex.app");
  execLogged("ditto", ["--norsrc", sourceAppRoot, appOutRoot]);
  execBestEffort("chflags", ["-R", "nouchg,noschg", appOutRoot], "清理 macOS 文件标志");
  execBestEffort("/usr/bin/xattr", ["-cr", appOutRoot], "清理 macOS 扩展属性");

  buildPatchedCodexCli(sourceCodexClientVersion);
  const loginSuccessPatch = patchCodexLoginSuccessBinary(
    path.join(appOutRoot, "Contents", "Resources", "codex"),
    config.loginSuccessPage,
  );
  log(`已补丁 Codex OAuth 成功页：${JSON.stringify(loginSuccessPatch.replacements)}`);
  signEmbeddedCodex("-");

  copyRuntimeOverrides(sourceCodexClientVersion);
  copyPluginMarketplaces();
  writeAppUpdateConfig();
  patchInfoPlist();
  assertAppBinaryArchMatchesHost();
  wrapMacosExecutableWithRuizhiUserData();
  buildImageGenHelper();
  await repackAppAsar();
  await patchFuses();
  const signingState = signApp();
  let zipPath = createZip();
  if (signingState.signed) {
    signingState.notarized = notarizeAndStaple(zipPath);
    if (signingState.notarized) {
      zipPath = createZip();
    }
  }
  createDmg(signingState);
  writeUpdateManifest(zipPath, signingState);

  log("macOS 构建完成");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
