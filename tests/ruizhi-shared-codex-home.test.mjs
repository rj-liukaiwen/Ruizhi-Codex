import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function existingProjectFiles(relativePaths) {
  return relativePaths.filter((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));
}

test("runtime defaults initialize Ruizhi home and isolate Electron user data", () => {
  const config = JSON.parse(readProjectFile("config/rj-codex.json"));
  assert.equal(config.openai.chatGptLoginBaseUrl, "https://gptauth.ruijie.com.cn");
  assert.equal(config.openai.baseUrl, "https://gptauth.ruijie.com.cn/v1");
  assert.equal(config.openai.providerBaseUrl, "https://gptauth.ruijie.com.cn/v1");
  assert.equal(config.runtime.defaultHomeDirName, ".ruizhi");
  assert.equal(config.runtime.electronUserDataDirName, "Ruizhi");
  assert.match(
    readProjectFile("scripts/build-macos.mjs"),
    /CFBundleName", "-string", "Codex"/,
    "macOS CFBundleName must stay Codex so Electron can find Codex Helper.app"
  );
  assert.match(
    readProjectFile("scripts/build-macos.mjs"),
    /CFBundleDisplayName", "-string", config\.productName/,
    "macOS display name should still show the Ruizhi product name"
  );

  const sources = existingProjectFiles([
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js"
  ]);

  for (const sourcePath of sources) {
    const source = readProjectFile(sourcePath);
    assert.match(source, /["`]\.ruizhi["`]/, `${sourcePath} should default RUIZHI_HOME to .ruizhi`);
    assert.match(source, /process\.env\[ruizhiHomeEnvName\]=codexHome|process\.env\[authConfig\.ruizhiHomeEnvName\]/, `${sourcePath} should initialize RUIZHI_HOME`);
    assert.match(source, /process\.env\.CODEX_HOME\s*=\s*codexHome|process\.env\["CODEX_HOME"\]\s*=\s*codexHome/, `${sourcePath} should initialize CODEX_HOME to the Ruizhi runtime home`);
    assert.doesNotMatch(source, /const codexHome=[^;]*process\.env\.CODEX_HOME[^;]*path\.join\(home,ruizhiDefaultHomeDirName\)/, `${sourcePath} should not default Ruizhi home from CODEX_HOME`);
    assert.doesNotMatch(source, /p\.push\(["`]\.ruizhi["`]\)/, `${sourcePath} should not patch CLI default home to .ruizhi`);
    assert.match(source, /electronUserDataDirName/, `${sourcePath} should route Electron userData through the runtime setting`);
  }
});

test("bootstrap auto-registers bundled Ruizhi marketplaces for first launch", () => {
  const config = JSON.parse(readProjectFile("config/rj-codex.json"));

  assert.ok(config.pluginMarketplaces.length > 0, "test expects a bundled Ruizhi marketplace");
  assert.equal(config.pluginMarketplaces[0].name, "ruijie-marketplace");
  assert.equal(config.pluginMarketplaces[0].online.source, "http://gitlab.dokploy.ruijie.com.cn/marketplace/ruijie-marketplace.git");
  assert.equal(config.pluginMarketplaces[0].online.autoUpgrade, false);

  for (const sourcePath of existingProjectFiles([
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js"
  ])) {
    const source = readProjectFile(sourcePath);

    assert.match(source, /function syncManagedMarketplaceConfig\(marketplaceSources\)/, `${sourcePath} should register local marketplaces in config.toml`);
    assert.match(source, /managedMarketplaceSpecs\(\)/, `${sourcePath} should only manage configured custom marketplaces`);
    assert.match(source, /marketplaceSpecs\.filter\(spec=>spec\.hardcodedPlugins!==true&&spec\.alwaysCopy!==true\)/, `${sourcePath} should not rewrite built-in OpenAI marketplaces`);
    assert.match(source, /const configPath=path\.join\(codexHome,"config\.toml"\)/, `${sourcePath} should write marketplace config into the Ruizhi runtime home`);
    assert.doesNotMatch(source, /const configPath=path\.join\(home,"\.codex","config\.toml"\)/, `${sourcePath} should not write marketplace config into the default Codex home`);
    assert.match(source, /fs\.existsSync\(configPath\)\?fs\.readFileSync\(configPath,"utf8"\):""/, `${sourcePath} should handle missing config.toml`);
    assert.match(source, /fs\.mkdirSync\(path\.dirname\(configPath\),\{recursive:true\}\)/, `${sourcePath} should create the config directory`);
    assert.match(source, /"\[marketplaces\."\+spec\.name\+"\]"/, `${sourcePath} should emit marketplace TOML tables`);
    assert.match(source, /tomlString\("local"\)/, `${sourcePath} should register local marketplace sources`);
    assert.match(source, /function marketplaceConfigBlock\(spec,source\)/, `${sourcePath} should register each marketplace once`);
    assert.match(source, /online&&online\.source&&online\.autoUpgrade===true/, `${sourcePath} should only use Git marketplaces when auto-upgrade is enabled`);
    assert.match(source, /tomlString\("git"\)/, `${sourcePath} should emit Git marketplace sources`);
    assert.match(source, /"ref = "\+tomlString\(online\.ref\)/, `${sourcePath} should preserve the configured Git ref`);
    assert.match(source, /"\[marketplaces\."\+spec\.name\+"\]"/, `${sourcePath} should emit [marketplaces.ruijie-marketplace] for the configured Ruizhi marketplace`);
    assert.match(source, /source=marketplaceSources\[spec\.sourceToken\]/, `${sourcePath} should require a synced offline snapshot before registration`);
    assert.match(source, /fs\.existsSync\(path\.join\(source,"\.agents","plugins","marketplace\.json"\)\)/, `${sourcePath} should only register valid synced marketplaces`);
    assert.match(source, /const existing(?:Ruizhi|Codex)Config=fs\.existsSync\(configPath\);[\s\S]{0,240}?const marketplaceSources=syncMarketplaces\(\);/, `${sourcePath} should preserve first-launch detection before creating config.toml`);
    assert.match(source, /syncManagedMarketplaceConfig\(marketplaceSources\);\s*syncManagedMarketplacePluginInstall\(marketplaceSources\);\s*syncRuijieProviderConfig\(\);\s*syncInstalledOpenAIBundledPluginCache\(\);/, `${sourcePath} should install managed marketplace plugins before plugin UI reads config`);
    assert.match(source, /function syncManagedMarketplacePluginInstall\(marketplaceSources\)/, `${sourcePath} should install configured marketplace plugins at startup`);
    assert.match(source, /const cacheRoot=path\.join\(codexHome,"plugins","cache",spec\.name\)/, `${sourcePath} should cache managed marketplace plugins under the Ruizhi runtime home`);
    assert.doesNotMatch(source, /path\.join\(home,"\.codex","plugins","cache",spec\.name\)/, `${sourcePath} should not cache managed marketplace plugins under the default Codex home`);
    assert.match(source, /copyManagedPluginCacheFiles\(sourceRoot,path\.join\(cacheRoot,plugin\.name,version\)\)/, `${sourcePath} should install each managed plugin version into the plugin cache`);
    assert.match(source, /"\[plugins\."\+tomlString\(pluginName\+"\@"\+marketplaceName\)\+"\]"/, `${sourcePath} should emit plugin install tables for managed marketplaces`);
    assert.match(source, /"enabled = (?:true|false)"/, `${sourcePath} should write an explicit initial state for newly installed managed marketplace plugins`);
    if (!sourcePath.endsWith("build-macos.mjs")) {
      assert.match(source, /if\((?:tomlKey|ruizhiTomlKey)\(lines\[index\]\)==="enabled"\)return source;/, `${sourcePath} should not overwrite existing per-plugin user settings`);
    }
    assert.match(source, /isPathInside\(marketplaceRoot,sourceRoot\)/, `${sourcePath} should reject plugin source paths that escape the synced marketplace`);
  }
});

test("Windows early bootstrap installs bundled Ruizhi marketplace without legacy anchors", () => {
  const source = readProjectFile("scripts/windows-asar-overrides.mjs");

  assert.match(source, /const ruizhiMarketplaceSpecs=\$\{JSON\.stringify\(marketplaceSpecs\)\};/);
  assert.match(source, /function ruizhiSyncBundledPluginMarketplaces\(\)/);
  assert.match(source, /ruizhiSyncBundledPluginMarketplaces\(\);/);
  assert.match(source, /path\.join\(resourcesRoot,\.\.\.spec\.resourcePath\)/);
  assert.match(source, /path\.join\(codexHome,\.\.\.spec\.installPath\)/);
  assert.match(source, /path\.join\(codexHome,"plugins","cache",spec\.name\)/);
  assert.match(source, /function ruizhiPluginConfigBlock\(marketplaceName,pluginName\)/);
  assert.match(source, /"\[plugins\."\+ruizhiTomlString\(pluginName\+"\@"\+marketplaceName\)\+"\]"/);
  assert.match(source, /enabled = false/);
  assert.match(source, /if\(ruizhiTomlKey\(lines\[index\]\)==="enabled"\)return source;/);
});

test("packaging keeps local plugins and skills visible when remote catalogs fail", async () => {
  for (const sourcePath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = readProjectFile(sourcePath);
    assert.match(source, /patchPluginSkillLocalListFallback/, `${sourcePath} should patch plugin and skill list fallbacks`);
  }

  const overrideSource = readProjectFile("scripts/windows-asar-overrides.mjs");
  assert.match(overrideSource, /function ruizhiLocalPluginMarketplaces/, "fallback should read installed plugin cache");
  assert.match(overrideSource, /path\.join\(codexHome,\\?"plugins\\?",\\?"cache\\?"\)/, "fallback should load plugins from the RUIZHI_HOME-backed plugin cache");
  assert.match(overrideSource, /path\.join\(codexHome,\\?"plugins\\?",\\?"marketplaces\\?"\)/, "fallback should load the complete bundled marketplace when the installed cache is incomplete");
  assert.match(overrideSource, /\.agents\\?",\\?"plugins\\?",\\?"marketplace\.json/, "fallback should read each bundled marketplace catalog");
  assert.match(overrideSource, /ruizhiReadLocalPluginConfigEnabledMap/, "fallback should preserve local plugin enabled state");
  assert.match(overrideSource, /ruizhiMergeLocalPluginMarketplaces/, "successful remote plugin responses should merge local installed plugins");
  assert.match(overrideSource, /remoteMarketplaces/, "fallback should keep remote marketplace entries when available");
  assert.match(overrideSource, /using local skills only/, "recommended skill failures should not block installed local skills");
  assert.match(overrideSource, /return\{skills:\[\],repositories:\[\],sections:\[\]\}/, "skill recommendation failure should return a valid empty response");

  const { patchPluginSkillLocalListFallbackSource } = await import("../scripts/windows-asar-overrides.mjs");
  const fixturePath = path.join(projectRoot, "docs/app-asar-analysis/26.707.31428/extracted-source/.vite/build/main-CH17cjbj.js");
  if (fs.existsSync(fixturePath)) {
    const mainBundle = fs.readFileSync(fixturePath, "utf8");
    const patched = patchPluginSkillLocalListFallbackSource(mainBundle);
    assert.notEqual(patched, mainBundle, "main bundle sample should receive the plugin/skill fallback patch");
    assert.match(patched, /ruizhiLocalPluginMarketplaces/, "patched main bundle should include local plugin reader");
    assert.match(patched, /ruizhiMergeLocalPluginMarketplaces\(\{codexHome:/, "patched plugin list should merge local and remote plugins");
    assert.match(patched, /using local skills only/, "patched skills handler should swallow remote recommendation failures");
  }
});

test("local plugin fallback keeps the full marketplace when cache is partial", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-plugin-fallback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marketplaceRoot = path.join(root, "plugins", "marketplaces", "openai-curated");
  const cacheRoot = path.join(root, "plugins", "cache", "openai-curated", "alpha", "1.0.0");
  for (const pluginName of ["alpha", "beta"]) {
    const pluginRoot = path.join(marketplaceRoot, "plugins", pluginName);
    fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "1.0.0", description: pluginName }));
  }
  fs.mkdirSync(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "openai-curated",
    plugins: ["alpha", "beta"].map((name) => ({ name, source: { path: `./plugins/${name}` }, policy: { installation: "AVAILABLE", authentication: "NONE" } }))
  }));
  fs.mkdirSync(path.join(cacheRoot, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(cacheRoot, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "alpha", version: "1.0.0", description: "alpha" }));

  const { ruizhiLocalPluginListFallbackHelperSource } = await import("../scripts/windows-asar-overrides.mjs");
  const context = { require, result: null };
  vm.runInNewContext(`${ruizhiLocalPluginListFallbackHelperSource()};result=ruizhiLocalPluginMarketplaces(${JSON.stringify(root)})`, context);
  assert.equal(context.result[0].plugins.length, 2);
  assert.equal(context.result[0].plugins.find((plugin) => plugin.name === "alpha").installed, true);
  assert.equal(context.result[0].plugins.find((plugin) => plugin.name === "beta").installed, false);
});

