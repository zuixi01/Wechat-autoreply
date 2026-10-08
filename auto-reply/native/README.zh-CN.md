# Windows 辅助程序的构建与校验

当前实际项目是 `WindowsAdapter/WindowsAdapter.csproj`，版本 0.4.0、协议 1、目标 Windows x64。它只提供 `info`、`listWindows` 和 `probe`；没有输入、发送、剪贴板写入、抢焦点或切换窗口命令。账号/客户身份、后台读取和无干扰发送均未验证。发布辅助程序不会使自动回复放行，也不会注册一个虚假的已验证平台驱动。

0.4.0 的 `probe` 返回格式 3，可明确选择 `control` 或 `raw` 视图，同时保存各节点的控件/内容标志。它保留严格版本化的证据和不完整原因，绑定 HWND/PID/进程名/启动 ticks，拒绝来源、版本或视图失配；返回 OS/文件版本和临时控件 ID，但不读取 Name/Value/Text。旧格式 1/2 仍可验证；0.2.0 不支持 raw，在枚举窗口之前拒绝此请求。

新增采样期间的被动桌面观察：前台/焦点事件计数，以及鼠标位置、剪贴板序号、最近输入时间戳的变化次数。只保存汇总，不记录坐标、输入内容、剪贴板内容或窗口标题；请求采样间隔 10ms，报告实际最大间隔。观察失败明确不完整，退出未确认拒绝报告并退出辅助。所有变化属于当前会话，不能归因于本程序；没有观察到变化也不证明未干扰。`noInterferenceVerified` 始终 false，不增加发送权限。完整树不等于完整消息读取。具体限制及独立 WPF 检查见 [D02 探测证据](../docs/native-probe.zh-CN.md)。

## 开发命令

从仓库根目录执行：

```powershell
.\scripts\dev-tools.ps1 run publish:native
.\scripts\dev-tools.ps1 run build:win:dev
.\scripts\dev-tools.ps1 run test:packaged-native
.\scripts\dev-tools.ps1 run test:native-probe
```

`publish:native` 使用 `.local/toolchain/dotnet/dotnet.exe`，以 Release / win-x64 / self-contained 发布；不裁剪 WPF/UIA，不使用单文件部署。运行时随程序提供，员工端不要求安装 .NET SDK；操作系统原生依赖及无开发环境电脑仍须单独验收。[.NET 官方部署说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/)。当前自带 Microsoft.NETCore.App 和 Microsoft.WindowsDesktop.App 10.0.12，运行时安全更新须重新发布，不依赖机器上的共享 .NET 自动更新。

每次先发布到 `.local/native/staging/<UUID>`，逐文件生成 SHA-256/大小清单，校验完整目录，只执行不读取窗口的 `info`，确认进程关闭后提升到 `.local/native/windows-x64`。上一生成目录改名保留为 `previous-<UUID>`；失败的 staging 留供排查，脚本不递归删除历史目录。并行构建不属于支持的发布流程。

`build:win:dev` 是未签名的开发目录包，使用已安装的 Electron 分发文件，显式关闭签名与资源编辑。先生成 `.local/release-build/<UUID>/source` 的私有源码副本并记录逐文件摘要，再从该副本审计、发布辅助、编译和打包；副本生成期间或构建后内容不一致均拒绝。辅助文件及编译输出固定在同一 UUID 的 native/out 目录，产物位于 `dist/windows-dev-<UUID>/win-unpacked`。成功后记录 `.local/reports/windows-dev-build/latest.json`，包内测试按明确 UUID 检查产物。物理依赖和 SDK 仍共享，`dependenciesFrozen=false`，不证明可重复构建、发布者签名或正式安装验收。详见 [固定源码构建](../docs/release-source-snapshot.zh-CN.md)。普通 `build:win` 流程另行构建当前源码，签名工具、证书和网络须由发布环境提供。

## 固定构建与执行边界

主进程单独构建 `out/main/native-adapter.js`，把本次清单的 SHA-256 固定到编译产物。打包前校验生成目录；打包后从实际 `app.asar` 读取该入口的固定值，校验复制后的全部辅助文件。缺文件、多文件、内容/大小变化、错误协议或版本、依赖机器共享 .NET、符号链接/目录别名、其他架构均拒绝。若签名流程改动辅助 EXE 的字节，须先完成签名再生成清单并构建固定值，否则包后检查拒绝，不能沿用旧清单。

私有工厂仅从应用资源的 `native/windows-x64` 创建桥接，不接收 IPC 提供的路径、参数或能力声明。每次启动重验目录；子进程隐藏窗口、不用 shell、不接收额外参数，清除继承的 .NET/CLR 启动钩子。最多 16 个待回应请求，每次 5 秒；收到超长/非法输出、取消或异常时关闭进程。停止必须等待 `close`；150 毫秒后尝试终止，1.5 秒未确认关闭则拒绝再启动，直到原进程确实关闭。

SHA-256 固定值依赖可信的应用构建，不能证明发布者身份，也不能防止应用和清单同时被整体替换。2026-10-03 的 npm 生产/全部依赖审计均为 0 项已知漏洞；它不覆盖 .NET 和原生二进制的全部风险。当前没有完成 Authenticode 签名、干净电脑安装或真实聊天能力验收。

## 包内测试

`test:packaged-native` 核查实际 ASAR 顶层只含应用输出、资源、生产依赖、package.json、LICENSE、NOTICE，拒绝历史 dist、源码、服务、测试、评测数据、开发脚本、环境文件、备份和本地配置；使用包内 `AutoReply.exe` 的 Electron Node 模式加载实际私有工厂，PATH 仅保留 Windows System32，校验资源并执行 `info`，等待辅助进程关闭，再验证包内 Provider 的编译固定摘要和独立报告目录中的 SQLite 写读。它不启动员工界面、不枚举微信/企微窗口、不调用供应商、不发送消息。

报告分别在 `.local/reports/native-publish/<UUID>/` 和 `.local/reports/packaged-native-smoke/<UUID>/`。包内测试不是整套桌面功能/视觉验收，也不证明安装、卸载、升级或多员工持续办公通过；已有桌面 smoke 仍须分别运行。
