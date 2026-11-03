# D13 企业全员暂停执行记录

日期：2026-10-07，仓库根目录，分支 `codex/reliable-agent`。上一目标轮次为实际进展：完成账号目的绑定停止确认，并通过全量 1410 项、真实 PostgreSQL 56 项、构建及 Electron 隔离启动。完整 D00–D20 目标仍在进行。

## 实现

迁移 033 增加不可改写的企业暂停批次及账号清单，单条查询认证绑定实际管理员登录和企业；普通服务不获表权限。新增严格摘要/分页合同、`request-pause-all`、`pause-all-request`、`pause-all-accounts` 命令。

集合 SQL 在取样账号上按 C 排序加锁，事务中创建各账号独立请求、原设备目标、暂停指针及账号/批次审计。不使用旧账号查询的 200 项上限；账号页与摘要同 SQL 快照，有界游标绑定企业与批次。

同 ID 重试只读取原批次，明确显示后来新增的账号及原请求失效数，不再暂停已恢复或后来独立暂停的账号。缺失可变指针也不让原账号在清单中消失；只标为该批次当前不生效。长中文标识使用适配合法 UTF-8 编码长度的 2048 字符游标上限，标识仍保持既有 128 字符合同。

原设备目的绑定确认继续使用迁移 032 流程；所有回执不证明物理停机、不授予发送权，也不改写未知发送、旧许可、租约或恢复围栏。操作见 [全员暂停](../../bulk-pause.zh-CN.md)。

## 当前证据

- 初次 2 文件 / 20 项通过：`.local/reports/bulk-pause-targeted-first.json`。
- 账号/HTTP/管理员组合 4 文件 / 38 项通过：`.local/reports/bulk-pause-targeted-final.json`；含 208 账号三页无遗漏/重复、审计回滚、企业隔离、不可变历史、重复请求及既有设备确认。
- 真实 PostgreSQL 5 文件 / 61 项通过，临时容器已清理：`.local/reports/postgres-concurrency/71b6456c-f0bc-4c9c-b158-9edb2f081f50/result.json`。新增批次同 ID 竞争、原账号锁阻止租约、新账号并发加入与原成员取样、完整回滚以及真实管理员对 208 账号的完整分页。

首次并发夹具有拼写错误，被格式工具拒绝；修正后进入验证。服务类型检查曾在 SQL 夹具的未知行类型处失败，改用对整个计数行的严格断言后通过。没有放宽测试期限、跳过测试或把合成标签当作业务准确度证据。

RLS 单次登录认证把 208 账号的嵌入式分页测试从本机首次约 4.77 秒降至约 0.47 秒；这是开发环境的一次对照观察，不是生产性能承诺。权限语义继续经过真实管理员和跨企业/普通服务负例检查。

最终证据已补齐；以下历史失败保留，当前结果分开记录。

第二次全量为 143 文件 / 1424 项，0 失败 / 0 跳过，353.02 秒，报告 `.local/reports/bulk-pause-full-verified.json`。当前三类类型检查及 10 文件 scoped lint 均退出 0；本轮只改中央管理员功能和合同，没有改员工界面/执行器或重新构建 Electron 资源。

共享开发在此期间更新了学习评测合同、CLI 与回放脚本，保留所有改动。受影响 3 文件 / 21 项已复验通过，报告 `.local/reports/bulk-pause-shared-recheck.json`。全服务类型检查曾在同期修改的 `memory-evaluation-v2.test.ts` 字段推断处失败，原 `.local/reports/bulk-pause-services-verified.json` 和日志保留；当前源码再次检查通过，报告 `.local/reports/bulk-pause-services-rechecked.json`。没有将中途不完整的共享源码检查算为通过。

实际管理员 CLI 的 `--help` 子进程退出 0，包含三个批次命令；报告 `.local/reports/bulk-pause-cli-help.json`。批次数据操作本身已由真实 PostgreSQL 独立管理员登录和相应命令路由测试覆盖。

当前源码再次完成实际 PostgreSQL 5 文件 / 61 项，0 失败 / 0 跳过，41.90 秒，临时容器已清理；报告 `.local/reports/postgres-concurrency/2cbdece9-f1de-4aec-8558-385bfbee2e19/result.json`。

汇总 `.local/reports/bulk-pause-stage/a30a4eed-5f7d-4153-b77b-965f091093a8/result.json` 保存当前检查结果与 11 个实现、接入和测试文件摘要；相对第二次全量前摘要均未变化。`incrementChecksPassed=true`、`fullGoalComplete=false`、`releaseReady=false`。源码基线 `.local/reports/bulk-pause-source-before-verified.json`，共享修改清单 `.local/reports/bulk-pause-source-drift-final.json`；共享工作区没有冻结。

第一次全量为 142 文件 / 1420 项，1419 通过、1 失败、0 跳过，报告 `.local/reports/bulk-pause-full-final.json`。原有员工确认联调触发 5 秒测试总期限；新增全员暂停及长中文游标测试均通过。原测试及暂停/状态组合 4 文件 / 81 项复验通过，报告 `.local/reports/bulk-pause-generation-recheck.json`，该员工路径约 1.55 秒。没有据此断言超时根因已经修复；新增只有慢运行的阶段耗时诊断，原测试期限、流程和断言保持不变，再做完整组合验证。

## 后续验收

D13 管理员界面、实际发送器停止取证及至少三台员工电脑联调继续待办。两平台后台收发、独立业务准确度、正式安装签名、生产恢复/整机回退和工作日试点均未完成。

本轮未操作真实聊天或调用真实模型，未安装、提交或发布；工作区未冻结，尚无本增量独立复核。不会以批次数据库写入替代全员物理停止验收。
