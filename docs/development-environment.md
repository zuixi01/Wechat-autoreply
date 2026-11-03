# 开发环境和验证命令

所有命令从克隆后的仓库根目录执行；不要求固定盘符或目录名。

## 工具和启动

完整开发要求 Windows x64、[.node-version](../.node-version) 指定的 Node.js 24.21.0、.NET 10 SDK、Python 3，以及包含 Windows SDK 的 Visual Studio C++ Build Tools。Node 24 下 `node-window-manager` 等窗口模块依赖 `node-gyp` 构建，缺少 C++ 工具会使 `npm ci` 失败。便携工具目录 `.local/toolchain` 不进入 Git，也不随新克隆提供；请先安装系统工具链，或自行准备对应的本地便携工具。

```powershell
npm ci
npm run dev
```

`npm ci` 会安装并重建 Electron 原生依赖，不要把跳过安装脚本当作完整开发安装。开发启动及普通构建会自动准备 `native/ForegroundWindow` 窗口辅助程序，源文件变化后重新编译，并将辅助程序 SHA-256 固定到主进程。

只做源码或文档贡献且不具备原生工具链时，可以使用：

```powershell
npm ci --ignore-scripts
npm run check:source
npm run verify
```

此路径不准备 Electron 原生模块，不能验证客户端运行、桌面测试或 Windows 打包。需要这些操作前，应在完整工具链下重新执行正常 `npm ci`。检查报告须明确采用的安装路径及未验证范围。

只有已经自行准备 `.local/toolchain` 中对应 Node 版本时，才可使用便携工具入口：

```powershell
.\scripts\dev-tools.ps1 run dev
.\scripts\dev-tools.ps1 run verify
```

模型、规则和联系人使用实际客户端设置，见 [启动说明](../README.md)。个人回复不要求企业服务、PostgreSQL 或 Python 启动。进入企业控制台、管理或工作记忆功能时才初始化相应服务。

## 验证

```powershell
npm run check:source            # 仓库源码与文档检查，不启动微信
npm run test:personal           # 实际驱动 + 合成桌面、本地 HTTP、真实 SQLite
npm run test:foreground-input   # Windows 焦点结构布局与 Unicode 字符序列，不操作桌面
npm run verify                 # 主进程/界面/服务类型、ESLint、全部日常测试
npm run build
npm run test:desktop            # 实际 Electron、IPC、SQLite；隔离资料
```

日常测试使用单个 worker，避免 PGlite WASM 争用内存。真实 PostgreSQL 多连接专项独立使用 `npm run test:postgres`；需要已缓存的 PostgreSQL 官方 Docker 镜像，脚本创建并清理属于本轮的隔离容器，不使用部署数据库。大容量回放使用 `npm run test:scenarios`，结果限合成模型和设备。

实机测试必须有明确授权的联系人，先手动选定单聊并清空草稿：

```powershell
npm run test:wechat -- --target "准确备注名" --current-chat
```

脚本使用实际应用资料和模型接口，正常展示测试窗口，再连接微信。保持目标聊天在前台；确认一条新回复的回显后暂停并退出。实机报告位于 `.local/reports/personal-wechat`。隔离测试通过不能代替实机成功，当前状态见 [能力报告](capability-report.wechat.md)。

## Windows 交付

```powershell
npm run build:win:dev
npm run test:packaged-native
npm run test:desktop:release
# 需要安装程序时
npm run build:win:installer:dev
```

每轮构建从固定源码快照编译，在 `dist/windows-dev-<UUID>/win-unpacked` 生成可运行目录。构建检查依赖审计、源码摘要、原生组件和包内资源，避免验证不同版本。构建详情和最新编号保存在 `.local/reports/windows-dev-build`。

目录包检查不等于安装、升级、卸载或签名验收。安装与工具准备见 [Windows 安装说明](windows-installer.zh-CN.md)，企业原生探测组件见 [native/README.zh-CN.md](../native/README.zh-CN.md)。

成功构建自动清理历史产物，保留最近两个成功版本及近期诊断。`npm run clean:artifacts` 预览，添加 `-- --apply` 执行。清理不会沿目录联接访问外部文件，保留源码、依赖、工具链、实际配置和数据库。

## 企业维护

服务启动和数据库迁移见 [server/README.md](../server/README.md)，管理员操作见 [server/admin/README.md](../server/admin/README.md)。服务使用单独的迁移凭据和普通 API 角色；生产使用 HTTPS，模型密钥仅保存在服务端。

账本恢复、旧设置迁移和审核分别见 [账本恢复](ledger-recovery.zh-CN.md)、[旧设置迁移](legacy-migration.zh-CN.md)、[旧配置审核](legacy-review.zh-CN.md)。这些维护命令不自动发现或修改实际员工资料。评测工具使用合成或独立标注的数据，说明见 [evals/jev/README.md](../evals/jev/README.md)。

设备登记和窗口探测不提供后台聊天收发。真实企业收发必须通过平台适配器能力验证，见 [企业能力报告](capability-report.wework.md)。
