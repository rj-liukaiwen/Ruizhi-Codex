# macOS arm64 打包记录

本文记录在本机为锐捷桌面端打包 macOS Apple Silicon/arm64 版本的实际流程、修复点与验证结果。

## 环境

- 工作目录：`/Volumes/ext_data/work/ai/rj-codex`
- 来源应用：`/Applications/Codex.app`
- 来源应用版本：`26.602.40724`
- 目标架构：`arm64`
- 应用版本：`0.2.3`
- Node.js：`v23.9.0`
- 系统：`Darwin 24.6.0 arm64`

## 打包命令

```bash
RUIZHI_MACOS_ARCH=arm64 node ./scripts/build-macos.mjs
```

脚本会读取 `RUIZHI_MACOS_ARCH` 并规范化为 `arm64`。当前脚本要求构建机架构与目标架构一致；本次构建机 `process.arch` 与源应用主程序均为 `arm64`。

## 构建前准备

本次构建前恢复了两个临时依赖/工作目录：

```bash
rm -rf /tmp/ruizhi-build-deps
mkdir -p /tmp/ruizhi-build-deps
cp package-lock.json /tmp/ruizhi-build-deps/package-lock.json
node - <<'NODE' >/tmp/ruizhi-build-deps/package.json
const lock=require('./package-lock.json');
const root=lock.packages[''];
console.log(JSON.stringify({
  name:root.name||'ruizhi-desktop-builder',
  version:root.version||'0.0.0',
  private:true,
  dependencies:root.dependencies||{},
  devDependencies:root.devDependencies||{}
}, null, 2));
NODE
npm ci --prefix /tmp/ruizhi-build-deps
mkdir -p /tmp/ruizhi-macos-work
```

原因：仓库中的 `node_modules` 是指向 `/tmp/ruizhi-build-deps/node_modules` 的符号链接，`.work/macos` 是指向 `/tmp/ruizhi-macos-work` 的符号链接；这两个 `/tmp` 目录不存在时，构建会分别失败于依赖解析和工作目录创建。

## 本次修复

构建环境的 `PATH` 中优先命中了 Python 安装的 `xattr`：

```text
/Library/Frameworks/Python.framework/Versions/3.12/bin/xattr
```

该实现不支持 macOS 系统 `xattr -cr` 递归清理参数，导致签名前失败。已将构建脚本中的签名前扩展属性清理改为显式调用系统工具：

```js
execLogged("/usr/bin/xattr", ["-cr", appOutRoot]);
```

## 主要流程

1. 清理并重建 `dist/macos` 与 `.work/macos`。
2. 从 `/Applications/Codex.app` 复制原始 app 到 `dist/macos/锐捷Codex.app`。
3. 更新 `Info.plist` 元数据：显示名、Bundle ID、版本号等。
4. 校验主程序 Mach-O 架构包含 `arm64`。
5. 编译并内置 `ruizhi-imagegen` 辅助工具。
6. 同步运行态覆盖内容：模型目录、Responses bridge、页面增强、imagegen skill、插件 marketplace。
7. 解包、补丁并重新打包 `app.asar`，包括中文化、更新逻辑、Browser/nativePipe、认证链接、菜单与帮助链接等补丁。
8. 关闭 `app.asar` 完整性校验 fuse。
9. 未配置 Developer ID secrets 时使用 ad-hoc 签名。
10. 生成 ZIP、DMG、更新清单与 electron-updater 清单。

## 输出产物

- `/Volumes/ext_data/work/ai/rj-codex/dist/Ruizhi-macos-0.2.3-arm64.dmg`
- `/Volumes/ext_data/work/ai/rj-codex/dist/Ruizhi-macos-0.2.3-arm64.zip`
- `/Volumes/ext_data/work/ai/rj-codex/dist/ruizhi-latest-macos-arm64.json`
- `/Volumes/ext_data/work/ai/rj-codex/dist/ruizhi-latest-macos-0.2.3-arm64.json`
- `/Volumes/ext_data/work/ai/rj-codex/dist/latest-mac-arm64.yml`
- `/Volumes/ext_data/work/ai/rj-codex/dist/latest-mac-0.2.3-arm64.yml`

脚本也会刷新通用 macOS 清单：

- `/Volumes/ext_data/work/ai/rj-codex/dist/ruizhi-latest-macos.json`
- `/Volumes/ext_data/work/ai/rj-codex/dist/latest-mac.yml`
- `/Volumes/ext_data/work/ai/rj-codex/dist/latest.yml`

完整构建日志：`docs/build/macos-arm64-ruizhi-build-20260608-150948.log`

## 验证命令

```bash
APP="/Volumes/ext_data/work/ai/rj-codex/dist/macos/锐捷Codex.app"
EXE="$APP/Contents/MacOS/Codex"

file "$EXE"
/usr/libexec/PlistBuddy \
  -c 'Print :CFBundleDisplayName' \
  -c 'Print :CFBundleIdentifier' \
  -c 'Print :CFBundleShortVersionString' \
  -c 'Print :CFBundleVersion' \
  "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
node -e "const m=require('./dist/ruizhi-latest-macos-arm64.json'); console.log(m.version, m.arch, m.macos.fileName, m.macos.size, m.macos.signed, m.macos.notarized)"
```

## 本次验证结果

- 主程序：`Mach-O 64-bit executable arm64`
- `CFBundleDisplayName`：`锐捷Codex`
- `CFBundleIdentifier`：`cn.ruizhi.desktop`
- `CFBundleShortVersionString`：`0.2.3`
- `CFBundleVersion`：`0.2.3`
- `codesign --verify --deep --strict`：通过
- `ruizhi-latest-macos-arm64.json`：`version=0.2.3`，`arch=arm64`，`fileName=Ruizhi-macos-0.2.3-arm64.zip`，`size=412473169`，`signed=false`，`notarized=false`
- 产物大小：DMG 约 `435M`，ZIP 约 `393M`

## 注意事项

- 默认来源是 `/Applications/Codex.app`；如需指定其他来源，设置 `CODEX_APP_ROOT`。
- 当前 arm64 打包需要在 Apple Silicon macOS 构建机上执行，脚本会拒绝跨架构打包。
- 没有配置 `MACOS_CODESIGN_IDENTITY`、Developer ID 和 notarization secrets 时，产物是 ad-hoc 签名，适合内部验证，不等同于正式公证发布包。
- 如果再次出现 `Cannot find package 'fs-extra'`，先检查 `node_modules` 符号链接和 `/tmp/ruizhi-build-deps` 是否仍存在。
- 如果再次出现 `.work/macos` 创建失败，先检查 `/tmp/ruizhi-macos-work` 是否仍存在。
- 如果再次出现 `spawnSync go ENOENT` 或 `go` 不在 `PATH`，按 `docs/build/skills/rj-codex-macos-arm64/SKILL.md` 的「Go 工具链准备」节临时下载 Go 到 `/tmp/ruizhi-go`，然后用 `PATH="/tmp/ruizhi-go/go/bin:$PATH"` 重跑打包；不要硬编码系统 Go 路径。
- 来源应用主程序名不要假设为 `Codex`。用 `Info.plist` 的 `CFBundleExecutable` 定位；新版 `/Applications/Codex.app` 可能是 `Contents/MacOS/ChatGPT`。
- 提交代码时不要把 `dist/` 产物纳入 Git，除非发布流程明确要求。
