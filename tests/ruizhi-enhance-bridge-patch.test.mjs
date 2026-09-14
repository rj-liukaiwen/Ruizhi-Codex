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

test("Windows asar patch injects enhance bridge and runtime service", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /ruizhi:enhance:call/);
  assert.match(source, /ruizhi-enhance-service\.cjs/);
  assert.match(source, /ruizhi-page-enhance\.js/);
  assert.match(source, /enhance:\s*\{/);
});

test("packaging scripts expose the enhance bridge on preload", () => {
  for (const scriptPath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs"]) {
    const source = read(scriptPath);
    assert.match(source, /ruizhi:enhance:call/, `${scriptPath} should register enhance IPC`);
    assert.match(source, /enhance:\s*\{/, `${scriptPath} should expose window.ruizhiDesktop.enhance`);
    assert.doesNotMatch(
      source,
      /!pageEnhanceConfig\.enabled\|\|!fs\.existsSync\(servicePath\)/,
      `${scriptPath} must keep the core model service available when page enhancement UI is disabled`,
    );
  }
});


test("Windows packages the usage bridge service even when page enhancement UI is disabled", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.match(source, /copyCoreEnhanceServiceResource/);
  assert.match(source, /bridge", "ruizhi-enhance-service\.cjs"/);
  assert.match(source, /pageEnhanceEnabled === false\s*\? copyCoreEnhanceServiceResource/s);
  assert.doesNotMatch(source, /files: 0/);
});


test("Windows preload keeps the usage bridge when page enhancement UI is disabled", () => {
  const source = read("scripts/windows-asar-overrides.mjs");

  assert.doesNotMatch(source, /if \(!pageEnhanceEnabled\(config\)\)[\s\S]*?return;/);
  assert.match(source, /preloadPageEnhanceFallbackSnippet/);
  assert.match(source, /__RUIZHI_INSTALL_WALLET_DETAILS__/);
  assert.match(source, /ruizhi:enhance:call/);
});
