# 中央数据库恢复与隔离

管理员维护命令把可信联合备份导入新数据库，保存全部业务历史，再暂停账号、撤销旧设备凭据、过期租约和未用登记码。恢复完成仍保持隔离，员工不能继续自动回复。原数据库和现用员工资料不会被替换。

## 执行条件和命令

在仓库根目录执行。需要 Node.js 24、开发依赖、PostgreSQL 16 客户端，以及通过 `PGDATABASE` 和 libpq `PG*` 环境或受保护密码文件配置的维护超级用户。目标集群须已有 `autoreply_app`、`autoreply_admin`、`autoreply_learning_worker`、`autoreply_restore_reader` 四个非登录、非超级用户、无 BYPASSRLS 的受信任角色。

```powershell
node --import tsx scripts/central-recovery.ts restore --backup "C:\private\backups\<UUID>" --output "C:\private\central-restore-new" --pg-bin "C:\PostgreSQL\16\bin"
```

备份必须来自受信任的本项目维护流程。大小、摘要、权限与归档结构校验能够发现损坏，不能证明归档来源；导入会执行其中的 SQL。凭据只提供给维护进程，不放入参数、报告或员工界面。

输出目录必须不存在，父目录必须真实存在且无符号链接替换。Windows 在复制归档前设置私有 ACL，仅当前用户和 SYSTEM 可访问；权限不能设置或核对时失败。目录中保存冻结归档、`attempt.json` 和成功后的 `restore-receipt.json`。

## 成功意味着什么

命令自己生成 `autoreply_restore_<UUIDhex>` 数据库名。先禁止连接，撤销 PUBLIC 权限并验证所有普通角色均无 CONNECT，再允许维护连接。通过固定参数进行完整原子导入：`--single-transaction --exit-on-error --no-owner --no-privileges --no-password`。不导入全局角色或旧密码；完整导入与导出均有 180 秒操作期限，元数据检查期限为 15 秒。参考 [创建数据库](https://www.postgresql.org/docs/16/sql-createdatabase.html) 和 [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)。

导入后的独立事务保存不可变恢复记录和每个企业的审计，暂停全部账号，撤销活跃旧设备，过期账号租约、学习后台租约和未使用登记码。已发布配置、知识、学习数据及全部发送记录保持原值；未知发送仍为未知。

迁移 030 的数据库触发器在存在恢复记录时拒绝恢复账号、新活租约、新执行许可、新活跃设备和有效登记码。恢复记录不能修改或删除；记录链损坏或守卫身份降权时拒绝准入。正常且没有恢复记录的数据库沿用原流程。

只有导入、隔离事务、摘要和权限检查全部成功才写完成回执。回执固定 `canRelease=false`、`automaticStart=false`。没有自动恢复账号、切换生产连接或解除围栏的参数。

## 失败和后续核对

失败会保留新数据库和私有目录，供管理员核对；没有完成回执就不能按成功处理。数据库仍无普通角色 CONNECT。命令不删除数据库、不复用失败目录、不覆盖原数据库。修复原因后使用新的输出目录重新执行。

此流程只证明中央隔离和备份内容的恢复。各组件备份不是同一个分布式事务；备份之后的聊天与发送历史、旧设备的实际停止、员工资料审核安装、最终恢复批准和整机回滚仍须按 D16 核对。不能因数据库暂停就认定所有旧设备已物理停止。

## 离线验证

```powershell
node scripts/run-joint-backup-postgres.mjs --central-restoration
node scripts/run-postgres-concurrency.mjs
```

前者使用新的临时 PostgreSQL 容器检查完整归档、逐表摘要、隔离准入、旧凭据/登记码拒绝以及导入失败不产生回执；后者包含两个独立连接并发提交同一恢复记录的检查。均使用合成业务数据，不读取聊天客户端，不发送消息，不调用模型。
