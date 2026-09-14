import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchChatGptSettingsArchivedThreadsFallback } from "../scripts/windows-asar-overrides.mjs";

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruizhi-archived-windows-"));
  const assetsDir = path.join(root, "webview", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const bundlePath = path.join(assetsDir, "data-controls-test.js");
  fs.writeFileSync(
    bundlePath,
    [
      "function Mt(e){return e.items}",
      "function jt(e){return e.pages.flatMap(Mt)}",
      "async function Ft(e){try{return await U.safeGet(`/wham/tasks/list`,{parameters:{query:{limit:20,cursor:e,task_filter:`archived`}}})}catch(e){console.warn(`ruizhiCloudArchivedTasksFallback`,e);return{items:[],cursor:null}}}",
      "const settings={queryFn:async()=>{console.warn(`ruizhiSettingsArchivedThreadsFallback`);return F(`list-archived-threads`,{hostId:H})}};"
    ].join("\n"),
    "utf8"
  );
  return { root, bundlePath };
}

test("Windows archived tasks patch filters invalid cloud task items", () => {
  const { root, bundlePath } = makeFixture();
  try {
    patchChatGptSettingsArchivedThreadsFallback(root, { log() {} });
    const patched = fs.readFileSync(bundlePath, "utf8");
    assert.match(patched, /ruizhiArchivedTaskItemsGuard/);
    assert.match(patched, /function Mt\(e\)\{return Array\.isArray\(e\?\.items\)\?e\.items\.filter\(e=>e!=null\):\[\]\}/);

    const before = patched;
    patchChatGptSettingsArchivedThreadsFallback(root, { log() {} });
    assert.equal(fs.readFileSync(bundlePath, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
