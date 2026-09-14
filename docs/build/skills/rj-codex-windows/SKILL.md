---
name: rj-codex-windows
description: Use when building, verifying, documenting, or troubleshooting the rj-codex Windows x64 desktop package from the pinned Codex Desktop source with scripts/build-windows.mjs. Applies to requests such as 打包 windows, Windows release, generating NSIS installer/zip/update manifests, checking exe icon/rcedit output, verifying 锐捷 onboarding copy, importing the pinned Codex source, or keeping dist artifacts out of commits.
---

# rj-codex Windows x64 打包

用于在 Windows 构建机上为锐捷桌面端生成 Windows x64 包（NSIS 安装包 + zip + 测试程序），并验证产物。默认只把流程、脚本或文档提交到 Git；不要提交 `dist/`、`.work/` 产物，也不要提交 `vendor/codex-desktop/windows/current/app/`，除非用户明确要求。

## 当前实测快照（2026-07-14）

- 当前固定源可来自 `C:\Programs\CodexR`，`source-manifest.json` 的 `packageVersion` 可能为 `null`，日志显示 `固定源版本：unknown` 不代表失败。
- 当前源是 Chromium 150 系列布局，主程序最终输出为 `ChatGPT.exe`；`config.windows.sourceExeName` 仍可保留 `Codex.exe` 用于 manifest 校验，再由构建脚本重命名为 `ChatGPT.exe`。
- 当前配置关闭界面品牌化：`branding.enabled=false`；不要因为日志出现“跳过品牌化/菜单/插件市场文案补丁”就判定失败。
- 当前模型列表仍启用：`models.enabled=true`、`modelBridge.enabled=false`；运行态校验应看到 `models=18`、`bridge=off`，模型列表走 macOS 同款 `models_cache.json` / `/models/list` 路径。
- `.ruizhi/config.toml` 初始化必须写入 `[model_providers.ruijie-uniapi]`、`base_url = "https://gptauth.ruijie.com.cn/v1"` 和 `chat_model_prefixes = ["glm-","deepseek-","kimi-","ray"]`。

## 先决检查

1. 进入仓库：`cd C:\work\rj-codex`（或当前仓库根目录）。
2. 检查工作区：`git status --short --branch`，先识别已有脏改，后续只处理本任务相关文件。
3. 确认是在 Windows 构建机上执行：`node -p "process.platform"` 应为 `win32`。脚本会拒绝非 Windows 主机。
4. 确认固定 Codex Desktop 源存在且完整：`vendor/codex-desktop/windows/current/app/resources/app.asar` 与 `vendor/codex-desktop/windows/current/app/Codex.exe` 都应存在。若缺失，先运行 `node ./scripts/import-codex-windows-source.mjs` 导入官方快照。
5. 确认固定源 manifest 存在：`vendor/codex-desktop/windows/current/source-manifest.json`。构建时会校验 `resources/app.asar` 和 `Codex.exe` 的 SHA256，校验失败说明固定源被改过或导入不完整，应确认来源后重新导入。
6. 确认 VC++ 运行库安装包存在：`resources/windows/prerequisites/vc_redist.x64.exe`。缺失时构建会失败，提示从 https://aka.ms/vc14/vc_redist.x64.exe 下载后放入该路径。
7. 确认 Windows asar 覆盖层非空：`overrides/windows-app/asar` 下应有文件。若为空，先运行 `node ./scripts/export-windows-overrides.mjs` 导出覆盖层（需要先有一次成功构建的补丁后 app.asar，或传入 `--patched-asar=<path>`）。
8. 记录运行环境：`node -v`、`npm -v`、`pnpm -v`。

## 依赖准备

构建脚本依赖 `fs-extra`、`@electron/fuses`、`rcedit`、`asar`、`electron-builder` 等。

> **注意**：仓库 `package.json` 中包含 `"app-server-types": "workspace:*"` 等 pnpm workspace 协议，**不能使用 `npm ci`**。采用隔离依赖方案（参照 macOS build 做法）：

