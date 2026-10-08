# D02 原生控件探测证据

2026-10-07 当前辅助已更新为 0.4.0 / 格式 3：新增采样期间只读桌面活动汇总，前台/焦点事件及鼠标/剪贴板序号/最近输入时间戳变化均保存次数和观察边界。自建 WPF 28 项、六文件 93 项、三类类型、十六文件 lint、构建、发布 info、CLI 包校验及编译工厂 info 验证通过。当前发布 `708a7216-4eb1-4290-994a-c71c8d84545b`，399 文件，清单摘要 `cf1c61d68f9e4a5122073b311c1989b05e3c9f758c9ca6ad385a7f18aa9e0bd3`。不读取输入或剪贴板内容，不归因活动，不证明无干扰；所有生产能力继续 false，实际微信/企微未采样。详细边界见 [执行记录](superpowers/plans/2026-10-07-desktop-activity-probe.md)。以下 0.3.0 / 0.2.0 为历史验证，不代表当前整包验收。

2026-10-07 新增原始视图：辅助 0.3.0 / 格式 2 明确返回 control/raw 与节点的控件/内容标志，桥接绑定清单版本、请求视图和原窗口实例，不静默回退。自建 WPF 窗口控件视图 4 节点、raw 8 节点，其中实际提供了被控件视图过滤的装饰节点；22 项原生检查、五文件 74 项相关测试、三类类型、十三文件 lint 和构建通过。发布 `f144fc6a-848f-4739-a0dc-49162ce646a7` 只执行 info，399 文件，清单摘要 `c159af1896b95548ade63c586c7c9968e874ecb9b6505c8c850f66dcd653dadb`。实际 CLI 包校验与当前编译主进程工厂的 info 查询通过，未枚举真实客户端。下文 0.2.0 发布及整包结果为历史证据，不能套用于本次 0.3.0 或当前整个工作区。

raw 能发现控件视图过滤掉的节点，不能保证提供客户身份、消息序列或后台发送。微信、企微 raw 实测均未运行，生产后台驱动仍缺失，三项能力仍 false。操作见 [只读命令](platform-probe-command.zh-CN.md)，执行记录见 [原始视图增量](superpowers/plans/2026-10-07-native-raw-view.md)。

## 以下为 0.2.0 的历史实施与发布记录

2026-10-07 补齐可执行 [`probe:read` 命令](platform-probe-command.zh-CN.md)：按平台与明确窗口绑定采样、使用独立发布记录的包摘要、私有保存元数据/失败证据并确认辅助退出。当前阶段没有运行真实微信/企微采样，所有生产能力仍为 false，尚无真实后台收发驱动。

已授权计划继续以内联方式实施。当前微信/企微实机测试按用户安排暂缓；本阶段完善真实 UIA 的只读元数据探针，使用独立 WPF 测试窗口验证底层行为，不读取实际客户端，不推断生产后台收发已经通过。

Ruling: D03 生产发送仍依赖两平台 D02/D03 实测矩阵；此时不能猜测微信/企微控件选择器、补写任意发送命令或将测试窗口成功当作生产能力。当前提升辅助版本到 0.2.0，协议仍 1，三项能力声明仍 false。

