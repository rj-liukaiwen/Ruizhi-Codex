# Codex Desktop 本机地图

本文件记录 `2026-05-07` 在 Windows Codex Desktop 环境里的实测结构。不同版本会变，先验证再改，别拿旧地图当圣旨。

## 版本与入口

- Windows 桌面应用包：`OpenAI.Codex_26.429.8261.0_x64__2p2nqsd0c76g0`
- CLI：`codex-cli 0.126.0-alpha.8`
- 用户 CLI：`%LOCALAPPDATA%\OpenAI\Codex\bin\codex.exe`
- 应用资源：`C:\Program Files\WindowsApps\OpenAI.Codex_26.429.8261.0_x64__2p2nqsd0c76g0\app\resources`
- 应用资源中包含：`app.asar`、`codex.exe`、`codex`、`node.exe`、`node_repl.exe`、`rg.exe`、`plugins/`、`native/`

macOS 不能照抄 WindowsApps 路径。路径要从 `$HOME`、应用 bundle、当前 `codex` 命令位置或项目配置推导。

## 本机状态目录

- `~/.codex/config.toml`：模型、marketplace、plugin、sandbox、环境变量策略等主配置。
- `~/.codex/auth.json`：认证状态。只允许脱敏查看字段结构，不要输出 token。
- `~/.codex/.codex-global-state.json`：Electron UI 状态、workspace roots、prompt history、agent mode、locale 等。
- `~/.codex/rules/default.rules`：命令权限规则，prefix_rule 在这里。
- `~/.codex/plugins/cache/`：已缓存插件，例如 `openai-bundled/browser-use`、`openai-curated/github`。
- `~/.codex/.tmp/bundled-marketplaces/`：官方 bundled marketplace 的本地 source。
- `~/.codex/codex-switcher/`：本项目写入的 marker、备份、local marketplace、模型目录等。
- `~/.codex/state_5.sqlite`：线程、动态工具、后台任务、remote control enrollment。
- `~/.codex/logs_2.sqlite`：运行日志，可能含 URL、错误、请求上下文；读取时只抽取域名和路径。
- `~/.agents/skills/`：全局 skills。锐捷内置 skills 注入目标在这里。

## SQLite 表

`state_5.sqlite` 已观察到的关键表：

- `threads`：线程、cwd、provider、模型、sandbox、git 信息。
- `thread_dynamic_tools`：线程里可用的动态工具。当前 namespace 主要为空和 `codex_app`。
- `remote_control_enrollments`：含 `websocket_url` 字段，当前为空；以后排查远控/云端接入时先看这里。
- `jobs`、`agent_jobs`、`agent_job_items`：后台任务状态。
- `device_key_bindings`：设备 key 与账号绑定，当前为空。

`logs_2.sqlite` 已观察到 `logs` 表，字段包括 `ts`、`level`、`target`、`feedback_log_body`、`thread_id`、`process_uuid`。日志量大，不要全量打印。

## 网络面

实测网络/端点分几类：

- 锐捷 API provider：`https://uniapi.ruijie.com.cn/v1`
- Codex/ChatGPT 桌面服务：`https://chatgpt.com/backend-api`
- OpenAI 认证/API 入口：`https://api.openai.com/auth`
- Codex 桌面更新/静态资源：`https://persistent.oaistatic.com/codex-app-...`
- Codex 官方文档：`https://developers.openai.com/codex/...`
- 本地浏览器/代理/开发服务：`http://127.0.0.1:*`、`http://localhost:*`
- 插件和 skills：大部分 marketplace/cache 是本地文件路径，不是远端商店安装链路。

判断边界：

- `RuiQinAPI`/`uniapi.ruijie.com.cn/v1` 能控制模型推理请求。
- `chatgpt.com/backend-api` 更像账号态、桌面 UI、商店、内置能力、云端功能链路。
- `persistent.oaistatic.com` 是更新和静态资源，不要拿它当业务 API。
- APIKey 模式不等于 ChatGPT 账号登录；商店插件灰掉通常不是本地 metadata 没写，而是服务端账号态限制。

## GitHub Issues 情报源

Codex Desktop 很多真实边界在 `openai/codex` issues 里，比官方文档更快暴露。每次排查桌面版魔改，优先搜索：

```text
repo:openai/codex is:issue Codex desktop marketplace plugin auth
repo:openai/codex is:issue skills local plugin Electron UI
repo:openai/codex is:issue API key ChatGPT auth plugin
repo:openai/codex is:issue Windows sandbox WindowsApps ACL
repo:openai/codex is:issue macOS CODEX_HOME bundled marketplace
repo:openai/codex is:issue backend-api plugins featured Cloudflare
```

已验证有价值的 issue 样本：