```bash
# 在临时目录创建独立的 package.json（只包含构建必需的 5 个包）
New-Item -ItemType Directory -Force -Path C:\temp\ruizhi-build-deps
```

```json
// C:\temp\ruizhi-build-deps\package.json
{
  "private": true,
  "dependencies": {
    "fs-extra": "^11.0.0",
    "asar": "^3.0.0",
    "@electron/fuses": "^1.8.0",
    "rcedit": "^4.0.0",
    "electron-builder": "^26.15.0"
  }
}
```

```bash
cd C:\temp\ruizhi-build-deps && npm install
# 创建 NTFS Junction 链接到项目 node_modules
cmd /c mklink /J C:\work\rj-codex\node_modules C:\temp\ruizhi-build-deps\node_modules
```

如需可选重编 `resources/codex.exe`（设置 `RUIZHI_BUILD_CODEX=1`），还需要 Rust 工具链（`cargo --version`）和 Git。

## 打包命令

默认 Windows x64 打包命令：

```bash
node ./scripts/build-windows.mjs
```

PowerShell 下建议显式把 electron-builder cache 放到工作区，避免默认写入 `%LOCALAPPDATA%` 被沙箱或权限策略拦截：

```powershell
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Resolve-Path .).Path '.work\electron-builder-cache')
node .\scripts\build-windows.mjs
```

如果完整脚本只在 NSIS 阶段失败，而 `.work\windows-installer-input` 和 `.work\windows\electron-builder.json` 已生成，可只重跑安装包阶段：

```powershell
$env:ELECTRON_BUILDER_CACHE=(Join-Path (Resolve-Path .).Path '.work\electron-builder-cache')
& 'C:\nvm4w\nodejs\node.exe' 'D:\work\rj-codex\node_modules\electron-builder\cli.js' --win nsis --x64 --prepackaged 'D:\work\rj-codex\.work\windows-installer-input' --config 'D:\work\rj-codex\.work\windows\electron-builder.json' --publish never
```

如需覆盖应用版本号：

```bash
RUIZHI_BUILD_VERSION=0.2.6 node ./scripts/build-windows.mjs
```

如需使用外部 Codex Desktop 源（跳过固定源 manifest 校验，适合源在项目外或修改过的场景）：

```bash
RUIZHI_WINDOWS_SOURCE_APP_ROOT=C:\codex-desktop-source\app node ./scripts/build-windows.mjs
```

> **外部源说明**：`RUIZHI_WINDOWS_SOURCE_APP_ROOT` 指向的路径可以在项目外（不受 `assertInsideProject` 限制），只检查 `resources/app.asar` 和 `Codex.exe` 是否存在，不校验 SHA256。当前机器可使用 `C:\Programs\CodexR` 或重新运行 `node ./scripts/import-codex-windows-source.mjs` 导入本机已安装源。

如需重编 `resources/codex.exe`（默认跳过，仅在前端/运行态覆盖不足时使用）：

```bash
RUIZHI_BUILD_CODEX=1 node ./scripts/build-windows.mjs
```

脚本始终构建 x64；固定源本身是 x64 快照，不要尝试在 Windows 上打 arm64 包。

## 脚本主要动作

