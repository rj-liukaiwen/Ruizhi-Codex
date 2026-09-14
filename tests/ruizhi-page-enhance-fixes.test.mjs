import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import os from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const require = createRequire(import.meta.url);

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function parseVersion(version) {
  return String(version).split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart !== rightPart) {
      return leftPart - rightPart;
    }
  }
  return 0;
}

test("Windows release version advances past the pre-plugin-menu installer", () => {
  const config = JSON.parse(read("config/rj-codex.json"));

  assert.equal(config.version, "0.3.144");
  assert.ok(
    compareVersions(config.version, "0.2.2") > 0,
    "Windows installer version must advance so machines with the old 0.2.2 package receive the native Plugins menu patch",
  );
});

test("renderer wires thread sorting and robust DOM adapters", () => {
  const source = read("resources/renderer/ruizhi-page-enhance.js");

  assert.match(source, /function installThreadSorting\(/);
  assert.match(source, /bridgeCall\("\/thread-sort-keys"/);
  assert.match(source, /data-ruizhi-sort-key/);
  assert.match(source, /function closestSessionRow\(/);
  assert.match(source, /function stableSessionIdFromElement\(/);
  assert.match(source, /function messageAuthorOf\(/);
  assert.match(source, /data-app-action-sidebar-thread-row/);
  assert.match(source, /data-app-action-sidebar-thread-title/);
  assert.match(source, /data-testid\*='conversation-turn'/);
  assert.match(source, /data-turn-key/);
  assert.match(source, /data-content-search-turn-key/);
  assert.match(source, /function threadScrollElement\(/);
  assert.match(source, /data-app-action-timeline-scroll/);
  assert.match(source, /RUIZHI_SETTINGS_VERSION_FIX_V1/);
  assert.match(source, /function installSettingsVersionFix\(/);
});

test("page enhance menu follows Codex surface and text tokens", () => {
  for (const scriptPath of [
    "resources/renderer/ruizhi-page-enhance.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /#ruizhi-page-enhance-menu \[data-trigger\]/, `${scriptPath} should style the trigger explicitly`);
    assert.match(source, /background:var\(--token-main-surface-primary,#fff/, `${scriptPath} should use Codex surface tokens with a light fallback`);
    assert.match(source, /color:var\(--token-text-primary,var\(--token-foreground,#0d0d0d\)\)/, `${scriptPath} should use Codex readable text tokens`);
    assert.match(source, /input\[type="checkbox"\]\{accent-color:var\(--token-text-link-foreground,#1f6feb\)/, `${scriptPath} should use Codex link accent for checks`);
    assert.doesNotMatch(source, /#ruizhi-page-enhance-menu button\{[^}]*#202123/, `${scriptPath} should not force the enhance menu into a dark fallback`);
    assert.doesNotMatch(source, /#ruizhi-page-enhance-menu \[data-panel\]\{[^}]*#202123/, `${scriptPath} should not force the enhance panel into a dark fallback`);
  }
});

test("page enhance hides its floating menu and replaces footer help with the Ruizhi build label", () => {
  const source = read("resources/renderer/ruizhi-page-enhance.js");

  assert.match(source, /menu:\s*false/);
  assert.match(source, /menu:\s*false,\s*sessionDelete/);
  assert.match(source, /function installFooterVersionBadge\(/);
  assert.match(source, /findFooterHelpControl/);
  assert.match(source, /ruizhi-footer-version-badge/);
  assert.match(source, /badge\.textContent = `锐捷 \$\{displayVersion\}`/);
});

test("session action click guard does not block action handlers", () => {
  for (const scriptPath of [
    "resources/renderer/ruizhi-page-enhance.js",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    const start = source.indexOf("function actionButton(");
    assert.notEqual(start, -1, `${scriptPath} should define actionButton`);
    const end = source.indexOf("async function exportMarkdown", start);
    assert.notEqual(end, -1, `${scriptPath} should define exportMarkdown after actionButton`);
    const actionButtonSource = source.slice(start, end);

    assert.match(actionButtonSource, /event\.preventDefault\(\)/, `${scriptPath} should keep sidebar rows from navigating when action buttons are clicked`);
    assert.match(actionButtonSource, /event\.stopPropagation\(\)/, `${scriptPath} should keep action clicks local to the injected button`);
    assert.doesNotMatch(actionButtonSource, /stopImmediatePropagation/, `${scriptPath} should not suppress the action button's own click handler`);
    assert.match(actionButtonSource, /button\.addEventListener\("click", handler, true\)/, `${scriptPath} should still invoke the action handler on click`);
  }
});

test("session actions only expose compact Markdown export", () => {
  for (const scriptPath of [
    "resources/renderer/ruizhi-page-enhance.js",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /sessionDelete:\s*false/, `${scriptPath} should retire session delete by default`);
    assert.match(source, /projectMove:\s*false/, `${scriptPath} should retire session migration by default`);
    assert.match(source, /\.ruizhi-session-actions button\{width:20px;height:20px/, `${scriptPath} should use a smaller export button`);
    assert.match(source, /group\.appendChild\(actionButton\("导出", "⇩", \(\) => exportMarkdown\(ref\)\)\)/, `${scriptPath} should keep Markdown export`);
    assert.doesNotMatch(source, />删除会话<input type="checkbox" data-feature="sessionDelete"/, `${scriptPath} should not show the delete toggle`);
    assert.doesNotMatch(source, />项目移动<input type="checkbox" data-feature="projectMove"/, `${scriptPath} should not show the migration toggle`);
    assert.doesNotMatch(source, /openProjectMove\(ref\)/, `${scriptPath} should not append migration actions`);
    assert.doesNotMatch(source, /deleteSession\(ref\)/, `${scriptPath} should not append delete actions`);
    assert.doesNotMatch(source, /function openProjectMove\(/, `${scriptPath} should not include the retired migration overlay`);
  }
});

test("session export action leaves room for native pin and timestamp controls", () => {
  for (const scriptPath of [
    "resources/renderer/ruizhi-page-enhance.js",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /\.ruizhi-session-actions\{[^}]*right:72px/, `${scriptPath} should move export left of native pin and time controls`);
    assert.match(source, /\.ruizhi-session-actions\{[^}]*z-index:1/, `${scriptPath} should not overlay native row controls with a high z-index`);
    assert.match(source, /pointer-events:none/, `${scriptPath} should keep the injected action layer from intercepting native controls`);
    assert.match(source, /\.ruizhi-session-actions button\{[^}]*pointer-events:auto/, `${scriptPath} should keep the export button itself clickable`);
    assert.doesNotMatch(source, /right:28px/, `${scriptPath} should not place export in the native control area`);
  }
});

test("packaging preload hides update error text instead of rendering 更新失败", () => {
  for (const scriptPath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs"]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /status==="error"\)return "更新失败"/, `${scriptPath} should not render update failure text`);
    assert.doesNotMatch(source, /textContent=.*更新失败/, `${scriptPath} should not render update failure text`);
  }
});

test("preload update integration leaves the native settings menu item untouched", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /findSettingsRow/, `${scriptPath} should not locate the native Settings row`);
    assert.doesNotMatch(source, /ruizhi-settings-update-row/, `${scriptPath} should not decorate the native Settings row`);
    assert.doesNotMatch(source, /ruizhi-update-status/, `${scriptPath} should not append update status into Settings`);
    assert.doesNotMatch(source, /设置\|Settings\|Preferences\|setting/, `${scriptPath} should not scan Settings labels`);
  }
});

test("first launch auth status remains available without patching the native login route", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function hasExistingRuizhiConfig\(/, `${scriptPath} should detect existing Ruizhi runtime configuration`);
    assert.match(source, /function readAuthJson\(/, `${scriptPath} should parse auth.json instead of inferring auth mode from API key presence`);
    assert.match(source, /authMode=auth&&typeof auth\.auth_mode==="string"\?auth\.auth_mode:null/, `${scriptPath} should expose auth_mode from auth.json`);
    assert.match(source, /config\.toml/, `${scriptPath} should treat config.toml as an existing Ruizhi configuration marker`);
    assert.match(source, /RUIZHI_EXISTING_CONFIG/, `${scriptPath} should preserve whether Ruizhi config.toml exists without mutating it`);
    assert.doesNotMatch(source, /RUIZHI_EXISTING_CODEX_CONFIG|codexConfigPath|hasExistingCodexConfig|codex-config/, `${scriptPath} should not use Codex config state for Ruizhi auth status`);
    assert.match(source, /configuredBy/, `${scriptPath} should report whether auth came from auth.json or Ruizhi config`);
    assert.match(source, /configured:authConfigured\|\|existingConfig/, `${scriptPath} should keep reporting existing auth state`);
    assert.doesNotMatch(source, /configured:key\.length>0\|\|existingConfig/, `${scriptPath} must not treat API key presence as the only auth.json signal`);
    assert.doesNotMatch(source, /function patchLoginRoute\(/, `${scriptPath} should not patch Codex's login route`);
    assert.doesNotMatch(source, /function patchOnboardingApiKeyTexts\(/, `${scriptPath} should not patch Codex's onboarding login content`);
    assert.doesNotMatch(source, /\["electron\.onboarding\.login\.chatgptToken\./, `${scriptPath} should leave native token login messages untouched`);
    assert.doesNotMatch(source, /\["electron\.onboarding\.login\.(google|microsoft)\./, `${scriptPath} should leave native third-party login messages untouched`);
    assert.doesNotMatch(source, /login-with-chatgpt-url|readLoginWithChatgptUrl|ruizhiLoginWithChatgptUrl/, `${scriptPath} should not override native ChatGPT login URLs`);
  }

  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /ruizhi:auth:get-sync/, `${scriptPath} should keep exposing cached auth status to non-login UI`);
    assert.match(source, /getCached:\(\)=>cachedAuthStatus/, `${scriptPath} should keep auth status available through the desktop bridge`);
    assert.doesNotMatch(source, /ruizhi:auth:get-login-with-chatgpt-url|loginWithChatgptUrl|getLoginWithChatgptUrl/, `${scriptPath} should not expose login URL override hooks`);
  }
});

test("page enhance installer skips Codex login pages", () => {
  for (const scriptPath of [
    "resources/renderer/ruizhi-page-enhance.js",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function isCodexLoginPage\(/, `${scriptPath} should detect native login documents`);
    assert.match(source, /if \(isCodexLoginPage\(\)\) return null;/, `${scriptPath} should not install page enhance on login pages`);
  }
});

test("packaging keeps archive locale labels native", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /codex\.archiveInfo/, `${scriptPath} should not override Codex archive info labels`);
    assert.doesNotMatch(source, /localTaskRow\.archive/, `${scriptPath} should not override Codex archive task labels`);
    assert.doesNotMatch(source, /settings\.dataControls\.archivedChats/, `${scriptPath} should not override archived chats settings labels`);
    assert.doesNotMatch(source, /sidebarElectron\.archive/, `${scriptPath} should not override sidebar archive labels`);
    assert.doesNotMatch(source, /threadHeader\.archive/, `${scriptPath} should not override thread header archive labels`);
  }
});

test("packaging patches onboarding continue button and build date badge", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function ruizhiBuildDateLabel\(/, `${scriptPath} should compute the build-date label during packaging`);
    assert.match(source, /\$\{appVersion\}-\$\{ruizhiShortBuildDate\(\)\}/, `${scriptPath} should include the packaging version and short build date`);
    assert.match(source, /\["electron\.onboarding\.login\.chatgpt\.continue", "使用锐捷继续"\]/, `${scriptPath} should patch the ChatGPT continue button label`);
    assert.match(source, /\["electron\.onboarding\.login\.chatgpt\.signIn\.streamlined", "使用锐捷继续"\]/, `${scriptPath} should patch the streamlined ChatGPT continue button label`);
    assert.match(source, /\["electron\.onboarding\.login\.includedPlans\.welcomeV2", ruizhiBuildDateLabel\(\)\]/, `${scriptPath} should replace the ChatGPT plan badge with the build date`);
  }
});

test("windows packaging shows Browser and Computer Use settings as available", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /patchWindowsBrowserAndComputerUseSettingsAvailability/, "Windows should patch Browser and Computer Use settings availability bundles");
  assert.match(source, /browser-use-settings-\.\*\\\.js/, "Windows should patch Browser Use settings chunks");
  assert.match(source, /computer-use-settings-\.\*\\\.js/, "Windows should patch Computer Use settings chunks");
  assert.match(source, /v=!0/, "Browser settings should show the main switch sections as enabled");
  assert.match(source, /browser-use-unavailable/, "Browser settings should keep a visible local Browser row instead of falling into the empty state");
  assert.match(source, /checked:!0,disabled:!1,onChange:Si/, "Unavailable plugin rows should render as enabled rather than greyed out");
  assert.match(source, /chrome-unavailable/, "Computer Use settings should keep a visible local Chrome row instead of falling into the empty state");
  assert.match(source, /if\(\(n\.available=!0\)&&C!=null\)/, "Computer Use settings should treat local desktop control as available");
});

test("packaging keeps RuiJie Work and renames the coding mode to RuiJie Coding", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function shortProductName\(\)/, `${scriptPath} should derive a short brand for mixed product-mode labels`);
    assert.match(source, /function replaceLocalizedVisibleText\(id, value\)/, `${scriptPath} should support id-specific locale replacements`);
    assert.match(source, /id === "sidebarElectron\.productMode\.chatGptWork"/, `${scriptPath} should patch the rich ChatGPT Work mode label`);
    assert.match(source, /<chatGpt>\$\{shortProductName\(\)\}<\/chatGpt> <work>工作<\/work>/, `${scriptPath} should render the mode label as 锐捷 工作`);
    assert.match(source, /id === "sidebarElectron\.productMode\.chatGptWork\.plainText"/, `${scriptPath} should patch the accessible ChatGPT Work mode label`);
    assert.match(source, /\$\{shortProductName\(\)\} 工作/, `${scriptPath} should render the accessible label as 锐捷 工作`);
    assert.match(source, /id === "sidebarElectron\.productMode\.codex"/, `${scriptPath} should patch the coding mode label explicitly`);
    assert.match(source, /return config\.productModes\?\.coding \?\? `\$\{shortProductName\(\)\} 编码`/, `${scriptPath} should render the coding mode label as 锐捷 编码`);
    assert.match(source, /replace\("\/ChatGPT\|Codex\/g|replace\(\/ChatGPT\|Codex\/g/, `${scriptPath} should replace ChatGPT and Codex in one pass`);
    assert.doesNotMatch(source, /replace\(\/ChatGPT\/g, config\.productName\)\.replace\(\/Codex\/g/, `${scriptPath} should not reprocess Codex inside the replacement product name`);
  }
});

test("packaging keeps product-mode labels as RuiJie Work and RuiJie Coding", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /sidebarElectron\.productMode\.chatGptWork/, `${scriptPath} should patch the rich ChatGPT Work mode label`);
    assert.match(source, /sidebarElectron\.productMode\.chatGptWork\.plainText/, `${scriptPath} should patch the accessible ChatGPT Work mode label`);
    assert.match(source, /sidebarElectron\.productMode\.codex/, `${scriptPath} should patch the Codex mode label`);
    assert.match(source, /\$\{shortProductName\([^)]*\)\} \\u7f16\\u7801|\$\{shortProductName\(\)\} 编码/, `${scriptPath} should render the Codex mode label as 锐捷 编码`);
  }
});

test("packaging brand replacement does not duplicate RuiJie before Codex", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /\(\?:\$\{escapeRegExp\(productPrefix\)\}\)\{2,\}\(\?=Codex\)/, `${scriptPath} should collapse repeated brand prefixes before Codex`);
    assert.match(source, /before\.endsWith\(productPrefix\)/, `${scriptPath} should preserve Codex when it is already prefixed by the product brand`);
  }
});

test("Windows override uses robust profile visibility entry-point patching", () => {
  const source = read("scripts/windows-asar-overrides.mjs");
  assert.match(source, /findOneFileByContent\(\s*assetsDir,\s*\/\^\.\+\\\.js\$\/,/);
  assert.match(source, /function ruizhiProfileVisibility\(\)\{return \{isProfileVisibilityLoading:false,isProfileVisible:true\}\}/);
  assert.match(source, /function ruizhiProfileDropdownEntryPoint\(\)\{return true\}/);
  assert.match(source, /function \$1\(\)\{return ruizhiProfileVisibility\(\)\}/);
  assert.match(source, /function \$1\(\)\{return ruizhiProfileDropdownEntryPoint\(\)\}/);
});

test("bootstrap only applies narrow managed config.toml updates", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js",
  ]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /# BEGIN Ruizhi Managed Defaults/, `${scriptPath} should not embed a managed config.toml block`);
    assert.doesNotMatch(source, /mergeManagedConfig|stripManagedConfigConflicts|managedConfigSectionNames/, `${scriptPath} should not merge or rewrite config.toml`);
    assert.doesNotMatch(source, /configTemplateLines/, `${scriptPath} should not template config.toml defaults`);
    assert.doesNotMatch(source, /fs\.writeFileSync\(target,\s*next,\s*"utf8"\)/, `${scriptPath} should not patch sandbox settings into config.toml`);
    assert.doesNotMatch(source, /fs\.copyFileSync\(configPath/, `${scriptPath} should not back up config.toml for mutation`);
    assert.doesNotMatch(source, /syncRuntimeModelProviderConfig|setTomlProviderBaseUrl|bak-provider/, `${scriptPath} should not repair provider URLs in config.toml`);
    assert.doesNotMatch(source, /path\.join\(home,"\.codex","config\.toml"\)/, `${scriptPath} should not write Ruizhi runtime config into ~/.codex`);
  }

  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function syncRuijieProviderConfig\(\)/, `${scriptPath} should only patch missing Ruizhi provider config`);
    assert.match(source, /insertTopLevelTomlKeyIfMissing/, `${scriptPath} should preserve an existing ChatGPT login base URL`);
    assert.match(source, /chatgpt_login_base_url/, `${scriptPath} should seed the ChatGPT login base URL when missing`);
    assert.match(source, /ruijieChatGptLoginBaseUrl/, `${scriptPath} should use the configured login base URL`);
    assert.match(source, /tomlKeyLine\("base_url",ruijieProviderBaseUrl\)|base_url = /, `${scriptPath} should write the provider base URL`);
    assert.match(source, /ruijieProviderBaseUrl/, `${scriptPath} should use the configured provider base URL`);
    assert.match(source, /chat_model_prefixes = /, `${scriptPath} should write chat model prefixes when missing`);
    assert.match(source, /function tomlStringArrayValue\(/, `${scriptPath} should parse existing chat model prefixes`);
    assert.match(source, /requiredChatModelPrefixes/, `${scriptPath} should preserve and complete required chat model prefixes`);
    assert.match(source, /!seen\.has\(prefix\)/, `${scriptPath} should append missing chat model prefixes instead of skipping existing config`);
    assert.match(source, /\[model_providers\.ruijie-uniapi\]/, `${scriptPath} should target only the Ruizhi UniAPI provider`);
  }
});

test("bootstrap exposes ruijie provider api_key as RUIJIE_UNIAPI_KEY", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /function syncRuijieUniApiKeyEnvFromConfig\(/, `${scriptPath} should bridge legacy provider api_key into the runtime env`);
    assert.match(source, /process\.env\.RUIJIE_UNIAPI_KEY=key/, `${scriptPath} should expose provider api_key as RUIJIE_UNIAPI_KEY`);
    assert.match(source, /findTomlTable\(lines,"\[model_providers\.ruijie-uniapi\]"\)/, `${scriptPath} should read only the Ruizhi provider table`);
    assert.match(source, /tomlKey\(lines\[index\]\)==="api_key"/, `${scriptPath} should read the provider api_key field`);
    assert.match(source, /quoteCode===34\|\|quoteCode===39/, `${scriptPath} should avoid fragile nested quote literals in bootstrap templates`);
    assert.doesNotMatch(source, /quote==="\\?\""/, `${scriptPath} should not generate invalid quote comparison syntax`);
  }
});

test("page enhance preload loads the renderer module without CSP-blocked eval or inline script injection", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
    "overrides/windows-app/asar/.vite/build/preload.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /globalThis\.ruizhiDesktop=api/, `${scriptPath} should provide the enhance bridge to preload world`);
    assert.match(source, /installRuizhiPageEnhance|pageEnhanceRendererInstallerSource/, `${scriptPath} should load the page enhance installer`);
    assert.match(source, /__RUIZHI_INSTALL_PAGE_ENHANCE__/, `${scriptPath} should use the inlined page enhance installer`);
    assert.doesNotMatch(source, /resourcesRoot=process\.resourcesPath[\s\S]{0,240}require\(scriptPath\)/, `${scriptPath} should not need Node fs/path from sandboxed preload`);
    const injectIndex = source.indexOf("function injectRuizhiPageEnhance()");
    assert.notEqual(injectIndex, -1, `${scriptPath} should define injectRuizhiPageEnhance`);
    const injectSnippet = source.slice(injectIndex, injectIndex + 700);
    assert.doesNotMatch(injectSnippet, /require\(scriptPath\)/, `${scriptPath} should not load external modules from sandboxed preload`);
    assert.doesNotMatch(source, /new Function\("window","document","ruizhiDesktop","__RUIZHI_PAGE_ENHANCE_CONFIG__","source",/, `${scriptPath} should not eval page enhance source`);
    assert.doesNotMatch(source, /runRuizhiPageEnhance/, `${scriptPath} should not evaluate page enhance source manually`);
    assert.doesNotMatch(source, /script\.textContent=.*RUIZHI_PAGE_ENHANCE_CONFIG/, `${scriptPath} should not inject an inline script`);
    assert.doesNotMatch(source, /appendChild\(script\)/, `${scriptPath} should not rely on DOM script injection`);
  }

  const rendererSource = read("resources/renderer/ruizhi-page-enhance.js");
  assert.match(rendererSource, /function installRuizhiPageEnhance\(/);
  assert.match(rendererSource, /module\.exports\s*=\s*\{\s*installRuizhiPageEnhance\s*\}/);
});

test("page enhance bootstrap carries the Ruizhi app version for settings display", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /appVersion[:,]/, `${scriptPath} should pass appVersion to page enhance`);
    assert.match(source, /appDisplayVersion/, `${scriptPath} should pass the Ruizhi build label to page enhance`);
  }
});

test("macOS bootstrap patch tolerates updater failure handler alias changes", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /bootstrapFailureHandlerPattern/, "macOS bootstrap patch should match the updater failure handler by shape");
  assert.match(source, /failureHandlerName/, "macOS bootstrap patch should capture the minified failure handler name");
  assert.match(source, /electronName/, "macOS bootstrap patch should capture the Electron module alias");
  assert.match(source, /bootstrapInitCode\(electronName\)/, "macOS init bootstrap should receive the captured Electron alias");
  assert.match(source, /\$\{electronName\}\.app\.commandLine\.appendSwitch/, "macOS init bootstrap should use the captured Electron alias");
  assert.match(source, /bootstrapForceUpdateCode\(electronName\)/, "macOS updater bootstrap should receive the captured Electron alias");
  assert.match(source, /\$\{electronName\}\.app\.isPackaged/, "macOS updater bootstrap should use the captured Electron alias");
  assert.match(source, /updaterInitializePattern/, "macOS bootstrap patch should match updater initialization by shape");
  assert.match(source, /runMainAppStartup/, "macOS bootstrap patch should keep the main app startup import boundary");
});

