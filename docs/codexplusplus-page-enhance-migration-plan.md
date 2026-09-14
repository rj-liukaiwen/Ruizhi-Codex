# CodexPlusPlus Page Enhance Migration Plan

## Goal

把 CodexPlusPlus 的高价值页面增强迁到 rj-codex，但不整坨复制 `renderer-inject.js`。rj-codex 继续采用固定 Codex Desktop 快照、asar 覆盖层、bootstrap/preload 注入的架构；CodexPlusPlus 作为功能和实现参考。

第一版迁移范围：

- Codex++ / 锐捷增强菜单
- 插件入口解锁
- 插件强制安装按钮解锁
- 会话删除与撤销
- Markdown 导出
- 项目移动
- 普通会话 / 项目会话排序修正
- 对话 Timeline
- 会话滚动恢复

第二版再考虑：

- Zed Remote
- Upstream worktree
- 用户脚本市场
- 推荐内容 / 广告位
- service tier 控制

## Current Facts

rj-codex 当前已经有大量 webview asset 覆盖，并且工作区有未提交改动。迁移前不能直接清空覆盖层，尤其不能误删 APIKey 登录、模型 bridge、插件 marketplace、VC++ 运行库提示、更新入口等现有产品能力。

当前 `vendor/codex-desktop/windows/current/app` 官方基线目录缺失，无法可靠做“覆盖文件与官方快照逐项 diff”。正式清理覆盖层前必须先恢复官方基线或从可复现来源重新导入。

CodexPlusPlus 的 `renderer-inject.js` 依赖 `window.__codexSessionDeleteBridge` 和本地 helper。删除、撤销、导出、移动、排序等能力不是纯前端功能，必须在 rj-codex 主进程实现对应服务。

## Architecture

新增三层：

1. Renderer enhance module

   路径建议：`resources/renderer/ruizhi-page-enhance.js`

   负责 DOM/React 页面增强：

   - 菜单与设置面板
   - 插件入口解锁
   - 插件强制安装按钮解锁
   - 会话行按钮
   - 项目移动 UI
   - Timeline
   - 滚动恢复

2. Preload bridge

   扩展 `window.ruizhiDesktop`：

   ```js
   window.ruizhiDesktop.enhance.call(route, payload)
   window.ruizhiDesktop.enhance.getSettings()
   window.ruizhiDesktop.enhance.setSettings(patch)
   ```

   preload 不直接碰文件系统，只转发 IPC。

3. Main process enhance service

   在 bootstrap/main 注册：

   ```text
   ruizhi:enhance:call
   ```

   支持路由：

   ```text
   /backend/status
   /settings/get
   /settings/set
   /delete
   /undo
   /export-markdown
   /archived-thread
   /move-thread-workspace
   /thread-sort-key
   /thread-sort-keys
   /diagnostics/log
   ```

## Config

在 `config/rj-codex.json` 增加：

```json
{
  "pageEnhance": {
    "enabled": true,
    "features": {
      "menu": true,
      "pluginEntryUnlock": true,
      "forcePluginInstall": true,
      "sessionDelete": true,
      "markdownExport": true,
      "projectMove": true,
      "timeline": true,
      "threadScrollRestore": true,
      "modelWhitelistUnlock": false,
      "zedRemoteOpen": false,
      "upstreamWorktreeCreate": false,
      "serviceTierControls": false
    }
  }
}
```

默认启用 `pluginEntryUnlock` 和 `forcePluginInstall`，因为产品决策要求迁移插件强制解锁，并允许覆盖 rj-codex 现有插件页禁用实现。

## Plugin Unlock Scope

插件强制解锁分为两个层面。

Build-time asset patch：

- 保留或重写当前 `scripts/windows-asar-overrides.mjs` 里的 OpenAI bundled plugin marketplace 修复。
- 当前 `policy.installation = "AVAILABLE"`、`policy.authentication = "ON_INSTALL"` 的 marketplace 补丁可以保留。
- 当前把不可用按钮显示成“即将支持，敬请期待”的补丁要被插件强制解锁覆盖。
- 如果构建期 patch 继续改 `plugins-availability-*` 和 `plugin-detail-page-*`，需要新增 marker，避免和 runtime enhance 重复抢状态。

Runtime renderer patch：

- 从 CodexPlusPlus 迁移 `pluginEntryUnlock`：
  - 找到插件导航入口。
  - spoof 本地 React auth context 的 `authMethod = "chatgpt"`。
  - 移除按钮 disabled 状态。
  - 文案改为“插件 - 已解锁”。

- 从 CodexPlusPlus 迁移 `forcePluginInstall`：
  - 扫描 disabled install button。
  - 清除 `disabled`、`aria-disabled`、`data-disabled`、`inert`。
  - 移除 `cursor-not-allowed`、`pointer-events-none`、低透明度样式。
  - patch React props 中的 `disabled` / `aria-disabled`。
  - 文案改为“强制安装”。
  - 用短周期 refresh 或 MutationObserver 保持按钮可用。

边界：

- 这只保证本地 UI 可以尝试进入安装流程。
- 不承诺绕过 ChatGPT 服务端账号态、Cloudflare、OAuth connector 权限或远端 marketplace 权限。
- 安装失败必须显示真实错误，不要吞掉失败并伪装成功。

