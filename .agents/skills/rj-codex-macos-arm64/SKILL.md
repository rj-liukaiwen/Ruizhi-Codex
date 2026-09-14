---
name: rj-codex-macos-arm64
description: Build, verify, document, or troubleshoot the rj-codex macOS Apple Silicon/arm64 desktop package from /Applications/Codex.app with scripts/build-macos.mjs. Use for requests such as 打包 mac arm, macOS arm64 release, generating DMG/ZIP/update manifests, checking arm64/codesign output, fixing repeated go/ruizhi-imagegen build failures, verifying 锐智 onboarding copy, or keeping dist artifacts out of commits.
---

# rj-codex macOS arm64 打包

用于在本项目为锐智桌面端生成 macOS Apple Silicon/arm64 包并验证产物。默认不要提交 `dist/` 产物，除非用户明确要求。

## 先决检查

1. 进入当前仓库根目录，先运行 `git status --short --branch`，识别已有脏改；后续只处理本任务相关文件。
2. 确认来源应用存在：`test -d /Applications/Codex.app`。如用户指定来源，使用 `CODEX_APP_ROOT=/path/to/Codex.app`。
3. 确认构建机和 Node 都是 arm64：`uname -m` 与 `node -p 'process.arch'` 都应为 `arm64`。
4. 不要硬编码来源主程序名。用 `Info.plist` 读取可执行文件：

```bash
SRC_APP="${CODEX_APP_ROOT:-/Applications/Codex.app}"
SRC_EXE_NAME=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$SRC_APP/Contents/Info.plist")
file "$SRC_APP/Contents/MacOS/$SRC_EXE_NAME"
```

判断标准：输出包含 `Mach-O 64-bit executable arm64`。新版来源 app 可能叫 `ChatGPT`，不是 `Codex`。

5. 记录运行环境：`node -v`、`npm -v`、`pnpm -v`、`command -v go || true`。

## 临时目录与依赖准备

本仓库常见状态是：

- `node_modules -> /tmp/ruizhi-build-deps/node_modules`
- `.work/macos -> /tmp/ruizhi-macos-work`

构建前执行：

```bash
mkdir -p /tmp/ruizhi-build-deps /tmp/ruizhi-macos-work
if [ ! -d /tmp/ruizhi-build-deps/node_modules/fs-extra ]; then
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
fi
```

## Go 工具链准备

`scripts/build-macos.mjs` 会用 `go build` 编译 `cmd/ruizhi-imagegen`。如果 `command -v go` 为空，或构建报 `spawnSync go ENOENT`，不要停下；用临时 Go toolchain 后重跑构建：

```bash
if ! command -v go >/dev/null 2>&1; then
  mkdir -p /tmp/ruizhi-go-download
  node <<'NODE' >/tmp/ruizhi-go-download/go-url.txt
const https = require('node:https');
https.get('https://go.dev/dl/?mode=json', (res) => {
  let body = '';
  res.on('data', (chunk) => body += chunk);
  res.on('end', () => {
    const releases = JSON.parse(body);
    const stable = releases.find((release) => release.stable);
    const file = stable?.files?.find((item) =>
      item.os === 'darwin' && item.arch === 'arm64' && item.kind === 'archive'
    );
    if (!file) throw new Error('No darwin arm64 Go archive found');
    console.log(`https://go.dev/dl/${file.filename}`);
  });
}).on('error', (error) => { throw error; });
NODE
  GO_URL=$(cat /tmp/ruizhi-go-download/go-url.txt)
  GO_FILE="/tmp/ruizhi-go-download/$(basename "$GO_URL")"
  [ -f "$GO_FILE" ] || curl -fL "$GO_URL" -o "$GO_FILE"
  rm -rf /tmp/ruizhi-go
  mkdir -p /tmp/ruizhi-go
  tar -C /tmp/ruizhi-go -xzf "$GO_FILE"
  export PATH="/tmp/ruizhi-go/go/bin:$PATH"
fi
go version
```

这个流程只写 `/tmp`，不改系统目录。若网络不可用，再向用户说明缺 Go 是当前阻塞点。

## 打包命令

默认 Apple Silicon/arm64 打包：

```bash
CODEX_APP_ROOT=/Applications/Codex.app RUIZHI_MACOS_ARCH=arm64 node ./scripts/build-macos.mjs
```

如刚准备了临时 Go，必须在同一个 shell 或同一个命令里带上 PATH：

```bash
PATH="/tmp/ruizhi-go/go/bin:$PATH" CODEX_APP_ROOT=/Applications/Codex.app RUIZHI_MACOS_ARCH=arm64 node ./scripts/build-macos.mjs
```

不要在 x64 主机硬搓 arm64 包。

## 脚本主要动作

- 清理并重建 `dist/macos` 与 `.work/macos`。
- 从 `CODEX_APP_ROOT` 或 `/Applications/Codex.app` 复制原始 app 到 `dist/macos/锐智.app`。
- 更新 `Info.plist` 元数据：显示名、Bundle ID、版本号等。
- 校验 app 主程序 Mach-O 架构包含 `arm64`。
- 编译并内置 `ruizhi-imagegen`。
- 同步运行态覆盖：模型目录、Responses bridge、页面增强、imagegen skill、插件 marketplace。
- 解包、补丁并重新打包 `app.asar`，包括中文化、更新逻辑、Browser/nativePipe、认证链接、菜单与帮助链接等补丁。
- 使用 `/usr/bin/xattr -cr` 清理扩展属性。
- 未配置 Developer ID secrets 时使用 ad-hoc 签名。
- 生成 ZIP、DMG、更新清单与 electron-updater 清单。

## 预期产物

版本号来自 `config/rj-codex.json`：

- `dist/Ruizhi-macos-<version>-arm64.dmg`
- `dist/Ruizhi-macos-<version>-arm64.zip`
- `dist/ruizhi-latest-macos-arm64.json`
- `dist/ruizhi-latest-macos-<version>-arm64.json`
- `dist/latest-mac-arm64.yml`
- `dist/latest-mac-<version>-arm64.yml`
- `dist/ruizhi-latest-macos.json`
- `dist/latest-mac.yml`
- `dist/latest.yml`

## 验证流程

构建完成后运行：

```bash
APP="$PWD/dist/macos/锐智.app"
EXE_NAME=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")
EXE="$APP/Contents/MacOS/$EXE_NAME"

