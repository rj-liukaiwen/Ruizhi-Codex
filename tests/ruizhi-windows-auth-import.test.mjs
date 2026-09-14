import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  patchExternalAgentImportDisabledSource,
  patchRuizhiAuthEnvironmentInAppServerProcessSource,
  patchRuizhiPostLoginOnboardingSource,
  patchRuizhiAuthToastSource,
  patchNativeWalletUsagePresentation,
  patchWindowsBrowserAndComputerUseSettingsAvailability,
  ensureWindowsBootstrapEarlyRuizhiEnv
} from "../scripts/windows-asar-overrides.mjs";

const require = createRequire(import.meta.url);

test("disables only the general settings external AI import button", () => {
  const source = [
    "async function Qe(e,t){if(t.items.length===0)return!1;let n={};return n}",
    "function tt(e){let t=(0,X.c)(76),u=e.variant===void 0?`section`:e.variant,m=rt(e),g=m.isDetecting||e.isActiveWorkspaceLoading,b=m.importChoices.length===0?null:{cached:!0};",
    "if(u===`general-row`){let e=b!=null,r=m.latestImportedAtMs!=null,i=m.lastCompletedImportProgress!=null;",
    "let u=g||m.isImporting||!m.isDetectionError&&!e&&(!r||!i),d=()=>m.openImportDialog(),f=(0,Q.jsx)(v,{id:`settings.general.importExternalAgent.noData`,defaultMessage:`未检测到数据`,description:`Disabled button label`});",
    "let p=(0,Q.jsx)(S,{color:`secondary`,size:`toolbar`,disabled:u,loading:m.isImporting,onClick:d,children:f});return p}",
    "return b==null?(0,Q.jsx)(S,{disabled:!0}):(0,Q.jsx)(S,{color:`secondary`,size:`toolbar`,disabled:m.isImporting,onClick:D,children:(0,Q.jsx)(v,{id:`settings.agent.importSettings.applySelected.appName`,defaultMessage:`导入到 {appName}`,description:`Apply selected imports`})})}",
    "function rt(e){let m=Re({detectedItems:e,enabled:!0,hostId:n});return m}",
    "id:`settings.general.importExternalAgent.noData`,defaultMessage:`未检测到数据`",
    "id:`settings.import.empty.description`,defaultMessage:`未找到可导入的设置`"
  ].join("");

  const patched = patchExternalAgentImportDisabledSource(source);

  assert.match(patched, /ruizhiExternalAgentGeneralButtonDisabled/);
  assert.match(patched, /ruizhiExternalAgentGeneralDetectionDisabled/);
  assert.doesNotMatch(patched, /ruizhiExternalAgentImportDialogDisabled/);
  assert.doesNotMatch(patched, /ruizhiExternalAgentSettingsButtonDisabled/);
  assert.match(patched, /async function Qe\(e,t\)\{if\(t\.items\.length===0\)return!1/);
  assert.match(patched, /source:u===`general-row`\?`settings-disabled`:`settings`/);
  assert.match(patched, /enabled:o!==`settings-disabled`/);
  assert.doesNotMatch(patched, /disabled:u,loading:m\.isImporting,onClick:d/);
  assert.match(patched, /disabled:m\.isImporting,onClick:D/);
  assert.match(patched, /openImportDialog\(\)/);
  assert.match(patched, /defaultMessage:`未检测到数据`/);
  assert.doesNotMatch(patched, /defaultMessage:`功能暂未开放`/);
  assert.match(patched, /defaultMessage:`未找到可导入的设置`/);
  assert.equal(patchExternalAgentImportDisabledSource(patched), patched);
});

test("keeps external-agent onboarding and restores the established sandbox bypass", () => {
  const overrideSource = fs.readFileSync("scripts/windows-asar-overrides.mjs", "utf8");

  assert.doesNotMatch(overrideSource, /ruizhiExternalAgentOnboardingSkipped/);
  assert.doesNotMatch(overrideSource, /ruizhiExternalAgentOnboardingDetectionDisabled/);
  assert.doesNotMatch(overrideSource, /ruizhiWindowsSandboxOnboardingSkipped/);
  assert.match(overrideSource, /function ruizhiWindowsSandboxOnboardingState\(\)/);
  assert.match(overrideSource, /ruizhiWindowsSandboxOnboardingBypass/);
  assert.match(overrideSource, /ruizhiWindowsSandboxReadinessBypass/);
  assert.match(overrideSource, /start-windows-sandbox-setup-for-host/);
});

test("wallet usage presentation patch is safe to apply repeatedly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-wallet-patch-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(
    path.join(assets, "rate.js"),
    "function a(e){return e!=null&&(e.windowDurationMins??0)>0}function b({intl:e,minutes:t,variant:n=`summary`}){let r=t??0,tail=1}",
  );
  fs.writeFileSync(path.join(assets, "modal.js"), "let credits=x?.credits.filter(y)??[];");
  fs.writeFileSync(
    path.join(assets, "settings.js"),
    "Generic label for a usage limit row;function c(e){let t=e.bucket.windowDurationMins??0;return `label`}",
  );

  try {
    patchNativeWalletUsagePresentation(root);
    const first = fs.readFileSync(path.join(assets, "modal.js"), "utf8");
    patchNativeWalletUsagePresentation(root);
    assert.equal(fs.readFileSync(path.join(assets, "modal.js"), "utf8"), first);
    assert.match(first, /ruizhiUsageCreditsFallback/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("Browser and Computer Use availability patches accept an already-patched release", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-browser-settings-patch-"));
  const assets = path.join(root, "webview", "assets");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(
    path.join(assets, "browser-use-settings-current.js"),
    "id:`settings.browserUse.control.description`,defaultMessage:`让 锐捷Codex 控制内置浏览器`",
  );
  fs.writeFileSync(path.join(assets, "browser-use-settings-visibility.js"), "export const visible=true;");
  fs.writeFileSync(
    path.join(assets, "computer-use-settings-current.js"),
    "if((n.available=!0)&&C!=null)useComputer()",
  );

  try {
    patchWindowsBrowserAndComputerUseSettingsAvailability(root);
    patchWindowsBrowserAndComputerUseSettingsAvailability(root);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("packaged bootstrap enables memories and removes the obsolete model catalog override", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-bootstrap-config-"));
  const bootstrapPath = path.join(root, "bootstrap.js");
  fs.writeFileSync(bootstrapPath, "module.exports = {};\n");
  try {
    ensureWindowsBootstrapEarlyRuizhiEnv(bootstrapPath, {
      productName: "锐捷Codex",
      runtime: { homeEnv: "RUIZHI_HOME", defaultHomeDirName: ".ruizhi", electronUserDataDirName: "Ruizhi" },
      openai: { baseUrl: "https://example.invalid/v1", providerBaseUrl: "https://example.invalid/v1" },
      modelBridge: { enabled: false },
      models: { enabled: false },
      pluginMarketplaces: [],
    });
    const source = fs.readFileSync(bootstrapPath, "utf8");
    assert.doesNotThrow(() => new vm.Script(source));
    assert.match(source, /ruizhiEnsureTomlBoolean\(next,"features","memories",true\)/);
    assert.match(source, /ruizhiRemoveTopLevelTomlKey\(next,"model_catalog_json"\)/);
    assert.match(source, /ruizhiInsertTopLevelTomlKeyIfMissing\(next,"model_provider","ruijie-uniapi"\)/);
    assert.doesNotMatch(source, /ruizhiInsertTopLevelTomlKeyIfMissing\(next,"model",/);
    assert.doesNotMatch(source, /ruizhiInsertTopLevelTomlKeyIfMissing\(next,"model_catalog_json"/);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("injects auth environment into every app-server process start", () => {
  const source = [
    "case`process-start`:{let{hostId:e,processHandle:n,...r}=s.params,a=i({hostId:e}).spawn(r);return a}"
  ].join("");

  const patched = patchRuizhiAuthEnvironmentInAppServerProcessSource(source);

  assert.match(patched, /ruizhiInjectAuthEnvironment/);
  assert.match(patched, /spawn\(ruizhiInjectAuthEnvironment\(r\)\)/);
  assert.equal(patchRuizhiAuthEnvironmentInAppServerProcessSource(patched), patched);
});

test("injects a legacy config.toml api_key when auth.json does not exist", () => {
  const source = "case`process-start`:{let{hostId:e,processHandle:n,...r}=s.params,a=i({hostId:e}).spawn(r);return a}";
  const patched = patchRuizhiAuthEnvironmentInAppServerProcessSource(source);
  const helperStart = patched.indexOf("function ruizhiInjectAuthEnvironment");
  const helperEnd = patched.indexOf("case`process-start`", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-legacy-auth-"));
  try {
    fs.writeFileSync(
      path.join(home, "config.toml"),
      [
        'model_provider = "ruijie-uniapi"',
        "",
        "[model_providers.ruijie-uniapi]",
        'env_key = "RUIJIE_UNIAPI_KEY"',
        'api_key = "legacy-key-123"',
        'base_url = "https://example.invalid/v1"',
        "",
      ].join("\n"),
      "utf8",
    );
    const context = vm.createContext({
      module: { exports: {} },
      process: { env: { CODEX_HOME: home } },
      require,
    });
    vm.runInContext(
      `${patched.slice(helperStart, helperEnd)};module.exports=ruizhiInjectAuthEnvironment({env:{CODEX_HOME:${JSON.stringify(home)}}});`,
      context,
    );
    assert.equal(context.module.exports.env.RUIJIE_UNIAPI_KEY, "legacy-key-123");
    assert.equal(context.module.exports.env.RUIZHI_API_KEY, "legacy-key-123");
    assert.equal(context.module.exports.env.OPENAI_API_KEY, "legacy-key-123");
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

test("mirrors Ruizhi OAuth login from .ruizhi into all provider API key variables", () => {
  const source = "case`process-start`:{let{hostId:e,processHandle:n,...r}=s.params,a=i({hostId:e}).spawn(r);return a}";
  const patched = patchRuizhiAuthEnvironmentInAppServerProcessSource(source);
  const helperStart = patched.indexOf("function ruizhiInjectAuthEnvironment");
  const helperEnd = patched.indexOf("case`process-start`", helperStart);
  const helperSource = patched.slice(helperStart, helperEnd);
  const ruizhiHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-oauth-home-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-must-not-win-"));
  try {
    fs.writeFileSync(
      path.join(ruizhiHome, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "oauth-token-123" } }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "wrong-codex-key" }),
      "utf8",
    );
    const context = vm.createContext({
      module: { exports: {} },
      process: { env: { CODEX_HOME: codexHome, RUIZHI_HOME: ruizhiHome } },
      require,
    });
    vm.runInContext(
      `${helperSource};module.exports=ruizhiInjectAuthEnvironment({env:{CODEX_HOME:${JSON.stringify(codexHome)},RUIZHI_HOME:${JSON.stringify(ruizhiHome)}}});`,
      context,
    );
    assert.equal(context.module.exports.env.RUIJIE_UNIAPI_KEY, "oauth-token-123");
    assert.equal(context.module.exports.env.RUIZHI_API_KEY, "oauth-token-123");
    assert.equal(context.module.exports.env.OPENAI_API_KEY, "oauth-token-123");
  } finally {
    fs.rmSync(ruizhiHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

test("completes Ruizhi post-login onboarding locally instead of waiting on ChatGPT workspace onboarding", () => {
  const source = [
    "function Zi({finalStep:e,hasPreviouslyCompletedOnboarding:t,isAdvancingOnboarding:n,onboardingOverride:r,postLoginWelcomePending:i}){",
    "let a=$e(),o=_(),{client:s,isLoading:c}=Ae(),l=Me(s,`2744470156`),",
    "{isLoading:u,shouldUseTeenOnboarding:d}=Kr({enabled:a.authMethod===`chatgpt`}),f=r===`welcome`||i||t===!1;",
    "return{isLoading:u||n||c||e.isLoading||r!==`welcome`&&!i&&t==null,shouldShowStandardOnboarding:f,",
    "shouldShowConversationalOnboarding:l,shouldShowTeenOnboarding:d,finalStep:{shouldShow:e.shouldShow}}}",
    "function Bi(){let e=t.get(Ii);if(Je(t,Ie,{}),n.authMethod===`chatgpt`&&ct(e==null?null:yn(e)).then(ok,fail),e==null)return;",
    "let{state:r,options:i}=e;return r}"
  ].join("");

  const patched = patchRuizhiPostLoginOnboardingSource(source);

  assert.match(patched, /ruizhiPostLoginOnboardingQueryBypass/);
  assert.match(patched, /ruizhiPostLoginOnboardingLoadingBypass/);
  assert.match(patched, /ruizhiPostLoginFinalStepBypass/);
  assert.match(patched, /ruizhiPostLoginOnboardingCompletionFallback/);
  assert.match(patched, /roleSelectionSkipped:!0,state:\{roles:\[\],personalizedSuggestionsEnabled:!1,workMode:null\}/);
  assert.equal(patchRuizhiPostLoginOnboardingSource(patched), patched);
});

test("preserves legacy provider api_key while refreshing provider metadata", () => {
  const overrideSource = fs.readFileSync("scripts/windows-asar-overrides.mjs", "utf8");

  assert.doesNotMatch(
    overrideSource,
    /if\(key==="api_key"\)\{\s*insertAt=index;\s*lines\.splice\(index,1\);/,
  );
  assert.match(
    overrideSource,
    /if\(key==="chat_model_prefixes"\)\{\s*insertAt=index;\s*lines\.splice\(index,1\);/,
  );
  assert.match(overrideSource, /legacyApiKey=ruizhiTomlStringValue/);
  assert.match(overrideSource, /ruizhiLegacyApiKeyFromConfig\(\)/);
});

test("automatically imports legacy provider auth without overwriting new auth", () => {
  const overrideSource = fs.readFileSync("scripts/windows-asar-overrides.mjs", "utf8");

  assert.match(overrideSource, /function ruizhiImportLegacyAuthIfNeeded\(\)/);
  assert.match(overrideSource, /function importLegacyRuijieAuthIfNeeded\(\)/);
  assert.equal((overrideSource.match(/if\(fs\.existsSync\(authFile\)\)return false;/g) ?? []).length, 2);
  assert.equal((overrideSource.match(/JSON\.stringify\(\{OPENAI_API_KEY:key\}/g) ?? []).length, 2);
  assert.equal((overrideSource.match(/fs\.renameSync\(temp,authFile\)/g) ?? []).length, 2);
  assert.doesNotMatch(overrideSource, /fs\.writeFileSync\(authFile,JSON\.stringify\(\{OPENAI_API_KEY:key\}/);
});

test("checks auth only on conversation routes and uses the official logout flow", async () => {
  const source = [
    "function jfe(){let e=(0,L9.c)(13),t=f(b),n=g(Du),s=(0,R9.useRef)(!1),c;return c}",
    "function Nfe(){let e=(0,L9.c)(27),{pathname:t,search:n}=Yu(),r=(0,R9.useRef)(!1),i,a;",
    "e[0]!==t||e[1]!==n?(i=vo({pathname:t,routeTemplate:sL(kX,t),search:n}),a=i.routeKind===`client-local-thread`||i.routeKind===`local-thread`||i.routeKind===`remote-thread`?fs(i):null,e[0]=t,e[1]=n,e[2]=i,e[3]=a):(i=e[2],a=e[3]);",
    "let o=a,s,c;let f;return o}",
    "function RouteGuard(){let S,D,yY=`/login`,bY=`/welcome`;if(S===`login`&&D!==yY){return Ju}if(S===`welcome`&&D!==bY){return Ju}}"
  ].join("");

  const patched = patchRuizhiAuthToastSource(source);

  assert.match(patched, /ruizhiAuthToastGuard/);
  assert.match(patched, /globalThis\.__ruizhiAuthToastStore=t/);
  assert.match(patched, /\.get\(Ai\)\.danger/);
  assert.match(patched, /client-local-thread/);
  assert.match(patched, /local-thread/);
  assert.match(patched, /remote-thread/);
  assert.match(patched, /if\(!conversationRoute\|\|toastStore==null/);
  assert.match(patched, /danger\(`当前未登录或者登录过期，请重新登录`,\{description:`即将跳转到登录界面`\}\)/);
  assert.match(patched, /sendMessageFromView\?\.\(\{type:`log-out`\}\)/);
  assert.match(patched, /logoutTimer=setTimeout/);
  assert.doesNotMatch(patched, /__RUIZHI_FORCE_LOGIN__/);
  assert.doesNotMatch(patched, /ruizhiAuthRouteGuard/);
  assert.doesNotMatch(patched, /showMessageBox/);
  assert.doesNotMatch(patched, /resetToLogin/);
  assert.doesNotMatch(patched, /app\.relaunch/);
  assert.doesNotMatch(patched, /app\.exit/);
  assert.doesNotMatch(patched, /function Nfe\(\)[\s\S]*?ruizhiAuthToastStore=f\(b\)/);
  assert.equal(patchRuizhiAuthToastSource(patched), patched);

  const effectStart = patched.indexOf("(0,R9.useEffect)(()=>");
  const effectEnd = patched.indexOf("/*ruizhiAuthToastGuard*/", effectStart);
  assert.ok(effectStart >= 0 && effectEnd > effectStart);

  const toastCalls = [];
  const rendererMessages = [];
  const timers = [];
  let cleanup;
  const context = vm.createContext({
    Ai: Symbol("toast-scope"),
    R9: {
      useEffect(effect) {
        cleanup = effect();
      }
    },
    clearTimeout(timerId) {
      const timer = timers.find((candidate) => candidate.id === timerId);
      if (timer) timer.cleared = true;
    },
    console,
    i: { routeKind: "local-thread" },
    ruizhiDesktop: {
      auth: {
        async get() {
          return { configured: false };
        }
      }
    },
    setTimeout(callback, delay) {
      const timer = { callback, cleared: false, delay, id: timers.length + 1 };
      timers.push(timer);
      return timer.id;
    },
    t: "/thread/test",
    window: {
      electronBridge: {
        sendMessageFromView(message) {
          rendererMessages.push(message);
        }
      }
    }
  });
  context.__ruizhiAuthToastStore = {
    get() {
      return {
        danger(title, options) {
          toastCalls.push({ options, title });
        }
      };
    }
  };

  vm.runInContext(patched.slice(effectStart, effectEnd), context);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(toastCalls.length, 1);
  assert.equal(toastCalls[0].title, "当前未登录或者登录过期，请重新登录");
  assert.equal(toastCalls[0].options.description, "即将跳转到登录界面");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1800);
  assert.deepEqual(rendererMessages, []);

  timers[0].callback();
  assert.equal(rendererMessages.length, 1);
  assert.equal(rendererMessages[0].type, "log-out");

  cleanup();
  assert.equal(timers[0].cleared, true);

  let nonConversationAuthChecks = 0;
  const loginContext = vm.createContext({
    Ai: Symbol("toast-scope"),
    R9: { useEffect(effect) { effect(); } },
    console,
    i: { routeKind: "other", pathname: "/login" },
    t: "/login",
    ruizhiDesktop: {
      auth: {
        async get() {
          nonConversationAuthChecks += 1;
          return { configured: false };
        }
      }
    },
  });
  loginContext.__ruizhiAuthToastStore = context.__ruizhiAuthToastStore;
  vm.runInContext(patched.slice(effectStart, effectEnd), loginContext);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nonConversationAuthChecks, 0);
  assert.equal(toastCalls.length, 1);
  assert.equal(timers.length, 1);
});

test("Windows build and fast sync share one auth and import patch pipeline", () => {
  const buildSource = fs.readFileSync("scripts/build-windows.mjs", "utf8");
  const overrideSource = fs.readFileSync("scripts/windows-asar-overrides.mjs", "utf8");
  const syncSource = fs.readFileSync("scripts/sync-windows-test.mjs", "utf8");

  assert.doesNotMatch(buildSource, /\bpatchExternalAgentImportDisabled\b/);
  assert.doesNotMatch(buildSource, /\bpatchRuizhiAuthToast\b/);
  assert.match(overrideSource, /refreshWindowsAsarBuildMetadata[\s\S]*patchExternalAgentImportDisabled\(extractedAppDir/);
  assert.match(overrideSource, /refreshWindowsAsarBuildMetadata[\s\S]*patchRuizhiAuthToast\(extractedAppDir/);
  assert.match(overrideSource, /refreshWindowsAsarBuildMetadata[\s\S]*patchRuizhiPostLoginOnboarding\(extractedAppDir/);
  assert.match(syncSource, /refreshWindowsAsarBuildMetadata\(extractedDir/);
});
