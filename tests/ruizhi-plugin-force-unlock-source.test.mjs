import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("renderer page enhance carries plugin force unlock and first-scope feature markers", () => {
  const source = read("resources/renderer/ruizhi-page-enhance.js");

  assert.match(source, /RUIZHI_PLUGIN_ENTRY_UNLOCK_V1/);
  assert.match(source, /RUIZHI_FORCE_PLUGIN_INSTALL_V1/);
  assert.match(source, /codex-force-install-unlocked/);
  assert.match(source, /强制安装/);
  assert.match(source, /RUIZHI_SESSION_ACTIONS_V1/);
  assert.match(source, /RUIZHI_CONVERSATION_TIMELINE_V1/);
  assert.match(source, /RUIZHI_THREAD_SCROLL_RESTORE_V1/);
  assert.match(source, /RUIZHI_THREAD_SORT_FIX_V1/);
  assert.doesNotMatch(source, /插件\s+-\s+已解锁/);
  assert.doesNotMatch(source, /Plugins\s+-\s+Unlocked/);
  assert.doesNotMatch(source, /setAuthMethod\("chatgpt"\)/);
  assert.doesNotMatch(source, /spoofChatGPTAuthMethod/);
});

test("plugin pending-support patch is gated by forcePluginInstall configuration", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /forcePluginInstall/);
  assert.match(source, /pendingSupport/);
  assert.match(source, /ruizhiForcePluginInstallEnabled/);
});
