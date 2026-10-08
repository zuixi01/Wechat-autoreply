# 微信与企业微信只读探测命令

开发计划中的 `probe:read` 已接通。它采集指定平台窗口的 UIA 控件元数据，供后续兼容性分析使用；没有读取聊天正文或执行发送的动作，也不启用自动回复。当前生产辅助为 `0.4.0`，支持控件和原始两种视图，并记录采样期间的桌面活动汇总。

**本轮未运行真实微信或企业微信探测。** 当前已知微信 `4.1.15.13` 的历史报告没有可用聊天控件，见 [微信能力报告](capability-report.wechat.md)。企业微信仍待实测。本命令准备后续实测所需的可重复证据，不能把生成报告当成已实现后台收发。

## 运行

在项目目录使用固定 Node 开发环境。先选择已经通过 `publish:native` 的发布编号；命令从该编号的独立发布记录读取辅助清单 SHA-256，再验证当前 `.local/native/windows-x64` 的全部文件。不会用待执行包自己计算的摘要替代原发布依据。发布记录错误、包改动或版本不符时拒绝启动。

当前发布记录 `708a7216-4eb1-4290-994a-c71c8d84545b` 对应辅助 `0.4.0`，清单 SHA-256 为 `cf1c61d68f9e4a5122073b311c1989b05e3c9f758c9ca6ad385a7f18aa9e0bd3`。旧 `f144fc6a-848f-4739-a0dc-49162ce646a7` 和 `13d3bbe7-2b3d-4ce3-be30-a488635437d4` 分别为历史 0.3.0 / 0.2.0，不能沿用旧摘要启动新版。本机后续实测可使用：

准备实机之前可先添加 `--check-package`，仅核对发布记录与包文件，不启动辅助或枚举窗口。该模式本轮已实际执行，退出 0，返回 `package_verified_only`；不是客户端能力探测。

```powershell
& .\scripts\dev-tools.ps1 -NpmArgs @('run','probe:read','--','--platform','wechat','--native-release','708a7216-4eb1-4290-994a-c71c8d84545b')
& .\scripts\dev-tools.ps1 -NpmArgs @('run','probe:read','--','--platform','wework','--native-release','708a7216-4eb1-4290-994a-c71c8d84545b','--tree-view','raw')
```

这两条是真实窗口探测命令，待用户准备并授权实机阶段后再执行。本轮只运行了 `--help`、包校验模式和合成测试，没有执行上面两条真实采样命令。

`--tree-view control|raw` 默认 `control`。控件视图过滤非控件元素，原始视图提供更详细的结构，可用于检查是否漏掉布局或其他节点；依据见 [微软 UIA 树视图说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview)。raw 并不保证客户端提供聊天内容、稳定客户 ID 或可发送控件。两次视图采样各自绑定快照和进程实例，不作为同一时刻完整消息树拼接。旧 0.2.0 辅助只能采集 control，请求 raw 时返回 `unsupported_view` 且不枚举窗口。`--check-package` 不能与窗口或视图参数组合。

多个匹配窗口时，命令保存 `window_selection_required` 报告，不猜主窗口。查看私有报告 `candidates`，明确选择 HWND，然后添加 `--window 数字句柄` 重跑。选择消失或换成另一平台时不回退到其他窗口。探测继续绑定 PID、进程名与启动 ticks，原生辅助在采样前后复核；窗口绑定仍不是员工账号或客户身份。

命令默认输出目录为 `.local/reports/platform-probe/<运行 UUID>/`。命令行只显示状态、目录、请求/实际视图、节点数、截断和辅助退出确认；原窗口绑定、控件树和节点的 `isControlElement/isContentElement` 标志存入 `evidence.json`。报告中原请求视图与返回视图必须匹配，不接受静默回退。多个窗口时需查看私有文件自行选择，不把原始控件证据粘贴到公开报告或聊天中。

## 状态及退出码

| 状态 | 含义 |
| --- | --- |
| `metadata_collected` | 保存了本次控件元数据；可能截断，不能证明聊天可读 |
| `no_client_window` | 本平台没有匹配窗口 |
| `window_selection_required` | 多个匹配窗口，需指定 HWND |
| `selected_window_missing` | 指定窗口不在当前本平台清单中 |
| `probe_failed` | 保存了失败阶段及受限错误分类，包括超时 |
| `cancelled` | 操作者取消，没有接受迟到结果 |
| `helper_stop_unconfirmed` | 辅助进程退出未确认，优先标识该问题 |

正常采样退出 `0` 只表示保存了 `metadata_collected` 报告；仅校验包模式退出 `0` 返回 `package_verified_only`，不创建窗口证据。退出 `2` 表示保存了待选择、没有窗口、失败、取消或退出未确认的报告。参数、发布记录、包验证或私有输出准备失败时退出 `1`。三项生产能力始终为 `false`，`messagesRead/messagesSent/modelCalls` 始终为 `0`。

辅助每次请求仍受原有 5 秒期限与进程关闭确认约束；整个采样阶段另有 20 秒截止，和操作者取消分别记录。控件树保留原生 300 节点、深度 8、遍历预算 3 秒的界限。关闭确认只指辅助进程退出，不证明微信/企微的发送器已停止或允许生产发送。

## 输出与验证边界

已有两份 control/raw 报告后，可运行 [离线对比命令](platform-probe-comparison.zh-CN.md) 汇总模式和节点数量，并检查窗口实例、版本及采样范围是否可比较。该命令不启动辅助、不合并消息树或授予平台能力。

格式 3 的 `desktopActivity` 保存采样期间的前台/焦点事件次数、鼠标/剪贴板序号/最近输入时间戳的变化次数、样本数、观察时长、实际最大采样间隔和停止确认。请求间隔为 10ms，实际调度可能更慢；短于采样间隔的变化可能漏掉。它观察当前会话，不能判断变化由员工、本程序或其他程序引起，不读取键盘内容或剪贴板内容。依据见微软 [SetWinEventHook](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwineventhook)、[GetClipboardSequenceNumber](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboardsequencenumber) 和 [GetLastInputInfo](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getlastinputinfo)。

钩子、计时器或采样失败明确保存不完整原因，探针附加 `activity_unavailable`；观察线程退出未确认时拒绝报告并终止辅助。`complete` 只表示观察器未报告故障，`noInterferenceVerified` 始终 false，零变化不作为自动发送准入。旧格式 1/2 没有期间观察字段。本轮验证来自自建 WPF 窗口和合成事件/采样，实际微信/企微的期间活动仍未测。

每次创建全新目录，先设置并验证仅当前 Windows 用户与 SYSTEM 可访问的 ACL，再保存证据；不覆盖历史文件、不接受任意公开输出路径，也拒绝目录别名。原始 `AutomationId/runtimeId` 仍可能有敏感信息，私有保存不等于完全匿名。

新增窗口列表校验拒绝多余文本字段和重复句柄，并关闭错误辅助。完整消息读取、稳定账号/客户身份、未打开会话可读、无焦点/草稿/剪贴板干扰的发送，以及两平台实机兼容矩阵仍须独立验证。真实驱动未通过这些要求前保持缺失，不以元数据测试或模拟发送替代。
