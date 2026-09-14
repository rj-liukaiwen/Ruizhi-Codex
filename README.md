# 锐捷Codex

这是一个 Codex Desktop 初版魔改构建工程。它不直接改系统安装目录，而是复制已安装的 Codex Desktop，解包 `app.asar` 后打补丁，再输出一个独立的桌面应用目录。

## 当前改动

- 登录页默认进入 APIKey 输入，不展示账号登录选择。
- 对外品牌统一为“锐捷”，APIKey 获取入口使用“锐擎API”相关文案。
- APIKey 文案改成通用 APIKey，并把取 Key 地址改为内部控制台地址。
- 默认锐捷 home 使用用户主目录下的 `.ruizhi`，优先读取 `RUIZHI_HOME`，并兼容 `CODEX_HOME`。启动后会把 `CODEX_HOME` 指向同一个目录，兼容 Codex 内部和 system skills 里写死的路径。
- Electron 启动时使用自定义 `ruizhi` provider，显示名为“锐擎API”。运行态先启动本地 Responses bridge，provider `base_url` 指向 `http://127.0.0.1:17888/v1`，上游仍是锐擎 UniAPI；认证继续复用 Codex 原生 APIKey 登录链路。
- APIKey 保存到锐捷 home 的 `auth.json`，不使用 `auth.command`，避免额外 token helper 把状态绕复杂。
- 默认语言设置为简体中文（`zh-CN`），并用内置 `zh-CN` 翻译回填前端 `defaultMessage`，避免首屏先显示英文再切中文。
- 默认配置开启 `default_mode_request_user_input`、`plugins`、`apps`、`browser_use`。
- 默认不重新编译 `resources\codex.exe`。只有必须修改 Rust 内嵌逻辑时才设置 `RUIZHI_BUILD_CODEX=1` 重编，否则优先走 Electron 启动注入、运行态资源同步和用户级缓存。
- 启动时从 GitLab raw 地址刷新模型目录到 `~/.codex/models_cache.json`，覆盖前备份已有文件，模型下拉框和本地 Responses bridge 都读取这份 Codex 模型缓存。目录只保留锐擎 API 里实测可用、适合 Codex 文本/代码协作的主流新模型：GPT 与 Qwen 走 `/v1/responses` 直通；Claude Opus/Sonnet、GLM 5.1、Kimi K2.6、MiniMax M2.7、DeepSeek V4 走本地 bridge 转换到 `/v1/chat/completions`。`qwen3.5`、`glm-5`、`kimi-k2.5`、`MiniMax-M2.5`、DeepSeek v3、embedding、realtime、rerank 和生图后端不放进 picker。
- GPT 模型在目录里显式标注 `input_modalities = ["text", "image"]`，避免前端误判“不支持图片输入”；非 GPT 模型暂按文本模型处理，后续要开放图片再逐个实测。
- 启动时写入 `RUIZHI_HOME\rules\ruizhi-managed.rules`，为内置锐捷 skill 的固定脚本命令预置 `prefix_rule(..., decision="allow")`，覆盖内置 marketplace 路径、本机 `.agents\skills` 路径和内置生图 helper 直接执行路径，避免用户没开完全访问权限时反复弹授权；只放行具体脚本 / helper 子命令，不全局放开 `node` / `bash` / PowerShell。
- 内置 `ruizhi-imagegen.exe` 生图 helper，并在运行态覆盖 system `imagegen` skill：默认走锐擎 UniAPI 的 `gpt-image-2`，从 `RUIZHI_HOME` / `CODEX_HOME` 的 `auth.json` 读取 APIKey，不要求用户安装 Python SDK 或手动设置 `OPENAI_API_KEY`。生成成功后要求直接用 Markdown 图片语法把本地图片渲染进会话，而不是只甩一个文件路径；用户只说“生成一张图片”这类缺主题请求时，优先通过 `request_user_input` 继续收集主题，避免普通 final 回复把任务显示成已结束。
- 会话列表和对话头里的“归档”文案改为“删除”，已归档对话页改为“已删除对话”，恢复动作改为“恢复”。底层仍使用 Codex 原生归档能力，不做物理删除。
- 内置本地插件 marketplace：`锐捷插件`。HBR 中文版检索、混沌大学检索、快速找书、锐捷知识库、NotebookLM 读书助手、Seedance 提示词助手和火山引擎视频生成分别作为独立插件展示，避免继续挤在一个聚合插件里。
- 启动时按插件 manifest 版本号同步内置 marketplace 到 `CODEX_HOME\.tmp\marketplaces`，只替换锐捷托管块，不覆盖用户已安装插件状态。
- 启动时先禁用 Codex 官方更新器，再在后台检查锐捷更新清单；如果发现新版本，会在使用过程中自动下载 NSIS 安装包，下载完成后提示用户，等用户退出锐捷时再静默安装。
- 主程序保留为 `Codex.exe`，进程名回到 Codex；安装器创建的桌面/开始菜单快捷方式显示为“锐捷Codex”。
- 从旧版升级时，安装器会清理安装目录里历史遗留的 `锐捷.exe`，避免旧进程名残留。
- 输出 NSIS 安装包，支持选择安装路径、开始菜单/桌面快捷方式、静默安装和系统卸载入口。
- 去掉 `app.asar` 完整性校验 fuse，让补丁后的 asar 可以启动。
- 输出 Windows zip 包。

