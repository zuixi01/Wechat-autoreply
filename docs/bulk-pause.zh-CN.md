# 企业全员暂停

2026-10-07，D13 增量。一次管理员操作暂停本企业在取样时已经存在的全部账号，包括停用账号。账号清单、各账号原目标设备清单、暂停指针和审计同事务保存；失败时全部回滚。

## 执行

迁移运维人员按顺序补齐迁移至 `033-tenant-pause-batches.sql`，更新中央管理程序。迁移不由服务自动执行，旧归档恢复后也须审核补齐。只使用独立企业管理员数据库登录，不能把数据库凭据交给员工。

在 仓库根目录，用现有管理员环境执行：

```powershell
$pauseBatchId = [guid]::NewGuid().ToString()
npm run admin -- request-pause-all --tenant 企业ID --request $pauseBatchId
npm run admin -- pause-all-request --tenant 企业ID --request $pauseBatchId
npm run admin -- pause-all-accounts --tenant 企业ID --request $pauseBatchId --limit 100
npm run admin -- pause-all-accounts --tenant 企业ID --request $pauseBatchId --limit 100 --after 上一页nextCursor
npm run admin -- runtime-status --tenant 企业ID --limit 100
```

发起时 `--request` 可省略，由程序生成新批次 ID；查询时必须提供返回的批次 ID。重试原操作复用原 ID。需要发起新的全员暂停时，生成新 ID。

`pause-all-accounts` 每页 1–100 项，默认 50，`nextCursor=null` 为末页。不能把游标用于另一企业或另一批次。每页与摘要来自同一条 SQL 的快照。原清单不可修改，后续每页中的运行暂停状态可因管理员其他操作而变化。

## 结果含义

| 字段 | 含义 |
| --- | --- |
| `accountCount` | 本批次冻结的账号数 |
| `activeAccounts` | 本批次请求仍是该账号最新请求且中央仍暂停的账号数；不是正在运行数 |
| `outsideAccounts` | 当前企业中不属于原批次的账号数；包括批次取样后新增账号 |
| `targetCount` | 各原账号当时未撤销的目标设备总数 |
| `reportedTargets` | 已保存历史停止确认的原设备数；不是当前物理停止数 |
| 账号页 `requestId` | 该账号独立的暂停请求 ID，与批次 ID 分开 |

新建账号仍按既有规则默认暂停。新账号不追加到原批次；账号新增、单独解除暂停或后续暂停取代旧请求，都不会被原批次的重试覆盖。重试仅返回原批次的当前摘要，不再次修改账号、设备目标、最新指针或审计。

当前设备确认继续使用 [账号暂停与停止确认](account-pause.zh-CN.md) 的挑战流程。全员暂停成功表示中央新执行权已经关闭，不能表示所有电脑已物理停止。各回执始终 `physicalStopVerified=false`、`canAuthorizeSend=false`，不清除未知发送，不取消旧许可，不改写租约，也不解除恢复围栏。管理员须分页检查设备最新状态，离线设备不能用别人的确认替代。

全员暂停使用集合 SQL，在同一事务中按固定顺序锁定原账号；新的租约或许可准入等待相同账号锁，暂停提交后被拒绝。批次表使用不可改写历史、企业行级权限与每条查询的登录认证；普通设备服务角色没有读取或改写权限。

验证证据见 [本轮记录](superpowers/plans/2026-10-07-bulk-pause.md)。管理员界面、真实平台停止证据和至少三台员工电脑联调仍待完成。
# 桌面操作入口

现有「企业连接 → 企业管理员」已接通独立管理服务，支持全员暂停、批次查询与账号分页。部署及当前验证边界见 [管理员界面](admin-console.zh-CN.md)。真实后台收发和多电脑联调仍待验收。

