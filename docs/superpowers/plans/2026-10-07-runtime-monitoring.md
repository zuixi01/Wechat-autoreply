# D13 运行监控执行记录

日期：2026-10-07，工作目录 `E:\wechat-autoreply\auto-reply`，分支 `codex/reliable-agent`。本增量完成运行监控的服务、员工主进程和管理员命令；完整 D00–D20 目标继续进行。

## 实现与校验

- 新增迁移 031：按企业隔离的设备最新状态表、账号/设备分页索引、管理员只读权限。嵌入式与实际 PostgreSQL 均重复执行迁移检查幂等性。
- 状态接口从设备凭据导出身份，在账号锁内重新检查撤销和禁用状态。报告绑定持久化轮次、序号和内容哈希；同包重发保留原接收时间，旧包及冲突包拒绝，损坏历史不能被悄悄覆盖。
- 主进程只上传运行元数据，未登记时无上报。5 秒轮询、2.5 秒本地等待上限；迟到回执受登记/地址绑定保护，关闭时先暂停回复，再取消并等待上报退出。
- 中央暂停回执可停止运行器；清除中央暂停不自动启动。运行状态声明不授予执行权、续租或证明物理停机。
- `runtime-status` 管理员命令使用同一 SQL 快照的总数与有界页面。207 个设备跨三页验证无漏项或重复，游标不能用于另一企业或账号过滤条件。
- 桌面脚本改为严格检查当前 v13 账本，并对全部模式阻断 HTTP、计数和拒绝意外网络请求。

## 最终证据

| 检查 | 结果 | 报告 |
| --- | --- | --- |
| 全量 Vitest | 137 文件 / 1383 项，0 失败 / 0 跳过 | `.local/reports/runtime-monitoring-full-final.json` |
| 监控及生命周期专项 | 6 文件 / 140 项，0 失败 / 0 跳过 | `.local/reports/runtime-monitoring-contracts-final.json` |
| 学习合同复验 | 10 文件 / 86 项，0 失败 / 0 跳过 | `.local/reports/runtime-monitoring-learning-recheck.json` |
| 实际 PostgreSQL 独立连接 | 3 文件 / 45 项，容器已清理 | `.local/reports/postgres-concurrency/1e3ff67d-5415-443b-af0a-3c2930bad6d7/result.json` |
| 服务/共享/测试类型 | 退出 0 | `.local/reports/runtime-monitoring-types-services-current.log` |
| Electron 主进程类型 | 退出 0 | `.local/reports/runtime-monitoring-types-node-final.log` |
| 当前界面类型 | 退出 0 | `.local/reports/runtime-monitoring-types-web-current.log` |
| 监控 TypeScript 与桌面脚本 lint | 合计 10 文件，0 错误 / 0 警告 | `.local/reports/runtime-monitoring-lint-final.json`、`runtime-monitoring-smoke-lint-final.json` |
| 当前 Electron 资源构建 | 退出 0 | `.local/reports/runtime-monitoring-build-final.log` |
| 实际 Electron 隔离启动 | 44.5.1 / Node 24.21.0、v13 SQLite 账本、私有 IPC、模拟界面、软件渲染；网络尝试 0、正常退出 | `.local/reports/desktop-smoke/fd239e91-9d67-4d33-acff-2906e6efa7d2/result.json` |

构建保留依赖中的 Rollup 注释提示，没有声称构建零警告。软件渲染检查不是默认硬件渲染、安装包或真实账号验证。

汇总报告：`.local/reports/runtime-monitoring-stage/d3bb57ce-639a-4169-8022-95f5bb9a6c62/result.json`。监控 19 个实现、接入与测试文件，相对最终回归前摘要均未变化；完整源码摘要保存在 `.local/reports/runtime-monitoring-source-before-final.json`。共享界面及其他桌面脚本更新已保留，最新界面重新构建并做了隔离启动，工作区未冻结。

## 保留的失败

前一次全量为 137 文件 / 1382 项，1342 通过、40 失败，报告 `.local/reports/runtime-monitoring-full.json`。运行期间学习合同加入人工标注来源 `labelOrigin`，早先加载的合同拒绝新字段；受影响模块复验及最终全量均通过。没有删除失败测试、放宽时间或把工程模拟数据当作业务人工标签。

早先桌面检查仍断言 v11，当前新账本已经是 v13，因此出现 `ledger_contract_failed`。失败报告为 `.local/reports/desktop-smoke/51ddf3f4-9e69-4fa2-92ca-c66159ba102f/result.json`。修正为严格检查 v13 后重新验证通过；此更改不扩大可接受版本范围。

## 后续任务

D13 的管理员界面、目的绑定的真实发送器停止取证和至少三台员工电脑联调继续待办。D03 微信/企微不干扰办公的后台收发适配器、D20 业务准确度、D15 正式安装签名、D16 审核启用恢复与整机回退、D17 工作日试点仍未完成。

本轮没有实际聊天操作、真实模型调用、打包安装、提交或独立复核。`incrementValidated=true`、`goalComplete=false`、`releaseReady=false`；监控结果不能解除任何发送或恢复围栏。
