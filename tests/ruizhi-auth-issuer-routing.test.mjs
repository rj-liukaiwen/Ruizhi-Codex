import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchCodexAuthIssuerSource } from "../scripts/codex-auth-issuer-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("Codex source patch routes authorize, token refresh, and revoke to the Ruizhi issuer", () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-auth-issuer-"));
  const issuer = "https://gptauth.ruijie.com.cn";

  try {
    const serverPath = writeFixture(
      sourceRoot,
      "codex-rs/login/src/server.rs",
      'pub(super) const DEFAULT_ISSUER: &str = "https://auth.openai.com";\n',
    );
    const managerPath = writeFixture(
      sourceRoot,
      "codex-rs/login/src/auth/manager.rs",
      [
        'const REFRESH_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";',
        'pub(super) const REVOKE_TOKEN_URL: &str = "https://auth.openai.com/oauth/revoke";',
        "",
      ].join("\n"),
    );

    const result = patchCodexAuthIssuerSource(sourceRoot, issuer);

    assert.equal(result.issuer, issuer);
    assert.match(fs.readFileSync(serverPath, "utf8"), /DEFAULT_ISSUER: &str = "https:\/\/gptauth\.ruijie\.com\.cn"/);
    assert.match(fs.readFileSync(managerPath, "utf8"), /REFRESH_TOKEN_URL: &str = "https:\/\/gptauth\.ruijie\.com\.cn\/oauth\/token"/);
    assert.match(fs.readFileSync(managerPath, "utf8"), /REVOKE_TOKEN_URL: &str = "https:\/\/gptauth\.ruijie\.com\.cn\/oauth\/revoke"/);
    assert.doesNotMatch(fs.readFileSync(serverPath, "utf8"), /auth\.openai\.com/);
    assert.doesNotMatch(fs.readFileSync(managerPath, "utf8"), /auth\.openai\.com/);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("both platform builders rebuild the matching Codex CLI with the Ruizhi auth issuer patch", () => {
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
  const windowsSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-windows.mjs"), "utf8");
  const macosSource = fs.readFileSync(path.join(projectRoot, "scripts", "build-macos.mjs"), "utf8");

  assert.equal(config.codexCli.tag, "rust-v0.144.2");
  assert.equal(config.codexCli.rebuildByDefault, true);
  assert.equal(config.openai.chatGptLoginBaseUrl, "https://gptauth.ruijie.com.cn");

  for (const [platform, source] of [["Windows", windowsSource], ["macOS", macosSource]]) {
    assert.match(source, /patchCodexAuthIssuerSource/,
      `${platform} builder should patch the embedded Codex OAuth issuer`);
    assert.match(source, /buildPatchedCodexCli\(/,
      `${platform} builder should rebuild the embedded Codex CLI`);
  }
});
