# 锐捷 Codex Windows 开发交接（2026-09-11）

## 当前发布基线

- 产品版本：`0.3.1442-26.715.52143-0910`
- 安装包名称：`Ruizhi-Setup-0.3.1442-26.715.52143-0910.exe`
- 安装包 SHA256：`3052D98F7C4F6FC7C27922C7C0CEF7B1890331AD3FF285C3DE2058BB21EF7991`
- Git 开发分支：`codex/release-baseline-alignment`
- Windows 主程序仍叫 `ChatGPT.exe`，产品名和快捷方式保持“锐捷Codex”。

## 本轮已经对齐和修复的内容

- 启用记忆功能，并保留安装版已有的模型、认证和会话逻辑。
- 本地开发版自动使用独立的用户数据目录，避免与已安装锐捷版互相抢占。
- 修复本地开发版首次启动的 Windows sandbox onboarding 阻塞。
- 插件和技能列表在远程目录不可用、缓存不完整时仍使用完整的本地市场；升级场景已验证可从 32 项旧缓存恢复到 201 个插件和 34 个技能。
- 安装器不再按进程名关闭所有 `ChatGPT.exe`。现在只检测并停止 `$INSTDIR\ChatGPT.exe` 完整路径对应的 PID，不会关闭 WindowsApps 中的官方 Codex。

## 常用命令

安装或刷新桌面上的本地开发快捷方式：

```powershell
npm run install:windows-dev-shortcut
```

启动本地开发版：

```powershell
npm run start:windows-dev
```

运行本轮相关回归测试：

```powershell
npm run test:windows-dev-launcher
node --test tests/ruizhi-windows-auth-import.test.mjs tests/ruizhi-shared-codex-home.test.mjs tests/ruizhi-windows-installer-process-isolation.test.mjs
```

复用现有 `codex.exe` 构建同版本 Windows 包：

```powershell
$env:RUIZHI_BUILD_VERSION='0.3.1442-26.715.52143-0910'
$env:RUIZHI_BUILD_CODEX='0'
npm run build:windows
```

## 固定源和大文件

Git 仓库故意不提交以下大文件：

- `vendor/codex-desktop/windows/current/app/`
- `resources/windows/prerequisites/vc_redist.x64.exe`
- `node_modules/`
- `.work/`、`dist/` 和本地用户数据

本次单独交付的“可接手源码包”包含前两项，因此解压后安装 Node.js 依赖即可继续构建。仅从 GitHub 克隆时，需要按照 `docs/build/skills/rj-codex-windows/SKILL.md` 重新导入固定官方基线并补齐 VC++ 运行库。

## 发布注意事项

- 新需求应继续从本分支或其合并后的默认分支开发，不要重新套用旧安装包源码。
- 不要把 `ChatGPT.exe` 改回按名称全局关闭，否则会再次误伤官方 Codex。
- 正式打包前至少运行上面的回归测试，并核对最终 EXE 的版本、文件名和 SHA256。
- `dist/`、`.work/`、账号文件、`.env` 和本地缓存不得提交到 Git。
