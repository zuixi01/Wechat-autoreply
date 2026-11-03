# 账号暂停与员工端停止确认

2026-10-07，D13 增量。管理员暂停账号时，中央保存不可改写的请求和当时未撤销设备清单；员工主进程停止本地处理后，用新挑战提交确认。管理员查询会核对确认与最近上报是否属于同一进程、同一运行轮次。

## 接入与命令

由独立迁移角色按顺序补齐迁移至 `032-account-pause-confirmation.sql`，再更新中央服务和员工程序。中央服务不自动迁移。旧备份恢复后须审核补齐迁移，停止确认不能解除恢复围栏。

在 仓库根目录，使用已配置的独立企业管理员数据库登录：

```powershell
$pauseRequestId = [guid]::NewGuid().ToString()
npm run admin -- request-pause --tenant 企业ID --account 账号ID --request $pauseRequestId
npm run admin -- pause-request --tenant 企业ID --account 账号ID --request $pauseRequestId
npm run admin -- runtime-status --tenant 企业ID --account 账号ID --limit 100
```

`--request` 可省略：发起时生成新 ID，查询时读取最新请求。重试发起应复用同一 ID；同 ID 不产生第二次审计。请求被后续暂停取代或账号解除暂停后，旧 ID 不能重新暂停账号。原 `pause` 命令也通过此流程发起暂停。

`targetCount` 是发起时冻结的未撤销设备数，`reportedTargets` 仅表示有历史确认入库的设备数。后来登记的设备不补进原清单；它仍受中央账号暂停约束。新设备、撤销、离线及后续进程变化须分别查看运行状态，不应将历史确认数当作当前停止数。

## 员工端流程与查询含义

首次收到请求后，主进程立即暂停、取消排队和在途处理，再调用私有设备接口 `POST /v1/runtime/pause/challenge`。服务器挑战限定账号暂停用途、请求、凭据导出的设备身份、进程实例、运行轮次、持久化实例标签和尝试 ID，期限 30 秒。

只有观察器已停止、Sender 静止、结算流程静止且续租停止时，才向 `POST /v1/runtime/pause/report` 提交声明。客户端单次流程最多等待 10 秒；HTTP 等待最多 2.5 秒。存储故障、平台停止失败、超时或切换登记不能生成成功确认。关闭时先停止回复，再取消并等待确认流程退出。

| `pauseConfirmation` | 含义 |
| --- | --- |
| `pending` | 原目标设备尚无本请求确认 |
| `awaiting_state` | 已入库，但最近状态尚未匹配确认的进程及轮次 |
| `confirmed_runtime` | 本请求确认与最近 30 秒的有效、已暂停状态匹配 |
| `stale` | 有历史确认，最近运行状态缺失、过期或无效 |
| `invalid` | 保存的确认合同、哈希、身份或期限不一致 |
| `revoked` | 原目标设备已撤销 |
| `not_requested` | 当前无有效请求或设备不属于原目标清单 |

同包重试返回原确认时间，不刷新新鲜度；旧请求、改写重复包、跨账号/企业/设备和撤销设备报告被拒绝。暂停与审计、目标快照同事务提交；确认在账号锁内重新检查权限和最新请求，入库越过挑战期限会回滚。

`confirmed_runtime` 证明已认证程序报告的本地停止状态。平台仅记录“未安装”或“停止方法已返回”，没有硬件或真实客户端停止取证；所有回执及查询始终 `physicalStopVerified=false`、`canAuthorizeSend=false`。暂停和确认不改写原许可、未知发送、租约、接管或恢复围栏，解除中央暂停也不会自动启动员工端。

## 验收边界

合成联调使用实际 SQLite、本地 HTTP、嵌入式 PostgreSQL及隔离 Docker PostgreSQL，不读取真实聊天，不调用真实模型。本增量的测试和最终组合结果记录于 [执行记录](superpowers/plans/2026-10-07-account-pause.md)。

D13 的 [企业全员暂停](bulk-pause.zh-CN.md) 已接入独立管理员命令。管理员界面、真实平台停止证据和至少三台员工电脑联调继续待办；完整微信/企微后台收发、Jev 业务准确度及发布验收尚未完成。