test("macOS fuse patch resolves renamed Electron framework binaries", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /function findElectronFrameworkExecutable\(/, "macOS fuse patch should resolve the framework binary itself");
  assert.match(source, /Framework\\\.framework/, "macOS fuse patch should inspect framework bundles");
  assert.match(source, /temporaryFuseExecutable/, "macOS fuse patch should avoid electron-fuses .app path rewriting");
  assert.match(source, /flipFuses\(temporaryFuseExecutable/, "macOS fuse patch should flip a temporary framework copy");
});

test("enhance service returns appVersion and retires destructive session routes", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-enhance-"));
  try {
    const { createRuizhiEnhanceService } = require(path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"));
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      config: {
        pageEnhance: {
          enabled: true,
          appVersion: "0.1.24",
          features: { timeline: false }
        }
      }
    });

    assert.equal(service.settings().appVersion, "0.1.24");
    assert.equal(service.settings().features.sessionDelete, false);
    assert.equal(service.settings().features.projectMove, false);
    const nextSettings = service.writeSettings({ features: { timeline: true, sessionDelete: true, projectMove: true } });
    assert.equal(nextSettings.appVersion, "0.1.24");
    assert.equal(nextSettings.features.sessionDelete, false);
    assert.equal(nextSettings.features.projectMove, false);
    assert.equal((await service.call("/delete", { session_id: "thread-1" })).status, "disabled");
    assert.equal((await service.call("/move-thread-workspace", { session_id: "thread-1", target_cwd: "/tmp" })).status, "disabled");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("enhance service model list follows the user models_cache.json contents", async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-model-cache-"));
  try {
    fs.writeFileSync(
      path.join(tmpHome, "models_cache.json"),
      `${JSON.stringify({
        default_model: "gpt-5.5",
        models: [
          {
            slug: "gpt-5.5",
            display_name: "gpt-5.5",
            visibility: "list",
            input_modalities: ["text"],
            supported_reasoning_levels: []
          }
        ]
      }, null, 2)}\n`,
      "utf8",
    );

    const { createRuizhiEnhanceService } = require(path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"));
    const service = createRuizhiEnhanceService({ codexHome: tmpHome });
    const result = await service.call("/models/list", { includeHidden: true, limit: 100 });

    assert.equal(result.status, "ok");
    assert.equal(result.data.length, 1);
    assert.equal(result.data[0].slug, "gpt-5.5");
    assert.equal(result.data[0].displayName, "gpt-5.5");
    assert.deepEqual(result.data[0].input_modalities, ["text", "image"]);
    assert.deepEqual(
      result.data[0].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
      ["minimal", "low", "medium", "high", "xhigh"],
    );
    assert.equal(result.data[0].defaultReasoningEffort, "medium");
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("application menu translation preserves Codex Automations", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /"Automations":"自动化"/);
  assert.match(source, /ruizhiEnsureNativeMenuItems/);
  assert.match(source, /\\`自动化\\`,g,\{index:3\}/);
  assert.match(source, /[mr]\(e,\\?`\/automations\\?`\)/);
  assert.match(source, /\\`设置…\\`,p,\{accelerator:\\`CmdOrCtrl\+,\\`,index:0\}/);
  assert.match(source, /visible=!0/);
  assert.match(source, /enabled=!0/);
  assert.doesNotMatch(source, /Automations[^;\n]+(remove|delete|hidden|disabled)/i);
});

test("Windows packaging keeps native Settings and Automations actions visible without stale main overrides", () => {
  const source = read("scripts/windows-asar-overrides.mjs");
  const buildDir = path.join(projectRoot, "overrides", "windows-app", "asar", ".vite", "build");
  const mainBundle = fs.readdirSync(buildDir).find((name) => /^main-.*\.js$/.test(name));

  assert.match(source, /ruizhiEnsureNativeMenuItems/);
  assert.match(source, /\\`自动化\\`,g,\{index:2\}/);
  assert.match(source, /[mr]\(e,\\?`\/automations\\?`\)/);
  assert.match(source, /\\`设置…\\`,p,\{accelerator:\\`CmdOrCtrl\+,\\`,index:0\}/);
  assert.match(source, /visible=!0/);
  assert.match(source, /enabled=!0/);
  assert.doesNotMatch(source, /Plugins\s+-\s+Unlocked|插件\s+-\s+已解锁/);
  assert.equal(mainBundle, undefined, "Windows overrides should not keep a stale hashed main bundle");
});

test("macOS application menu keeps native Settings and Automations actions visible", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /function patchApplicationMenu\(/);
  assert.match(source, /ruizhiTranslateApplicationMenu/);
  assert.match(source, /ruizhiEnsureNativeMenuItems/);
  assert.match(source, /label:\\?`自动化\\?`/);
  assert.match(source, /[mr]\(e,\\?`\/automations\\?`\)/);
  assert.match(source, /label:\\?`设置…\\?`/);
  assert.match(source, /settingsRoute:i/);
  assert.match(source, /[mr]\(e,i\)/);
  assert.match(source, /helperStart/, "macOS native menu patch should detect stale injected helpers");
  assert.match(source, /applicationMenuPatchSource\(\).*next\.slice\(helperEnd\)/s, "macOS native menu patch should replace stale injected helpers in rebuilt asars");
  assert.match(source, /visible=!0/);
  assert.match(source, /enabled=!0/);
});

test("application menu hides library and pull request entries and opens Ruizhi account auth", () => {
  for (const scriptPath of [
    "scripts/windows-asar-overrides.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /"Account":"账户"/, `${scriptPath} should localize Account`);
    assert.match(source, /"Library":"资料库"/, `${scriptPath} should know the Library label before hiding it`);
    assert.match(source, /"Pull Requests":"拉取请求"/, `${scriptPath} should know the Pull Requests label before hiding it`);
    assert.match(source, /Library\|Libraries\|资料库\|Pull Request\|Pull Requests\|拉取请求/, `${scriptPath} should hide Library and Pull Requests menu entries`);
    assert.match(source, /visible=!1/, `${scriptPath} should hide retired menu entries`);
    assert.match(source, /enabled=!1/, `${scriptPath} should disable retired menu entries`);
    assert.match(source, /gptauth\.ruijie\.com\.cn\//, `${scriptPath} should open the Ruizhi account auth URL`);
    assert.match(source, /openExternal/, `${scriptPath} should use the system browser for Account`);
    assert.match(source, /shell:/, `${scriptPath} should pass Electron shell into the menu helper`);
  }
});

test("packaging routes ChatGPT account settings links to Ruizhi auth", () => {
  for (const scriptPath of [
    "scripts/windows-asar-overrides.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /chatgpt\\.com\\\/#settings/, `${scriptPath} should patch ChatGPT account settings links`);
    assert.match(source, /open-security-settings/, `${scriptPath} should patch ChatGPT security settings links`);
    assert.match(source, /gptauth\.ruijie\.com\.cn\//, `${scriptPath} should route account settings to Ruizhi auth`);
    assert.match(source, /已补丁账户设置链接/, `${scriptPath} should log the account-settings link patch`);
  }
});

test("macOS application menu patch tolerates main bundle minifier alias changes", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /settingsMenuMatch/, "macOS menu patch should capture settings navigation aliases");
  assert.match(source, /setApplicationMenuMatch/, "macOS menu patch should capture setApplicationMenu aliases");
  assert.match(source, /MenuItem:\$\{electronName\}\.MenuItem/, "macOS menu patch should use the captured Electron alias");
  assert.match(source, /settingsRoute:\$\{settingsRouteName\}/, "macOS menu patch should use the captured settings route alias");
});

test("packaging opens Codex native settings gates including Browser and Chrome", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /ruizhiNativeFeatureGateValue/, `${scriptPath} should patch native feature gates`);
    assert.match(source, /3075919032/, `${scriptPath} should keep Codex native Automations nav visible`);
    assert.match(source, /4166894088/, `${scriptPath} should keep Codex native profile Settings visible`);
    assert.match(source, /410262010/, `${scriptPath} should make in-app Browser controls available`);
    assert.match(source, /3903563814/, `${scriptPath} should allow Browser plugin navigation to non-local sites`);
    assert.match(source, /410065390/, `${scriptPath} should make Google Chrome controls available`);
    assert.doesNotMatch(source, /1506311413/, `${scriptPath} should leave Computer Use controls to Codex defaults`);
    assert.doesNotMatch(source, /querySelectorAll\([^)]*(自动化|Automations|settingsPage|general-settings)/, `${scriptPath} should not fake native sidebar/profile buttons with DOM insertion`);
  }
});

