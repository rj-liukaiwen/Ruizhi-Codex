---
name: rj-codex-macos-x64
description: Use when building, verifying, documenting, or troubleshooting the rj-codex macOS Intel/x64/x86_64 desktop package from /Applications/Codex.app with scripts/build-macos.mjs. Applies to requests such as 打包 macos x86, macOS x64 release, generating DMG/ZIP/update manifests, checking lipo/codesign output, or keeping dist artifacts out of commits.
---

# rj-codex macOS x64 打包

用于在 `/Users/tom/work/rj/rj-codex` 为锐捷桌面端生成 macOS Intel/x86_64 包，并验证产物。默认只把流程和文档提交到 Git；不要提交 `dist/` 产物，除非用户明确要求。

## 先决检查

1. 进入仓库：`cd /Users/tom/work/rj/rj-codex`。
2. 检查工作区：`git status --short --branch`，先识别已有脏改，后续只处理本任务相关文件。
3. 确认来源应用存在：`test -d /Applications/Codex.app`。如用户指定来源，使用 `CODEX_APP_ROOT=/path/to/Codex.app`。
4. 确认是在 macOS x64 构建机上执行；脚本会拒绝主机架构与目标架构不一致的构建。
5. 记录运行环境：`node -v`、`pnpm -v`。

## 打包命令

默认 Intel/x86_64 打包命令：

```bash
RUIZHI_MACOS_ARCH=x64 node ./scripts/build-macos.mjs
```

如需指定 Codex.app 来源：

```bash
CODEX_APP_ROOT=/Applications/Codex.app RUIZHI_MACOS_ARCH=x64 node ./scripts/build-macos.mjs
```

脚本会把 `RUIZHI_MACOS_ARCH` 规范化为 `x64`，并要求主程序 Mach-O 架构包含 `x86_64`。

## 脚本主要动作

- 清理并重建 `dist/macos` 与 `.work/macos`。
- 从 `CODEX_APP_ROOT` 或 `/Applications/Codex.app` 复制原始 app 到 `dist/macos/锐捷Codex.app`。
- 更新 `Info.plist` 元数据：显示名、Bundle ID、版本号等。
- 用 `lipo -archs` 校验 app 主程序架构。
- 编译并内置 `ruizhi-imagegen`。
- 同步运行态覆盖：模型目录、Responses bridge、页面增强、imagegen skill、插件 marketplace。
- 解包、补丁并重新打包 `app.asar`，包括中文化、更新逻辑、Browser/nativePipe、认证链接、菜单与帮助链接等补丁。
- 关闭 `app.asar` 完整性校验 fuse。
- 未配置 Developer ID secrets 时使用 ad-hoc 签名。
- 生成 ZIP、DMG、更新清单与 electron-updater 清单。

## 预期产物

版本号来自构建脚本和仓库配置；以下以 `0.2.3` 为例：

- `dist/Ruizhi-macos-0.2.3-x64.dmg`
- `dist/Ruizhi-macos-0.2.3-x64.zip`
- `dist/ruizhi-latest-macos-x64.json`
- `dist/ruizhi-latest-macos-0.2.3-x64.json`
- `dist/latest-mac-x64.yml`
- `dist/latest-mac-0.2.3-x64.yml`
- `dist/ruizhi-latest-macos.json`
- `dist/latest-mac.yml`
- `dist/latest.yml`

## 验证流程

构建完成后至少运行：

```bash
APP="/Users/tom/work/rj/rj-codex/dist/macos/锐捷Codex.app"
EXE="$APP/Contents/MacOS/Codex"

lipo -archs "$EXE"
plutil -extract CFBundleDisplayName raw "$APP/Contents/Info.plist"
plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
ls -lh dist/Ruizhi-macos-*-x64.dmg dist/Ruizhi-macos-*-x64.zip dist/ruizhi-latest-macos-x64.json dist/latest-mac-x64.yml
node -e "const m=require('./dist/ruizhi-latest-macos-x64.json'); console.log(m.version, m.arch, m.macos.fileName, m.macos.size)"
```

判断标准：

- `lipo -archs` 输出包含 `x86_64`。
- `CFBundleDisplayName` 应为 `锐捷Codex`。
- `codesign --verify --deep --strict` 退出码为 `0`。
- `ruizhi-latest-macos-x64.json` 中 `arch` 应为 `x64`，`macos.fileName` 应指向 `Ruizhi-macos-<version>-x64.zip`。

## 常见故障

- 找不到来源 app：先安装 `/Applications/Codex.app`，或设置 `CODEX_APP_ROOT`。
- 架构不匹配：x64 包需要在 x64 macOS 构建机上执行；不要在 arm64 主机硬搓 x64 包。
- 签名不是正式发布签名：未配置 `MACOS_CODESIGN_IDENTITY`、Developer ID 和 notarization secrets 时，脚本会使用 ad-hoc 签名，只适合内部验证。
- 推送或提交前：保留 `dist/` 为未跟踪/忽略产物，不要暂存发布包；只暂存文档、脚本或源码变更。

## 汇报模板

完成后向用户说明：

- 打包命令和来源 app。
- DMG、ZIP、x64 清单的绝对路径。
- 架构、版本、签名、清单验证结果。
- 是否使用 ad-hoc 签名，是否适合正式发布。
- 如执行了提交/推送，给出 commit hash 和目标分支。
