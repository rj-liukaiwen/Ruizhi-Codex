# Windows 本地开发版隔离

本地开发版与已安装的锐捷 Codex 使用不同的数据目录。生产安装包继续使用默认路径，不受这里的设置影响。

| 项目 | 已安装生产版 | 本地开发版 |
| --- | --- | --- |
| 程序 | 系统安装目录 | `dist/test-app-<version>` |
| Codex / 锐捷 Home | `%USERPROFILE%\.ruizhi` | 项目内 `.dev-data\ruizhi-home` |
| Electron 用户数据与缓存 | `%APPDATA%\Ruizhi` | 项目内 `.dev-data\electron-user-data` |
| 自动更新 | 开启 | 由 `test` / `development` 标记关闭 |
| 模型桥基础端口 | `17888` | `18888`，运行时仍按程序路径派生 |
| 桌面快捷方式 | `锐捷Codex` | `锐捷Codex 本地开发` |

首次安装开发版快捷方式：

```powershell
npm run install:windows-dev-shortcut
```

快捷方式启动兼容性检查（实际使用 Windows PowerShell 5 解析启动器）：

```powershell
npm run test:windows-dev-launcher
```

构建本地开发版并复用现成 `codex.exe`：

```powershell
npm run build:windows:local
```

启动开发版：

```powershell
npm run start:windows-dev
```

启动脚本只给开发版子进程设置环境变量，不修改系统级或用户级环境变量。默认也不会继承生产环境中的 API Key；开发版首次启动后应在自己的数据目录中单独登录或配置 Key。

正式安装包仍由 `build-windows.mjs` 按生产配置生成，安装后继续读取 `%USERPROFILE%\.ruizhi` 和 `%APPDATA%\Ruizhi`。在本机安装验证正式 EXE 时，不会读取项目内的 `.dev-data`。
