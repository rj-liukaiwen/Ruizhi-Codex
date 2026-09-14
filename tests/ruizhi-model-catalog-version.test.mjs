import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { applyRuizhiModelCatalogCompatibilityPatches } from "../scripts/windows-asar-overrides.mjs";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("model catalog source version is pinned to the current Codex runtime series", () => {
  const catalog = JSON.parse(readProjectFile("resources/ruizhi-model-catalog.json"));

  assert.equal(catalog.client_version, "0.133.0");
});

test("model catalog only exposes ray and GPT 5.3+ models", () => {
  const catalog = JSON.parse(readProjectFile("resources/ruizhi-model-catalog.json"));

  assert.deepEqual(
    catalog.models.map((entry) => entry.slug),
    [
      "ray",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.3-codex",
    ],
  );
});

test("Ruizhi startup default model is ray", () => {
  const config = JSON.parse(readProjectFile("config/rj-codex.json"));
  const catalog = JSON.parse(readProjectFile("resources/ruizhi-model-catalog.json"));
  const defaultModel = "ray";

  assert.equal(config.openai.defaultModel, defaultModel);
  assert.equal(catalog.default_model, defaultModel);
  assert.equal(catalog.models[0]?.slug, defaultModel);
  assert.ok(catalog.models.some((model) => model.slug === defaultModel), "default model should exist in catalog");
  assert.equal(catalog.models.find((model) => model.slug === defaultModel)?.apply_patch_tool_type, "freeform");

  const serviceSource = readProjectFile("resources/bridge/ruizhi-enhance-service.cjs");
  assert.match(serviceSource, /: "ray"/);
  assert.match(serviceSource, /isDefault: model === defaultModel/);
});

test("all visible models consistently require apply_patch for manual file edits", () => {
  const catalog = JSON.parse(readProjectFile("resources/ruizhi-model-catalog.json"));

  for (const model of catalog.models.filter((entry) => entry.visibility === "list")) {
    assert.equal(model.apply_patch_tool_type, "freeform", `${model.slug} should expose apply_patch as a freeform tool`);
    assert.match(
      model.base_instructions,
      /(?:use .*apply_patch.*manual (?:code )?edit|file creation or edit.*must use apply_patch)/i,
      `${model.slug} should direct manual edits through apply_patch`,
    );
    assert.match(
      model.base_instructions,
      /(?:do not (?:create or )?edit files with .*shell|never use shell_command.*write files)/i,
      `${model.slug} should prohibit shell-based manual file writes`,
    );
  }
});

test("GPT 5.6 models route through Responses", () => {
  const config = JSON.parse(readProjectFile("config/rj-codex.json"));

  assert.equal(config.modelBridge.routes["gpt-5.6-sol"], "responses");
  assert.equal(config.modelBridge.routes["gpt-5.6-terra"], "responses");
  assert.equal(config.modelBridge.routes["gpt-5.6-luna"], "responses");
});

test("model catalog omits Qwen models from the curated picker", () => {
  const catalog = JSON.parse(readProjectFile("resources/ruizhi-model-catalog.json"));

  assert.deepEqual(
    catalog.models
      .filter((model) => model.slug.startsWith("qwen"))
      .map((model) => model.slug),
    [],
  );
});

test("model catalog compatibility defaults all Codex model entries to image-capable", () => {
  const catalog = {
    models: [
      { slug: "api-model-without-modalities", visibility: "list" },
      { slug: "api-model-text-only", visibility: "list", input_modalities: ["text"] },
      { slug: "api-model-extra-modality", visibility: "list", input_modalities: ["audio"] },
    ],
  };

  applyRuizhiModelCatalogCompatibilityPatches(catalog);

  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[0].inputModalities, ["text", "image"]);
  assert.deepEqual(catalog.models[1].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[1].inputModalities, ["text", "image"]);
  assert.deepEqual(catalog.models[2].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[2].inputModalities, ["text", "image"]);
});