- 校验固定源 manifest，清理并重建 `.work/windows-app-out`。
- 从 `vendor/codex-desktop/windows/current/app` 复制原始 Codex Desktop 到 `.work/windows-app-out`，清理日志目录，校验无绝对路径残留。
- 可选重编 `resources/codex.exe`：克隆 OpenAI codex 源码，补丁 home 目录（优先 `RUIZHI_HOME`）、内置模型目录、imagegen skill，禁用 Responses WebSocket。
- 复制运行态覆盖：图标 `icon.ico`、模型目录 `ruizhi-model-catalog.json`（按当前 `codex.exe --version` 写入 `client_version`）、Responses bridge、页面增强脚本、系统 skills、VC++ 运行库。
- 内置插件 marketplace（锐捷插件）。
- 解包 `app.asar`，按配置应用 `overrides/windows-app/asar` 覆盖层与 asar 覆盖函数；`branding.enabled=false` 时跳过中文化/菜单/帮助链接等界面品牌化补丁，仍保留更新逻辑、Browser/nativePipe、认证链接、Statsig/CES 禁用、app sunset 禁用、模型列表读取等运行态补丁，刷新构建元数据并重新打包 `app.asar`。
- 关闭 `app.asar` 完整性校验 fuse（`@electron/fuses`；新版 Chromium 架构找不到 sentinel 时会自动跳过）。
- 重命名主程序为配置中的 `windows.appExeName`（当前为 `ChatGPT.exe`），用 `rcedit` 替换主程序图标为 `assets/ruizhi.ico`。
- 校验运行态产物（模型目录、可选 bridge、环境标记、marketplace）。
- 用 PowerShell `Compress-Archive` 生成 zip。
- 复制到 `dist/test-app-<version>`，写入测试环境标记。
- 用 `electron-builder` 生成 NSIS 安装包与 electron-updater 清单（`latest.yml`），清理旧 `锐捷.exe` 残留。
- 写入开发环境标记到 `.work/windows-app-out`。

## 预期产物

版本号来自 `config/rj-codex.json` 的 `version`（可用 `RUIZHI_BUILD_VERSION` 覆盖）；以下用 `$version` 表示当前构建版本：

安装包与 zip 输出在 `dist/installer/`：

- `dist/installer/Ruizhi-Setup-$version.exe`（NSIS 安装包）
- `dist/installer/ruizhi-windows-$version.zip`（便携 zip）
- `dist/installer/latest.yml`（electron-updater 清单）
- `dist/installer/latest-$version.yml`（版本归档清单）

测试程序输出在 `dist/`：

- `dist/test-app-$version/ChatGPT.exe`（测试环境，可直接启动验证）

构建中间产物（默认 `.gitignore` 忽略）：

- `.work/windows-app-out/ChatGPT.exe`（开发环境标记的完整 app）
- `.work/windows-installer-input/`（electron-builder 预打包输入）
- `.work/windows/`（asar 解包与 electron-builder 配置）

文件名规则：源程序仍按 `windows.sourceExeName` 校验（当前为 `Codex.exe`），输出主程序按 `windows.appExeName` 重命名（当前为 `ChatGPT.exe`）；快捷方式与任务管理器名称按配置输出（当前为 `ChatGPT`）；appId 为 `cn.ruizhi.desktop`。

## 验证流程

构建完成后至少运行：

```powershell
# 主程序存在且图标已替换
$version = (Get-Content .\config\rj-codex.json | ConvertFrom-Json).version
Test-Path ".work\windows-app-out\ChatGPT.exe"
# 模型目录已内置
Test-Path ".work\windows-app-out\resources\models\ruizhi-model-catalog.json"
# bridge 仅在 modelBridge.enabled=true 时内置
if ((Get-Content .\config\rj-codex.json | ConvertFrom-Json).modelBridge.enabled) { Test-Path ".work\windows-app-out\resources\bridge\ruizhi-responses-bridge.cjs" }
# VC++ 运行库已内置
Test-Path ".work\windows-app-out\resources\prerequisites\vc_redist.x64.exe"
# 环境标记
Get-Content ".work\windows-app-out\resources\ruizhi-environment.json"
# 测试程序环境标记（应为 test）
Get-Content "dist\test-app-$version\resources\ruizhi-environment.json"
# 产物清单
Get-ChildItem "dist\installer\Ruizhi-Setup-$version.exe", "dist\installer\ruizhi-windows-$version.zip", "dist\installer\latest.yml" | Select-Object Name, Length
# latest.yml 版本号
Select-String -Path dist\installer\latest.yml -Pattern "^version:"
```

判断标准：

- `.work/windows-app-out/ChatGPT.exe` 存在。
- `.work/windows-app-out/resources/ruizhi-environment.json` 中 `environment` 为 `development`。
- `dist/test-app-$version/resources/ruizhi-environment.json` 中 `environment` 为 `test`。
- `dist/installer/Ruizhi-Setup-$version.exe` 与 `dist/installer/ruizhi-windows-$version.zip` 都存在且体积合理（安装包约 200MB+，zip 约 200MB+）。
- `dist/installer/latest.yml` 中 `version:` 为 `$version`。