## 构建

```powershell
cd C:\Users\ruijie\Desktop\rj-codex
npm install
npm run import:codex-windows-source
npm run build:windows
```

`import:codex-windows-source` 会把当前本机官方 Codex Desktop 导入到 `vendor\codex-desktop\windows\current\app`，并写入 `vendor\codex-desktop\windows\current\source-manifest.json`。`build:windows` 只读取这个固定快照，不再自动扫描 WindowsApps 最新版本；官方大更新后需要显式重新导入并适配补丁点。

Windows `app.asar` 定制代码放在 `overrides\windows-app\asar`，这个目录是相对官方 `app.asar` 的覆盖层。固定快照继续保持只读基线，不要直接改 `vendor\codex-desktop\windows\current\app`。

```powershell
npm run export:windows-overrides
npm run sync:windows-test
npm run watch:windows-test
```

`export:windows-overrides` 会从当前已补丁的测试包导出差异文件，用于升级固定快照后重建覆盖层。平时改前端或 Electron 主进程逻辑，直接编辑 `overrides\windows-app\asar` 里的文件，然后跑 `sync:windows-test` 重新打进 `dist\test-app-<version>\resources\app.asar`；已经启动的 Electron 不会运行时替换 JS，需要重启 `dist\test-app-<version>\Codex.exe`。`watch:windows-test` 只是自动同步覆盖层文件变更，不会自动重启应用。

默认构建不会重新编译 Rust 版 Codex，速度主要花在复制固定 Electron 资源、应用 `app.asar` 覆盖层、生成 Go helper 和安装包。确实需要改 `resources\codex.exe` 这个 Rust app server/CLI helper 时再显式打开：

```powershell
$env:RUIZHI_BUILD_CODEX = "1"
npm run build:windows
```

如果需要临时回到旧的字符串补丁链路重新生成覆盖层，可以显式打开：

```powershell
$env:RUIZHI_WINDOWS_USE_LEGACY_PATCHES = "1"
npm run build:windows
npm run export:windows-overrides
```

Windows 正式分发产物放到 `dist\installer`。如果要本地直接点开测试，运行测试目录：

```powershell
.\dist\test-app-<version>\Codex.exe
```

实际目录带版本号，例如：

```powershell
.\dist\test-app-0.1.13\Codex.exe
```