test("model catalog compatibility removes non-chat API models from picker cache", () => {
  const catalog = {
    models: [
      { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "list", input_modalities: ["text", "image"] },
      { slug: "qwen3.6-plus", display_name: "Qwen3.6 Plus", visibility: "list" },
      { slug: "gpt-image-2", display_name: "Image-2", visibility: "list" },
      { slug: "gpt-image2", display_name: "gpt-image2", visibility: "list" },
      { slug: "text-embedding-3-large", display_name: "Text Embedding 3 Large", visibility: "list" },
      { slug: "bge-reranker-v2", display_name: "BGE Reranker", visibility: "list" },
      { slug: "gpt-realtime", display_name: "GPT Realtime", visibility: "list" },
    ],
  };

  applyRuizhiModelCatalogCompatibilityPatches(catalog);

  assert.deepEqual(
    catalog.models.map((model) => model.slug),
    ["gpt-5.4", "qwen3.6-plus"],
  );
  assert.deepEqual(catalog.models[0].input_modalities, ["text", "image"]);
  assert.deepEqual(catalog.models[1].input_modalities, ["text", "image"]);
});

test("model catalog compatibility preserves full reasoning level lists", () => {
  const supportedReasoningLevels = [
    { effort: "minimal", description: "最少推理" },
    { effort: "low", description: "轻量推理" },
    { effort: "medium", description: "标准推理" },
    { effort: "high", description: "深度推理" },
    { effort: "xhigh", description: "最高推理" },
  ];
  const catalog = {
    models: [
      {
        slug: "api-model-full-reasoning",
        visibility: "list",
        supported_reasoning_levels: supportedReasoningLevels.map((entry) => ({ ...entry })),
      },
    ],
  };

  applyRuizhiModelCatalogCompatibilityPatches(catalog);

  assert.deepEqual(catalog.models[0].supported_reasoning_levels, supportedReasoningLevels);
  assert.deepEqual(catalog.models[0].supportedReasoningEfforts, [
    { reasoningEffort: "minimal", description: "最少推理" },
    { reasoningEffort: "low", description: "轻量推理" },
    { reasoningEffort: "medium", description: "标准推理" },
    { reasoningEffort: "high", description: "深度推理" },
    { reasoningEffort: "xhigh", description: "最高推理" },
  ]);
});