## 文案验证

如本次涉及欢迎页文案，解包最终 app 的 `app.asar` 验证：

```powershell
node -e "const asar=require('asar');const fs=require('fs');const path=require('path');const appAsar='.work/windows-app-out/resources/app.asar';const out=require('os').tmpdir()+'/ruizhi-built-asar-check';fs.rmSync(out,{recursive:true,force:true});asar.extractAll(appAsar,out);const today=new Date();const buildDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;const required=['使用锐捷继续',`锐捷构建日期：${buildDate}`];const forbidden=['使用 ChatGPT 继续','使用ChatGPT继续','所有 ChatGPT 套餐均包含','ChatGPT套餐均包含'];let all='';function walk(dir){for(const name of fs.readdirSync(dir)){const p=path.join(dir,name);const st=fs.statSync(p);if(st.isDirectory())walk(p);else if(/\.(js|html|json)$/.test(name))all+=fs.readFileSync(p,'utf8')+'\n';'}}walk(path.join(out,'webview'));for(const text of required)console.log(`${text}: ${all.includes(text)?'FOUND':'MISSING'}`);for(const text of forbidden)console.log(`${text}: ${all.includes(text)?'STILL_PRESENT':'absent'}`);"
```

判断标准：必需文案为 `FOUND`，旧文案为 `absent`。

## Codex Desktop 版本差异

### v26+ (Chromium 架构)

当前外部源使用 Codex Desktop **v26.616.10790.0**（Chromium 149），与旧版 Electron 架构有本质差异：

| 对比项 | 旧版 (Electron) | 新版 v26+ (Chromium) |
|--------|----------------|---------------------|
| 主程序 | Codex.exe 是完整 Electron binary | Codex.exe 是 4.5MB Chromium 启动器 |
| 运行时 | 无 chrome.dll | chrome.dll 是 307MB 的 Chromium 运行时 |
| Electron version | `version` 文件存在 | 无 `version` 文件，通过 manifest 推断 |
| Fuse wire | 有 sentinel，支持 `@electron/fuses` | 无 sentinel，跳过 fuse 操作 |
| Preload | 可能已有 `ruizhiDesktop` anchor 和 `appVersion` | 可能只有 `electronBridge`，需 fallback 注入 `ruizhiDesktop` |
| asar 结构 | 标准 Electron asar | 相同（仍为 asar 格式） |
| JS 混淆 | 旧版变量名（`_j`、`Xe`、`Ze`） | 新版混淆变量名（`IL`、`X0`、`Z0`） |
| 菜单代码 | 旧版 pattern `let Xe=[],Ze=[]` | 新版 `let ut={label:\`File\`}` |
| Browser 能力 | `n.Menu.setApplicationMenu` | `a.Menu.setApplicationMenu` |
| autoHideMenuBar | `win32` only | `win32||linux` |
| removeMenu | `win32` only | 支持 `win32||linux` 和 `!==darwin` 两种模式 |
| JSX 命名空间 | `$.jsx`/`$.jsxs` | `Z.jsx`/`Z.jsxs` |
| Button 组件 | `uc` | `aa` |
| dispatchMessage | `G.dispatchMessage` | `J.dispatchMessage` |
| VC++ 错误页函数 | `_j()` + `yj()` | `IL()` + `RL()` |
| Statsig bootstrap | 旧版 pattern 匹配 | 新版 pattern 不匹配，跳过补丁 |
| 插件目录 | `plugins/openai-bundled/` | 同，但需从外部源手动复制 |

构建脚本已兼容上述差异（通过动态正则提取变量名、sentinel 检测、manifest 推断 Electron 版本等），但未来 Codex Desktop 大版本升级时仍需逐项验证。

## 常见故障

### 基础环境

