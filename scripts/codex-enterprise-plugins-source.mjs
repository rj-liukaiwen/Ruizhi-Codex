import fs from "node:fs";
import path from "node:path";

const ENTERPRISE_LOCAL_MARKER = "let _requested_marketplace_kinds = marketplace_kinds;";
const ENTERPRISE_REMOTE_MARKER =
  "let _enterprise_remote_plugin_catalog_disabled = (config, auth);";
const REMOTE_PLUGIN_AUTH_REFRESH_MARKER =
  "remote plugin catalog unauthorized; refreshing auth before retry";
const REMOTE_PLUGIN_FETCH_MARKETPLACES_HELPER_MARKER =
  "async fn fetch_remote_marketplaces_with_auth_refresh(";

function patchPluginListSource(source) {
  if (source.includes(ENTERPRISE_LOCAL_MARKER)) {
    return source;
  }

  if (
    source.includes("let explicit_marketplace_kinds = marketplace_kinds.is_some();") &&
    source.includes("let include_local = marketplace_kinds.contains(&PluginListMarketplaceKind::Local);") &&
    source.includes("let include_vertical = marketplace_kinds.contains(&PluginListMarketplaceKind::Vertical);")
  ) {
    return source;
  }

  const pattern = /let explicit_marketplace_kinds = marketplace_kinds\.is_some\(\);\n\s*let marketplace_kinds =\n\s*marketplace_kinds\.unwrap_or_else\(\|\| vec!\[PluginListMarketplaceKind::Local\]\);\n\s*let include_local = marketplace_kinds\.contains\(&PluginListMarketplaceKind::Local\);\n\s*let include_vertical = marketplace_kinds\.contains\(&PluginListMarketplaceKind::Vertical\);/;
  if (!pattern.test(source)) {
    throw new Error("补丁点不存在：Codex 企业版本地插件目录");
  }

  return source.replace(
    pattern,
    [
      "let _requested_marketplace_kinds = marketplace_kinds;",
      "        let explicit_marketplace_kinds = true;",
      "        let marketplace_kinds = vec![PluginListMarketplaceKind::Local];",
      "        let include_local = true;",
      "        let include_vertical = false;",
    ].join("\n"),
  );
}

function patchRemotePluginSource(source) {
  if (source.includes(ENTERPRISE_REMOTE_MARKER)) {
    return source;
  }

  if (
    source.includes("pub async fn fetch_openai_curated_remote_collection_marketplace(") &&
    source.includes("build_remote_marketplace(")
  ) {
    return source;
  }

  const pattern = /pub async fn fetch_openai_curated_remote_collection_marketplace\(\n[\s\S]*?\n\}\n\nfn build_remote_marketplace/;
  if (!pattern.test(source)) {
    throw new Error("补丁点不存在：Codex OpenAI 远程插件目录");
  }

  return source.replace(
    pattern,
    [
      "pub async fn fetch_openai_curated_remote_collection_marketplace(",
      "    config: &RemotePluginServiceConfig,",
      "    auth: Option<&CodexAuth>,",
      ") -> Result<Option<RemoteMarketplace>, RemotePluginCatalogError> {",
      "    let _enterprise_remote_plugin_catalog_disabled = (config, auth);",
      "    Ok(None)",
      "}",
      "",
      "fn build_remote_marketplace",
    ].join("\n"),
  );
}