test("packaging opens the native profile dropdown entry point", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeProfileVisibility/, `${scriptPath} should patch the native profile visibility bundle`);
    assert.match(source, /2478676115/, `${scriptPath} should open the native profile visibility gate`);
    assert.match(source, /3503973010/, `${scriptPath} should open the native profile dropdown layer`);
    assert.match(source, /ruizhiProfileVisibility/, `${scriptPath} should keep the Settings profile section visible`);
    assert.match(source, /isProfileVisibilityLoading:false,isProfileVisible:true/, `${scriptPath} should not redirect away from Settings profile`);
    assert.match(source, /show_dropdown_entry_point/, `${scriptPath} should force the profile dropdown entry point on`);
    assert.match(source, /ruizhiProfileDropdownEntryPoint/, `${scriptPath} should keep the profile dropdown entry point visible`);
    assert.match(source, /accountId:/, `${scriptPath} should match the newer profile visibility hook shape`);
    assert.match(source, /isProfileVisible:/, `${scriptPath} should match the newer dropdown entry-point hook shape`);
  }
});

test("packaging routes and logs native profile token activity", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeProfileUsageFallback/, `${scriptPath} should patch the native profile usage query bundle`);
    assert.match(source, /\/wham\/profiles\/me/, `${scriptPath} should preserve the official profile endpoint first`);
    assert.match(source, /\/profile\/usage/, `${scriptPath} should fall back to local Ruizhi profile usage`);
    assert.match(source, /globalThis\.ruizhiDesktop\?\.enhance\?\.call/, `${scriptPath} should use the existing enhance bridge for local usage`);
    assert.match(source, /CODEX_API_BASE_URL/, `${scriptPath} should set the native ChatGPT backend API base at launch`);
    assert.match(source, /https:\/\/gptauth\.ruijie\.com\.cn/, `${scriptPath} should route native backend API calls to Ruizhi auth backend`);
    assert.match(source, /patchNativeProfileApiCallLogging/, `${scriptPath} should patch main-process profile API URL logging`);
    assert.match(source, /\[ruizhi\]\[profile-api\]/, `${scriptPath} should log the resolved profile API URL without auth headers`);
    assert.match(source, /replace\(\/\^\\\\\/\+\//, `${scriptPath} should preserve the slash escape in generated regex literals`);
    assert.match(source, /\[ruizhi\]\[profile\] GET \/wham\/profiles\/me start/, `${scriptPath} should log renderer profile API attempts`);
    assert.match(source, /invalid profile payload/, `${scriptPath} should reject malformed profile payloads before rendering`);
    assert.match(source, /using empty local profile fallback/, `${scriptPath} should keep profile rendering alive when every profile source fails`);
  }
});

