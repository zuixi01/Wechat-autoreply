# 控件视图报告的离线对比

`probe:compare` 读取已有的两份私有探测报告，汇总 control/raw 的节点、离屏/禁用节点和已声明模式数量。它不启动辅助程序、不枚举聊天窗口、不读取聊天正文、不发送消息或调用模型。本轮仅以合成报告验证实际命令，尚无两平台的真实视图对比结果。

## 运行

先按 [只读探测命令](platform-probe-command.zh-CN.md) 分别采集 control/raw，记录两个报告目录的 UUID。原报告保留在 `.local/reports/platform-probe/<UUID>/evidence.json`。对比命令只接受两个 UUID，不接受任意文件或公开输出路径：

```powershell
& .\scripts\dev-tools.ps1 -NpmArgs @('run','probe:compare','--','--help')
& .\scripts\dev-tools.ps1 -NpmArgs @('run','probe:compare','--','--control','<control报告UUID>','--raw','<raw报告UUID>')
```

第二条中的占位符须替换为实际完整 UUID。每次生成新私有目录中的 `comparison.json`，不改动或覆盖输入；保存输入原字节的 SHA-256，以便之后核对同一份证据。摘要用于绑定文件，不证明原始内容来自可信发布者。

## 对比范围

可比较的报告须均成功采集并确认辅助退出，来自同一平台、HWND/PID/进程名/启动 ticks、客户端完整版本、Windows 版本、辅助版本/发布编号/清单摘要。两个快照编号不得重复，采样时间须落在各自运行区间内，两次采样间隔最多五分钟。五分钟是诊断工具的比较范围，不能证明期间账号、客户或界面稳定，也不是客户端能力指标。

不匹配时保存 `evidence_not_comparable` 和明确原因，节点差值为 null；不会猜测或忽略版本、实例差异。报告截断或活动观察不可用时仍可汇总已有数量，但保留全部不完整原因。不能据少量控件或零模式证明客户端永远不可读。

`patternNodes` 只计数已声明的 Text、Value、Invoke、Selection、Scroll、VirtualizedItem、ItemContainer 模式。模式存在不等于内容可读，更不等于账号/客户稳定身份、未打开会话可读或后台可发送。离屏标志也不是未打开客户消息的证明。raw 的非控件元素数量是本次 raw 快照的统计，不声称与 control 的某个节点一一对应；节点差值可为负，界面在两次独立采样之间可能变化。

汇总不输出原始 AutomationId、runtime ID、类名、窗口句柄或进程启动 ticks；桌面活动仅保留既有汇总，不能归因于程序或证明无干扰。`snapshotsMerged/nodeIdentityMatched` 固定 false，四项能力和消息/模型计数保持 false/0。完整生产收发准入仍须按开发计划实测。

| 退出码 | 含义 |
| --- | --- |
| 0 | 帮助，或保存 `aggregate_comparison`；后者只表示可比较的汇总 |
| 2 | 保存了 `evidence_not_comparable`，需要检查原因并重采适当证据 |
| 1 | 参数、文件、合同、私有权限或输出失败，未接受对比结果 |

## 文件权限

输入目录和文件需通过当前用户私有 ACL、规范路径及目录别名检查；单份输入最多 4MiB。输出继续仅允许当前用户与 SYSTEM，不以复制到公开目录绕过要求。Windows 保护新空目录时先核对当前所有者，只替换 DACL，不重复设置同一所有者；避免在只有 Modify 权限的项目盘上请求额外 WRITE_OWNER。微软区分 [所有者的 DACL 控制与所有权写入](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object)、[标准访问权限](https://learn.microsoft.com/en-us/windows/win32/secauthz/standard-access-rights)。它不接管其他用户的目录，也不为已有不私有的输入自动放宽检查。

验证依据见 [执行记录](superpowers/plans/2026-10-07-platform-probe-comparison.md)。真实微信/企微探测按用户安排暂缓，已有微信控件缺失与企微未测的结论保持。
