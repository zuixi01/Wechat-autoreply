# 恢复时逐笔核验发送结果

独立维护人员可以保存已核验的发送结果，供最终恢复审批引用。待核验项由服务端完整恢复核对生成，包括备份中存在的本地执行和中央存在但备份中没有的许可。不能提交界面一页，不能遗漏或重复任何待核验项。

迁移 038 接在 035–037 后执行，重复执行保留原记录。维护认证、实际数据库名称核对、私有文件输出和原编号重试沿用 [维护登记命令](restore-history-maintenance.zh-CN.md)。维护环境变量为 `RESTORE_HISTORY_MAINTENANCE_DATABASE_URL`，需要实际维护登录主体，不能用普通管理员或服务连接替代。

```powershell
node --import tsx server/scripts/restore-history-maintenance.ts review-executions --database <实际数据库名> --file <独立核验的私有JSON> --output .local/maintenance/<新私有目录>/execution-receipt.json
node --import tsx server/scripts/admin.ts restore-execution-review --tenant <企业ID> --account <账号ID> --case <恢复案UUID> --review <核验UUID>
```

输入遵循 `src/shared/contracts/restore-execution.ts` 中 `RestoreExecutionReviewInputSchema`，最多 1 MiB 严格 UTF-8 JSON。包含新 `reviewId`、企业/账号/恢复案/完整清单编号、已保存的 `historyProofId`、当前完整 `assessmentBasisHash`、独立核验人员和五分钟内的核验时间，以及逐项 `outcomes`。来源历史必须仍有效且覆盖维护登记后的所有设备停止时刻，账号保持暂停、没有活动租约。

每项结果绑定原 `subjectKey/subjectHash/conversationId`、独立依据摘要和观察时刻：

- 已发送：绑定签名来源历史中的具体 `automation_outbound` 消息编号和内容摘要，核验人员另核对原稿文本摘要并明确确认因果归属。相同文本或时间接近不能自行证明是该次自动发送。
- 未发送：明确核验独立派发日志，保存日志条目摘要，确认没有开始派发且发送器已静止。没有看到消息、截图空白或模型判断不能作为未发送依据。
- 同一执行的本地和中央记录必须给出一致结果、执行主体和证据；不同执行不能复用同一消息或未派发日志条目。原终态与新结果矛盾时拒绝。

数据库事务锁定账号，重新验证原签名和当前完整核对，保存服务端生成的完整待核验快照、原请求、实际维护登录主体和回执。记录不能更新或删除，普通管理员只能读取本企业认证范围。来源、清单或中央状态变化时旧回执保留，但不作为当前核验；原编号重试只能返回原请求对应的历史回执，不能修改时间或结果再复用编号。

本命令检查权限、绑定、覆盖和声明一致性，**不会自动核验物理日志或消息的因果归属**；回执明确 `physicalOutcomeVerifiedByThisCommand=false`。目前没有经实机验收的生产来源，本次测试只使用自建合成事实。

原未知许可与派发记录不改写，原独立 reconciliation 决定及设备应用仍须完成。此流程 `canRelease=false`、`automaticStart=false`，不解除恢复暂停。后续还须完成最终恢复批准、新消息运行边界、本地持久化应用与中央精确确认；真实后台收发、Jev 业务准确度和多员工办公验收保持待办。超过当前单文件容量的完整核验需要后续分页事务实现，不能裁减清单后放行。
