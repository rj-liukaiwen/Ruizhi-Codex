import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { patchDesktopAuthAllowedUrlsSource, patchNativeKeymapBindingsFallbackSource } = await import("../scripts/windows-asar-overrides.mjs");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function unsignedJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

test("platform usage maps billing cents to a wallet remaining percentage without a reset window", async () => {
  // Given: a real HTTP boundary that exposes the two OAuth-compatible billing endpoints.
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/dashboard/billing/usage") {
      response.end(JSON.stringify({ object: "list", total_usage: 94778.8916 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      response.end(JSON.stringify({ object: "billing_subscription", hard_limit_usd: 2739.726028 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-"));
  fs.writeFileSync(
    path.join(tmpHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-oauth-token" } }),
  );

  try {
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
    });

    // When: the desktop usage bridge requests the current user's platform usage.
    const result = await service.call("/usage/platform");

    // Then: units are normalized and the native Codex rate-limit contract is returned.
    assert.equal(result.status, "ok");
    assert.equal(result.data.rate_limit.primary_window.used_percent, 34.59429542638925);
    assert.equal(result.data.rate_limit.primary_window.limit_window_seconds, -60);
    assert.equal(result.data.rate_limit.primary_window.reset_at, null);
    assert.equal(result.data.credits.balance, 1791.937112);
    assert.equal(result.metadata.used_usd, 947.788916);
    assert.equal(result.metadata.limit_usd, 2739.726028);
    assert.deepEqual(
      requests.toSorted((left, right) => left.url.localeCompare(right.url)),
      [
        { authorization: "Bearer test-oauth-token", url: "/v1/dashboard/billing/subscription" },
        { authorization: "Bearer test-oauth-token", url: "/v1/dashboard/billing/usage" },
      ],
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});


test("platform usage prefers API key fallback from ~/.codex over stale OAuth tokens", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ authorization: request.headers.authorization, url: request.url });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/dashboard/billing/usage") {
      response.end(JSON.stringify({ total_usage: 1234 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      response.end(JSON.stringify({ hard_limit_usd: 100 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-codex-fallback-"));
  const tmpHome = path.join(tmpRoot, ".ruizhi");
  const tmpCodexHome = path.join(tmpRoot, ".codex");
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(tmpCodexHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "stale-oauth-token" } }));
  fs.writeFileSync(path.join(tmpCodexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-oauth-working-key" }));
  const previousHome = process.env.USERPROFILE;
  const previousUserProfile = process.env.USERPROFILE;
  const previousHomedrive = process.env.HOMEDRIVE;
  const previousHomepath = process.env.HOMEPATH;
  process.env.USERPROFILE = tmpRoot;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = tmpRoot;

  try {
    const { createRuizhiEnhanceService } = require(path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"));
    const service = createRuizhiEnhanceService({ codexHome: tmpHome, platformBaseUrl: `http://127.0.0.1:${address.port}` });
    const result = await service.call("/usage/platform");

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 12.34);
    assert.ok(requests.every((request) => request.authorization === "Bearer sk-oauth-working-key"));
  } finally {
    process.env.USERPROFILE = previousUserProfile;
    if (previousHomedrive == null) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = previousHomedrive;
    if (previousHomepath == null) delete process.env.HOMEPATH; else process.env.HOMEPATH = previousHomepath;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
test("platform usage accepts an isolated runtime backend override", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/dashboard/billing/usage") {
      response.end(JSON.stringify({ total_usage: 2500 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      response.end(JSON.stringify({ hard_limit_usd: 100 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-env-"));
  fs.writeFileSync(
    path.join(tmpHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "local-oauth-token" } }),
  );
  const previousBaseUrl = process.env.RUIZHI_PLATFORM_BASE_URL;

  try {
    process.env.RUIZHI_PLATFORM_BASE_URL = `http://127.0.0.1:${address.port}`;
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({ codexHome: tmpHome });
    const result = await service.call("/usage/platform");

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 25);
    assert.equal(result.metadata.limit_usd, 100);
    assert.equal(result.metadata.remaining_usd, 75);
    assert.equal(result.metadata.window_kind, "wallet");
    assert.equal(result.data.rate_limit.primary_window.used_percent, 25);
  } finally {
    if (previousBaseUrl === undefined) delete process.env.RUIZHI_PLATFORM_BASE_URL;
    else process.env.RUIZHI_PLATFORM_BASE_URL = previousBaseUrl;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("platform usage refreshes an expired OAuth access token after HTTP 401", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "" });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/dashboard/billing/usage" && request.headers.authorization === "Bearer expired-token") {
      response.statusCode = 401;
      response.end(JSON.stringify({ error: "expired" }));
      return;
    }
    if (request.url === "/oauth/token") {
      response.end(JSON.stringify({ access_token: "fresh-token", refresh_token: "fresh-refresh-token" }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/usage" && request.headers.authorization === "Bearer fresh-token") {
      response.end(JSON.stringify({ total_usage: 500 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      response.end(JSON.stringify({ hard_limit_usd: 20 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-refresh-"));
  const authPath = path.join(tmpHome, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "expired-token", refresh_token: "old-refresh-token" } }),
  );

  try {
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const result = await service.call("/usage/platform");
    const savedAuth = JSON.parse(fs.readFileSync(authPath, "utf8"));

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 5);
    assert.equal(result.metadata.limit_usd, 20);
    assert.equal(savedAuth.tokens.access_token, "fresh-token");
    assert.equal(savedAuth.tokens.refresh_token, "fresh-refresh-token");
    assert.equal(requests.some((request) => request.url === "/oauth/token" && request.method === "POST"), true);
    assert.equal(requests.some((request) => request.url === "/v1/dashboard/billing/usage" && request.authorization === "Bearer fresh-token"), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("platform usage works when the packaged macOS runtime has no global fetch", async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/dashboard/billing/usage") {
      response.end(JSON.stringify({ total_usage: 1250 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      response.end(JSON.stringify({ hard_limit_usd: 50 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-no-fetch-"));
  fs.writeFileSync(
    path.join(tmpHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "no-fetch-token" } }),
  );
  const previousFetch = globalThis.fetch;

  try {
    globalThis.fetch = undefined;
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const result = await service.call("/usage/platform");

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 12.5);
    assert.equal(result.metadata.limit_usd, 50);
    assert.equal(result.metadata.remaining_usd, 37.5);
  } finally {
    globalThis.fetch = previousFetch;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("platform usage network failures return a failed result instead of rejecting IPC", async () => {
  const server = http.createServer((_request, response) => {
    response.end("unused");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-failed-"));
  fs.writeFileSync(
    path.join(tmpHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-oauth-token" } }),
  );

  try {
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${port}`,
    });

    await assert.doesNotReject(() => service.call("/usage/platform"));
    const result = await service.call("/usage/platform");
    assert.equal(result.status, "failed");
    assert.match(result.message, /127\.0\.0\.1|fetch failed|ECONNREFUSED|HTTP/);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("platform usage refreshes an expired OAuth token before requesting billing data", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiredToken = unsignedJwt({ exp: now - 120, sub: "user-1" });
  const refreshedToken = unsignedJwt({ exp: now + 3600, sub: "user-1" });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/oauth/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "refresh-token-1");
        assert.equal(form.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
        response.end(JSON.stringify({
          access_token: refreshedToken,
          id_token: refreshedToken,
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "Bearer",
        }));
      });
      return;
    }
    if (request.url === "/v1/dashboard/billing/usage") {
      assert.equal(request.headers.authorization, `Bearer ${refreshedToken}`);
      response.end(JSON.stringify({ total_usage: 1234 }));
      return;
    }
    if (request.url === "/v1/dashboard/billing/subscription") {
      assert.equal(request.headers.authorization, `Bearer ${refreshedToken}`);
      response.end(JSON.stringify({ hard_limit_usd: 50 }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-refresh-"));
  const authPath = path.join(tmpHome, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: expiredToken,
        refresh_token: "refresh-token-1",
      },
    }),
  );

  try {
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const result = await service.call("/usage/platform");
    const updatedAuth = JSON.parse(fs.readFileSync(authPath, "utf8"));

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 12.34);
    assert.equal(result.metadata.limit_usd, 50);
    assert.equal(updatedAuth.tokens.access_token, refreshedToken);
    assert.equal(updatedAuth.tokens.refresh_token, "refresh-token-2");
    assert.equal(typeof updatedAuth.last_refresh, "string");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].url, "/oauth/token");
    assert.deepEqual(
      new Set(requests.slice(1).map((request) => `${request.method} ${request.url}`)),
      new Set(["GET /v1/dashboard/billing/usage", "GET /v1/dashboard/billing/subscription"]),
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("platform usage refreshes and retries when billing endpoints reject the cached token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const cachedToken = unsignedJwt({ exp: now + 3600, sub: "user-1" });
  const refreshedToken = unsignedJwt({ exp: now + 7200, sub: "user-1" });
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      method: request.method,
      authorization: request.headers.authorization,
      url: request.url,
    });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/oauth/token") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        assert.equal(form.get("grant_type"), "refresh_token");
        assert.equal(form.get("refresh_token"), "refresh-token-1");
        response.end(JSON.stringify({
          access_token: refreshedToken,
          refresh_token: "refresh-token-2",
          expires_in: 7200,
          token_type: "Bearer",
        }));
      });
      return;
    }
    if (request.url === "/v1/dashboard/billing/usage" || request.url === "/v1/dashboard/billing/subscription") {
      if (request.headers.authorization === `Bearer ${cachedToken}`) {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: { message: "expired token" } }));
        return;
      }
      assert.equal(request.headers.authorization, `Bearer ${refreshedToken}`);
      response.end(JSON.stringify(
        request.url.endsWith("/usage") ? { total_usage: 4321 } : { hard_limit_usd: 100 },
      ));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-platform-usage-401-refresh-"));
  const authPath = path.join(tmpHome, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: cachedToken,
        refresh_token: "refresh-token-1",
      },
    }),
  );

  try {
    const { createRuizhiEnhanceService } = require(
      path.join(projectRoot, "resources", "bridge", "ruizhi-enhance-service.cjs"),
    );
    const service = createRuizhiEnhanceService({
      codexHome: tmpHome,
      platformBaseUrl: `http://127.0.0.1:${address.port}`,
    });
    const result = await service.call("/usage/platform");
    const updatedAuth = JSON.parse(fs.readFileSync(authPath, "utf8"));

    assert.equal(result.status, "ok");
    assert.equal(result.metadata.used_usd, 43.21);
    assert.equal(updatedAuth.tokens.access_token, refreshedToken);
    assert.equal(updatedAuth.tokens.refresh_token, "refresh-token-2");
    assert.equal(requests.filter((request) => request.method === "POST" && request.url === "/oauth/token").length, 1);
    assert.equal(requests.some((request) => request.authorization === `Bearer ${cachedToken}`), true);
    assert.equal(requests.some((request) => request.authorization === `Bearer ${refreshedToken}`), true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test("desktop builders expose one build-time backend contract for isolated local packages", () => {
  for (const scriptPath of ["scripts/build-macos.mjs", "scripts/build-windows.mjs"]) {
    const source = read(scriptPath);
    assert.match(source, /RUIZHI_BUILD_API_BASE_URL/, `${scriptPath} should override the model API base URL`);
    assert.match(source, /RUIZHI_BUILD_PROVIDER_BASE_URL/, `${scriptPath} should override the provider base URL`);
    assert.match(source, /RUIZHI_BUILD_CHATGPT_LOGIN_BASE_URL/, `${scriptPath} should override the OAuth issuer`);
    assert.match(source, /process\.env\.RUIZHI_PLATFORM_BASE_URL=chatGptBackendApiBaseUrl/, `${scriptPath} should publish the usage backend at runtime`);
    assert.match(source, /platformBaseUrl:process\.env\.RUIZHI_PLATFORM_BASE_URL/, `${scriptPath} should avoid a cross-scope bootstrap reference`);
  }

  const windowsOverrides = read("scripts/windows-asar-overrides.mjs");
  assert.match(windowsOverrides, /RUIZHI_BUILD_API_BASE_URL/);
  assert.match(windowsOverrides, /RUIZHI_BUILD_PROVIDER_BASE_URL/);
  assert.match(windowsOverrides, /RUIZHI_BUILD_CHATGPT_LOGIN_BASE_URL/);
  assert.match(windowsOverrides, /process\.env\.RUIZHI_PLATFORM_BASE_URL=chatGptBackendApiBaseUrl/);
  assert.match(windowsOverrides, /platformBaseUrl:process\.env\.RUIZHI_PLATFORM_BASE_URL/);
  assert.match(windowsOverrides, /11369540-using-codex-with-your-chatgpt-plan/);
  assert.match(windowsOverrides, /buildChatGptLoginBaseUrl\(config\)\}\/dashboard\/overview|chatGptLoginBaseUrl\(config\)\}\/console|buildChatGptLoginBaseUrl\(config\)\}\/console|buildChatGptLoginBaseUrl\}\/console/);

  const macosBuilder = read("scripts/build-macos.mjs");
  assert.match(macosBuilder, /11369540-using-codex-with-your-chatgpt-plan/);
  assert.match(macosBuilder, /buildChatGptLoginBaseUrl\}\/dashboard\/overview/);
});

test("local desktop packages isolate account and user data when launched directly", () => {
  // Given: both platform builders can emit a local-test package next to the production package.
  for (const scriptPath of ["scripts/build-macos.mjs", "scripts/build-windows.mjs"]) {
    const source = read(scriptPath);

    // When: the package is built with isolated runtime directory names.
    // Then: a direct app launch must not reuse the production account or Electron profile.
    assert.match(source, /RUIZHI_BUILD_HOME_DIR_NAME/, `${scriptPath} should override the Ruizhi account home`);
    assert.match(source, /RUIZHI_BUILD_ELECTRON_USER_DATA_DIR_NAME/, `${scriptPath} should override Electron user data`);
    assert.match(source, /resolveBuildDirectoryName/, `${scriptPath} should reject unsafe directory overrides`);
  }
});

test("usage settings renders exact wallet totals instead of only a remaining percentage", () => {
  // Given: the platform bridge already returns exact USD totals in its metadata.
  const detailsPath = path.join(projectRoot, "resources", "renderer", "ruizhi-wallet-details.js");

  // When: the renderer enhancement is packaged for the native Usage settings page.
  // Then: it must expose every amount needed for an auditable wallet summary.
  assert.equal(fs.existsSync(detailsPath), true, "wallet details renderer should exist");
  const source = fs.readFileSync(detailsPath, "utf8");
  assert.match(source, /\/usage\/platform/);
  assert.match(source, /metadata\.limit_usd/);
  assert.match(source, /metadata\.used_usd/);
  assert.match(source, /metadata\.remaining_usd/);
  assert.match(source, /\u603b\u989d\u5ea6/);
  assert.match(source, /\u5df2\u4f7f\u7528/);
  assert.match(source, /\u5269\u4f59\u4f59\u989d/);
  assert.match(source, /\u4f7f\u7528\u6bd4\u4f8b/);
  assert.match(source, /isUsageSettingsPage/);
  assert.match(source, /\/settings\/usage/);
  assert.match(source, /\u4f7f\u7528\u60c5\u51b5\u548c\u8ba1\u8d39/);
  assert.match(source, /findInsertionTarget/);
  assert.match(source, /findUsageSettingsContainer/);
  assert.match(source, /hideNativeLoadError/);
  assert.match(source, /lastAttemptAt/);
  assert.match(source, /rescanEvents/);
});

test("usage settings wallet details render even when native usage rows fail", () => {
  // Given: the native OpenAI usage settings bundle can fail before rendering
  // its built-in quota row.
  const source = read("resources/renderer/ruizhi-wallet-details.js");

  // When: the Ruizhi renderer scans the settings route.
  // Then: it must use the page container as a fallback insertion target instead
  // of requiring the native `璐︽埛棰濆害` row to already exist.
  assert.match(source, /function isUsageSettingsPage\(\)/);
  assert.match(source, /currentRouteText\(\)\.includes\("\/settings\/usage"\)/);
  assert.match(source, /function findUsageSettingsContainer\(\)/);
  assert.match(source, /document\.querySelector\("main,\[role='main'\]"\) \|\| document\.body/);
  assert.match(source, /const walletCard = findWalletCard\(\)/);
  assert.match(source, /const usageContainer = findUsageSettingsContainer\(\)/);
  assert.match(source, /createRoot\(target\)/);
  assert.match(source, /\\u65e0\\u6cd5\\u52a0\\u8f7d\\u4f7f\\u7528\\u8bbe\\u7f6e/);
  assert.match(source, /Couldn\.\?t load usage settings/);
  assert.match(source, /root\.dataset\.status === "error"/);
  assert.match(source, /visibilitychange/);
});

test("wallet details stay confined to the usage settings route", () => {
  const source = read("resources/renderer/ruizhi-wallet-details.js");

  assert.match(source, /function isUsageSettingsPage\(\)\s*\{\s*return currentRouteText\(\)\.includes\("\/settings\/usage"\);\s*\}/s);
  assert.match(source, /function findInsertionTarget\(\)\s*\{\s*if \(!isUsageSettingsPage\(\)\) return null;/s);
});

test("usage settings wallet details hide stale errors once native rows render", () => {
  const source = read("resources/renderer/ruizhi-wallet-details.js");

  assert.match(source, /root\.dataset\.status === "error" && findWalletCard\(\)/);
  assert.match(source, /removeDetails\(\);\s*hideNativeLoadError\(\);\s*return;/s);
  assert.match(source, /root\.dataset\.status = previousStatus;\s*if \(findWalletCard\(\)\)/s);
});

test("desktop packaging composes the wallet details renderer on both platforms", () => {
  // Given: macOS, Windows, and imported Windows asar builds share one renderer source contract.
  for (const scriptPath of [
    "scripts/build-macos.mjs",
    "scripts/build-windows.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);

    // When: packaging generates its preload integration.
    // Then: every path must use the shared source composer that includes wallet details.
    assert.match(source, /page-enhance-source\.mjs/, `${scriptPath} should import the shared renderer composer`);
    assert.match(source, /pageEnhanceRendererInstallerSource/, `${scriptPath} should inline the composed renderer source`);
  }
});

test("wallet details remain available when optional page enhancements are disabled", () => {
  // Given: production keeps the unrelated page-enhancement feature set disabled.
  assert.equal(JSON.parse(read("config/rj-codex.json")).pageEnhance.enabled, false);

  // When: preload integrations initialize the desktop bridge.
  // Then: the wallet installer must run independently of the optional page-enhancement gate.
  for (const scriptPath of [
    "scripts/build-macos.mjs",
    "scripts/build-windows.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);
    assert.match(source, /__RUIZHI_INSTALL_WALLET_DETAILS__/, `${scriptPath} should initialize wallet details directly`);
    assert.match(source, /onReady\(injectRuizhiWalletDetails\)/, `${scriptPath} should install wallet details on DOM readiness`);
  }
});

test("desktop fetch trusts the configured OAuth/API host without weakening the default allowlist", () => {
  const source = "isDesktopAuthAllowedUrl(e){let n=new URL(e).host.toLowerCase();return!!(n===`localhost`||n===`localhost:8000`||n===`openai.com`||n.endsWith(`.openai.com`))}";
  const patched = patchDesktopAuthAllowedUrlsSource(source, "http://127.0.0.1:3300");

  assert.match(patched, /n==="127\.0\.0\.1:3300"/);
  assert.match(patched, /n===`localhost`/);
  assert.match(patched, /n===`openai\.com`/);
  assert.match(patched, /ruizhiTrustedDesktopAuthHost:127\.0\.0\.1:3300/);
  assert.equal(patchDesktopAuthAllowedUrlsSource(patched, "http://127.0.0.1:3300"), patched);
});

test("packaging falls back when successful wham responses have incompatible shapes", () => {
  // Given: every supported packaging implementation.
  for (const scriptPath of [
    "scripts/build-macos.mjs",
    "scripts/build-windows.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);

    // When: the native profile and usage queries are patched.
    // Then: semantic shape checks activate local adapters after HTTP 200 HTML or flat JSON.
    assert.match(source, /patchNativePlatformUsageFallback/, `${scriptPath} should patch the native usage query`);
    assert.match(source, /\/usage\/platform/, `${scriptPath} should call the platform usage bridge`);
    assert.match(source, /ruizhiPlatformUsageBridgeFirst/, `${scriptPath} should not wait for the OpenAI usage endpoint before using the platform bridge`);
    assert.match(source, /ruizhiWalletQuotaWindow/, `${scriptPath} should render wallet balances without inventing a monthly reset`);
    assert.match(source, /ruizhiWalletQuotaSettingsLabel/, `${scriptPath} should label the settings row as a wallet quota`);
    assert.match(source, /rate_limit\?\.primary_window/, `${scriptPath} should validate the platform usage shape`);
    assert.match(source, /e\?\.stats/, `${scriptPath} should validate the profile response shape`);
    assert.match(source, /ruizhiProfileDropdownUsageForAllAuth/, `${scriptPath} should show usage for custom OAuth and API key accounts`);
  }
  for (const scriptPath of ["scripts/build-macos.mjs", "scripts/windows-asar-overrides.mjs"]) {
    const source = read(scriptPath);
    assert.match(source, /patchNativeExternalLinkHrefFallback/, `${scriptPath} should patch usage popover links with missing hrefs`);
    assert.match(source, /ruizhiExternalLinkHrefFallback/, `${scriptPath} should avoid crashing when a usage link href is absent`);
    assert.match(source, /ruizhiEmptyExternalLinkHidden/, `${scriptPath} should remove empty usage popover links`);
    assert.match(source, /patchNativeProfileDropdownUsageUpsell/, `${scriptPath} should patch the profile dropdown usage upsell row`);
    assert.match(source, /ruizhiProfileUsageUpsellHidden/, `${scriptPath} should remove the blank upsell row above learn more`);
  }
});

test("usage bridge remains available when optional page enhancements are disabled", () => {
  // Given: every supported packaging implementation can disable renderer-only enhancements.
  for (const scriptPath of [
    "scripts/build-macos.mjs",
    "scripts/build-windows.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = read(scriptPath);

    // When: the main process registers the backend bridge.
    // Then: only the service file controls availability; renderer feature flags must not disable usage.
    assert.doesNotMatch(
      source,
      /!pageEnhanceConfig\.enabled\|\|!fs\.existsSync\(servicePath\)/,
      `${scriptPath} should not disable the usage bridge with renderer feature flags`,
    );
  }
});

test("usage settings tolerates missing keymap bindings from local desktop state", () => {
  // Given: the native settings route can render hotkey labels before keymap state has hydrated.
  const source = "function E({commandId:e,keymapState:t,isMacOS:n}){let r=v(e);if(r==null||!y(r))return[];let i=t?.bindings.filter(t=>t.command===e);if(i!=null&&i.length>0)return i.map(e=>e.key);return T({commandId:e,isMacOS:n})}";

  // When: packaging patches the keymap helper.
  const patched = patchNativeKeymapBindingsFallbackSource(source);

  // Then: missing or malformed bindings become an empty list instead of throwing undefined.filter.
  assert.match(patched, /Array\.isArray\(t\?\.bindings\)\?t\.bindings\.filter/);
  assert.match(patched, /ruizhiKeymapBindingsFallback/);
  assert.equal(patchNativeKeymapBindingsFallbackSource(patched), patched);
  for (const scriptPath of [
    "scripts/build-macos.mjs",
    "scripts/build-windows.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const packagingSource = read(scriptPath);
    assert.match(packagingSource, /patchNativeKeymapBindingsFallback/, `${scriptPath} should patch keymap bindings before usage settings renders`);
  }
});

test("macOS rebuilds reuse a fresh official app download outside the cleaned source directory", () => {
  // Given: the macOS builder is commonly rerun several times while validating a release.
  const source = read("scripts/build-macos.mjs");

  // When: the downloaded official app is still fresh.
  // Then: it lives in a persistent work cache and is reused instead of downloading 587 MB again.
  assert.match(source, /downloadCacheDir/, "macOS builder should define a persistent download cache");
  assert.match(
    source,
    /path\.join\(projectRoot, "\.work", "download-cache", "macos"\)/,
    "download cache must live outside the work directory that every build cleans",
  );
  assert.match(source, /canReuseCachedDownload\(downloadPath\)/, "macOS builder should check cache reuse before downloading");
  assert.match(source, /RUIZHI_CODEX_DOWNLOAD_CACHE_MAX_AGE_MS/, "cache freshness should be configurable");
});

test("macOS rebuilds inspect the Mach-O binary behind an existing launcher wrapper", () => {
  // Given: an already-installed Ruizhi app uses ChatGPT -> ChatGPT.bin to isolate user data.
  const source = read("scripts/build-macos.mjs");

  // When: the app is reused as a same-version local build source.
  // Then: architecture and fuse operations target the real .bin executable, not the shell wrapper.
  assert.match(source, /wrappedExecutablePath = `\$\{plistExecutablePath\}\.bin`/);
  assert.match(source, /return fs\.existsSync\(wrappedExecutablePath\) \? wrappedExecutablePath : plistExecutablePath/);
  assert.match(source, /const executablePath = findMainExecutable\(\)/);
});