`dist\test-app-<version>\Codex.exe` 就是补丁后的 Electron 主程序，不是二次转发启动器；安装后的快捷方式名称仍是“锐捷”。`.work\windows-app-out` 是开发构建中间产物，`resources\codex.exe` 是 Codex 自带的 app server/CLI helper，不是用户入口。

## macOS 云构建

```shell
CODEX_APP_ROOT=/Applications/Codex.app npm run build:macos
```

最短路径是用 GitHub Actions 的 macOS runner 打 unsigned 包：

```powershell
gh workflow run build-macos.yml
```

不传 `codex_app_url` 时，脚本会默认下载 OpenAI 官方 Codex Desktop macOS DMG。也可以在仓库 Secrets 里配置 `CODEX_MACOS_APP_URL` 覆盖默认来源。这个 URL 必须指向包含 `Codex.app` 的 `.zip` 或 `.dmg`，构建脚本会复制官方 app、补丁 `Contents/Resources/app.asar`、内置锐捷模型/插件/生图 helper、写入 MinIO generic update 配置、做签名，然后上传 `dist/Ruizhi-macos-<version>.zip`、`dist/latest.yml`、`dist/latest-<version>.yml`、`dist/ruizhi-latest-macos.json` 和 `dist/ruizhi-latest-macos-<version>.json`。JSON 里的 `macos` 和 `manualDownload` 都指向同一个英文 zip，官网/人工下载继续读取 `ruizhi-latest-macos.json`。当前 macOS 云构建只支持 arm64，如果 runner 不是 arm64 会直接失败。GitHub 下载单个 artifact 时仍会套一层 zip，这是 GitHub Actions 平台机制；现在每个 artifact 只包含一个目标文件，不再把全部 macOS 产物揉成一个集合包。

这不是正式分发签名。要给普通用户无拦截安装，还需要 Apple Developer ID 签名和 notarization；先把 unsigned 云包跑通，别一上来就把苹果全家桶塞进 CI 里抽盲盒。

如果要在云端做正式签名和公证，在 GitHub 仓库 Secrets 里配置：

```text
MACOS_CERTIFICATE_P12_BASE64
MACOS_CERTIFICATE_PASSWORD
MACOS_CODESIGN_IDENTITY
APP_STORE_CONNECT_KEY_ID
APP_STORE_CONNECT_ISSUER_ID
APP_STORE_CONNECT_PRIVATE_KEY_BASE64
```

`MACOS_CERTIFICATE_P12_BASE64` 是 Developer ID Application 证书导出的 `.p12` 的 base64 内容。`APP_STORE_CONNECT_PRIVATE_KEY_BASE64` 是 App Store Connect API Key `.p8` 的 base64 内容。缺少这些 secrets 时，workflow 会自动降级为 ad-hoc 签名包，`ruizhi-latest-macos.json` 会标记 `signed:false`、`notarized:false`。macOS 自动更新必须用正式 Developer ID 签名和 notarization 才能给普通用户稳定工作；ad-hoc 包只适合内测跑链路。

如果只是自己测试 Mac 能不能跑，不需要 Apple 开发者账号。下载 artifact 里的 `ruizhi-macos-update-<version>`，先解开 GitHub 外层 zip，再解开里面的 `Ruizhi-macos-<version>.zip`，把 `锐捷Codex.app` 放到 `/Applications` 或 `~/Applications`：

```bash
xattr -dr com.apple.quarantine /Applications/锐捷Codex.app
open /Applications/锐捷Codex.app
```

未配置 Developer ID 和 notarization 时，macOS 仍可能提示拦截；内测机可以右键 `锐捷Codex.app` 选择打开。正式给普通用户分发仍然要走 Developer ID 签名和公证。

首次启动会生成：

```powershell
%USERPROFILE%\.ruizhi\config.toml
%USERPROFILE%\.ruizhi\auth.json
%USERPROFILE%\.codex\models_cache.json
%USERPROFILE%\.ruizhi\.tmp\marketplaces\ruijie-skills
```