test("packaging keeps Usage settings visible for Ruizhi auth modes", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeUsageSettingsVisibility/, `${scriptPath} should patch the native Usage settings visibility bundle`);
    assert.match(source, /patchNativeProfileDropdownUsageVisibility/, `${scriptPath} should patch the profile dropdown Usage entry`);
    assert.match(source, /enable_free_go_usage_settings/, `${scriptPath} should locate the Usage settings access bundle by code shape`);
    assert.match(source, /isUsageSettingsVisible/, `${scriptPath} should patch the Usage settings visibility result`);
    assert.match(source, /ruizhiUsageSettingsAlwaysVisible/, `${scriptPath} should keep Usage settings visible for Ruizhi auth modes`);
    assert.match(source, /ruizhiProfileDropdownUsageForAllAuth/, `${scriptPath} should keep the profile dropdown Usage item visible for every authenticated mode`);
    assert.match(source, /codex\\\.profileDropdown\\\.usage/, `${scriptPath} should locate the profile dropdown Usage item`);
    assert.match(source, /patchNativeUsageSettingsVisibilitySource/, `${scriptPath} should use the shared all-auth Usage visibility patch`);
  }

  const windowsOverrideSource = read("scripts/windows-asar-overrides.mjs");
  assert.match(windowsOverrideSource, /\["Qo=`Usage`", "Qo=`使用情况`"\]/, "Windows overrides should label the menu as 使用情况");
});

