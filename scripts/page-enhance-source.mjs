import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const pageEnhanceRendererSources = Object.freeze([
  Object.freeze({
    fileName: "ruizhi-page-enhance.js",
    sourcePath: path.join(projectRoot, "resources", "renderer", "ruizhi-page-enhance.js"),
  }),
  Object.freeze({
    fileName: "ruizhi-wallet-details.js",
    sourcePath: path.join(projectRoot, "resources", "renderer", "ruizhi-wallet-details.js"),
  }),
]);

export function pageEnhanceRendererInstallerSource() {
  return pageEnhanceRendererSources
    .map(({ sourcePath }) => fs.readFileSync(sourcePath, "utf8"))
    .join("\n");
}
