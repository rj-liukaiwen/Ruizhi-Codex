# Windows 0.3.1442 打包记录

本文记录 2026-07-14 至 2026-07-15 处理 `Ruizhi-Setup-0.3.1442.exe` 的 Windows 打包、启动修复和中文界面修复过程。

## 目标

- 安装到 `C:\Program\Codex\ChatGPT` 后，双击 `ChatGPT.exe` 可以正常启动。
- 默认界面语言为中文，重启后仍保持中文。
- `CODEX_HOME` 指向用户目录下的 `.ruizhi`，Electron `userData` 使用 `Ruizhi`。
- 保留中文化与锐智运行时配置，取消此前额外 UI 增强。
- 输出 NSIS 安装包、zip 和更新清单。

## 关键修复

### debug

- 启动 
```shell
& 'C:\Program\Codex\ChatGPT\ChatGPT.exe' `
  --user-data-dir="$env:TEMP\ruizhi-codex-chrome-debug-9222" `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port=9222 `
  --remote-allow-origins=* `
  --no-first-run `
  --no-default-browser-check

Invoke-RestMethod http://127.0.0.1:9222/json/list | ConvertTo-Json -Depth 10

https://chrome-devtools-frontend.appspot.com/serve_rev/@25f5b661e5b08141ec24b17d1ce96c5ceb5828da/inspector.html?ws=127.0.0.1:9222/devtools/page/569502BC5D3E0206C05713CACCD617C1
```
### 启动无响应

本次启动无响应的根因是打包后的 `app.asar/package.json` 指向了不存在的入口：

```text
main = .vite/build/bootstrap.js
```

新快照实际需要从以下入口启动：

```text
main = .vite/build/early-bootstrap.js
```

修复点在 `scripts/windows-asar-overrides.mjs` 的 `refreshWindowsAsarBuildMetadata()`：当解包目录中存在 `.vite/build/early-bootstrap.js` 时，自动把 `package.json.main` 改为该入口，并在运行时校验 asar 入口存在。

### 中文界面

中文问题分三层处理：

- `patchWindowsDefaultLocale()` 把 webview 默认 locale 改为 `zh-CN`。
- `patchWindowsFrontendLocalization()` 用 `zh-CN-*.js` locale bundle 回填 `defaultMessage`。
- preload 注入只保留 locale 强制逻辑，不再注入页面增强。

本次还固定了左上角产品模式切换文案：

```text
工作 / Codex
```

避免全局品牌替换把 `Codex` 误改成 `锐智`，导致用户看不到原来的产品切换语义。

### 取消 UI 增强

按要求“只保留中文，取消其他 UI 增强”：

- `config/rj-codex.json` 中 `pageEnhance.enabled=false`。
- 所有 pageEnhance feature 开关设为 `false`。
- 打包时不复制 `resources/renderer/ruizhi-page-enhance.js`。
- 打包时不复制 `resources/bridge/ruizhi-enhance-service.cjs`。
- bootstrap 不再注入 pageEnhance 主进程代码。

### Windows 设置未完成

“Windows 设置未完成 / 重试 Windows 设置”不是安装器失败，而是 Codex Desktop 的 Windows sandbox onboarding。它在用户进入需要本地文件编辑、命令执行或工作区权限的流程时触发。

常见原因：

- UAC 权限确认没有完成，或用户点了“否”。
- `codex-windows-sandbox-setup.exe` 未能启动或被系统/安全软件拦截。
- 以普通权限安装运行，但当前工作区策略要求 elevated sandbox。
- 沙箱状态尚未写入用户配置目录，需要重新点击“完成设置”。

包内应包含：

```text
resources\codex-windows-sandbox-setup.exe
resources\codex-command-runner.exe
```

排查时优先确认这两个文件存在，并让用户点击“完成设置”时允许 UAC。若不需要本地写文件/执行命令，可在提示中选择受限访问继续使用聊天。

## 2026-07-15 追补修复

本轮继续处理两个安装后问题：

- “完成 Windows 设置以继续 / 重试 Windows 设置”点击后仍无法继续：根因是官方 Windows sandbox onboarding 在本地包里仍会作为阻塞层显示。锐智 Windows 包当前不依赖该官方 onboarding 完成写文件/执行命令流程，因此在 `scripts/windows-asar-overrides.mjs` 中新增 `patchWindowsSandboxOnboardingBypass()`，让 webview 的 sandbox onboarding context 固定为 `shouldShow:false`，避免遮挡主界面和任务操作。
- 左上角“ChatGPT 工作 / Codex”切换菜单缺失：组件本身仍在 `app-main-*.js` 中，但入口受 Statsig gate `824038554` 控制；本地 bootstrap 返回空 gates 后该值为 false，所以整个下拉入口被置空。新增 `patchWindowsProductModeSwitcherVisibility()`，并将 `824038554` 加入本地 native feature gate 允许列表，确保安装包内恢复工作/Codex 切换菜单。

验证点：

```powershell
$env:RUIZHI_CODEX_CLIENT_VERSION = "0.144.2"
node scripts\sync-windows-test.mjs
node scripts\validate-windows-runtime.mjs .work\windows-app-out
```

静态检查结果：

- `app-main-*.js` 包含 `sidebarElectron.productMode.trigger`。
- `app-main-*.js` 已注入 `ruizhiWindowsSandboxOnboardingState()`，返回 `isEnabled:true, isLoading:false, shouldShow:false`。
- `app.asar/package.json.main` 仍为 `.vite/build/early-bootstrap.js`，避免回退到双击无响应问题。

## 打包命令

PowerShell 建议使用本地 electron-builder cache，并固定 Codex client version，避免沙箱或权限问题影响构建：

```powershell
Set-Location "D:\work\rj-codex"
$env:RUIZHI_CODEX_CLIENT_VERSION = "0.144.2"
$env:ELECTRON_BUILDER_CACHE = (Join-Path (Resolve-Path ".").Path ".work\electron-builder-cache")
node scripts\build-windows.mjs
```

如只需要从已生成的 `.work\windows-installer-input` 重新打安装包，可单独运行 electron-builder 的 NSIS 阶段。

## 验证命令

```powershell
node --check scripts\windows-asar-overrides.mjs
node --check scripts\sync-windows-test.mjs
node --check scripts\build-windows.mjs
node scripts\sync-windows-test.mjs
node scripts\validate-windows-runtime.mjs .work\windows-app-out
```

重点检查：

- `.work\windows-app-out\ChatGPT.exe` 存在。
- `.work\windows-app-out\resources\app.asar` 的 `package.json.main` 为 `.vite/build/early-bootstrap.js`。
- `.work\windows-app-out\resources\app.asar` 中 `sidebarElectron.productMode.chatGptWork` 为 `工作`。
- `.work\windows-app-out\resources\app.asar` 中 `sidebarElectron.productMode.codex` 为 `Codex`。
- `resources\renderer\ruizhi-page-enhance.js` 不存在。
- `resources\bridge\ruizhi-enhance-service.cjs` 不存在。

## 本次结果

已验证安装后的 `C:\Program\Codex\ChatGPT\ChatGPT.exe` 可以启动，界面中文正常。后续若重新打包，必须保留 `early-bootstrap.js` 入口修复和 `zh-CN` 默认 locale 修复。