`config.toml` 里的锐捷托管配置被 `# BEGIN Ruizhi Managed Defaults` 和 `# END Ruizhi Managed Defaults` 包住。后续更新只替换这个托管块，Codex 自己写入的插件安装状态会保留。

生图 helper 会随 Windows 产物放在：

```powershell
.\dist\test-app-<version>\resources\bin\ruizhi-imagegen.exe
```

在锐捷进程中会自动设置：

```powershell
$env:RUIZHI_HOME
$env:CODEX_HOME
$env:RUIZHI_OPENAI_BASE_URL
$env:RUIZHI_MODEL_PROVIDER_BASE_URL
$env:RUIZHI_IMAGEGEN_EXE
```

system `imagegen` skill 会优先使用 `$env:RUIZHI_IMAGEGEN_EXE`，例如：

```powershell
& $env:RUIZHI_IMAGEGEN_EXE generate --prompt "一张锐捷桌面端启动页概念图" --out "output/imagegen/ruizhi.png" --quality medium --size auto --force
```

Windows 正式分发产物只看 `dist\installer`：

```powershell
.\dist\installer\Ruizhi-Setup-<version>.exe
.\dist\installer\Ruizhi-Setup-<version>.exe.blockmap
.\dist\installer\latest.yml
.\dist\installer\ruizhi-windows-<version>.zip
```

每次 Windows 构建还会保留一个可直接点击的测试程序：

```powershell
.\dist\test-app-<version>\Codex.exe
```

`dist\test-app-<version>` 是测试环境，不是分发物，不上传到更新目录。它带 `resources\ruizhi-environment.json` 标记，启动后版本号显示为 `<version>-test`，并跳过自动更新，避免测试时被远端正式包覆盖。`.work\windows-app-out` 只是开发构建中间产物，构建结束后会标记为 `development`。

Windows 不再生成 `dist\锐捷Codex-Setup.exe`、`dist\installer\锐捷Codex-Setup-<version>.exe` 或 `dist\ruizhi-latest.json`。自动更新和官网下载统一以 `latest.yml` 为准。发版时先把 `dist\installer\Ruizhi-Setup-<version>.exe` 上传到 `updates.downloadBaseUrl` 对应目录，再上传同目录下的 `Ruizhi-Setup-<version>.exe.blockmap`，最后覆盖 `dist\installer\latest.yml` 为远端 `latest.yml`；顺序别反，反了客户端就会拿着清单找不存在的包。

macOS 自动更新走 macOS 目录下的 `latest.yml`。官网和人工下载继续走 `ruizhi-latest-macos.json`，但 JSON 里的 `macos` 和 `manualDownload` 都指向同一个 `Ruizhi-macos-<version>.zip`，不再单独生成中文 app zip 或 test-kit。发版时先把 `dist\Ruizhi-macos-<version>.zip` 上传到 `updates.macos.downloadBaseUrl` 对应目录，再上传版本化清单，最后覆盖同目录下的 `latest.yml` 和 `ruizhi-latest-macos.json`。

当前更新临时走 MinIO S3 HTTP 直链：

```text
http://minio.rjagi.cn:9000/ai-ruizhi/updates/windows/latest.yml
http://minio.rjagi.cn:9000/ai-ruizhi/updates/windows/Ruizhi-Setup-<version>.exe
http://minio.rjagi.cn:9000/ai-ruizhi/updates/windows/Ruizhi-Setup-<version>.exe.blockmap
http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/latest.yml
http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/latest-<version>.yml
http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/ruizhi-latest-macos.json
http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/ruizhi-latest-macos-<version>.json
http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/Ruizhi-macos-<version>.zip
```

`https://minio.rjagi.cn/browser/ai-ruizhi` 只是 MinIO Console 页面，不是客户端更新直链。HTTP 分发只适合当前内测跑通链路；正式分发前还是应该把 `minio-s3.rjagi.cn` 的可信 HTTPS 反代修好，并且只给 `ai-ruizhi/updates/windows/*` 和 `ai-ruizhi/updates/macos/*` 开匿名只读，不要开放匿名上传。

