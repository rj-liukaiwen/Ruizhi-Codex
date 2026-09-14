import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { patchCodexEnterprisePluginSource } from "../scripts/codex-enterprise-plugins-source.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function writeFixture(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

test("enterprise plugin list always uses configured local marketplaces", () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-enterprise-plugins-"));

  try {
    const pluginSourcePath = writeFixture(
      sourceRoot,
      "codex-rs/app-server/src/request_processors/plugins.rs",
      [
        "let explicit_marketplace_kinds = marketplace_kinds.is_some();",
        "let marketplace_kinds =",
        "    marketplace_kinds.unwrap_or_else(|| vec![PluginListMarketplaceKind::Local]);",
        "let include_local = marketplace_kinds.contains(&PluginListMarketplaceKind::Local);",
        "let include_vertical = marketplace_kinds.contains(&PluginListMarketplaceKind::Vertical);",
        "",
        "if !remote_sources.is_empty() {",
        "    match codex_core_plugins::remote::fetch_remote_marketplaces(",
        "        &remote_plugin_service_config,",
        "        auth.as_ref(),",
        "        &remote_sources,",
        "        /*global_catalog_cache_path*/ Some(config.codex_home.as_path()),",
        "    )",
        "    .await",
        "    {",
        "        Ok(remote_marketplaces) => {",
        "            let _ = remote_marketplaces;",
        "        }",
        "        Err(err) => {",
        "            let _ = err;",
        "        }",
        "    }",
        "}",
        "",
        "    async fn load_remote_installed_plugins(",
        "        &self,",
        "        plugins_manager: Arc<codex_core_plugins::PluginsManager>,",
        "        plugins_input: &codex_core_plugins::PluginsConfigInput,",
        "        visible_marketplaces: &[&str],",
        "        auth: Option<&CodexAuth>,",
        "    ) -> Vec<PluginMarketplaceEntry> {",
        "        let remote_marketplaces = if let Some(remote_marketplaces) = plugins_manager",
        "            .build_remote_installed_plugin_marketplaces_from_cache(visible_marketplaces)",
        "        {",
        "            Ok(remote_marketplaces)",
        "        } else {",
        "            plugins_manager",
        "                .build_and_cache_remote_installed_plugin_marketplaces(",
        "                    plugins_input,",
        "                    auth,",
        "                    visible_marketplaces,",
        "                    Some(self.effective_plugins_changed_callback()),",
        "                )",
        "                .await",
        "        };",
        "",
        "        match remote_marketplaces {",
        "            Ok(remote_marketplaces) => remote_marketplaces",
        "                .into_iter()",
        "                .map(remote_marketplace_to_info)",
        "                .collect(),",
        "            Err(",
        "                RemotePluginCatalogError::AuthRequired",
        "                | RemotePluginCatalogError::UnsupportedAuthMode,",
        "            ) => Vec::new(),",
        "            Err(err) => {",
        "                warn!(",
        "                    error = %err,",
        "                    \"plugin/installed remote installed plugin fetch failed; returning local marketplaces only\"",
        "                );",
        "                Vec::new()",
        "            }",
        "        }",
        "    }",
        "",
        "    async fn plugin_read_response(&self) {}",
        "",
        "fn remote_plugin_catalog_error_type(err: &RemotePluginCatalogError) -> &'static str {",
        "    match err {",
        "        RemotePluginCatalogError::UnexpectedStatus { .. } => \"remote_catalog_unexpected_status\",",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
    const remoteSourcePath = writeFixture(
      sourceRoot,
      "codex-rs/core-plugins/src/remote.rs",
      [
        "pub async fn fetch_openai_curated_remote_collection_marketplace(",
        "    config: &RemotePluginServiceConfig,",
        "    auth: Option<&CodexAuth>,",
        ") -> Result<Option<RemoteMarketplace>, RemotePluginCatalogError> {",
        "    fetch_openai(config, auth).await",
        "}",
        "",
        "fn build_remote_marketplace() {}",
        "",
      ].join("\n"),
    );

    const result = patchCodexEnterprisePluginSource(sourceRoot);
    const patched = fs.readFileSync(pluginSourcePath, "utf8");
    const patchedRemote = fs.readFileSync(remoteSourcePath, "utf8");

    assert.equal(result.changed, true);
    assert.match(patched, /let _requested_marketplace_kinds = marketplace_kinds;/);
    assert.match(patched, /let explicit_marketplace_kinds = true;/);
    assert.match(patched, /let marketplace_kinds = vec!\[PluginListMarketplaceKind::Local\];/);
    assert.match(patched, /let include_local = true;/);
    assert.match(patched, /let include_vertical = false;/);
    assert.doesNotMatch(patched, /marketplace_kinds\.unwrap_or_else/);
    assert.match(
      patchedRemote,
      /let _enterprise_remote_plugin_catalog_disabled = \(config, auth\);/,
    );
    assert.match(patchedRemote, /Ok\(None\)/);
    assert.doesNotMatch(patchedRemote, /fetch_openai\(config, auth\)/);
    assert.match(
      patched,
      /fn remote_plugin_catalog_error_is_unauthorized\(err: &RemotePluginCatalogError\) -> bool/,
    );
    assert.match(patched, /remote plugin catalog unauthorized; refreshing auth before retry/);
    assert.match(patched, /auth_manager\.refresh_token\(\)\.await/);
    assert.match(patched, /Some\(auth_manager\.auth\(\)\.await\)/);
    assert.match(patched, /fetch_remote_marketplaces_with_auth_refresh\(/);
    assert.match(patched, /self\.auth_manager\.as_ref\(\)/);
    assert.doesNotMatch(
      patched,
      /match codex_core_plugins::remote::fetch_remote_marketplaces\(\n\s*&remote_plugin_service_config,/,
    );

    const secondResult = patchCodexEnterprisePluginSource(sourceRoot);
    assert.equal(secondResult.changed, false);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test("both platform builders apply the enterprise plugin source patch", () => {
  for (const sourcePath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs"]) {
    const source = fs.readFileSync(path.join(projectRoot, sourcePath), "utf8");
    assert.match(source, /patchCodexEnterprisePluginSource/,
      `${sourcePath} should disable OpenAI remote plugin catalogs in the embedded Codex CLI`);
    assert.match(source, /ruizhi legacy skill migration failed/,
      `${sourcePath} should not let legacy skill migration block marketplace registration`);
  }
});

test("Ruizhi marketplace uses an isolated bundled local snapshot", () => {
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
  const marketplace = config.pluginMarketplaces.find((entry) => entry.name === "ruijie-marketplace");

  assert.ok(marketplace);
  assert.equal(marketplace.installPath, "plugins/marketplaces/ruijie-marketplace");
  assert.equal(marketplace.online.autoUpgrade, false);
});

test("coding mode label has a visible word separator", () => {
  const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
  assert.equal(config.productModes.coding, "锐捷 编码");

  for (const sourcePath of [
    "scripts/build-windows.mjs",
    "scripts/build-macos.mjs",
    "scripts/windows-asar-overrides.mjs",
  ]) {
    const source = fs.readFileSync(path.join(projectRoot, sourcePath), "utf8");
    assert.doesNotMatch(source, /锐捷编码/, `${sourcePath} should not contain the unspaced label`);
  }
});
