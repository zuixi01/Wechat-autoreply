# 恢复审批与本机历史边界

最终恢复准入前，必须逐笔完成原发送核对，再由独立维护人员批准一份绑定当前完整证据的恢复边界。迁移 040 保存不可修改的审批请求、服务端边界和实际维护登录主体。普通管理员和设备不能写入批准记录。

当前已实现审批、目标设备读取、本机历史边界及独立执行核对证据重新保存；历史重读分类、中央完成确认及运行围栏解除仍待接通。**以下命令不恢复自动回复**，原账号暂停和 unknown 状态保留。目标读取还需迁移 041，保持普通服务不继承证据读取权限。

## 1. 完成每笔原发送核对

先执行 [完整发送结果核验](restore-execution-review.zh-CN.md)。当本地申请响应丢失、没有 permitId 时，服务端按原 agent、登录轮次、客户端实例、任务、任务摘要、原稿和会话匹配中央许可；唯一匹配才合并为同一执行。多个候选或同任务主体冲突时拒绝。

对所有 issued/unknown 许可，原 reconciliation 报告、独立管理员记录/决定和设备精确应用确认都必须完整。已发送必须与独立来源中的具体消息一致，不能仅凭文本相同。所有原请求封存也必须有对应设备应用；地方记录未知不能被一次“历史已隔离”代替。

管理员只读核对：

```powershell
node --import tsx server/scripts/admin.ts restore-resolution-basis --tenant <企业ID> --account <账号ID> --case <恢复案UUID> --review <发送核验UUID>
node --import tsx server/scripts/admin.ts restore-recovery-preview --tenant <企业ID> --account <账号ID> --case <恢复案UUID> --upload <完整清单UUID> --review <发送核验UUID>
```

预览只返回范围和摘要，不返回客户正文，也不批准恢复。`separateReconciliationComplete` 仅说明中央现有原核对记录满足结构和绑定检查，不能证明恢复后的本机核对日志已经重新应用。

## 2. 独立维护批准

按 `RestoreRecoveryApprovalInputSchema` 编写私有 JSON：新 `authorizationId`、企业/账号/恢复案/完整清单/核验编号、预览中的六个 `expected*Hash`、独立复核人员、五分钟内 `reviewedAt`，以及固定 `historyPolicy="quarantine_all_history"`。不要直接把整个预览当输入，额外字段会拒绝。输入最多 16 KiB，严格 UTF-8。

```powershell
node --import tsx server/scripts/restore-history-maintenance.ts authorize-recovery --database <实际数据库名> --file <私有审批JSON> --output .local/maintenance/<新私有目录>/recovery-authorization.json
node --import tsx server/scripts/admin.ts restore-recovery-authorization --tenant <企业ID> --account <账号ID> --case <恢复案UUID> --authorization <审批UUID>
```

维护凭据使用 `RESTORE_HISTORY_MAINTENANCE_DATABASE_URL`，必须为实际维护数据库登录；没有普通管理员/服务凭据回退。先认证、核对真实数据库名，再打开输入文件，事务中重新认证并锁定账号。原编号与原内容重试返回原回执，不刷新期限。有效期最多五分钟，且不能超过完整历史、发送核验或独立来源自身的期限。

审批重新核对签名、公钥撤销、全部来源消息、完整本地/中央依据、原核对决定和应用、所有请求封存；要求账号暂停且没有活动租约。任何依据变化、签名撤销或过期，原回执仍留存，其当前可用状态另行标记。维护命令检查这些记录的绑定，**不会自动核验物理消息因果、全设备停止或独立日志事实**。

## 3. 本机原子应用底座

`Ledger.applyRestoreRecoveryBoundary(scope, package, now)` 是主进程内部接口；不得接成允许员工手写 package 的 IPC。当前主进程 `applyRestoreRecoveryBoundary({})` 已通过自身恢复上下文及登记身份发现恢复案，再从凭据限定的 `POST /v1/restorations/recovery/current` 读取当前完整审批；先停止观察器/发送器/结算和租约，确认静止后才本地应用。切换账号、移除连接、关闭期间迟到响应和并行恢复操作均拒绝。

中央仍重新核验签名、撤销、独立核对和完整当前依据，按原目标设备、账号及恢复案限定读取。日常服务显式切到原只读角色，不使用维护连接或维护凭据，不能写审批、完成确认、租约或发送记录；返回包不含来源公钥配置、维护登记内容、客户正文或模型密钥。请求只有恢复案和恢复上下文，响应边读边限 2 MiB，仍保留原五秒期限。当前只有内部编排，尚未新增员工恢复完成入口。

SQLite 同一事务核对本机最新恢复来源、完整清单摘要及每条已知来源消息的编号/方向/内容摘要，隔离尚未处理的旧入站消息，将完整来源枚举的全部会话设为人工接管，包括本机尚未出现或没有消息的会话，并保存不可修改的原审批包与应用回执。保存的包包含历史编号/摘要，不含消息正文。原发送结果不改写，其他账号不受影响。

异常整笔回滚；重启或重复调用返回原应用回执，不消费后来观察的消息，不更新原应用时间。再次备份恢复后，旧审批包因新恢复来源被拒绝。历史应用查询只供审计；当前回执固定 `localExecutionResolutionRequired=true`、`centralConfirmationRequired=true`、`canRelease=false`、`automaticStart=false`。

完整边界及本机包目前最多 2 MiB，来源总消息上限 200000；超限拒绝并保持暂停，后续需完整分页协议，不能裁减后放行。本机持久化尚未接通历史消息再次读取时的边界分类，也没有释放围栏；中央完成确认和显式恢复账号仍须继续开发。

## 4. 恢复设备逐笔重新核对

主进程内部 `applyRestoreRecoveryExecutions({})` 接着读取凭据绑定的 `/v1/restorations/recovery/resolutions`，取得完整原核验、执行主体、独立 reconciliation 报告/裁定/应用记录及请求封存，重新核对全部本地执行后以一个 SQLite 事务保存不可修改的证据与回执。只能使用自身恢复案和原授权，不能让员工提交执行包。原发送状态、中央队列、发送基线和旧应用确认不改写，新的回执也不授予重发权。

边界提交后断网，该边界保持；重新调用继续读取核对包。成功状态为 `executions_recorded`，仍是 `canRelease=false`，不代表中央完成确认。原授权不刷新期限；本地已提交的精确同包重试仅返回原回执。再次恢复产生新来源后，旧核对包不能用于新恢复。

旧中央终态只保存了原发送回执的摘要，当前返回明确的 `terminal_reference`，不会拼造原回执正文或将摘要当成实际发送证明。独立来源和维护核验继续承担原物理事实核验。完整核对包也按 2 MiB 限额拒绝超限，不截取局部记录后放行。详见 [执行记录](superpowers/plans/2026-10-07-restore-resolution-reapplication.md)。员工完成入口、完整历史重读分类及中央最终准入仍待完成。

实际微信/企微后台收发、日常办公互不干扰、Jev 业务准确度、多个员工电脑及正式安装验收仍按原计划执行，模拟与 SQL 检查不能替代这些验收。