function patchPluginProcessorSource(source) {
  if (source.includes(REMOTE_PLUGIN_AUTH_REFRESH_MARKER)) {
    return source;
  }

  if (
    source.includes("Err(RemotePluginCatalogError::AuthRequired) => {}") &&
    source.includes("Err(RemotePluginCatalogError::UnsupportedAuthMode) => {}") &&
    source.includes("async fn load_remote_installed_plugins(") &&
    source.includes("build_remote_installed_plugin_marketplaces_from_cache(visible_marketplaces)")
  ) {
    return source;
  }

  const helperInsertionPoint = "fn remote_plugin_catalog_error_type(";
  if (!source.includes(helperInsertionPoint)) {
    throw new Error("补丁点不存在：Codex 远程插件 401 鉴权错误识别");
  }
  const sourceWithHelper = source.replace(
    helperInsertionPoint,
    [
      "fn remote_plugin_catalog_error_is_unauthorized(err: &RemotePluginCatalogError) -> bool {",
      "    matches!(",
      "        err,",
      "        RemotePluginCatalogError::UnexpectedStatus { status, .. } if status.as_u16() == 401",
      "    )",
      "}",
      "",
      "async fn refresh_remote_plugin_auth(",
      "    auth_manager: &AuthManager,",
      "    err: &RemotePluginCatalogError,",
      "    context: &str,",
      ") -> Option<Option<CodexAuth>> {",
      "    if !remote_plugin_catalog_error_is_unauthorized(err) {",
      "        return None;",
      "    }",
      "    match auth_manager.refresh_token().await {",
      "        Ok(()) => {",
      "            tracing::info!(",
      `                "${REMOTE_PLUGIN_AUTH_REFRESH_MARKER}"`,
      "            );",
      "            Some(auth_manager.auth().await)",
      "        }",
      "        Err(refresh_err) => {",
      "            warn!(",
      "                error = %err,",
      "                refresh_error = %refresh_err,",
      "                context = context,",
      "                \"remote plugin catalog auth refresh failed\"",
      "            );",
      "            None",
      "        }",
      "    }",
      "}",
      "",
      "async fn fetch_remote_marketplaces_with_auth_refresh(",
      "    auth_manager: &AuthManager,",
      "    remote_plugin_service_config: &RemotePluginServiceConfig,",
      "    initial_auth: Option<&CodexAuth>,",
      "    remote_sources: &[RemoteMarketplaceSource],",
      "    global_catalog_cache_path: Option<&std::path::Path>,",
      ") -> Result<Vec<codex_core_plugins::remote::RemoteMarketplace>, RemotePluginCatalogError> {",
      "    let mut current_auth = initial_auth.cloned();",
      "    let mut retried_after_refresh = false;",
      "    loop {",
      "        match codex_core_plugins::remote::fetch_remote_marketplaces(",
      "            remote_plugin_service_config,",
      "            current_auth.as_ref(),",
      "            remote_sources,",
      "            global_catalog_cache_path,",
      "        )",
      "        .await",
      "        {",
      "            Ok(remote_marketplaces) => return Ok(remote_marketplaces),",
      "            Err(err) if !retried_after_refresh => {",
      "                if let Some(refreshed_auth) = refresh_remote_plugin_auth(",
      "                    auth_manager,",
      "                    &err,",
      "                    \"plugin/list remote plugin catalog\",",
      "                )",
      "                .await",
      "                {",
      "                    retried_after_refresh = true;",
      "                    current_auth = refreshed_auth;",
      "                    continue;",
      "                }",
      "                return Err(err);",
      "            }",
      "            Err(err) => return Err(err),",
      "        }",
      "    }",
      "}",
      "",
      helperInsertionPoint,
    ].join("\n"),
  );

  const sourceWithListRetry = sourceWithHelper.replace(
    /codex_core_plugins::remote::fetch_remote_marketplaces\(\n\s*&remote_plugin_service_config,\n\s*auth\.as_ref\(\),\n\s*&remote_sources,\n\s*\/\*global_catalog_cache_path\*\/ Some\(config\.codex_home\.as_path\(\)\),\n\s*\)/,
    [
      "fetch_remote_marketplaces_with_auth_refresh(",
      "                self.auth_manager.as_ref(),",
      "                &remote_plugin_service_config,",
      "                auth.as_ref(),",
      "                &remote_sources,",
      "                /*global_catalog_cache_path*/ Some(config.codex_home.as_path()),",
      "            )",
    ].join("\n"),
  );
  if (!sourceWithListRetry.includes(REMOTE_PLUGIN_FETCH_MARKETPLACES_HELPER_MARKER)) {
    throw new Error("补丁点不存在：Codex 远程插件列表 401 刷新重试");
  }

  const pattern = /    async fn load_remote_installed_plugins\(\n[\s\S]*?\n    }\n\n    async fn plugin_read_response/;
  if (!pattern.test(sourceWithListRetry)) {
    throw new Error("补丁点不存在：Codex 远程已安装插件 401 刷新重试");
  }

  return sourceWithListRetry.replace(
    pattern,
    [
      "    async fn load_remote_installed_plugins(",
      "        &self,",
      "        plugins_manager: Arc<codex_core_plugins::PluginsManager>,",
      "        plugins_input: &codex_core_plugins::PluginsConfigInput,",
      "        visible_marketplaces: &[&str],",
      "        auth: Option<&CodexAuth>,",
      "    ) -> Vec<PluginMarketplaceEntry> {",
      "        let mut current_auth = auth.cloned();",
      "        let mut retried_after_refresh = false;",
      "",
      "        loop {",
      "            let remote_marketplaces = if !retried_after_refresh",
      "                && let Some(remote_marketplaces) = plugins_manager",
      "                    .build_remote_installed_plugin_marketplaces_from_cache(visible_marketplaces)",
      "            {",
      "                Ok(remote_marketplaces)",
      "            } else {",
      "                plugins_manager",
      "                    .build_and_cache_remote_installed_plugin_marketplaces(",
      "                        plugins_input,",
      "                        current_auth.as_ref(),",
      "                        visible_marketplaces,",
      "                        Some(self.effective_plugins_changed_callback()),",
      "                    )",
      "                    .await",
      "            };",
      "",
      "            match remote_marketplaces {",
      "                Ok(remote_marketplaces) => {",
      "                    return remote_marketplaces",
      "                        .into_iter()",
      "                        .map(remote_marketplace_to_info)",
      "                        .collect();",
      "                }",
      "                Err(",
      "                    RemotePluginCatalogError::AuthRequired",
      "                    | RemotePluginCatalogError::UnsupportedAuthMode,",
      "                ) => return Vec::new(),",
      "                Err(err)",
      "                    if remote_plugin_catalog_error_is_unauthorized(&err)",
      "                        && !retried_after_refresh =>",
      "                {",
      "                    retried_after_refresh = true;",
      "                    if let Some(refreshed_auth) = refresh_remote_plugin_auth(",
      "                        self.auth_manager.as_ref(),",
      "                        &err,",
      "                        \"plugin/installed remote installed plugins\",",
      "                    )",
      "                    .await",
      "                    {",
      "                        current_auth = refreshed_auth;",
      "                    } else {",
      "                        return Vec::new();",
      "                    }",
      "                }",
      "                Err(err) => {",
      "                    warn!(",
      "                        error = %err,",
      "                        \"plugin/installed remote installed plugin fetch failed; returning local marketplaces only\"",
      "                    );",
      "                    return Vec::new();",
      "                }",
      "            }",
      "        }",
      "    }",
      "",
      "    async fn plugin_read_response",
    ].join("\n"),
  );
}

