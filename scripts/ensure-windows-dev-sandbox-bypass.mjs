import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { patchWindowsSandboxOnboardingBypass } from "./windows-asar-overrides.mjs";

const require = createRequire(import.meta.url);
const asar = require("asar");
const marker = "ruizhiWindowsSandboxReadinessBypass";

function findContextFile(asarPath) {
  const matches = asar.listPackage(asarPath).filter((entry) =>
    /windows-sandbox-onboarding-context-.*\.js$/.test(entry)
  );
  if (matches.length !== 1) {
    throw new Error(`Windows sandbox onboarding context match count is ${matches.length}`);
  }
  return matches[0].replace(/^\\/, "");
}

function isReady(asarPath) {
  asar.uncache?.(asarPath);
  const source = asar.extractFile(asarPath, findContextFile(asarPath)).toString("utf8");
  return source.includes(marker)
    && source.includes("isRequired:!1,requirement:null");
}

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const asarArg = args.find((arg) => arg !== "--check");
if (!asarArg) {
  throw new Error("Usage: node ensure-windows-dev-sandbox-bypass.mjs [--check] <app.asar>");
}

const asarPath = path.resolve(asarArg);
if (!fs.existsSync(asarPath)) {
  throw new Error(`app.asar does not exist: ${asarPath}`);
}

if (isReady(asarPath)) {
  console.log("WINDOWS_DEV_SANDBOX_BYPASS_OK");
  process.exit(0);
}
if (checkOnly) {
  console.error("WINDOWS_DEV_SANDBOX_BYPASS_MISSING");
  process.exit(1);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-dev-sandbox-"));
const extractedDir = path.join(tempRoot, "app");
const patchedAsar = path.join(tempRoot, "app.asar");
try {
  asar.uncache?.(asarPath);
  asar.extractAll(asarPath, extractedDir);
  patchWindowsSandboxOnboardingBypass(extractedDir);
  await asar.createPackage(extractedDir, patchedAsar);
  asar.uncache?.(patchedAsar);
  if (!isReady(patchedAsar)) {
    throw new Error("Patched app.asar did not pass the Windows sandbox bypass check");
  }
  fs.copyFileSync(patchedAsar, asarPath);
  asar.uncache?.(asarPath);
  console.log("WINDOWS_DEV_SANDBOX_BYPASS_REPAIRED");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
