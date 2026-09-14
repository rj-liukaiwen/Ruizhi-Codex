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

test("macOS automatic update checks are disabled", () => {
  const config = JSON.parse(read("config/rj-codex.json"));

  assert.equal(config.updates.macos.enabled, false);
  assert.equal(config.updates.macos.manifestUrl, "");
  assert.equal(config.updates.macos.downloadBaseUrl, "");
});

test("macOS build removes stale electron-updater config when updates are disabled", () => {
  const source = read("scripts/build-macos.mjs");

  assert.match(source, /const appUpdatePath = path\.join\(appResourcesDir\(\), "app-update\.yml"\);/);
  assert.match(source, /fs\.rmSync\(appUpdatePath, \{ force: true \}\);/);
  assert.match(source, /macOS 更新已禁用，已移除 app-update\.yml/);
});