- 找不到固定 Codex Desktop 源：先运行 `node ./scripts/import-codex-windows-source.mjs` 导入官方快照到 `vendor/codex-desktop/windows/current/app`。固定源体积较大，默认不纳入 Git。
- 固定源 manifest 校验失败：说明 `resources/app.asar` 或 `Codex.exe` 被手动改过或导入不完整，应确认来源后重新运行 `import:codex-windows-source`。或使用 `RUIZHI_WINDOWS_SOURCE_APP_ROOT` 指定外部源跳过校验。
- 找不到 VC++ 运行库：从 https://aka.ms/vc14/vc_redist.x64.exe 下载 `vc_redist.x64.exe`，放入 `resources/windows/prerequisites/`。
- Windows asar 覆盖层为空：`overrides/windows-app/asar` 下没有文件时构建失败。先运行 `node ./scripts/export-windows-overrides.mjs` 导出覆盖层（需要先有一次成功构建的补丁后 app.asar，或传入 `--patched-asar=<path>`）。
- 固定 Codex Desktop 源已变化：`resources/app.asar` 或 `Codex.exe` 与 manifest 不一致。先确认是否切换了来源；确认后运行 `node ./scripts/import-codex-windows-source.mjs` 重新导入并刷新 `source-manifest.json`。
- 找不到 `fs-extra` 等依赖：按「依赖准备」节的隔离方案安装依赖，**不要用 `npm ci`**（pnpm workspace 协议不兼容）。
- 项目 `node_modules` 如果是旧的文本占位（内容类似 `/tmp/ruizhi-build-deps/node_modules`），在 Windows 不能解析；确认不是非空真实目录后，替换为指向 `C:\temp\ruizhi-build-deps\node_modules` 的 NTFS Junction。
- 历史产物被占用无法清理：`EPERM`/`EBUSY` 说明旧版锐智/Codex 正在运行，先关闭相关进程后重新构建。
- 测试程序目录被占用：同上，先关闭正在运行的测试版锐智。
- 历史产物被占用无法清理：`EPERM`/`EBUSY` 说明旧版锐捷/Codex 正在运行，先关闭相关进程后重新构建。
- 测试程序目录被占用：同上，先关闭正在运行的测试版锐捷。
- 推送或提交前：保留 `dist/`、`.work/`、`vendor/codex-desktop/windows/current/app/` 为未跟踪/忽略产物，不要暂存发布包；只暂存文档、脚本或源码变更。
- `EPERM: mkdir/rename ... electron-builder\Cache\nsis`：设置 `ELECTRON_BUILDER_CACHE=.work\electron-builder-cache` 后重跑；如仍在解压 rename 被拦截，只对 electron-builder NSIS 阶段请求提升权限，不必重跑前面的 asar/zip 阶段。

### rcedit 图标替换

- `rcedit is not a function`：Node 22 ESM 不支持从 CJS 模块命名导出。将 `import rceditPkg from "rcedit"; const { rcedit } = rceditPkg;` 改为 `import rcedit from "rcedit";`（`rcedit` 的 CJS 默认导出就是函数本身）。
- 主程序图标替换偶发失败：脚本会自动重试 3 次。持续失败时确认 `Codex.exe` 没有被占用，或设置 `RUIZHI_SKIP_EXE_ICON_PATCH=1` 跳过。

### 插件与 Skill 路径

- `官方 OpenAI 插件资源不存在`：外部源路径不包含 `vendor/` 子目录，需手动将 `C:/codex-desktop-source/app/resources/plugins/openai-bundled/` 拷贝到 `vendor/codex-desktop/windows/current/app/resources/plugins/openai-bundled/`。
- `skill 文案补丁目标不存在：chrome/skills/chrome/SKILL.md`：新版 Codex Desktop 将 Chrome skill 重命名为 `control-chrome`，路径需更新为 `chrome/skills/control-chrome/SKILL.md`（`windows-asar-overrides.mjs` 中两处引用）。

### 启动错误页（VC++ Runtime）

