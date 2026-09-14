# macOS x64 打包记录

本文记录在本机为锐捷桌面端打包 macOS Intel/x86_64 版本的实际流程与验证结果。

## 环境

- 工作目录：`/Users/tom/work/rj/rj-codex`
- 来源应用：`/Applications/Codex.app`
- 目标架构：`x64` / `x86_64`
- 应用版本：`0.2.3`
- Node.js：`v22.14.0`
- pnpm：`8.3.1`

## 打包命令

```bash
RUIZHI_MACOS_ARCH=x64 node ./scripts/build-macos.mjs
```

脚本会读取 `RUIZHI_MACOS_ARCH` 并规范化为 `x64`。当前脚本要求构建机架构与目标架构一致；在 x64 构建时，主程序 Mach-O 架构需要包含 `x86_64`。

## 主要流程

1. 清理并重建 `dist/macos` 与 `.work/macos`。
2. 从 `/Applications/Codex.app` 复制原始 app 到 `dist/macos/锐捷Codex.app`。
3. 更新 `Info.plist` 元数据：显示名、Bundle ID、版本号等。
4. 使用 `lipo -archs` 校验主程序包含目标架构 `x86_64`。
5. 编译并内置 `ruizhi-imagegen` 辅助工具。
6. 同步运行态覆盖内容：模型目录、Responses bridge、页面增强、imagegen skill、插件 marketplace。
7. 解包、补丁并重新打包 `app.asar`，包括中文化、更新逻辑、Browser/nativePipe、认证链接、菜单与帮助链接等补丁。
8. 关闭 `app.asar` 完整性校验 fuse。
9. 未配置 Developer ID secrets 时使用 ad-hoc 签名。
10. 生成 ZIP、DMG、更新清单与 electron-updater 清单。

## 输出产物

- `/Users/tom/work/rj/rj-codex/dist/Ruizhi-macos-0.2.3-x64.dmg`
- `/Users/tom/work/rj/rj-codex/dist/Ruizhi-macos-0.2.3-x64.zip`
- `/Users/tom/work/rj/rj-codex/dist/ruizhi-latest-macos-x64.json`
- `/Users/tom/work/rj/rj-codex/dist/ruizhi-latest-macos-0.2.3-x64.json`
- `/Users/tom/work/rj/rj-codex/dist/latest-mac-x64.yml`
- `/Users/tom/work/rj/rj-codex/dist/latest-mac-0.2.3-x64.yml`

脚本也会刷新通用 macOS 清单：

- `/Users/tom/work/rj/rj-codex/dist/ruizhi-latest-macos.json`
- `/Users/tom/work/rj/rj-codex/dist/latest-mac.yml`
- `/Users/tom/work/rj/rj-codex/dist/latest.yml`

## 验证命令

```bash
APP="/Users/tom/work/rj/rj-codex/dist/macos/锐捷Codex.app"
EXE="$APP/Contents/MacOS/Codex"

lipo -archs "$EXE"
plutil -extract CFBundleDisplayName raw "$APP/Contents/Info.plist"
plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
node -e "const m=require('./dist/ruizhi-latest-macos-x64.json'); console.log(m.version, m.arch, m.macos.fileName, m.macos.size)"
```

## 本次验证结果

- `lipo -archs` 输出：`x86_64`
- `CFBundleDisplayName`：`锐捷Codex`
- `CFBundleShortVersionString`：`0.2.3`
- `codesign --verify --deep --strict`：通过
- `ruizhi-latest-macos-x64.json`：`version=0.2.3`，`arch=x64`，`fileName=Ruizhi-macos-0.2.3-x64.zip`，`size=426565513`
- 产物大小：DMG 约 `458M`，ZIP 约 `407M`

## 注意事项

- 默认来源是 `/Applications/Codex.app`；如需指定其他来源，设置 `CODEX_APP_ROOT`。
- 当前 x64 打包需要在 x64 macOS 构建机上执行，脚本会拒绝跨架构打包。
- 没有配置 `MACOS_CODESIGN_IDENTITY`、Developer ID 和 notarization secrets 时，产物是 ad-hoc 签名，适合内部验证，不等同于正式公证发布包。
- 提交代码时不要把 `dist/` 产物纳入 Git，除非发布流程明确要求。
