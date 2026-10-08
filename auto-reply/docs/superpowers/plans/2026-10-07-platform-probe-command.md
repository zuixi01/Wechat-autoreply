# 2026-10-07 两平台只读命令执行记录

承接 D02/D03：当前辅助仅有元数据探测，微信 `4.1.15.13` 历史实测没有聊天控件，企微没有平台证据。用户仍暂缓真实客户端探测。本轮补齐开发计划列出的 `probe:read` 可执行命令，不猜平台选择器、不新增未经验证的生产发送动作，也不缩小全自动办公需求。

## 实现

- 指定微信/企微及完成的原生发布 UUID，从独立发布记录取原摘要，并校验当前辅助全部文件，不自签待执行包。
- 真正采样按平台筛选，只在唯一候选或显式 HWND 下继续；多窗口待选择，选定窗口消失不回退。严格绑定 HWND/PID/进程名/启动 ticks。
- 保存原元数据、截断、失败阶段/受限错误分类和退出确认。20 秒采样截止与操作者取消区分；拒绝迟到结果，未确认退出优先标识。
- 每次新建受保护目录，在存入原控件元数据前设置实际 Windows ACL，再验证子文件权限；不覆盖、不接受公开输出参数或目录别名。
- 窗口列表额外文本或重复句柄会触发辅助关闭。报告、命令输出与原辅助的三项生产能力始终 false。
- `--check-package` 只校验发布及包，不启动辅助或枚举窗口；捕获函数也拒绝将此模式误当采样。
- 正常入口写出私有证据，命令行只放状态和目录等概要。Native C#、原辅助版本和生产驱动没有变化。

## 当前验证

最终定向 6 文件 / 84 项通过，零失败/跳过：`.local/reports/platform-probe-final.json`。覆盖参数、平台隔离、歧义/明确窗口、失效绑定、重复列表、文本/能力篡改、超时、取消和晚到结果、关闭未确认，以及真实 Windows 私有 ACL 和发送适配器既有合同。不是微信/企微实机收发。

服务类型最终通过：`.local/reports/platform-probe-services-verified.log`；主进程及界面类型通过：`.local/reports/platform-probe-node.log`、`platform-probe-web.log`。8 文件 lint 最终通过：`.local/reports/platform-probe-lint-verified.log`；首次缺返回类型的失败保存在 `platform-probe-lint.log`，已补类型，未关闭规则。

构建通过：`.local/reports/platform-probe-build.log`。没有新辅助发布或安装包，没有新安装、提交、外部部署或独立复核。

实际运行 CLI `--help`，并以 `--check-package` 核对发布 `13d3bbe7-2b3d-4ce3-be30-a488635437d4`：399 文件，摘要 `30a84a9e9a571718a6711666cdbbe427cceafdb1c51c851cf68902dafc30d7cc`。`.local/reports/platform-probe-cli-package-check.json` 返回 `package_verified_only`，helperStarted/windowEnumeration/chatWindowsRead 均 false，消息和模型调用为 0。独立同包校验报告为 `platform-probe-pin-check.json`；首次临时检查脚本的 CJS 顶层 await 错误留在 `platform-probe-pin-check-first.log`，改为 async main 后通过。正式 CLI 原本已用 async main。

本轮不重复六分钟全库回归：改动集中于只读桥接、命令与保护输出，已扩展关联检查，且共享业务评测仍在另一开发线上修改。上一轮全量/共享复验失败仍保留，未将本轮 84 项写成全库绿色。

公开操作说明补入 Git 白名单；内部执行记录、原始窗口证据和 `.local` 报告继续忽略。全目标仍 active，D02 两平台矩阵、D03 真实生产驱动、D20 业务效果、多电脑部署与试点仍未通过。

阶段记录 `.local/reports/platform-probe-stage/57a7f737-2959-4e16-b026-d3f41199ff5c/result.json` 保存最后功能验证后的 11 个源码摘要及报告索引，incrementChecksPassed=true / productionAdapterImplemented=false / fullGoalComplete=false / releaseReady=false。未声称全量运行前后源码冻结，当前目录仍有共享评测开发。