- `#16808`：桌面 plugin marketplace 请求 `https://chatgpt.com/backend-api/plugins/featured?platform=codex` 可能返回 403/Cloudflare challenge；CLI marketplace 与 Electron marketplace 可能不是同一路径。
- `#16663`：local skill-bearing plugin 在 CLI/runtime namespaced 正常，但 Electron UI 会把 plugin-owned skills 暴露成独立项。
- `#18555`：macOS `CODEX_HOME` 路径含 `@` 会触发 bundled marketplace/git ref 相关误判，Computer Use 设置页也可能和后端 MCP 状态不一致。
- `#17612`、`#18620`：Windows sandbox 可能在 WindowsApps 资源 ACL 或 `CreateProcessWithLogonW` 阶段失败，表现为子进程超时或 shell 命令无法启动。
- `#17066`：local marketplace 的 plugin path `./` 不能引用 marketplace root，当前校验要求至少一个普通子路径组件。

使用 issue 时要提取事实：版本、平台、标签、日志、失败端点、有效 workaround、无效 workaround。不要照搬 issue 作者的猜测，更不要把 upstream bug 包成我们 switcher 的“稳定功能”。

## 安全排查命令

查看当前 CLI 和路径：

```powershell
codex --version
where.exe codex
```

查看主配置的 provider、marketplace 和 plugin，不读 `auth.json`：

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" `
  -Pattern "model_provider|model_providers|base_url|env_key|marketplaces|plugins|auth" `
  -Context 1,2
```

读取 SQLite 结构：

```powershell
@'
import sqlite3, os
home=os.path.expanduser('~')
for name in ['state_5.sqlite','logs_2.sqlite']:
    path=os.path.join(home,'.codex',name)
    con=sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    cur=con.cursor()
    print(f'== {name} ==')
    cur.execute("select name from sqlite_master where type='table' order by name")
    for (table,) in cur.fetchall():
        cur.execute(f'pragma table_info({table})')
        cols=[(r[1],r[2]) for r in cur.fetchall()]
        cur.execute(f'select count(*) from {table}')
        print(table, cur.fetchone()[0], cols)
    con.close()
'@ | python -
```

从日志抽取域名，不输出 query/token：

```powershell
@'
import sqlite3, os, re, urllib.parse, collections
path=os.path.join(os.path.expanduser('~'),'.codex','logs_2.sqlite')
url_re=re.compile(r'\b(?:https?|wss?)://[^\s"\'<>`)}]+')
con=sqlite3.connect(f'file:{path}?mode=ro', uri=True)
cur=con.cursor()
cur.execute("select feedback_log_body from logs where feedback_log_body like '%http%' or feedback_log_body like '%wss%' limit 20000")
hosts=collections.Counter()
samples={}
for (body,) in cur:
    if not body:
        continue
    for match in url_re.finditer(body):
        url=urllib.parse.urlsplit(match.group(0))
        if not url.netloc:
            continue
        host=url.netloc.lower()
        hosts[host]+=1
        samples.setdefault(host, urllib.parse.urlunsplit((url.scheme, url.netloc, url.path[:120], '', '')))
for host, count in hosts.most_common(25):
    print(count, host, samples[host])
con.close()
'@ | python -
```

扫描桌面应用资源中的硬编码 URL，仍然只输出域名和路径：

```powershell
@'
import os, re, urllib.parse, collections
root=r'C:\Program Files\WindowsApps\OpenAI.Codex_26.429.8261.0_x64__2p2nqsd0c76g0\app\resources'
url_re=re.compile(rb'\b(?:https?|wss?)://[^\s"\'<>`)}]+')
hosts=collections.Counter()
samples={}
for dirpath, _, filenames in os.walk(root):
    for filename in filenames:
        path=os.path.join(dirpath, filename)
        try:
            if os.path.getsize(path) > 300_000_000:
                continue
            data=open(path, 'rb').read()
        except OSError:
            continue
        for match in url_re.finditer(data):
            raw=match.group(0).decode('utf-8', 'ignore')
            url=urllib.parse.urlsplit(raw)
            if not url.netloc:
                continue
            host=url.netloc.lower()
            hosts[host]+=1
            samples.setdefault(host, urllib.parse.urlunsplit((url.scheme, url.netloc, url.path[:140], '', '')))
for host, count in hosts.most_common(40):
    print(count, host, samples[host])
'@ | python -
```

## 修改边界

- 推荐生产改造面：`config.toml`、`rules/default.rules`、`~/.agents/skills`、local marketplace、switcher 的备份/恢复/注入逻辑。
- 谨慎实验面：`state_5.sqlite`、`logs_2.sqlite`、`.codex-global-state.json`。可以读，少直接写。
- 不建议生产 patch：`app.asar`、WindowsApps 应用资源、桌面应用二进制。更新覆盖、签名破坏、回滚困难，属于把锅焊在自己脸上。
- 网络代理和环境变量在 `[shell_environment_policy.set]` 里可能影响子进程，改前先确认现有用户配置，别顺手清掉。
