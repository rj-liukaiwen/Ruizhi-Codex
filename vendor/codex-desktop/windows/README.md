# Windows Codex Desktop 固定源

`current/app/` 是 Windows 打包使用的官方 Codex Desktop 固定快照，不再由 `build:windows` 自动扫描本机 WindowsApps 最新版本。

更新固定源时显式运行：

```powershell
npm run import:codex-windows-source
```

构建时会校验 `current/source-manifest.json` 里的 `resources/app.asar` 和 `Codex.exe` SHA256。校验失败说明固定源被手动改过或导入不完整，应确认来源后重新导入。

`current/app/` 体积较大，默认不纳入 Git；如果后续要跨机器复现，应走 Git LFS、Release artifact 或内部对象存储。
