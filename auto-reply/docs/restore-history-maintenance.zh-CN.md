# 恢复历史的维护登记

在已经完成独立核验后，维护人员可登记历史来源、备份起点和所有设备停止事实，供普通管理员保存来源签名报告。此命令记录维护人员的核验声明及依据摘要，不自动验证实机事实，不实现聊天读取，不提供最终恢复批准。尚无经过真实微信/企微验收的生产历史来源；不得复制夹具的密钥或 true 能力值启用生产。

采用迁移 035、036 及项目既有独立维护连接：实际登录主体必须具有维护 superuser 权限，且不能通过 SET ROLE 冒用。普通管理员、员工、学习服务和恢复读取角色均不能登记这些事实。维护凭据只在受保护的 `RESTORE_HISTORY_MAINTENANCE_DATABASE_URL` 环境中配置，不回退到 ADMIN_DATABASE_URL、DATABASE_URL 或员工凭据；不要把连接串写入命令行、文档或输出文件。

在仓库根目录运行，数据库名称必须明确匹配实际连接目标：

```powershell
node --import tsx server/scripts/restore-history-maintenance.ts --help
node --import tsx server/scripts/restore-history-maintenance.ts register --database <实际数据库名> --file <已核验的私有JSON> --output .local/maintenance/<新目录>/receipt.json
node --import tsx server/scripts/restore-history-maintenance.ts revoke --database <实际数据库名> --file <私有撤销JSON> --output .local/maintenance/<另一新目录>/receipt.json
```

仅本地数据库流程已使用合成来源验证；没有连接生产数据库或启用生产来源。命令先认证和核对数据库，再打开最多 16 KiB、严格 UTF-8 的 JSON，写入事务重新认证。成功回执保存在 `.local` 或 `evals/private` 内；目标文件必须不存在。新空目录设置当前用户/SYSTEM 的 Windows 私有权限，已有非空目录必须已经满足私有权限，不能借此重设其他目录的 ACL。文件同步落盘；控制台只输出固定成功或错误码。

登记文件遵循 `server/src/recovery/restore-history-maintenance.ts` 中 `RestoreHistoryRegistrationSchema`：

- `registrationId` 为新 UUID；`tenantId/accountId/caseId/uploadId` 为此次完整核对范围。
- `expectedContextHash/expectedInventoryBasisHash/expectedAssessmentBasisHash/expectedScopeHash` 必须来自当前完整服务端核对，不能用界面的一页内容计算。
- `platformAccountIdHash` 和 `sourceTrust` 为独立核验的真实平台账号、来源版本、发布摘要、公钥、有效期和实机验证依据。设备报告不能自己注册自己的公钥。
- `backupStartedAt/backupStartVerificationSha256` 必须来自独立备份开始依据，不能用文件修改时间或备份完成时间代替。
- `allDevicesStoppedAt/deviceStopVerificationSha256` 须核验该账号的所有设备；中央账号保持暂停且没有活动租约。恢复后的停止观察和维护复核均最多过去五分钟。
- `review` 记录独立核验人员、依据摘要、复核时间以及三项明确核验声明。程序检查绑定、时间和权限，但不会代替维护人员核验依据文件的事实内容；回执 `factVerificationPerformedByThisCommand=false`。

登记从数据库完整清单和核对单生成维护要求，保存时持有账号行锁。来源公钥的实际 Ed25519 SPKI DER 摘要用于撤销及事务锁；标签、PEM 格式或版本改名不能绕过撤销。维护要求与原请求、实际数据库登录主体、原回执在同一事务中保存；审计失败全部回滚。

撤销文件遵循 `RestoreHistoryKeyRevocationSchema`，只接受新 `registrationId`、真实 `publicKeyPem`、`reasonSha256`、核验人员及五分钟内的 `reviewedAt`。按实际密钥全局撤销，不能用新的 keyId 重新启用旧密钥。撤销与来源报告保存共享实际公钥事务锁：撤销先提交，则排队的新报告被拒绝。维护记录、要求和撤销均不可 UPDATE/DELETE。

回执丢失、输出失败或响应不确定时，保留原文件和 registrationId，并向另一个新输出文件重试；不得刷新文件中的时间/摘要后复用编号。原维护登录主体可取得相同原回执，不重复登记或审计。历史重试不重新证明来源当前有效、设备仍停止或依据仍最新；普通管理员提交签名报告时会再次检查最新维护要求、撤销、完整依据和时间。

登记和撤销始终 `canRelease=false`、`automaticStart=false`。现已接通 [逐笔发送结果核验](restore-execution-review.zh-CN.md) 的独立维护保存与管理员只读核对。最终批准、新运行边界及本地/中央原子准入仍待开发；本流程不能解除任何恢复或发送围栏。见 [历史证据保存](restore-history-proof.zh-CN.md)。
