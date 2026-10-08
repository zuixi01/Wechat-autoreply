# 账号完整恢复确认核对

使用已绑定管理员身份的 `ADMIN_DATABASE_URL`，在项目目录执行：

```powershell
npm run admin -- restore-completion-audit --tenant TENANT_ID --account ACCOUNT_ID
```

结果核对该账号的所有恢复案，包含恢复上下文、最新独立审批、原设备确认请求/回执摘要和完整祖先链摘要。只返回元数据，不返回客户正文或来源私钥。读取在账号事务锁内进行，不修改记录、不调用模型、不获取回复执行权。

| 状态 | 含义 |
| --- | --- |
| `awaiting_authorization` | 该恢复案尚无独立恢复审批 |
| `awaiting_declaration` | 最新审批尚无设备持久化确认 |
| `awaiting_current_evidence` | 原声明保留，但当前证据已不满足核对要求 |
| `ready_for_independent_review` | 当前原证据完整，可进入独立最终准入复核 |

`cases` 包含全部恢复案，超过普通显示页也不会省略；完整输出超过上限则拒绝，不提供部分成功。命令不接受 `--case`、`--limit`、`--after`。新增恢复案、确认变化或证据到期会改变 `basisHash`；较早检查的审批若在核对结束前到期，也不能保留就绪状态。

`allCasesPrepared` 和 `preparedUntil` 仅说明此次完整核对时的准备状态，不是恢复准入证明。输出始终包含 `finalAdmissionRequired: true`、`physicalDurabilityVerifiedByThisRead: false`、`canRelease: false`；账号和本机仍保持原恢复围栏。最终准入、员工完成入口及长期来源授权续期继续开发。
