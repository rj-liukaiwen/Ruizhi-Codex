---
name: ruijie-codex-desktop
description: v2026.05.11.01；当需要排查、修改、测试或打包锐智/Codex Desktop 固定快照覆盖层、本机配置、账号态/APIKey、skills 注入、插件/商店、权限规则、网络端点、日志状态、GitHub openai/codex issues 情报和 Windows/macOS 兼容时使用。适用于 app.asar 覆盖层、Windows installer/test-app、macOS app/zip、local marketplace、auth.json/config.toml/rules/default.rules、~/.agents/skills、~/.codex/plugins/marketplace/cache、桌面应用资源和打包验证等任务。
---

# 锐智 Codex 桌面版

## 核心原则

这个 skill 用于维护 `rj-codex` 里的锐智桌面版固定快照、覆盖层、打包脚本和相关本机状态。先判断产品边界，再动配置；不要把 ChatGPT 账号态、Codex 商店服务端限制、API provider 配置混成一坨。

- 不要打印 `auth.json`、环境变量或日志里的 token/API key。需要查看时只输出结构、字段名、认证模式和脱敏后的域名。
- 修改真实用户状态前，优先在仓库代码和测试里实现；确实要动 `~/.codex` 或 `~/.agents` 时，保留备份或使用项目已有备份机制。
- Windows 和 macOS 路径都用 `os.UserHomeDir`、`filepath`、`os.UserConfigDir` 这类跨平台 API 推导，不要硬编码 `C:\Users\...`。
- GitHub `openai/codex` issues 是重要情报源，尤其是 `app`、`auth`、`skills`、`sandbox`、`windows-os`、`macos`、`plugins` 相关问题。碰到桌面版、插件、网络、权限、沙箱和账号态问题时，先判断是否需要查 issue；发布前或未知异常必须查。
- 非预期异常不要吞掉。切换器失败应该明确报错，别假装“已配置成功”。
- `vendor/codex-desktop/windows/current/app` 是只读官方基线，不直接改；我们的可维护源码放在 `overrides/windows-app/asar/` 和构建脚本里。
- Windows 构建要保留可直接点击测试的 `dist/test-app-<version>/Codex.exe`；正式发布主要看 `dist/installer` 下的 installer、版本 zip 和 manifest。`dist/installer` 不清空历史产物。
- macOS 构建走 GitHub Actions 云构建，入口是 `.github/workflows/build-macos.yml`；本地脚本只能在 macOS 上运行，当前脚本会在非 Darwin 平台直接失败，不要在 Windows 上硬造 `.app`。

## 工作流

1. 先读项目状态：运行 `git status --short`，确认不要覆盖用户已有修改；再用 `rg` 定位 `scripts/`、`config/rj-codex.json`、`overrides/windows-app/asar/`、`marketplaces/`、`resources/` 里的相关逻辑。

2. 判断是否需要搜 GitHub issues：未知桌面版异常、插件商店、账号态、官方服务限制、沙箱和平台兼容问题，优先查 `repo:openai/codex is:issue`。普通文案、覆盖层、打包脚本和本项目已知功能不要为了形式主义乱搜。

3. 读取本机 Codex 状态时只看必要文件：`~/.codex/config.toml`、`~/.codex/.codex-global-state.json`、`~/.codex/rules/default.rules`、`~/.codex/plugins/`、`~/.codex/codex-switcher/`、`~/.agents/skills/`。`auth.json` 只能脱敏查看。

4. 如果任务涉及网络、商店、插件灰掉、账号态/APIKey 差异、桌面应用资源或 SQLite 日志，读取 `references/codex-desktop-map.md`，按里面的命令抽取域名、端点和状态，不要全盘乱 grep。

5. 实现 Windows 桌面改动时优先走覆盖层：先定位官方 `app.asar` 解包后的实际文件，再把差异文件放入 `overrides/windows-app/asar/`。只适合构建期注入的逻辑放在 `scripts/windows-asar-overrides.mjs`，不要默认继续堆脆弱字符串替换。

6. 常规验证按改动范围选择：只改 JS 构建脚本先跑 `node --check`；改覆盖层后跑 `npm run sync:windows-test` 并重启 `dist/test-app-<version>/Codex.exe`；发布新版本跑端到端检查后再打包。

7. 打包发布版本时统一改 `config/rj-codex.json` 的 `version`。Windows 执行 `npm run build:windows`，期望输出 `dist/installer/Ruizhi-Setup-<version>.exe`、`dist/installer/ruizhi-windows-<version>.zip`、`dist/installer/latest.yml`、`dist/installer/latest-<version>.yml` 和 `dist/test-app-<version>/Codex.exe`。macOS 通过 GitHub Actions 执行 `npm run build:macos`，期望输出 `dist/macos/锐智.app`、`dist/Ruizhi-macos-<version>-<arch>.zip`、`dist/latest-mac.yml`、`dist/latest-mac-<version>.yml`、`dist/ruizhi-latest-macos.json` 和 `dist/ruizhi-latest-macos-<version>.json`；上传 artifact 时每个文件单独一个 artifact，名称带 `<version>` 和必要的 `<arch>`，不要再上传一个包含所有 macOS 产物的集合包。