export function patchCodexEnterprisePluginSource(codexSourceRoot) {
  const pluginSourcePath = path.join(
    codexSourceRoot,
    "codex-rs",
    "app-server",
    "src",
    "request_processors",
    "plugins.rs",
  );
  if (!fs.existsSync(pluginSourcePath)) {
    throw new Error(`Codex 插件源码文件不存在：${pluginSourcePath}`);
  }
  const remoteSourcePath = path.join(
    codexSourceRoot,
    "codex-rs",
    "core-plugins",
    "src",
    "remote.rs",
  );
  if (!fs.existsSync(remoteSourcePath)) {
    throw new Error(`Codex 远程插件源码文件不存在：${remoteSourcePath}`);
  }

  const source = fs.readFileSync(pluginSourcePath, "utf8");
  const patched = patchPluginProcessorSource(patchPluginListSource(source));
  if (patched !== source) {
    fs.writeFileSync(pluginSourcePath, patched, "utf8");
  }

  const remoteSource = fs.readFileSync(remoteSourcePath, "utf8");
  const patchedRemote = patchRemotePluginSource(remoteSource);
  if (patchedRemote !== remoteSource) {
    fs.writeFileSync(remoteSourcePath, patchedRemote, "utf8");
  }

  return {
    changed: patched !== source || patchedRemote !== remoteSource,
    files: [pluginSourcePath, remoteSourcePath],
  };
}