- `未找到启动错误页补丁目标`：新版函数名从 `_j(e){` 变为 `IL(e){`，helper 从 `yj(){` 变为 `RL(){`。`patchVcRuntimeErrorPage` 函数的搜索和替换模式需更新。当前已改为正则动态提取变量名，兼容新旧版本。
- JSX 命名空间变化：旧版使用 `$.jsx`/`$.jsxs`，新版使用 `Z.jsx`/`Z.jsxs`。Button 组件从 `uc` 变为 `aa`。
- dispatchMessage 命名空间变化：旧版 `G.dispatchMessage`，新版 `J.dispatchMessage`。

### 菜单与窗口

- `Windows 顶部菜单 bundle 匹配数量异常：0`：新版菜单模板从 `let Xe=[],Ze=[]` 变为 `let ut={label:\`File\`}`。`findWindowsNativeMenuBundle` 需匹配 `Menu.setApplicationMenu` 和新版模板特征。
- `顶部菜单窗口可见性补丁点不存在：autoHideMenuBar`：新版 pattern 从 `process.platform===`win32`?{autoHideMenuBar:!0}:{}` 变为 `process.platform===`win32`||process.platform===`linux`?{autoHideMenuBar:!0}:{}`。`patchWindowsBrowserWindowNativeMenuVisibility` 已改为 `/autoHideMenuBar:!0/g` 正则替换。
- `顶部菜单窗口可见性补丁点不存在：removeMenu`：新版支持多种模式（`win32||linux`、`!==darwin`），正则需兼容。

### Statsig / CES / 分析

- `Statsig post-login bootstrap bundle 匹配数量异常`：新版 Codex Desktop 中该 pattern 不再匹配。`patchNativeStatsigBootstrap` 会记录 "补丁点不存在" 日志并跳过（非致命）。
- `ReferenceError: candidates is not defined`：`patchNativeStatsigBootstrap` 函数中缺少 `walkFiles` + pattern 过滤的 `candidates` 定义。已补全。

### 版本与 Fuse

- `缺少 Electron runtime version 文件`：新版 Codex Desktop 不使用标准 Electron 版本文件。`electronRuntimeVersion()` 会从 manifest 文件名（如 `149.0.7827.115.manifest`）提取 Chromium 版本，按 `major - 116` 公式推断 Electron 版本（Chrome 149 → Electron 33）。
- `Could not find sentinel in the provided Electron binary`：新版 Codex.exe 是 Chromium 启动器（4.5MB），不含 Electron fuse sentinel。`patchFuses()` 会先搜索 sentinel 字符串，不存在时跳过 fuse 操作。
- `latest.yml` 缺失：如果完整脚本中断后只手动重跑了 electron-builder，可能只生成 exe/blockmap。需要补齐 `latest.yml` 与 `latest-<version>.yml`，字段包含 `version`、`files[0].url`、`sha512`、`size`、`path`、`releaseDate`。

### 个人资料与认证

- `Codex 个人资料入口补丁点不存在`：`profile-visibility` 文件中函数变量名 `r`/`t` 在新旧版本间互换。`patchNativeProfileVisibility` 已改为 `(\w+)` 捕获组 + 反向引用 `\1` 匹配。
- `补丁点不存在：ChatGPT 认证链接外部浏览器打开`：新版 pattern 增加了 `||n.openTarget===`external-browser`` 条件。正则已改为 `(?:...)?` 可选匹配。
- 当前 Chromium 150 源中 profile visibility 和 ChatGPT auth 外部浏览器补丁可能完全匹配不到；这些补丁应记录“已跳过”并继续，不应阻断打包。

### 补丁函数缺失

- `ReferenceError: findOneFileByContent is not defined`：辅助函数缺失，在 `walkFiles` 之后添加了 `findOneFileByContent(dir, namePattern, contentPattern, description)` 实现。

## 汇报模板

完成后向用户说明：

- 打包命令和固定 Codex Desktop 源版本（来自 `source-manifest.json` 的 `packageVersion`）。
- NSIS 安装包、zip、更新清单、测试程序的绝对路径。
- 环境标记、模型目录、bridge、marketplace 验证结果。
- 欢迎页按钮和构建日期文案验证结果（如涉及）。
- 如执行了提交/推送，给出 commit hash 和目标分支。
