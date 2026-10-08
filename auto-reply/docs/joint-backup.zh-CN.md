# 联合备份与隔离恢复

D16 管理员离线运维入口，保存实际数据并恢复到新的核对目录。员工界面不接收数据库凭据或任意文件路径。正式恢复启用及产品验收仍按原开发计划执行。

## 数据范围

| 组件 | 员工资料目录中的来源 | 隔离恢复位置 |
| --- | --- | --- |
| 配置 | `settings.json` | `review-only/settings.json` |
| 发送账本 | `agent/ledger.sqlite` | `ledger/ledger.sqlite`，含新恢复围栏 |
| 知识库 | `knowledge/knowledge.sqlite` | `review-only/knowledge.sqlite` |
| 学习记录 | `worktrace/memory/learning.sqlite` | `review-only/learning.sqlite` |
| 设备登记（可缺省） | `agent-device.json` | `review-only/agent-device.json` |
| 旧经验卡（可缺省） | `worktrace/memory/cards.json` | `review-only/cards.json` |
| 前台试验账本（可缺省） | `agent/foreground-wechat.sqlite` | `review-only/foreground.sqlite` |
| 中央数据库 | 管理员维护环境的完整 PostgreSQL custom archive | `review-only/central.dump` |

前四项缺失会失败，可缺省项明确记为 absent；未初始化资料不能冒充空备份。知识库当前 user_version 0、学习库 15，账本沿用自身兼容检查（11/12/13）。模型文件、缓存、日志、原始知识上传文件不在此业务包内；已解析正文/分块和中央发布知识被保存，原上传文件需另存。

SQLite 原生快照包含 WAL 已提交内容；中央使用完整 `pg_dump --format=custom --no-password --lock-wait-timeout=5s`，不筛表或导出局部行安全视图，见 [PostgreSQL 16 说明](https://www.postgresql.org/docs/16/app-pgdump.html)。**各组件分别一致，整包不是分布式事务。** 清单记录采集起止、固定组件、大小和 SHA-256，备份后消息/发送结果/新中央状态仍需独立核对。

## 命令

在仓库根目录运行，维护主机安装开发依赖、Node.js 24（本次验证 24.21.0）及 PostgreSQL 16 客户端。用 `PGDATABASE`、libpq `PG*` 环境/受保护密码文件提供完整备份权限，不把凭据放参数/报告或员工界面。普通服务的受限行安全登录不能制作全库备份。员工资料应已关闭应用，或由管理员取得完整受保护离线副本。

```powershell
node --import tsx scripts/joint-recovery.ts backup --profile "C:\private\employee-profile" --output "C:\private\backups" --pg-bin "C:\PostgreSQL\16\bin"
node --import tsx scripts/joint-recovery.ts verify --backup "C:\private\backups\<UUID>" --pg-bin "C:\PostgreSQL\16\bin"
node --import tsx scripts/joint-recovery.ts stage --backup "C:\private\backups\<UUID>" --output "C:\private\restore-new" --pg-bin "C:\PostgreSQL\16\bin"
```

输出只含清单/位置/状态和固定错误码，不含配置值、客户正文或 SQL 原文。`verify` 用 `pg_restore --list` 检查中央归档结构，不执行 SQL，不证明业务准确度或上线条件。

Windows 写数据前保护新建空目录的 NTFS ACL，仅当前用户与 SYSTEM 可访问，并核对所有组件；无法设置/核对则失败，应选当前用户拥有的私有目录。中文及类似 shell 的路径字符通过 UTF-8 JSON 作为数据传入。公开目录/额外开放文件权限会被拒绝。归档未额外加密，跨机传递仍须保护存储和传输权限。

所有组件成功才发布 `manifest.json`；失败目录和局部文件不可用，不能手工补清单绕过检查。

## 恢复处理

`stage` 只创建不存在的新目录，不覆盖旧资料或启动应用/中央服务。配置、设备、学习、中央归档仅进入 `review-only`；旧自动开关、已激活方法和机器加密凭据不直接安装。账本经原有恢复函数生成新 provenance，保留旧消息/未知发送围栏。

全部数据复制、摘要及权限复核后才写 `staging-receipt.json`，明确 `automaticStart=false`、`requiresReview=true`、`readyForProfile=false`。校验后文件改变会保留失败目录而无完成回执，已恢复账本仍阻断执行。此目录不能作为活动应用资料。

中央归档已支持导入新隔离数据库，操作见 [中央数据库恢复](central-recovery.zh-CN.md)。正式中央恢复启用、全组件审核安装、备份后历史证明、围栏最终解除、整机版本回滚演练仍属于 D16 待完成项。真实微信/企微驱动、Jev 业务准确度、多员工办公验收也尚未完成。

## 验证

`node scripts/run-joint-backup-postgres.mjs` 只创建新的随机标签临时容器。最新报告 `.local/reports/joint-backup-postgres/696e1879-bcb9-4f4e-863a-289a293f4f45/result.json`：PostgreSQL 16.15、迁移 001–029、两个企业的合成数据，68 表行数/逐行聚合摘要一致、行安全保留。隔离数据库禁止普通角色 CONNECT，账本围栏保留、容器已清理。独立复核确认实际备份/恢复目录及文件仅当前用户/SYSTEM 可访问。没有真实聊天/消息/模型调用。