## Local Data Services

迁移或重写 CodexPlusPlus 的 SQLite/session 文件操作：

- 数据库：`CODEX_HOME/state_5.sqlite`
- rollout：从 `threads.rollout_path` 读取
- 删除：
  - 备份 `threads`
  - 备份关联表：`thread_dynamic_tools`、`thread_goals`、`thread_spawn_edges`、`stage1_outputs`、`agent_job_items`
  - 备份 rollout 文件内容
  - 删除数据库记录和 rollout 文件
- 撤销：
  - 从备份 token 恢复数据库行
  - 恢复 rollout 文件
  - 检测冲突，不能覆盖用户新文件
- Markdown 导出：
  - 解析 rollout jsonl 的 `response_item` 消息
  - 只导出 user / assistant
  - 图片 data URL 不内嵌，外链用 Markdown link
- 项目移动：
  - 更新 `threads.cwd`
  - 同步 rollout 第一行 session metadata cwd
- 排序：
  - 提供 `updated_at_ms` / `updated_at` / fallback sort key

## Renderer Module Split

`resources/renderer/ruizhi-page-enhance.js` 内部拆模块：

```text
core/
  bridge
  settings
  scheduler
  toast
  dom
features/
  menu
  plugin-unlock
  session-actions
  project-move
  timeline
  thread-scroll
```

每个 feature 必须有：

- feature flag
- version marker
- idempotent install
- cleanup function
- error diagnostics

统一一个 MutationObserver 调度 `scan()`，避免多个循环互相打架。插件强制安装可以保留短周期 refresh，但必须在 feature disabled 或页面离开时清理。

## Build Integration

Windows：

- `scripts/windows-asar-overrides.mjs`
  - 注入 preload bridge。
  - 注入 main enhance IPC/service。
  - 把 `resources/renderer/ruizhi-page-enhance.js` 打进 app resources 或 preload 动态载入。
  - 调整插件页现有“即将支持” patch，使其在 `forcePluginInstall` 启用时不再压制按钮。

- `scripts/build-windows.mjs`
  - 同步同等逻辑，避免 build 脚本和 overrides 脚本漂移。

macOS：

- `scripts/build-macos.mjs`
  - 至少同步 preload bridge 与 renderer enhance。
  - 如果第一版只验证 Windows，可在 macOS 标注暂不启用本地数据服务，但配置结构必须兼容。

## Tests

静态测试：

```text
node --check scripts/windows-asar-overrides.mjs
node --check scripts/build-windows.mjs
node --check scripts/build-macos.mjs
node --check resources/renderer/ruizhi-page-enhance.js
node --test tests/*.test.mjs
```

新增测试建议：

- `tests/ruizhi-page-enhance-config.test.mjs`
  - 验证 `pageEnhance.features.forcePluginInstall === true`
  - 验证 `modelWhitelistUnlock` 和 `serviceTierControls` 默认 false

- `tests/ruizhi-enhance-bridge-patch.test.mjs`
  - 验证 preload 暴露 `window.ruizhiDesktop.enhance.call`
  - 验证 bootstrap 注册 `ruizhi:enhance:call`

- `tests/ruizhi-plugin-force-unlock-source.test.mjs`
  - 验证 renderer enhance 包含 plugin entry unlock marker
  - 验证 renderer enhance 包含 force install marker
  - 验证旧的“即将支持”安装按钮补丁不会在强制解锁开启时覆盖 runtime 状态

运行验证：

- `npm run sync:windows-test`
- 重启 `dist/test-app-<version>/Codex.exe`
- 检查：
  - 插件入口显示并可进入
  - 插件安装按钮从 disabled 变为“强制安装”
  - 本地 bundled plugin 可尝试安装
  - 远端 ChatGPT connector 如果失败，错误真实显示
  - 会话删除/撤销成功
  - Markdown 导出成功
  - 项目移动后 sidebar 和普通会话排序正确
  - Timeline 与滚动恢复不影响聊天输入
  - APIKey 登录、模型列表、更新入口、VC++ 提示不回归

## Migration Order

1. 恢复或重新导入官方 Codex Desktop Windows 基线。
2. 保留当前 `.codex` / `Codex` 共享运行目录改动。
3. 增加 `pageEnhance` 配置。
4. 增加 preload/main enhance bridge 最小闭环。
5. 增加 renderer enhance 空框架和菜单。
6. 迁移插件入口解锁与强制安装按钮解锁。
7. 迁移本地数据服务：删除、撤销、导出、移动、排序。
8. 迁移会话行 UI、项目移动 UI、Timeline、滚动恢复。
9. 清理旧插件页“即将支持”补丁或让它受 `forcePluginInstall` 配置控制。
10. 跑静态测试、同步 Windows test app、人工验证。

## Risk Controls

- 不直接打印 auth、API key、token。
- 删除和移动会话前必须有备份。
- 撤销不能覆盖新生成的 rollout 文件。
- 插件强制安装只能改变本地 UI 状态，不伪造服务端成功。
- 所有 DOM patch 都加版本 marker，避免重复绑定。
- 官方快照升级后，插件选择器和 React fiber 访问必须重新验证。