下载页 Docker 镜像里的 Nginx 会把 `/updates/windows/` 和 `/updates/macos/` 分别反代到 MinIO 的 `http://minio.rjagi.cn:9000/ai-ruizhi/updates/windows/` 和 `http://minio.rjagi.cn:9000/ai-ruizhi/updates/macos/`。官网页面使用同源 `/updates/windows/latest.yml`，避免 HTTPS 页面直接请求 HTTP MinIO 被浏览器拦截；清单里的安装包相对路径也会继续走同一个代理前缀。

macOS 目录按 electron-updater 的 generic 结构放：

```text
ai-ruizhi/updates/macos/latest.yml
ai-ruizhi/updates/macos/latest-<version>.yml
ai-ruizhi/updates/macos/ruizhi-latest-macos.json
ai-ruizhi/updates/macos/ruizhi-latest-macos-<version>.json
ai-ruizhi/updates/macos/Ruizhi-macos-<version>.zip
```

当前脚本每次生成的 `latest.yml` 只指向一个 arm64 zip，文件名不带架构后缀。后面要同时兼容 Intel 和 Apple Silicon 时，再改成 universal zip；不要在当前目录里临时混入 x64/arm64 后缀或子目录。上传顺序和 Windows 一样：先传 zip 和版本化清单，最后覆盖 `latest.yml` 与 `ruizhi-latest-macos.json`，避免客户端或官网读到清单时安装包还不存在。

## 官网

`website/` 是锐捷官网静态页。页面会先请求版本清单，再从清单里的 `url` 解析出最终下载地址，不把安装包地址硬编码进前端。

推荐的分发策略是：

- Windows 走 `latest.yml`，前端从 `path` / `files[0].url` 解析出安装包地址。
- macOS 自动更新走 `/updates/macos/latest.yml`；官网下载仍可读 `ruizhi-latest-macos.json`，`macos.url` 可以是同目录相对路径，也可以是完整 URL。
- 不要直接把 GitHub Actions artifact 链接塞给官网用户，那种链接不是稳定公开下载源；如果要走 GitHub，应该用 Release asset。
- 如果官网后面要挂到 HTTPS 域名，清单和下载源也要换成 HTTPS 或同源代理；浏览器会拦截 HTTPS 页面去请求 HTTP 下载源。

## 下载页 Docker

`website` 是纯静态下载页，Docker 镜像只用 Nginx 托管页面，不参与桌面端构建。

```powershell
npm run build:website-docker
npm run serve:website-docker
npm run push:website-docker
```

默认访问地址：

```text
http://localhost:8080
```

需要换端口时：

```powershell
$env:RUIZHI_WEBSITE_PORT = "18080"
docker compose up -d
```

默认发布镜像：

```text
hocho5i996/rj-codex-website:0.1.13
```

如果后面要切到别的 Docker Hub 仓库，直接覆盖：

```powershell
$env:RUIZHI_WEBSITE_IMAGE = "你的命名空间/你的仓库:你的标签"
docker compose build
docker compose push
```

## 说明

这个初版是 UI 与本地配置层补丁，不是重新实现 Codex 后端。Codex 官方远端插件商店如果在服务端继续要求 ChatGPT 账号，单靠前端补丁不能把服务端权限变出来；这不是魔法，是 HTTP。后续要做成完全可控安装包，还需要处理签名、品牌资源、远端插件策略和 release 分发。

启动时的 `RUIZHI_HOME` / `CODEX_HOME`、用户数据目录和内置 marketplace 同步逻辑已经按 Windows/macOS/Linux 分支写入。macOS 构建必须在 macOS 上完成 `.app` 解包、补丁和重新签名；正式分发还要接 Apple Developer ID 与 notarization。Windows 上硬搓不了，这不是玄学，是苹果签名链。