file "$EXE"
/usr/libexec/PlistBuddy \
  -c 'Print :CFBundleDisplayName' \
  -c 'Print :CFBundleIdentifier' \
  -c 'Print :CFBundleShortVersionString' \
  -c 'Print :CFBundleVersion' \
  "$APP/Contents/Info.plist"
codesign --verify --deep --strict --verbose=2 "$APP"
ls -lh dist/Ruizhi-macos-*-arm64.dmg dist/Ruizhi-macos-*-arm64.zip dist/ruizhi-latest-macos-arm64.json dist/latest-mac-arm64.yml
node -e "const m=require('./dist/ruizhi-latest-macos-arm64.json'); console.log(m.version, m.arch, m.macos.fileName, m.macos.size, m.macos.signed, m.macos.notarized)"
```

判断标准：

- `file "$EXE"` 输出包含 `Mach-O 64-bit executable arm64`。
- `CFBundleDisplayName` 为 `锐智`。
- `CFBundleIdentifier` 为 `cn.ruizhi.desktop`。
- `codesign --verify --deep --strict` 退出码为 `0`。
- `ruizhi-latest-macos-arm64.json` 中 `arch` 为 `arm64`，`macos.fileName` 指向 `Ruizhi-macos-<version>-arm64.zip`。

## 文案验证

解包最终 app 的 `app.asar` 验证欢迎页文案：

```bash
rm -rf /tmp/ruizhi-built-asar-check
node - <<'NODE'
const asar=require('asar');
const fs=require('fs');
const path=require('path');
const appAsar='dist/macos/锐智.app/Contents/Resources/app.asar';
const out='/tmp/ruizhi-built-asar-check';
fs.rmSync(out,{recursive:true,force:true});
asar.extractAll(appAsar,out);
const today=new Date();
const buildDate=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
const required=['使用锐擎继续',`锐智构建日期：${buildDate}`];
const forbidden=['使用 ChatGPT 继续','使用ChatGPT继续','所有 ChatGPT 套餐均包含','ChatGPT套餐均包含'];
let all='';
function walk(dir){
  for(const name of fs.readdirSync(dir)){
    const p=path.join(dir,name); const st=fs.statSync(p);
    if(st.isDirectory()) walk(p); else if(/\.(js|html|json)$/.test(name)) all += fs.readFileSync(p,'utf8')+'\n';
  }
}
walk(path.join(out,'webview'));
for(const text of required) console.log(`${text}: ${all.includes(text) ? 'FOUND' : 'MISSING'}`);
for(const text of forbidden) console.log(`${text}: ${all.includes(text) ? 'STILL_PRESENT' : 'absent'}`);
NODE
```

判断标准：必需文案为 `FOUND`，旧文案为 `absent`。

## 常见故障

- `spawnSync go ENOENT`：执行“Go 工具链准备”，并用带 `/tmp/ruizhi-go/go/bin` 的 PATH 重跑。
- 找不到来源 app：先安装 `/Applications/Codex.app`，或设置 `CODEX_APP_ROOT`。
- 来源可执行文件不是 `Codex`：正常；用 `CFBundleExecutable` 定位，不要硬编码。
- 架构不匹配：arm64 包需要在 Apple Silicon macOS 构建机上执行。
- 找不到 `fs-extra`：恢复 `/tmp/ruizhi-build-deps`，确认 `node_modules` 符号链接有效。
- `.work/macos` 创建失败：恢复 `/tmp/ruizhi-macos-work`。
- `xattr -cr` 失败：确认构建脚本使用 `/usr/bin/xattr`。
- 签名不是正式发布签名：未配置 `MACOS_CODESIGN_IDENTITY`、Developer ID 和 notarization secrets 时，脚本会使用 ad-hoc 签名，只适合内部验证。
- 推送或提交前：不要暂存 `dist/` 发布包；只暂存文档、脚本或源码变更。

## 汇报模板

完成后说明：

- 打包命令和来源 app。
- DMG、ZIP、arm64 清单的绝对路径。
- 架构、版本、签名、清单验证结果。
- 欢迎页按钮和构建日期文案验证结果。
- 是否使用 ad-hoc 签名，是否适合正式发布。
- 如执行了提交/推送，给出 commit hash 和目标分支。