## 固定快照与覆盖层

- 官方 Windows 快照固定在 `vendor/codex-desktop/windows/current/app`，用 `vendor/codex-desktop/windows/current/source-manifest.json` 校验，不直接修改。
- 覆盖层目录是 `overrides/windows-app/asar/`，只保存相对官方 `app.asar` 有差异的文件。
- `npm run export:windows-overrides` 用于从当前补丁结果导出覆盖层。
- `npm run sync:windows-test` 用于把覆盖层快速重新打入 `dist/test-app-<version>/resources/app.asar`。
- `npm run watch:windows-test` 只做测试热同步；Electron 已加载代码不会运行时热替换，仍需要重启 `dist/test-app-<version>/Codex.exe`。
- 模型列表、默认中文、APIKey 登录、禁用官方更新、版本测试标记、菜单中文化、托盘菜单、内置技能权限和插件不可用提示都属于需要在发布前抽查的 patch 面。

## GitHub Issues 情报

先用 GitHub 搜索定位同类问题，再和本机现象对照。常用搜索：

```text
repo:openai/codex is:issue Codex desktop marketplace plugin auth
repo:openai/codex is:issue skills local plugin Electron UI
repo:openai/codex is:issue API key ChatGPT auth plugin
repo:openai/codex is:issue Windows sandbox WindowsApps ACL
repo:openai/codex is:issue macOS CODEX_HOME bundled marketplace
repo:openai/codex is:issue backend-api plugins featured Cloudflare
```

优先关注这些信息：

- 复现版本、平台、订阅类型、auth mode、CLI/app 版本。
- 日志路径、具体错误字符串、失败端点、状态码。
- issue 作者已验证的 workaround 和明确无效的方案。
- 是否标了 `app`、`auth`、`skills`、`sandbox`、`windows-os` 等标签。
- 是否只是 Electron UI 缺陷，而 CLI/runtime 已经正常。

已知有价值的 issue 类型：

- 插件 marketplace 请求 `chatgpt.com/backend-api/plugins/featured?platform=codex` 被 403/Cloudflare challenge 拦住，说明桌面 UI 商店不只是本地配置问题。
- local skill-bearing plugin 在 CLI/runtime 里 namespaced 正常，但 Electron UI 会把 plugin-owned skills 暴露成独立项，说明 UI 展示和 runtime 不是一回事。
- macOS `CODEX_HOME` 路径含 `@` 会影响 bundled marketplace 解析，路径字符本身可能触发 git ref 误判。
- Windows sandbox 在 WindowsApps 资源 ACL 上失败，会表现成子进程超时或 `CreateProcessWithLogonW` 失败，不能简单归咎到 PowerShell。
- local marketplace 的 plugin path 不能用 `./` 指向 root，必须放在子目录或按当前校验规则调整。

## 关键判断

- `auth_mode = apikey` 主要影响模型/API 请求链路，不等于拥有 ChatGPT 账号态。Codex 商店插件、账号授权、部分内置能力可能仍依赖 ChatGPT 账号服务。
- 本地 marketplace/plugin metadata 可以让插件预装或展示，但不能绕过服务端账号登录要求。别再写那种“改个 config 就能打开官方商店”的玄学代码。
- Skills 注入是可靠路径：把 skill 复制到 `~/.agents/skills`，用版本 marker 判定是否需要覆盖，必要时同步 `~/.codex/rules/default.rules` 的命令权限。
- 权限规则要“先识别后重写”：删除旧的本项目托管规则，再写当前规则，保留用户自己的规则，避免 default.rules 变成垃圾堆。
- 直接 patch Codex Desktop 应用资源、`app.asar` 或 WindowsApps 目录属于高风险实验，容易被更新覆盖，也可能破坏签名。生产方案优先走配置、switcher、skills 和 local marketplace。

## 常用任务

### APIKey/账号切换

检查主进程里的 `ruizhi:auth:set-and-test`、本地 provider、默认模型和 `Authorization` 头处理。API key 需要去除首尾空白和换行，不要把用户输入原样拼入 header。

### Skills 注入

检查系统 skill、本地 skill、内置 skill 权限规则和 marketplace 同步。新增面向用户的内置 skill 时，必须同步 Windows 覆盖层、构建脚本、权限规则和 macOS 打包脚本。

### 插件/商店

检查 `marketplaces/ruijie-skills`、`.codex-plugin/plugin.json`、OpenAI bundled/curated 插件、`~/.codex/config.toml` 的 `[marketplaces]`、`[plugins]`。如果 UI 提示需要 ChatGPT 账号登录，先按账号态限制解释；前端只负责把不可用的添加按钮显示为“即将支持，敬请期待”，不要承诺已支持。

### 网络排查

读取 `references/codex-desktop-map.md`。重点区分 `uniapi.ruijie.com.cn/v1` provider 链路、`chatgpt.com/backend-api` 账号/桌面服务链路、`persistent.oaistatic.com` 更新/静态资源链路和本地 `127.0.0.1`/插件 browser 链路。

## 参考资料

- `references/codex-desktop-map.md`：本机 Codex Desktop 路径、配置、SQLite 表、网络端点、GitHub issues 情报入口、排查命令和风险边界。