test("Usage settings stays visible for Ruizhi custom OAuth accounts", async () => {
  const { patchNativeUsageSettingsVisibilitySource } = await import("../scripts/windows-asar-overrides.mjs");
  assert.equal(
    typeof patchNativeUsageSettingsVisibilitySource,
    "function",
    "packaging should expose a reusable Usage visibility patch instead of hard-coding API key auth",
  );

  const source = "function ah({authMethod:e,plan:t,isFreeGoUsageSettingsEnabled:n}){let a=e===`chatgpt`,s=a&&t===`pro`;return{canManageCreditSettings:s,isUsageSettingsVisible:s||a&&n||e===`apikey`}}function oh(e){return e===`free`}";
  const patched = patchNativeUsageSettingsVisibilitySource(source);
  const usageVisible = Function(
    `${patched};return ah({authMethod:\"ruizhi-oauth\",plan:null,isFreeGoUsageSettingsEnabled:false}).isUsageSettingsVisible;`,
  )();

  assert.equal(usageVisible, true, "锐捷自有 OAuth 登录后也必须显示“使用情况和计费”菜单");
  assert.match(patched, /ruizhiUsageSettingsAlwaysVisible/, "the bundle should carry the always-visible Usage marker");
});

test("profile API logging patch emits parseable regex literals", () => {
  const source = read("scripts/windows-asar-overrides.mjs");
  const replacementMatch = source.match(/source = source\.replace\([\s\S]*?,\n\s*("function \$1\(e,t\)\{[\s\S]*?return n\}")\n\s*\);/);
  assert.ok(replacementMatch, "should keep the profile API logging replacement discoverable");
  const replacement = Function(`return ${replacementMatch[1]}`)()
    .replaceAll("$1", "ruizhiProfileApiUrl")
    .replaceAll("$2", "ruizhiApiBase");
  assert.doesNotThrow(
    () => new Function("ruizhiApiBase", `return (${replacement});`),
    "generated profile API logging function should not produce an invalid regex literal"
  );
});

