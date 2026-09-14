import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  patchCodexLoginSuccessBinary,
  patchCodexLoginSuccessBuffer,
} from "../scripts/codex-login-success-branding.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const legacyHtml = [
  "<title>Signed in to Codex</title>",
  '<div class="title">Signed in to Codex</div>',
  '<div class="setup-description">You may now close this page</div>',
].join("\n");

const currentHtml = [
  "<title>Signed in to Codex</title>",
  '<p class="message" id="status-message">You&rsquo;re signed in and may close this tab</p>',
].join("\n");

test("Codex login success branding patches legacy and current embedded pages without changing binary size", () => {
  const fixture = Buffer.from(`prefix\0${legacyHtml}\0${currentHtml}\0suffix`, "utf8");
  const patched = patchCodexLoginSuccessBuffer(fixture, {
    title: "锐捷Codex",
    legacyMessage: "授权完成，关闭本页",
    currentMessage: "授权成功，可以关闭本页面",
  });

  assert.equal(patched.buffer.length, fixture.length);
  assert.equal(patched.replacements.title, 3);
  assert.equal(patched.replacements.legacyMessage, 1);
  assert.equal(patched.replacements.currentMessage, 1);
  assert.doesNotMatch(patched.buffer.toString("utf8"), /Signed in to Codex/);
  assert.doesNotMatch(patched.buffer.toString("utf8"), /You may now close this page/);
  assert.doesNotMatch(patched.buffer.toString("utf8"), /You&(?:amp;)?rsquo;re signed in/);
  assert.match(patched.buffer.toString("utf8"), /锐捷Codex/);
  assert.match(patched.buffer.toString("utf8"), /授权成功，可以关闭本页面/);
});

test("Codex login success branding patches a binary file in place", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-login-success-"));
  const binaryPath = path.join(tempDir, "codex.bin");
  const fixture = Buffer.from(`prefix\0${legacyHtml}\0suffix`, "utf8");
  fs.writeFileSync(binaryPath, fixture);

  try {
    const result = patchCodexLoginSuccessBinary(binaryPath, {
      title: "锐捷Codex",
      legacyMessage: "授权完成，关闭本页",
      currentMessage: "授权成功，可以关闭本页面",
    });
    const patched = fs.readFileSync(binaryPath);

    assert.equal(patched.length, fixture.length);
    assert.equal(result.replacements.title, 2);
    assert.equal(result.replacements.legacyMessage, 1);
    assert.match(patched.toString("utf8"), /锐捷Codex/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex login success branding fails clearly when no supported page exists", () => {
  assert.throws(
    () => patchCodexLoginSuccessBuffer(Buffer.from("no login page here"), {
      title: "锐捷Codex",
      legacyMessage: "授权完成，关闭本页",
      currentMessage: "授权成功，可以关闭本页面",
    }),
    /没有找到 Codex OAuth 成功页文案/,
  );
});

test("both platform builders apply the shared Codex login success binary patch before signing or packaging", () => {
  const windowsSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-windows.mjs"), "utf8");
  const macosSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-macos.mjs"), "utf8");

  assert.match(windowsSource, /patchCodexLoginSuccessBinary/);
  assert.match(windowsSource, /path\.join\(appOutRoot, "resources", "codex\.exe"\)/);
  assert.match(macosSource, /patchCodexLoginSuccessBinary/);
  assert.match(macosSource, /path\.join\(appOutRoot, "Contents", "Resources", "codex"\)/);
  assert.ok(
    macosSource.indexOf("patchCodexLoginSuccessBinary") < macosSource.lastIndexOf("signApp()"),
    "macOS must patch the embedded page before signing",
  );
});

test("macOS re-signs the patched embedded Codex before probing or packaging it", () => {
  const macosSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-macos.mjs"), "utf8");
  const patchCall = macosSource.lastIndexOf("patchCodexLoginSuccessBinary(");
  const preliminarySignCall = macosSource.indexOf("signEmbeddedCodex(\"-\")", patchCall);
  const runtimeProbeCall = macosSource.indexOf("copyRuntimeOverrides(", patchCall);

  assert.match(
    macosSource,
    /function signEmbeddedCodex\(identity\)[\s\S]*?codesign[\s\S]*?--verify/,
    "the builder must explicitly sign and verify the executable stored under Contents/Resources",
  );
  assert.ok(
    preliminarySignCall > patchCall && preliminarySignCall < runtimeProbeCall,
    "the patched executable must be re-signed before later packaging steps can publish it",
  );
  assert.match(
    macosSource.slice(macosSource.indexOf("function signApp()"), macosSource.indexOf("function notaryPrivateKeyContent")),
    /signEmbeddedCodex\([\s\S]*?codesign[\s\S]*?appOutRoot/,
    "the final app signing stage must explicitly sign embedded Codex with the selected identity before signing the bundle",
  );
});

test("macOS publishes only a fully signed Codex at the final app path", () => {
  const macosSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-macos.mjs"), "utf8");
  const signingHelper = macosSource.slice(
    macosSource.indexOf("function signEmbeddedCodex(identity)"),
    macosSource.indexOf("function signApp()"),
  );

  assert.match(signingHelper, /signingPath/);
  assert.match(
    signingHelper,
    /codesign[\s\S]*?--verify[\s\S]*?renameSync\(signingPath, codexPath\)/,
    "the builder must sign and verify a staged inode before atomically replacing the executable used by the app",
  );
});

test("macOS reads the client version before patching and leaves runtime QA to a clean process", () => {
  const macosSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-macos.mjs"), "utf8");
  const mainSource = macosSource.slice(macosSource.indexOf("async function main()"));
  const sourceVersionRead = mainSource.indexOf("const sourceCodexClientVersion = codexClientVersionFromExe(");
  const patchCall = mainSource.indexOf("patchCodexLoginSuccessBinary(");
  const signingHelper = macosSource.slice(
    macosSource.indexOf("function signEmbeddedCodex(identity)"),
    macosSource.indexOf("function signApp()"),
  );

  assert.ok(
    sourceVersionRead >= 0 && sourceVersionRead < patchCall,
    "the builder must read the client version from the untouched source executable before changing signed pages",
  );
  assert.match(mainSource, /copyRuntimeOverrides\(sourceCodexClientVersion\)/);
  assert.doesNotMatch(signingHelper, /--version/);
});
