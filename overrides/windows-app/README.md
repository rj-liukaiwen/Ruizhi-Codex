# Windows app.asar 覆盖层

`asar/` 里的文件路径相对于官方固定快照的 `resources/app.asar`。

规则：

- 不要直接修改 `vendor/codex-desktop/windows/current/app`。
- 平时改前端或 Electron 主进程逻辑，直接编辑 `asar/` 里的对应文件。
- 改完运行 `npm run sync:windows-test`，然后重启 `dist/test-app/Codex.exe`。
- 官方固定快照升级后，先跑完整构建确认补丁结果，再用 `npm run export:windows-overrides` 重新导出覆盖层。
- `node_modules` 不放进覆盖层；构建和同步脚本会自动补齐运行时依赖。