test("macOS packaging avoids provenance-blocked Resource directory creation", () => {
  const source = readProjectFile("scripts/build-macos.mjs");
  assert.match(source, /execLogged\("ditto", \["--norsrc", sourceAppRoot, appOutRoot\]\)/, "macOS packaging should avoid copying source app xattrs into dist");

  const copyIndex = source.indexOf('execLogged("ditto", ["--norsrc", sourceAppRoot, appOutRoot])');
  const runtimeIndex = source.indexOf("copyRuntimeOverrides(", copyIndex);
  const marketplaceIndex = source.indexOf("copyPluginMarketplaces();", copyIndex);
  const plistIndex = source.indexOf("patchInfoPlist();", copyIndex);
  const helperIndex = source.indexOf("buildImageGenHelper();", copyIndex);

  assert.ok(copyIndex >= 0, "macOS build should copy the source app with ditto");
  assert.ok(runtimeIndex > copyIndex && runtimeIndex < plistIndex, "runtime override directories should be created before plist edits can make the bundle provenance-protected");
  assert.ok(marketplaceIndex > copyIndex && marketplaceIndex < plistIndex, "marketplace directories should be created before plist edits can make the bundle provenance-protected");
  assert.ok(helperIndex > runtimeIndex, "Go helper build should happen after runtime Resource directories already exist");
});