test("enhance service exposes local profile token usage", () => {
  const source = read("resources/bridge/ruizhi-enhance-service.cjs");
  assert.match(source, /case "\/profile\/usage"/, "enhance service should expose a local profile usage route");
  assert.match(source, /profileUsage\(\)/, "enhance service should aggregate profile usage locally");
  assert.match(source, /daily_usage_buckets/, "local profile usage should match the native profile API shape");
  assert.match(source, /tokens_used/, "local profile usage should be backed by stored thread token counts");
});

test("packaging plugin auth compatibility patch is shared and narrowly scoped", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /pluginAccountGatePattern/, `${scriptPath} should locate the plugin auth gate by code shape`);
    assert.match(source, /findOneFileByContent/, `${scriptPath} should not depend on a fixed plugin auth bundle name`);
    assert.match(source, /patchNativePluginAuthCompatibilitySource/, `${scriptPath} should use the shared narrow plugin auth patch`);
  }

  const macosSource = read("scripts/build-macos.mjs");
  assert.doesNotMatch(
    macosSource,
    /authMethod===`chatgpt`[\s\S]{0,200}__ruizhi_never__/,
    "macOS packaging must not globally disable native ChatGPT-authenticated feature paths",
  );
});

test("plugin auth compatibility does not rewrite unrelated ChatGPT feature checks", async () => {
  const { patchNativePluginAuthCompatibilitySource } = await import("../scripts/windows-asar-overrides.mjs");
  assert.equal(typeof patchNativePluginAuthCompatibilitySource, "function");

  const source = [
    "function gate(e){return e!==`chatgpt`}",
    "function statsig(account){return account.authMethod===`chatgpt`}",
    "function onboarding(account){return account.authMethod===`chatgpt`}",
  ].join(";");
  const patched = patchNativePluginAuthCompatibilitySource(source);

  assert.equal(Function(`${patched};return gate(\"chatgpt\");`)(), false);
  assert.equal(Function(`${patched};return gate(\"apikey\");`)(), false);
  assert.equal(Function(`${patched};return gate(\"amazonBedrock\");`)(), false);
  assert.equal(Function(`${patched};return gate(\"copilot\");`)(), true);
  assert.equal((patched.match(/authMethod===`chatgpt`/g) ?? []).length, 2);
  assert.doesNotMatch(patched, /__ruizhi_never__/);
});

test("packaging native feature gate patch tolerates Statsig hook alias changes", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /statsigGateSourcePattern/, `${scriptPath} should match the Statsig hook call with a regex`);
    assert.match(source, /targetGateMatch\[2\]/, `${scriptPath} should capture the minified gate hook alias before patching`);
    assert.match(source, /\$\{gateHook\}\(\$\{gateStore\},e\)/, `${scriptPath} should call the captured gate hook and store aliases after the Ruizhi override`);
  }
});

test("packaging disables native Statsig initialize network traffic", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeStatsigNetwork/, `${scriptPath} should patch Statsig network settings`);
    assert.ok(source.includes("https:\\/\\/ab\\.chatgpt\\.com\\/v1"), `${scriptPath} should locate the hard-coded Statsig API root`);
    assert.match(source, /preventAllNetworkTraffic:!0/, `${scriptPath} should disable Statsig initialize requests`);
    assert.doesNotMatch(source, /networkOverrideFunc:ij\}/, `${scriptPath} should not hard-code stale native Statsig network aliases`);
  }
});

test("packaging disables post-login Statsig bootstrap wait", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeStatsigBootstrap/, `${scriptPath} should patch the post-login Statsig bootstrap path`);
    assert.match(source, /Timed out while fetching post-login Statsig bootstrap/, `${scriptPath} should locate the startup-blocking bootstrap function`);
    assert.match(source, /ruizhiCreateStatsigBootstrapPayload/, `${scriptPath} should provide a local bootstrap payload`);
    assert.match(source, /return\{statsigPayload:\$\{match\[11\]\},user:\$\{match\[12\]\}\}/, `${scriptPath} should replace the remote bootstrap result with the local payload shape`);
  }
});

test("packaging disables native CES analytics network traffic", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeCesAnalyticsNetwork/, `${scriptPath} should patch CES analytics settings`);
    assert.ok(source.includes("https:\\/\\/chatgpt\\.com\\/ces\\/v1"), `${scriptPath} should locate the hard-coded CES API root`);
    assert.match(source, /ruizhi-disabled:\/\/ces\/v1\/rgstr/, `${scriptPath} should replace the CES event endpoint`);
    assert.match(source, /ruizhi-disabled:\/\/ces\/v1/, `${scriptPath} should replace the CES base endpoint`);
    assert.match(source, /!1&&\$2&&\$3===`success`&&\$4===!0/, `${scriptPath} should keep AnalyticsLogger disabled before initialization`);
  }
});

test("packaging app sunset gate patch tolerates feature gate alias changes", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.ok(source.includes("appSunset\\.title[\\s\\S]*`2929582856`"), `${scriptPath} should locate the app sunset bundle by content`);
    assert.ok(source.includes("/if\\(([A-Za-z_$][\\w$]*)\\(`2929582856`\\)\\)\\{/"), `${scriptPath} should match the minified feature gate alias`);
    assert.ok(source.includes("if(false&&$1(`2929582856`)){"), `${scriptPath} should disable the captured app sunset gate`);
  }
});

test("packaging model availability patch tolerates model bundle splits", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /modelAvailabilityAllowlistPattern/, `${scriptPath} should locate model filtering by code shape`);
    assert.match(source, /findOneFileByContent\(\s*assetsDir,\s*\/\\\.js\$\/,\s*modelAvailabilityAllowlistPattern/s, `${scriptPath} should allow renamed shared model helper chunks`);
    assert.match(source, /"!1"/, `${scriptPath} should disable the hidden-model allowlist flag`);
    assert.doesNotMatch(source, /\(\?:\[\^;\]\*\?,\)\*/, `${scriptPath} should avoid broad backtracking in model bundle scans`);
  }
});

test("packaging enables Codex native Browser desktop availability without Browser runtime patches", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeBrowserDesktopFeatureAvailability/, `${scriptPath} should patch desktop Browser availability`);
    assert.match(source, /ruizhiNativeBrowserDesktopFeatureAvailability/, `${scriptPath} should keep the Browser availability patch scoped`);
    assert.match(source, /browserPane:!0/, `${scriptPath} should allow the native Browser pane`);
    assert.match(source, /inAppBrowserUse:!0/, `${scriptPath} should enable the native in-app Browser backend`);
    assert.match(source, /inAppBrowserUseAllowed:!0/, `${scriptPath} should allow in-app Browser use`);
    assert.match(source, /computerUse:!0/, `${scriptPath} should enable Computer Use for the local desktop`);
    assert.match(source, /computerUseNodeRepl:!0/, `${scriptPath} should enable Computer Use Node REPL support`);
    assert.doesNotMatch(source, /patchBrowserDesktopFeaturePayload/, `${scriptPath} should not patch Browser feature payloads`);
  }

  const buildDir = path.join(projectRoot, "overrides", "windows-app", "asar", ".vite", "build");
  const mainBundle = fs.readdirSync(buildDir).find((name) => /^main-.*\.js$/.test(name));
  assert.equal(mainBundle, undefined, "Windows overrides should rely on build-time main bundle patching");

  assert.equal(
    (fs.existsSync(path.join(projectRoot, "overrides", "windows-app", "asar", "webview", "assets"))
      ? fs.readdirSync(path.join(projectRoot, "overrides", "windows-app", "asar", "webview", "assets"))
      : [])
      .filter((name) => /^browser-use-settings-.*\.js$/.test(name)).length,
    0,
    "Windows overrides should not carry stale Browser settings asset patches"
  );
});