探测报告必须绑定请求的 HWND、PID、进程名及启动 ticks；开始/结束复查，当前窗口或实例改变拒绝。记录 OS/客户端文件版本、采样时间/快照 ID、控件节点和父节点、临时 runtime ID、控件类型和支持模式。runtime ID 可重用且只用于本次控件树比较，不是账号/客户稳定身份；微软说明见 [GetRuntimeId](https://learn.microsoft.com/en-us/dotnet/api/system.windows.automation.automationelement.getruntimeid?view=windowsdesktop-9.0)。

上限 300 节点、深度 8、检查预算 3 秒；任何限额、控件失效或元数据截断均明确标为不完整。UIA 调用可能阻塞，预算不能中断一个阻塞调用，桥接仍使用既有进程级 5 秒超时/关闭确认。只采集 metadata，不调用 Name/Value/Text、不修改焦点、输入、剪贴板或窗口；原始 AutomationId/runtimeId 仍应私有保存，不能当作完全脱敏证据。

前台窗口只记录起止两次观测，不据相等推断全过程无变化。完整报告也仅指 control-view 元数据遍历，无权声明消息已读完整、未打开会话可读或可以后台发送。TypeScript 桥接严格校验来源绑定、树结构、限额/不完整状态和 false 能力标记；失配后关闭辅助进程。

验证使用自建 WPF 窗口，其 UI 在独立线程泵消息，UIA 从其他线程调用，遵循 [微软线程说明](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-threading-issues)。探测模块接受可信调用者提供的进程允许列表；正式辅助入口固定为 Weixin/WeChat/WXWork，测试组件仅传入自己创建的进程，不能通过正式 IPC 改允许列表。

实施顺序：桥接拒绝错误证据的失败测试 → 严格合同和原生采样 → 实际 WPF 元数据/截断/进程绑定检查 → 新辅助发布/包内 info 和回归。原始报告不进入应用包。

Ruling: 2026-10-03 新鲜审计发现开发依赖高危 12 项、生产 0 项，完整发布在依赖门禁停止。相关 [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 与 [http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) 公告当时未列已修复版本。仓库没有 patches，移除未使用的 patch-package；尝试较早打包器 26.5.0 后仍有 11 项风险（包括旧 rebuild），故回到并固定已用的 26.15.3。仅在 app-builder-lib 下替换下载模块为 @electron/get 5.1.0，必须在固定 Node 24 上验证其 ESM/API/校验与打包兼容性；未通过前不当作可发布修复，不豁免审计。原 install-app-deps 保留。

## 当前验证结果

正式辅助 0.2.0 已实际 self-contained 发布，399 个文件、146356626 字节，清单 SHA-256 为 `30a84a9e9a571718a6711666cdbbe427cceafdb1c51c851cf68902dafc30d7cc`。实际 info 返回 0.2.0，三项能力均 false，进程关闭确认通过。只执行 info，没有调用正式入口 listWindows/probe。

自建 WPF 的真实 UIA 检查共 15 项通过；桥接先以错误绑定、树结构、文本字段、伪造能力、遗漏截断、前台矛盾及缺 runtime ID 形成失败测试，再校验并关闭错误辅助。非数字绑定的额外失败测试防止 BigInt 异常逃出错误关闭路径。当前探针及相关回归为 8 文件、144 项通过，包含现有中央管理员/评测/核对和桌面运行接口，不全归因于探针新增。

下载兼容性使用打包器真实 CommonJS 模块和本机 HTTP 服务，校验下载、缓存复用、错误 SHA 拒绝和恢复后的正确下载；不下载真实 Electron 发行包。最新依赖审计生产/全部均为 0，锁文件摘要 `ac9935fbe63f94aed412c3544f42a8bada54ca34b9fa289cebd8f5b0534b5282`。固定 Node 24.21.0 下构建/打包通过，未豁免审计或校验。

完整 `verify:release` 最终退出 0，90 文件、813 项通过（239.19 秒），包含真实 WPF 检查、新构建、包内及两项桌面检查。新开发目录包 `19e5c960-ac45-4cdc-9093-147c5a5b880e` 的实际 ASAR 为 166441081 字节、17604 路径，SHA-256 `d5347a74729a274f04b89e4d80dbb508e82ed452e8d53fe63edae930dae33c43`。包内 AutoReply.exe 验证自带辅助/SQLite/Provider 和合成迁移/恢复；完整桌面、反馈专项采用项目 Electron 加载同一隔离编译输出，退出 0、未超时（27.66 / 12.52 秒），不等于实际安装后的完整 GUI。

历史失败原样保留：首次依赖 12 项高危；同步新增学习表使旧合成数据库清理缺外键依赖，随后新队列表再次暴露此问题；现在只在隔离 PGlite 夹具的清理语句使用 CASCADE，生产迁移/权限/隔离断言不改。学习版本正规化的断言已明确包含空版本。过程中还出现命令启动、PDF/生成和数据库初始化超时，以及新测试先于实现的暂时失败；未放宽期限，最终通过不证明所有环境性能问题已解决。同期新增学习/就绪状态代码不归因本阶段。

可重复指定构建验证，避免共享 latest 更新后检查到另一份产物：

```powershell
& .\scripts\dev-tools.ps1 -NpmArgs @('run','test:native-probe')
& .\scripts\dev-tools.ps1 -NpmArgs @('run','test:packaged-native','--','--build-id','19e5c960-ac45-4cdc-9093-147c5a5b880e')
& .\scripts\dev-tools.ps1 -NpmArgs @('run','test:desktop:release','--','--build-id','19e5c960-ac45-4cdc-9093-147c5a5b880e')
& .\scripts\dev-tools.ps1 -NpmArgs @('run','test:workbench:feedback','--','--build-id','19e5c960-ac45-4cdc-9093-147c5a5b880e')
```

显式编号优先于桌面命令默认 latest；无效/重复编号在启动前拒绝。另一个构建 `328feb89-f488-4ecc-a6a4-723b27107927` 已实际验证显式编号的包内、完整桌面及反馈检查。汇总 `.local/reports/native-probe-stage/3dda4283-940e-4b54-afc0-802ec013e047/result.json` 绑定源文件摘要、失败、完整串联和三份最终证据。

D02/D03 仍未完成：两平台矩阵继续未测，没有生产收发驱动或稳定账号/客户身份；没有真实 Jev 调用、准确度测量、安装/多电脑试点。完整 D00–D20 标准保持不变，目标仍 active。

发布之后的后台学习版本一致性修改已完成 85 项专项及服务类型检查，原生相关源码摘要未变。完整发布证据对应上述固定构建；后续后台修改尚未再次完整构建，补记见实施状态和同目录 `post-release-central.json`。