test("model catalog compatibility fills empty reasoning levels for API catalogs", () => {
  const catalog = {
    models: [
      {
        slug: "api-model-empty-reasoning",
        visibility: "list",
        supported_reasoning_levels: [],
      },
    ],
  };

  applyRuizhiModelCatalogCompatibilityPatches(catalog);

  assert.deepEqual(
    catalog.models[0].supported_reasoning_levels.map((entry) => entry.effort),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    catalog.models[0].supportedReasoningEfforts.map((entry) => entry.reasoningEffort),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.equal(catalog.models[0].default_reasoning_level, "medium");
  assert.equal(catalog.models[0].defaultReasoningEffort, "medium");
  assert.deepEqual(catalog.models[0].supported_reasoning_efforts, ["minimal", "low", "medium", "high", "xhigh"]);
});

test("desktop bootstrap refreshes the user models cache from the bundled catalog", () => {
  const config = JSON.parse(readProjectFile("config/rj-codex.json"));

  assert.equal(config.models.catalogPath, "resources/ruizhi-model-catalog.json");
  assert.equal(config.models.remoteCatalogUrl, undefined);

  for (const scriptPath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs"]) {
    const source = readProjectFile(scriptPath);

    assert.match(source, /const userModelCatalogFile="models_cache\.json";/);
    assert.match(source, /function normalizeExistingModelCatalogCache\(target\)/);
    assert.doesNotMatch(source, /if\(normalizeExistingModelCatalogCache\(target\)\)return;/);
    assert.doesNotMatch(source, /if\(normalizeExistingModelCatalogCache\(target\)\)return false;/);
    assert.match(source, /syncBundledModelCatalogCache\(\);/);
    assert.match(source, /watchModelCatalogCache\(\);/);
    assert.match(source, /function bundledModelCatalogPath\(\)/);
    assert.match(source, /path\.join\(resourcesRoot,"models",modelCatalogFile\)/);
    assert.match(source, /writeModelCatalogCacheFromSource\(bundledModelCatalogPath\(\),target\)/);
    assert.match(source, /normalizeModelCatalogFile\(temp\);/);
    assert.match(source, /function normalizeModelCatalogFile\(filePath\)/);
    assert.match(source, /function normalizeUserModelCatalogCache\(\)/);
    assert.match(source, /function watchModelCatalogCache\(\)/);
    assert.match(source, /fs\.watchFile\(target,\{interval:1000\}/);
    assert.match(source, /ruizhi model catalog post-refresh normalize failed/);
    assert.match(source, /function applyRuizhiModelCatalogCompatibilityPatches\(catalog\)/);
    assert.match(source, /applyRuizhiModelCatalogCompatibilityPatches\(catalog\);/);
    assert.match(source, /isNonChatModelCatalogEntry/);
    assert.match(source, /catalog\.models=catalog\.models\.filter/);
    assert.match(source, /\(\?:gpt-\)\?image/);
    assert.match(source, /model\.input_modalities=\["text","image"\]/);
    assert.match(source, /model\.inputModalities=model\.input_modalities/);
    assert.match(source, /model\.supported_reasoning_efforts=\["minimal","low","medium","high","xhigh"\]/);
    assert.match(source, /model\.supportedReasoningEfforts=model\.supported_reasoning_levels\.map/);
    assert.match(source, /model\.defaultReasoningEffort=model\.default_reasoning_level/);
    assert.match(source, /const requiredFields=\["slug","display_name","supported_reasoning_levels","shell_type"/);
    assert.match(source, /model-catalog-normalize/);
    assert.match(source, /ruizhi bundled model catalog recovery failed/);
    assert.doesNotMatch(source, /fs\.writeFileSync\(target,next,"utf8"\)/);
    assert.doesNotMatch(source, /catalog\.fetched_at=new Date\(\)\.toISOString\(\);/);
    assert.match(source, /catalogPath:path\.join\(codexHome,userModelCatalogFile\)/);
    assert.doesNotMatch(source, /remoteCatalogUrl/);
    assert.doesNotMatch(source, /modelCatalogRemoteUrl/);
    assert.doesNotMatch(source, /downloadRemoteModelCatalog/);
    assert.doesNotMatch(source, /ruizhi remote model catalog sync failed/);
    assert.doesNotMatch(source, /RUIZHI_MODEL_CATALOG_URL/);
    assert.doesNotMatch(source, /const userModelCatalogFile="model-catalog\.json";/);
    assert.doesNotMatch(source, /catalogPath:path\.join\(resourcesRoot,"models",modelCatalogFile\)/);
  }

  const asarPatchSource = readProjectFile("scripts/windows-asar-overrides.mjs");
  assert.match(asarPatchSource, /const userModelCatalogFile="models_cache\.json";/);
  assert.match(asarPatchSource, /function normalizeExistingModelCatalogCache\(target\)/);
  assert.doesNotMatch(asarPatchSource, /if\(normalizeExistingModelCatalogCache\(target\)\)return;/);
  assert.doesNotMatch(asarPatchSource, /if\(normalizeExistingModelCatalogCache\(target\)\)return false;/);
  assert.match(asarPatchSource, /ruizhiSyncBundledModelCatalogCache/);
  assert.match(asarPatchSource, /if\(fs\.existsSync\(target\)\)\{/);
  assert.match(asarPatchSource, /syncBundledModelCatalogCache\(\);/);
  assert.match(asarPatchSource, /watchModelCatalogCache\(\);/);
  assert.match(asarPatchSource, /function bundledModelCatalogPath\(\)/);
  assert.match(asarPatchSource, /path\.join\(resourcesRoot,"models",modelCatalogFile\)/);
  assert.match(asarPatchSource, /writeModelCatalogCacheFromSource\(bundledModelCatalogPath\(\),target\)/);
  assert.match(asarPatchSource, /normalizeModelCatalogFile\(temp\);/);
  assert.match(asarPatchSource, /function normalizeModelCatalogFile\(filePath\)/);
  assert.match(asarPatchSource, /function normalizeUserModelCatalogCache\(\)/);
  assert.match(asarPatchSource, /function watchModelCatalogCache\(\)/);
  assert.match(asarPatchSource, /fs\.watchFile\(target,\{interval:1000\}/);
  assert.match(asarPatchSource, /ruizhi model catalog post-refresh normalize failed/);
  assert.match(asarPatchSource, /function applyRuizhiModelCatalogCompatibilityPatches\(catalog\)/);
  assert.match(asarPatchSource, /applyRuizhiModelCatalogCompatibilityPatches\(catalog\);/);
  assert.match(asarPatchSource, /isNonChatModelCatalogEntry/);
  assert.match(asarPatchSource, /catalog\.models=catalog\.models\.filter/);
  assert.match(asarPatchSource, /\(\?:gpt-\)\?image/);
  assert.match(asarPatchSource, /model\.input_modalities=\["text","image"\]/);
  assert.match(asarPatchSource, /model\.supported_reasoning_efforts=\["minimal","low","medium","high","xhigh"\]/);
  assert.match(asarPatchSource, /const requiredFields=\["slug","display_name","supported_reasoning_levels","shell_type"/);
  assert.match(asarPatchSource, /model-catalog-normalize/);
  assert.match(asarPatchSource, /ruizhi bundled model catalog recovery failed/);
  assert.doesNotMatch(asarPatchSource, /catalog\.fetched_at=new Date\(\)\.toISOString\(\);/);
  assert.match(asarPatchSource, /catalogPath:path\.join\(codexHome,bridgeUserModelCatalogFile\)/);
  assert.doesNotMatch(asarPatchSource, /remoteCatalogUrl/);
  assert.doesNotMatch(asarPatchSource, /modelCatalogRemoteUrl/);
  assert.doesNotMatch(asarPatchSource, /downloadRemoteModelCatalog/);
  assert.doesNotMatch(asarPatchSource, /ruizhi remote model catalog sync failed/);
  assert.doesNotMatch(asarPatchSource, /RUIZHI_MODEL_CATALOG_URL/);
  assert.doesNotMatch(asarPatchSource, /const userModelCatalogFile="model-catalog\.json";/);
});

test("desktop patches host model listing to read the user models cache", () => {
  for (const scriptPath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs"]) {
    const source = readProjectFile(scriptPath);

    assert.match(source, /function patchListModelsForHostFromUserCache\(\)/);
    assert.match(source, /models_cache\.json/);
    assert.match(source, /list-models-for-host/);
    assert.match(source, /modelListQueryFnPattern/);
    assert.match(source, /applyRuizhiModelCatalogCompatibilityPatches\(catalog\);/);
    assert.match(source, /forceFreshModelListQuery/);
    assert.match(source, /staleTime:0,\$1/);
    assert.match(source, /ruizhiNormalizeModelsResult/);
    assert.match(source, /\.then\(ruizhiNormalizeModelsResult\)/);
    assert.match(source, /ruizhiModel\.input_modalities=/);
    assert.match(source, /\\`text\\`,\\`image\\`/);
    assert.match(source, /ruizhiModel\.supported_reasoning_efforts=ruizhiFinalEfforts/);
    assert.match(source, /\\`minimal\\`,\\`low\\`,\\`medium\\`,\\`high\\`,\\`xhigh\\`/);
    assert.match(source, /ruizhiNormalizeModelsResult\(\{data:ruizhiResult\.data,nextCursor:null\}\)/);
  }

  const asarPatchSource = readProjectFile("scripts/windows-asar-overrides.mjs");
  assert.match(asarPatchSource, /function patchListModelsForHostFromUserCache\(/);
  assert.match(asarPatchSource, /models_cache\.json/);
  assert.match(asarPatchSource, /list-models-for-host/);
  assert.match(asarPatchSource, /modelListQueryFnPattern/);
  assert.match(asarPatchSource, /applyRuizhiModelCatalogCompatibilityPatches\(catalog\);/);
  assert.match(asarPatchSource, /forceFreshModelListQuery/);
  assert.match(asarPatchSource, /staleTime:0,\$1/);
  assert.match(asarPatchSource, /ruizhiNormalizeModelsResult/);
  assert.match(asarPatchSource, /\.then\(ruizhiNormalizeModelsResult\)/);
  assert.match(asarPatchSource, /ruizhiModel\.input_modalities=/);
  assert.match(asarPatchSource, /\\`text\\`,\\`image\\`/);
  assert.match(asarPatchSource, /ruizhiModel\.supported_reasoning_efforts=ruizhiFinalEfforts/);
  assert.match(asarPatchSource, /\\`minimal\\`,\\`low\\`,\\`medium\\`,\\`high\\`,\\`xhigh\\`/);
  assert.match(asarPatchSource, /ruizhiNormalizeModelsResult\(\{data:ruizhiResult\.data,nextCursor:null\}\)/);
});

test("host model listing patch separates the helper from queryFn", () => {
  for (const scriptPath of ["scripts/build-windows.mjs", "scripts/build-macos.mjs", "scripts/windows-asar-overrides.mjs"]) {
    const source = readProjectFile(scriptPath);

    assert.doesNotMatch(
      source,
      /\$\{helper\}queryFn:/,
      `${scriptPath} must not concatenate a function declaration directly before queryFn`,
    );
    assert.match(
      source,
      /legacyModelListQueryFnPattern/,
      `${scriptPath} should repair existing bundles that already contain the old broken helper`,
    );
    assert.doesNotMatch(
      source,
      /source\.includes\("function ruizhiListModelsForHostFromUserCache\("\)\) return source/,
      `${scriptPath} must not silently keep the old broken helper`,
    );
  }
});

test("macOS build rewrites runtime model catalog with bundled Codex version", () => {
  const source = readProjectFile("scripts/build-macos.mjs");

  assert.match(source, /writeRuntimeModelCatalog/);
  assert.match(source, /codexClientVersionFromExe/);
  assert.match(source, /writeRuntimeModelCatalog\(\s*modelCatalogPath\(\),\s*path\.join\(modelTargetDir,\s*"ruizhi-model-catalog\.json"\),\s*codexClientVersion/s);
  assert.doesNotMatch(
    source,
    /fs\.copyFileSync\(modelCatalogPath\(\),\s*path\.join\(modelTargetDir,\s*"ruizhi-model-catalog\.json"\)\)/,
    "macOS build must not copy a stale source client_version into the runtime catalog"
  );
});

test("macOS build forces current model picker allowlist patch", () => {
  const source = readProjectFile("scripts/build-macos.mjs");

  assert.match(source, /function findOneFileByContent\(/);
  assert.match(source, /findOneFileByContent\(\s*assetsDir,\s*\/\\\.js\$\/,\s*modelAvailabilityAllowlistPattern/s);
  assert.match(source, /const modelAvailabilityAllowlistPattern = \/\[A-Za-z_\$\]\[\\w\$\]\*\(\?:\\\.useHiddenModels\)\?\&&\[A-Za-z_\$\]\[\\w\$\]\*!==`amazonBedrock`\//);
  assert.ok(source.includes('"!1"'), "macOS build should disable the available_models allowlist condition");
  assert.match(source, /\(\?:\\\.useHiddenModels\)\?/);
  assert.doesNotMatch(
    source,
    /replaceExactIfPresent\(source,\s*"let l=s\.useHiddenModels&&a!==`amazonBedrock`,u;"/,
    "macOS build must not rely on the stale minified exact string for the model picker allowlist patch"
  );
});
