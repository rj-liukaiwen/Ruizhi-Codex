# Windows 一键构建与发布

本仓库是用户提供的锐捷 Codex 定制构建工程，不是 OpenAI 官方发行项目，也不将第三方软件重新声明为本仓库的开源代码。

当前固定输入：`Ruizhi-Codex-Source-0.3.1442-0910-d5fbc05.zip`，SHA256
`2a4e04da1e688af735eefd16c5e18c0241a4089a2dafd5e8e663b5a5b7ce808d`。

Git 中保存定制源码和构建脚本；大型固定快照放在独立的 `source-0.3.1442-0910-d5fbc05` Release。
构建只从 ZIP 恢复 vendor 程序目录，校验归档和固定程序摘要，不覆盖 Git 中的源码或工作流。
包内原根 package.json 混入了官方 monorepo 的 workspace 依赖，与提供的锁文件不兼容；现使用该锁文件对应的专用构建依赖，原清单留在 docs/source/original-package.json。

## 一键操作

Actions → Windows build and release → Run workflow → 选择 main、填写版本号。

- 勾选 publish：全部构建与检查成功后发布公开 Release。
- 不勾选：仅生成 Artifacts。
- 已有版本不覆盖，下一次填写新版本号。

交付安装程序、便携 ZIP、blockmap、latest.yml、版本化清单、SHA256SUMS 和构建记录。
Windows 安装程序未签名；真实账号、远端模型和插件功能不以构建成功代替验收。

本仓库只启用 Windows 工作流。原 macOS 工作流移至 .github/upstream-workflows 供参考。
配置中的更新文件地址指向本仓库的 HTTPS Release latest/download，原内部 MinIO 不作为本仓库的分发目标。
运行时是否读取该配置仍须以实际包验证，历史 README 的功能描述可能早于此固定快照。
