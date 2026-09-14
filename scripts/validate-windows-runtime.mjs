import fs from "node:fs";
import path from "node:path";
import {
  projectRoot,
  resolveProjectPath,
  validateRuizhiRuntimeBundle
} from "./windows-asar-overrides.mjs";

const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "rj-codex.json"), "utf8"));
const appVersion = process.env.RUIZHI_BUILD_VERSION ?? config.version;

function assertVersionFilePart(version) {
  if (!/^[0-9A-Za-z._+-]+$/.test(version)) {
    throw new Error(`版本号不能用于测试目录名：${version}`);
  }
}

function windowsTestAppDirName(version = appVersion) {
  assertVersionFilePart(version);
  return `test-app-${version}`;
}

function log(message) {
  console.log(`[ruizhi] ${message}`);
}

const targetRoot = resolveProjectPath(process.argv[2] ?? path.join("dist", windowsTestAppDirName()));
const explicitTarget = process.argv[2] != null;
validateRuizhiRuntimeBundle(targetRoot, config, {
  log,
  label: path.relative(projectRoot, targetRoot),
  expectedVersion: appVersion,
  expectedEnvironment: explicitTarget ? process.env.RUIZHI_EXPECTED_ENVIRONMENT : "test"
});
