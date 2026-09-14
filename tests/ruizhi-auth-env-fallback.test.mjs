import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('responses bridge auth file accepts login token fallbacks', () => {
  const source = fs.readFileSync('resources/bridge/ruizhi-responses-bridge.cjs', 'utf8');
  const start = source.indexOf('function authFromFile(authHome)');
  const end = source.indexOf('function authHeader(req, authHome)', start);
  assert.ok(start >= 0 && end > start, 'authFromFile not found');
  const snippet = `${source.slice(start, end)}\nmodule.exports = { authFromFile };`;
  const sandbox = {
    module: { exports: {} },
    exports: {},
    require,
    path,
    fs,
  };
  vm.runInNewContext(snippet, sandbox);
  const authFromFile = sandbox.module.exports.authFromFile;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruizhi-auth-'));
  try {
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'token-123' } }), 'utf8');
    assert.equal(authFromFile(tempHome), 'token-123');
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify({ RUIJIE_UNIAPI_KEY: 'api-456', tokens: { access_token: 'token-123' } }), 'utf8');
    assert.equal(authFromFile(tempHome), 'api-456');
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'openai-789', RUIJIE_UNIAPI_KEY: 'api-456', tokens: { access_token: 'token-123' } }), 'utf8');
    assert.equal(authFromFile(tempHome), 'api-456');
    fs.writeFileSync(path.join(tempHome, 'auth.json'), JSON.stringify({ RUIZHI_API_KEY: 'ruizhi-101', OPENAI_API_KEY: 'openai-789', tokens: { access_token: 'token-123' } }), 'utf8');
    assert.equal(authFromFile(tempHome), 'ruizhi-101');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Windows early bootstrap defines auth env sync before calling it', () => {
  const source = fs.readFileSync('scripts/windows-asar-overrides.mjs', 'utf8');
  const preludeStart = source.indexOf('const prelude = `');
  const syncDefinition = source.indexOf('function syncRuijieUniApiKeyEnvFromAuth()', preludeStart);
  const syncCall = source.indexOf('syncRuijieUniApiKeyEnvFromAuth();', preludeStart);
  const watchCall = source.indexOf('watchRuijieAuthEnvFromAuth();', preludeStart);
  assert.ok(preludeStart >= 0, 'Windows early bootstrap prelude not found');
  assert.ok(syncDefinition > preludeStart, 'auth env sync definition not found in early bootstrap prelude');
  assert.ok(syncCall > syncDefinition, 'auth env sync is called before it is defined');
  assert.ok(watchCall > syncCall, 'auth env watcher is not enabled after initial sync');
});

test('Windows conversation auth never participates in login or onboarding routing', () => {
  const buildSource = fs.readFileSync('scripts/build-windows.mjs', 'utf8');
  const overrideSource = fs.readFileSync('scripts/windows-asar-overrides.mjs', 'utf8');
  const toastStart = overrideSource.indexOf('export function patchRuizhiAuthToastSource');
  const toastEnd = overrideSource.indexOf('function patchChatGptAuthExternalBrowser', toastStart);
  const toastSource = overrideSource.slice(toastStart, toastEnd);

  assert.ok(toastStart >= 0 && toastEnd > toastStart, 'auth toast patch source not found');
  assert.match(toastSource, /\.get\(Ai\)\.danger/);
  assert.match(toastSource, /danger\(\\`当前未登录或者登录过期，请重新登录\\`,\{description:\\`即将跳转到登录界面\\`\}\)/);
  assert.match(toastSource, /conversationRoute=i\.routeKind===\\`client-local-thread\\`/);
  assert.match(toastSource, /if\(!conversationRoute\|\|toastStore==null/);
  assert.match(toastSource, /sendMessageFromView\?\.\(\{type:\\`log-out\\`\}\)/);
  assert.match(toastSource, /logoutTimer=setTimeout/);
  assert.doesNotMatch(toastSource, /__RUIZHI_FORCE_LOGIN__|ruizhiAuthRouteGuard|resetToLogin|app\.relaunch|app\.exit|showMessageBox/);
  assert.doesNotMatch(buildSource, /function verifyConversationAuth\(\)/);
  assert.doesNotMatch(overrideSource, /function ruizhiVerifyConversationAuth\(\)/);
  assert.match(overrideSource, /ruizhiMainAuthIpcRegistered/);
  assert.match(overrideSource, /electron\.ipcMain\.handle\(\\`ruizhi:auth:get\\`/);
});

test('Windows app-server mirrors Ruizhi OAuth tokens into all provider API key variables', () => {
  const source = fs.readFileSync('scripts/windows-asar-overrides.mjs', 'utf8');
  const helperStart = source.indexOf('function ruizhiInjectAuthEnvironment(options)');
  const helperEnd = source.indexOf('case\\`process-start\\`', helperStart);
  const helperSource = source.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(helperSource, /env\.RUIZHI_HOME\|\|process\.env\.RUIZHI_HOME\|\|env\.CODEX_HOME/);
  assert.match(helperSource, /oauthKey=String\(auth\?\.tokens\?\.access_token\|\|auth\?\.access_token/);
  assert.match(helperSource, /env\.OPENAI_API_KEY=env\.OPENAI_API_KEY\|\|providerKey/);
  assert.match(source, /ruizhiProviderKeyMirrorsOpenAiApiKey/);
  assert.match(source, /spawn\(ruizhiInjectAuthEnvironment\(\$3\)\)/);
});

test('legacy .ruizhi auth.json formats remain readable without manual migration', () => {
  const source = fs.readFileSync('scripts/windows-asar-overrides.mjs', 'utf8');
  assert.match(source, /auth\?\.RUIJIE_UNIAPI_KEY/);
  assert.match(source, /auth\?\.RUIZHI_API_KEY/);
  assert.match(source, /auth\?\.OPENAI_API_KEY/);
  assert.match(source, /auth\?\.tokens\?\.access_token/);
  assert.match(source, /auth\?\.access_token/);
  assert.match(source, /ruizhiLegacyApiKeyFromConfig/);
  assert.match(source, /\[model_providers\.ruijie-uniapi\]/);
  assert.match(source, /legacyApiKey/);
  assert.doesNotMatch(source, /key==="api_key"\|\|key==="chat_model_prefixes"/);
  assert.match(source, /insertTopLevelTomlKeyIfMissing\(existing,\"chatgpt_login_base_url\"/);
  assert.match(source, /insertTopLevelTomlKeyIfMissing\(withLoginBase,\"model_catalog_json\"/);
});