test("packaging keeps ChatGPT authentication URLs in the system browser", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /patchChatGptAuthExternalBrowser/, `${scriptPath} should patch auth browser dispatch`);
    assert.match(source, /ruizhiIsChatGptAuthUrl/, `${scriptPath} should detect ChatGPT OAuth URLs explicitly`);
    assert.match(source, /useExternalBrowser:!0/, `${scriptPath} should force auth URLs to the OS browser`);
  }
});

test("packaging Browser desktop availability patch tolerates main bundle minifier alias changes", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /nativeBrowserDesktopFeatureAvailabilityPattern/, `${scriptPath} should match desktop feature availability with a regex`);
    assert.match(source, /CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE/, `${scriptPath} should anchor on the desktop feature availability function body`);
    assert.match(source, /returnExpression/, `${scriptPath} should capture the full availability return expression`);
    assert.match(source, /ruizhiNativeBrowserDesktopFeatureAvailability\(\$\{returnExpression\}\)/, `${scriptPath} should wrap the captured availability result`);
    assert.doesNotMatch(source, /\[\\s\\S\]\*\?\)\\}function/, `${scriptPath} should avoid broad cross-function regex backtracking`);
  }
});

test("packaging uses current OpenAI bundled plugin ids for Browser automation", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /\{\s*(?:"name"|name)\s*:\s*"browser"\s*,\s*(?:"path"|path)\s*:\s*"\.\/plugins\/browser"/, `${scriptPath} should bundle the current Browser plugin id`);
    assert.match(source, /\{\s*(?:"name"|name)\s*:\s*"latex"\s*,\s*(?:"path"|path)\s*:\s*"\.\/plugins\/latex"/, `${scriptPath} should bundle the current LaTeX plugin id`);
    assert.doesNotMatch(source, /\{\s*(?:"name"|name)\s*:\s*"browser-use"\s*,\s*(?:"path"|path)\s*:\s*"\.\/plugins\/browser-use"/, `${scriptPath} should not generate the retired browser-use plugin id`);
    assert.doesNotMatch(source, /\{\s*(?:"name"|name)\s*:\s*"latex-tectonic"\s*,\s*(?:"path"|path)\s*:\s*"\.\/plugins\/latex-tectonic"/, `${scriptPath} should not generate the retired latex-tectonic plugin id`);
  }
  assert.doesNotMatch(read("scripts/windows-asar-overrides.mjs"), /pluginDirRenames/, "Windows bundled plugin restore should not rename current plugin directories to retired ids");
  assert.doesNotMatch(read("scripts/windows-asar-overrides.mjs"), /path\.join\(pluginsRoot,\s*"latex-tectonic"/, "Windows bundled plugin patches should target the current latex plugin directory");
});

test("windows packaging patches the native Plugins menu independently from tray labels", () => {
  const source = read("scripts/windows-asar-overrides.mjs");
  const refreshStart = source.indexOf("export function refreshWindowsAsarBuildMetadata(");
  assert.notEqual(refreshStart, -1, "Windows metadata refresh should exist");
  const refreshEnd = source.indexOf("\n}\n\nfunction nodeModuleTargetDir", refreshStart);
  assert.notEqual(refreshEnd, -1, "Windows metadata refresh body should be locatable");
  const refreshSource = source.slice(refreshStart, refreshEnd);

  assert.match(source, /function patchWindowsNativeMenuItems\(/, "Windows native menu patch should be split from tray label patching");
  assert.match(refreshSource, /patchWindowsNativeMenuItems\(extractedAppDir, config, \{ log \}\)/, "Windows refresh should always patch native menu entries");
  assert.match(source, /try\{ruizhiEnsureNativeMenuItems\(\{menu:/, "Windows native menu patch should mount before setApplicationMenu, not only inject helpers");
  assert.doesNotMatch(source, /source\.includes\("ruizhiEnsureNativeMenuItems\(\{menu:"\)/, "Windows native menu patch should not mistake the helper definition for a mounted hook");
  assert.match(source, /settingsRouteVar/, "Windows native menu patch should resolve the current settings route variable dynamically");
  assert.match(source, /\/settings\/general-settings/, "Windows native menu patch should target the real settings route");
  assert.doesNotMatch(source, /settingsRoute:yB/, "Windows native menu patch should not hard-code an unrelated minified variable");
  assert.match(source, /ensureSettingsMenu/, "Windows native menu patch should create a Settings top-level menu when missing");
  assert.match(source, /ensurePluginsMenu/, "Windows native menu patch should create a Plugins top-level menu when missing");
  assert.match(source, /helperStart/, "Windows native menu patch should detect stale injected helpers");
  assert.match(source, /source\.slice\(0, helperStart\).*windowsNativeMenuPatchSource\(\).*source\.slice\(insertionIndex\)/s, "Windows native menu patch should replace stale injected helpers in rebuilt asars");
  assert.match(source, /Plugins":"插件"/, "Windows native menu translator should localize Plugins");
  assert.match(source, /Usage":"使用情况"/, "Windows native menu translator should localize Usage");
  assert.match(source, /r\(e,\\`\/settings\/usage\\`\)/, "Windows native menu patch should open /settings/usage");
  assert.match(source, /\\`使用情况\\`,U,\{index:1\}/, "Windows native menu patch should add Usage under Settings");
  assert.match(source, /\\`插件\\`,m,\{index:2\}/, "Windows native menu patch should add a Plugins label under Settings");
  assert.match(source, /label:\\`插件\\`,submenu:\[\]/, "Windows native menu patch should add a top-level Plugins menu");
  assert.match(source, /r\(e,\\`\/plugins\\`\)/, "Windows native menu patch should open /plugins");
});

test("macOS packaging adds a native Usage menu entry", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /Usage":"使用情况"/, "macOS native menu translator should localize Usage");
  assert.match(source, /\/settings\/usage/, "macOS native menu patch should open /settings/usage");
  assert.match(source, /label:\\`使用情况\\`/, "macOS native menu patch should add a Usage label");
});

test("windows packaging keeps the native menu bar visible on BrowserWindow", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /autoHideMenuBar:\s*!1/, "Windows BrowserWindow menu bar must not be hidden after native menu entries are added");
  assert.match(source, /setMenuBarVisibility\(!0\)/, "Windows BrowserWindow should keep its menu bar visible");
  assert.doesNotMatch(source, /\.removeMenu\(\)/, "Windows BrowserWindow menu must not be removed after native menu entries are added");
});

test("windows packaging does not copy source Logs into build output", () => {
  const source = read("scripts/build-windows.mjs");

  assert.match(source, /function shouldCopyPinnedCodexAppEntry\(/, "Windows build should define a copy filter for the pinned app source");
  assert.match(source, /relativeParts\[0\]\.toLowerCase\(\) === "logs"/, "Windows build should skip top-level Logs from the pinned app source");
  assert.match(source, /relativeParts\.join\("\/"\)\.toLowerCase\(\) === "resources\/plugins\/openai-bundled"/, "Windows build should skip bundled plugin resources that are restored later");
  assert.match(source, /fsExtra\.copy\(installedAppRoot, appOutRoot, \{ filter: shouldCopyPinnedCodexAppEntry \}\)/, "Windows build should apply the copy filter when staging the app");
});

test("windows packaging can use an explicit external source app root", () => {
  const source = read("scripts/build-windows.mjs");

  assert.match(source, /RUIZHI_WINDOWS_SOURCE_APP_ROOT/, "Windows build should accept an explicit source app root override");
  assert.match(source, /path\.resolve\(process\.env\.RUIZHI_WINDOWS_SOURCE_APP_ROOT\)/, "Windows source override should support absolute paths outside the workspace");
  assert.match(source, /verifyWindowsSourceManifest\(appRoot\)/, "Default pinned source should keep manifest verification");
  assert.match(source, /log\(`使用外部 Codex Desktop 源/, "External source override should be visible in build logs");
  assert.match(source, /codexClientVersionFromExe\(path\.join\(pinnedCodexAppRoot, "resources", "codex\.exe"\)\)/, "Windows build should read the Codex client version from the pinned source executable");
  assert.match(source, /RUIZHI_CODEX_CLIENT_VERSION/, "Windows build should allow explicit Codex client version when child-process execution is blocked");
  assert.match(source, /patchOpenAIBundledPluginDescriptions\(resourcesDir, \{ log, sourceAppRoot: pinnedCodexAppRoot \}\)/, "Windows build should restore bundled plugin resources from the active source app root");
});

test("windows packaging can skip rcedit icon patching in restricted environments", () => {
  const source = read("scripts/build-windows.mjs");

  assert.match(source, /RUIZHI_SKIP_EXE_ICON_PATCH/, "Windows build should expose an escape hatch for rcedit spawn restrictions");
  assert.match(source, /跳过主程序图标替换/, "Windows build should log when exe icon patching is skipped");
});

test("windows packaging can use an isolated work directory", () => {
  const source = read("scripts/build-windows.mjs");

  assert.match(source, /RUIZHI_WINDOWS_WORK_SUBDIR/, "Windows build should allow an isolated work directory");
  assert.match(source, /resolveProjectPath\(process\.env\.RUIZHI_WINDOWS_WORK_SUBDIR/, "Windows work directory override should stay inside the project");
  assert.match(source, /RUIZHI_WINDOWS_INSTALLER_INPUT_SUBDIR/, "Windows build should allow an isolated installer input directory");
  assert.match(source, /RUIZHI_WINDOWS_INSTALLER_OUT_SUBDIR/, "Windows build should allow an isolated installer output directory");
});

test("runtime bundle validation cleanup is best effort", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /function removeValidationDirBestEffort\(/, "Runtime validation should isolate cleanup failures");
  assert.doesNotMatch(source, /fs\.rmSync\(extractDir, \{ recursive: true, force: true \}\);/, "Runtime validation should not let temp cleanup failure mask validation result");
});

test("packaging bundles current OpenAI plugin metadata without writing config defaults", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /openAIBundledPluginDefinitions/, `${scriptPath} should keep the bundled OpenAI plugin catalog`);
    assert.doesNotMatch(source, /\[plugins\."\$\{plugin\.name\}@openai-bundled"\]/, `${scriptPath} should not write plugin enablement blocks to config.toml`);
  }

  const bootstrapSource = read("overrides/windows-app/asar/.vite/build/bootstrap.js");
  assert.ok(bootstrapSource.includes('"name":"browser"'), "bootstrap should carry the native Browser plugin id");
  assert.ok(bootstrapSource.includes('"name":"chrome"'), "bootstrap should carry the native Chrome plugin id");
  assert.ok(bootstrapSource.includes('"name":"latex"'), "bootstrap should carry the native LaTeX plugin id");
});

test("bootstrap leaves unmanaged Codex config sections untouched", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js",
  ]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /stripManagedConfigConflicts/, `${scriptPath} should not strip user config.toml sections`);
    assert.doesNotMatch(source, /managedSectionNames/, `${scriptPath} should not maintain managed TOML sections`);
    assert.doesNotMatch(source, /managedBlock/, `${scriptPath} should not prepend managed defaults to config.toml`);
  }
});

test("packaging updates Codex bundled Browser native-pipe trust only", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.doesNotMatch(source, /patchBrowserNativePipeStartup/, `${scriptPath} should not force Browser native pipe startup`);
    assert.doesNotMatch(source, /patchOpenAIBundledBrowserRuntime/, `${scriptPath} should not patch bundled Browser runtime scripts`);
    assert.match(source, /patchTrustedBrowserClientHashes/, `${scriptPath} should refresh Browser client trusted hashes`);
    assert.doesNotMatch(source, /ruizhiIabSessionFallback/, `${scriptPath} should not inject Browser IAB session fallback logic`);
  }

  const overrideSource = read("scripts/windows-asar-overrides.mjs");
  assert.doesNotMatch(overrideSource, /patchJsonFile\(path\.join\(pluginsRoot,\s*"browser"/, "Browser plugin.json should remain the official Codex file");
  assert.doesNotMatch(overrideSource, /writeTranslatedOpenAIPluginSkill\(\s*path\.join\(pluginsRoot,\s*"browser"/, "Browser SKILL.md should remain the official Codex file");
  assert.doesNotMatch(overrideSource, /const browserSkill = `# Browser/, "Browser skill previews should remain official");
});

test("packaging logs Browser native-pipe availability boundaries", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /ruizhiBrowserNativePipeLog/, `${scriptPath} should log Browser desktop availability input and output`);
    const nativePipeLogger = scriptPath === "scripts/build-windows.mjs"
      ? /patchBrowserNativePipeDiagnostics/
      : /ruizhiBrowserNativePipeEnabled/;
    assert.match(source, nativePipeLogger, `${scriptPath} should log Browser native pipe enable state`);
  }
});

test("windows packaging disables Browser native-pipe peer authorization like macOS", () => {
  const source = read("scripts/build-windows.mjs");

  assert.match(source, /patchBrowserNativePipePeerAuthorization/, "Windows build should import and run the Browser native-pipe peer authorization patch");
  assert.match(source, /patchBrowserNativePipeDiagnostics\(extractedDir, \{ log \}\);\s*patchBrowserNativePipePeerAuthorization\(extractedDir, \{ log \}\);\s*patchBrowserUseIabOpenStability\(extractedDir, \{ log \}\);/s, "Windows build should apply peer authorization between native-pipe diagnostics and IAB stability patches");
});

test("bootstrap refreshes cached bundled Browser runtime scripts on launch", () => {
  for (const scriptPath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "overrides/windows-app/asar/.vite/build/bootstrap.js",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /ensureOpenAIBundledPluginCache/, `${scriptPath} should create missing plugin cache roots`);
    assert.match(source, /copyPluginCacheFiles/, `${scriptPath} should refresh plugin cache files`);
    assert.match(source, /runtimePluginNames=new Set\(\["browser","chrome"\]\)/, `${scriptPath} should refresh Browser runtime plugin caches`);
    assert.match(source, /entry\.name==="scripts"&&runtimePluginNames\.has\(pluginName\)/, `${scriptPath} should copy scripts only for Browser runtimes`);
    assert.doesNotMatch(source, /!fs\.existsSync\(sourcePluginsRoot\)\|\|!fs\.existsSync\(cacheRoot\)/, `${scriptPath} should not skip first-run cache creation`);
  }
});
