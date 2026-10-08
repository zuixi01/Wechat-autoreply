# 员工设备运行监控

2026-10-07 D13 增量：员工主进程定期向中央服务上报运行元数据；管理员按企业、账号分页查询设备状态。它用于发现未上报、状态过期、撤销和能力未验证的设备。

## 接入与查询

先由独立迁移角色按文件名顺序执行 `server/migrations/001-*.sql` 至 `032-account-pause-confirmation.sql`。运行状态表使用企业行级权限，普通服务角色可写，绑定本企业的独立管理员数据库登录只可读。中央服务不会自动执行数据库迁移。旧联合归档恢复出的数据库可能没有迁移 031/032，必须按恢复流程审核并补齐迁移；本监控不能解除恢复围栏。

员工端在主进程初始化 `DesktopAgentRuntime` 后启动上报器。未登记时不发请求、不分配上报轮次；登记后首次立即上报，后续每 5 秒上报一次。每次最多等待 2.5 秒，关闭程序时先暂停回复，再取消并等待上报退出。生产使用已有 HTTPS 服务地址和操作系统加密保存的设备凭据。

在仓库根目录，以已有的管理员数据库登录环境运行：

```powershell
npm run admin -- runtime-status --tenant 企业ID --limit 100
npm run admin -- runtime-status --tenant 企业ID --account 账号ID --limit 100
npm run admin -- runtime-status --tenant 企业ID --after 上一页nextCursor --limit 100
```

`--limit` 为 1–100，默认 50。`nextCursor=null` 表示最后一页；翻页必须保留原企业和账号过滤条件。总数与每页取自同一条 SQL 的快照，设备按账号、设备 ID 排序，超过 200 个设备仍可继续分页。翻页期间新增或撤销设备可能改变后续页，分页不宣称跨请求冻结的全量快照。

接口为 `POST /v1/runtime/status`，仅使用已登记设备 Bearer 凭据。企业、员工、账号和平台从凭据导出，客户端不能另外指定。主进程构造上报数据，渲染进程没有通用上报入口。

## 状态含义

| 字段或结果 | 含义 |
| --- | --- |
| `recent` | 服务器在最近 30 秒收到并验证了新上报 |
| `stale` | 最近有效上报已超过 30 秒 |
| `missing` | 该设备尚无上报记录 |
| `revoked` | 设备已撤销；可保留其最后一次历史上报 |
| `invalid` | 持久化报告、哈希、轮次或时间不一致 |
| `serverPaused` | 中央账号当前暂停状态 |
| `observation.status` | 设备最近声明的运行状态、暂停结果、能力元数据及收集计数 |
| `leaseLive` | 此查询时账号存在未到期租约；另列租约持有设备 |
| `physicalStopVerified=false` | 本接口没有证明平台发送动作已物理停止 |
| `canAuthorizeSend=false` | 上报和查询均不授予发送权限 |

报告只包含运行状态及版本、能力、数量元数据，不含聊天文本、联系人、客户会话、模型密钥或设备凭据。`recent` 表示最近有上报，不能据此判断聊天客户端可用、后台收发已验收或回复准确。

收到普通中央暂停回执时，上报器暂停处于 `running` 或 `starting` 的本地运行器；含目的绑定请求时，即使本地已经暂停，也执行该请求的停止确认流程。解除中央暂停不会自动启动员工端。断网时中央状态会过期，现有租约和发送校验继续决定执行资格。

## 重放、重启与隔离

上报轮次从本地账本持久化分配，同轮次使用递增序号。中央在账号锁内重新验证设备权限并保存最后一条报告：完全相同的重发返回原接收时间；旧轮次、旧序号被拒绝；同轮次同序号改变内容被拒绝。重放旧包不能延长状态新鲜度。

进程重启重新分配更高轮次。若恢复了更旧账本，其轮次低于中央记录，上报会被拒绝，不能覆盖较新状态；恢复和设备重新登记须遵循已有审核流程。登记或服务地址改变后的迟到响应不会触发当前设备暂停。

报告不续租，不修改账号暂停、未知发送或执行许可。原始 `pauseAcknowledged` 是本地运行器的状态声明。现已接入 [目的绑定停止确认](account-pause.zh-CN.md)，查询核对最近状态与确认的进程轮次；真实平台物理停止取证、管理界面和至少三台真实员工电脑联调仍是 D13 待办。

## 验证

最终全量回归 137 文件 / 1383 项通过，零失败、零跳过。专项联调 6 文件 / 140 项通过；实际 PostgreSQL 多连接回归 3 文件 / 45 项通过，包含重复包争锁、旧包等待新包提交后被拒绝、排队期间撤销设备后拒绝写入。临时容器已清理。

三类类型检查通过，监控新增 TypeScript 文件及桌面检查脚本合计 10 文件 lint 无错误/警告。Electron 资源构建通过；在空白私有测试配置中以软件渲染启动真实 Electron，私有 IPC、当前 v13 账本和模拟界面通过，客户/模型网络请求为零。检查脚本原先仍要求旧 v11，已按当前账本合同改为严格检查 v13；旧来源版本的迁移验收继续由账本恢复测试负责。

前一次全量 137 文件 / 1382 项中 40 项失败：运行期间共享学习合同补入 `labelOrigin`，早先加载的严格合同拒绝新的人工标注来源字段。该轮失败报告保留；当前受影响的 10 文件 / 86 项已全部复验通过，最终全量也已通过。

桌面检查所有模式均阻断 HTTP；最终报告 `networkAttempts=0`，内置 Provider 初始化请求数也为 0。该检查使用空白私有配置及模拟界面，不能代替有凭据的真实设备验证。

最终报告：`.local/reports/runtime-monitoring-full-final.json`、`.local/reports/runtime-monitoring-contracts-final.json`、`.local/reports/postgres-concurrency/1e3ff67d-5415-443b-af0a-3c2930bad6d7/result.json`、`.local/reports/runtime-monitoring-learning-recheck.json`、`.local/reports/desktop-smoke/fd239e91-9d67-4d33-acff-2906e6efa7d2/result.json`。汇总为 `.local/reports/runtime-monitoring-stage/d3bb57ce-639a-4169-8022-95f5bb9a6c62/result.json`，具体过程见 [执行记录](superpowers/plans/2026-10-07-runtime-monitoring.md)。历史失败保存于 `.local/reports/runtime-monitoring-full.json` 和 `.local/reports/desktop-smoke/51ddf3f4-9e69-4fa2-92ca-c66159ba102f/result.json`。

19 个监控实现、接入和测试文件在最终回归前后摘要一致。共享工作区其他界面/测试脚本有更新，最新界面已重新类型检查、构建和隔离启动；工作区未冻结。本次未重新打包、安装、提交或独立复核。

本轮未操作真实微信、企业微信或调用真实模型；完整目标继续进行。
