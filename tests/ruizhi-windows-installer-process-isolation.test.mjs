import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const buildSource = fs.readFileSync("scripts/build-windows.mjs", "utf8");

test("Windows installer checks the running app by its full install path", () => {
  assert.match(buildSource, /!macro customCheckAppRunning/);
  assert.match(buildSource, /Join-Path '\$INSTDIR'/);
  assert.match(buildSource, /\.ExecutablePath\.Equals\(/);
  assert.match(buildSource, /StringComparison\]::OrdinalIgnoreCase/);
});

test("Windows installer stops only matching process IDs and never every ChatGPT.exe", () => {
  assert.match(buildSource, /Stop-Process -Id \$\$_\.ProcessId/);
  assert.doesNotMatch(buildSource, /taskkill[^\n]*\/im[^\n]*APP_EXECUTABLE_FILENAME/i);
  assert.doesNotMatch(buildSource, /Stop-Process[^\n]*-Name/i);
});
