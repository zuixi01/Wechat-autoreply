# 管理员命令

> 本地历史证据路径仅标识原验证记录；相关报告、截图或安装包未随仓库发布，无法通过 GitHub 访问，也不证明当前提交已重新通过检查。

恢复开单与读取命令已加入迁移 019：open-restore-review、restore-reviews、restore-review、restore-review-permits。它们暂停账号并保存恢复来源及全部既有许可，不解除恢复阻断、不证明员工设备已实际停止，也不改写未知发送记录。完整步骤和剩余恢复协议见 [账本恢复说明](../../docs/ledger-recovery.zh-CN.md)。

这是当前中央服务的直接操作入口。它使用单独的管理员数据库登录，适用于服务运维人员；后续仍须完成服务端认证的管理 HTTP 接口及现有 React 应用内的管理员页面，不能把数据库凭据发给员工。

运行监控与目的绑定暂停需要补齐迁移至 032。`request-pause --tenant --account [--request UUID]` 发起并返回不可变请求摘要，`pause-request` 读取该请求；`runtime-status --tenant [--account] [--limit 1–100] [--after nextCursor]` 分页查询各设备当前确认状态。详细操作及停止声明的边界见 [账号暂停与停止确认](../../docs/account-pause.zh-CN.md)。

企业全员暂停须补齐迁移 033。`request-pause-all --tenant [--request UUID]` 一次暂停取样时的全部账号，`pause-all-request --tenant --request UUID` 查询批次，`pause-all-accounts --tenant --request UUID [--limit 1–100] [--after nextCursor]` 查看完整冻结清单。原 ID 重试不覆盖后来新增、恢复或单独暂停的账号，历史确认不等于当前物理停机。操作见 [全员暂停](../../docs/bulk-pause.zh-CN.md)。

## 部署前提

1. 独立迁移角色依次执行迁移 001 至 012。迁移及两个设备认证函数、管理员认证函数的拥有者使用有 BYPASSRLS 的独立凭据角色，普通服务和管理员登录都不能使用该身份。升级后旧自动发布如果没有有效评测批准，加载和执行会被拒绝；迁移不会自动补造批准记录。迁移 006 增加独立人工确认及许可用途，旧许可保留自动用途；管理员只能读取人工确认，不能改写确认或未知执行结果。迁移 007 增加只能追加的核对单/证据备注；迁移 008 让服务读取核对快照并追加不可改写的设备报告，备注仍不向服务开放，管理员只能读取设备报告。迁移 009 增加独立不可变结案决定和设备应用确认；管理员只能调用已认证且限定参数的结案函数，不能直接写决定表。迁移 010 增加永久许可请求封存、设备应用确认与数据库签发拦截；管理员只读，未应用的封存阻止恢复。迁移 012 增加跨实例逻辑生成准入及任务截止时间保护，特权计数触发器仍由独立 BYPASSRLS 凭据角色拥有，管理员不能直接调用或改其限额。所有迁移均不授予管理员修改许可结果的权限。
2. 迁移运维人员按 [bootstrap.example.sql](bootstrap.example.sql) 建立企业、启用的管理员员工和数据库登录映射；替换示例 ID，并通过秘密管理工具配置登录认证。管理员登录继承 `autoreply_admin`，普通 HTTP 服务登录只使用 `autoreply_app`。
3. 配置 `ADMIN_DATABASE_URL`。命令不回退到 `DATABASE_URL`。普通 HTTP 服务启动时也拒绝属于 `autoreply_admin` 的登录；普通服务及管理员登录都不能是可切换到 superuser/BYPASSRLS 角色的成员。
4. 发布、恢复、冻结评测或批准评测时，设置与服务进程一致的 `TEXT_MODEL_BASE_URL`、`TEXT_MODEL_ID`、`TEXT_MODEL_EXPECTED_ID`；这些管理操作不需要 Jev 或文本模型密钥，也不会调用模型。
5. 使用新的 Jev A/B/C 回放、独立标签审核和中央校准时，在既有迁移之上依次应用 045–049。迁移 048 的独立审核登录仅加入 `autoreply_jev_reviewer`，使用 `REVIEW_DATABASE_URL`；配置见下文，不能复用管理员、设备或学习 worker 的数据库身份。迁移 049 将候选集合与目标事先登记为 run 的不可改写记录；拟校准的实验须在任一回放开始前运行 `eval:jev declare`，操作见 [Jev 校准说明](../../evals/jev/README.md#从中央封存结果校准阈值)。

管理员作用域来自数据库会话登录与启用的管理员映射；`--tenant` 只选择该登录已授权的企业。认证函数在特权函数内使用 `session_user`，而不是会被函数拥有者替代的 `current_user`；相关语义见 [PostgreSQL 角色函数说明](https://www.postgresql.org/docs/17/functions-info.html)。RLS 对管理员增加登录映射限制，修改 `app.tenant_id` 不能取得其他企业的记录。绑定停用、管理员员工停用或角色变为普通员工后，后续操作被拒绝。

## 执行

标准终端从仓库根目录执行。npm 的 `--` 必须原样转发；本机 PowerShell 包装器会消耗部分分隔参数，直接调用已固定的 Node 最可靠：

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts --help
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts accounts --tenant your-company
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts provision --tenant your-company --account employee-1-wework --employee employee-1 --platform wework
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts enroll --tenant your-company --account employee-1-wework
```

已安装对应 Node 的标准 npm 终端也可使用 `npm run admin -- <command> <options>`。命令不会自动读取 `.env`，变量由运维环境注入。

`enroll` 会明确将一次性登记码返回给管理员的标准输出，供员工登记使用；这一输出含凭据，不应进入公共日志。数据库和审计只保存代码哈希及登记事件，不保存原码。登记码 10 分钟有效、只能用一次；命令返回失败或输出丢失后需检查管理记录，不能当成没有写入而无限重试。

| 命令                         | 参数                                       | 行为                                                                                          |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `accounts`                   | `--tenant`                                 | 查询最多 200 个账号的员工、平台、中央暂停、发布版本、租约和未知记录数量；不返回密钥或聊天文本 |
| `provision`                  | `--tenant --account --employee --platform` | 创建普通员工和默认暂停的账号；重复执行不改变员工、平台、暂停或绑定                            |
| `enroll`                     | `--tenant --account`                       | 给启用的员工账号发一个登记码                                                                  |
| `publish`                    | `--tenant --account --file`                | 从最多 1 MiB 的完整 JSON 文件发布不可变版本；配置、发布正文和审计同事务提交，不自动解除暂停   |
| `pause`                      | `--tenant --account`                       | 关闭中央新执行权和许可准入；保留在途许可及结果                                                |
| `resume`                     | `--tenant --account`                       | 检查有效发布、生成器指纹、员工状态和未结执行后解除中央暂停；员工电脑仍须显式启动              |
| `revoke`                     | `--tenant --account --agent`               | 撤销目标设备凭据，暂停账号，令该设备现有租约到期；保留租约版本和全部执行记录                  |
| `unresolved`                 | `--tenant --account`                       | 查询最多 200 项已签发或未知许可的元数据，不包含回复正文和凭据；不修改发送状态                 |
| `open-reconciliation`        | `--tenant --account --permit`              | 为已有已签发/未知许可开不可变核对单，同事务暂停新准入并保存审计；重复开单返回原快照           |
| `reconciliations`            | `--tenant --account`                       | 查询最近最多 200 个核对单的哈希、创建人、当前许可状态及备注数量                               |
| `reconciliation`             | `--tenant --account --case`                | 查询一份核对快照与最多 100 条证据备注；case 必须为 UUID                                       |
| `record-reconciliation-note` | `--tenant --account --case --file`         | 读取最多 8 KiB 的严格 JSON 元数据，追加证据编号/哈希/观察时间及审计；不结算许可               |
| `generator-version`          | 无                                         | 离线输出当前文本生成配置指纹，不连接数据库或模型                                              |
| `freeze-evaluation`          | `--tenant --account --file`                | 冻结目标自动发布全文、样本分组和预算，返回 runId、快照哈希与数据库时间；不激活配置            |
| `approve-evaluation`         | `--tenant --account --run --file`          | 读取最多 8 MiB 的原始标签与测量记录，重算指标，通过后写入不可变批准及审计；不启动账号         |
| `evaluations`                | `--tenant --account`                       | 查询最多 200 项冻结记录、批准人、标注人、哈希与撤销时间，不返回客户原文                       |
| `revoke-evaluation`          | `--tenant --account --approval`            | 撤销批准并暂停账号；不清空已经签发或未知的执行许可                                            |

未知选项、重复参数、无关参数、缺参数和把凭据放入参数均被拒绝。失败返回非零退出码及通用 JSON 错误，不返回原始数据库错误或文件内容。

## 发布步骤

复制 [publication.example.json](publication.example.json) 到本地私有目录，填入实际 Jev 请求和已验证的返回模型。运行 `generator-version`，将其指纹填入 `textGeneratorVersion`；与服务进程的 endpoint、请求模型、实际模型、提示词和温度一致才允许发布。

模板默认 shadow、`evaluationApproved=false`、`automaticEnabled=false`，没有业务知识。示例阈值只用于开发，不能证明业务准确度。自动发布必须持有作用域一致且未过期、未撤销的 `evaluationApprovalId`；仅改 `evaluationApproved=true` 无法启用自动回复。

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts generator-version
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts publish --tenant your-company --account employee-1-wework --file .local/admin/publication.json
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts resume --tenant your-company --account employee-1-wework
```

同一版本号必须保持完整内容、问题集哈希和生成器指纹一致；内容变更使用新版本。重新发布已保存的旧版本可切回该配置，但其知识有效期、实际问题集、生成器和评测批准仍须有效。版本回退演练仍未完成。

## 自动发布的评测准入

新 `jev-abc-v1` 执行协议目前禁止 `approve-evaluation` 批准，返回 `central_replay_evidence_required`；正确计划哈希、手填业务指标及费用声明不能替代中央执行证据。调用账本、完整草稿封存、首个盲评包封存和独立数据库审核身份已实现，操作见 [Jev 执行说明](../../evals/jev/README.md)。真实账单、完整校准/留出证据及最新审核修订尚未接入最终准入，该协议的生产批准继续关闭。下方手工提交流程适用于历史非 replay 计划，不能作为新执行器已验收的证明。

先在校准集确定策略，再冻结尚未运行留出集的目标自动发布。目标文件采用完整 `PublicationSchema`，设置 enforced、`evaluationApproved=true`、`automaticEnabled=true`，此时不填写批准 ID，也不能直接发布。冻结文件为 `{ "publication": <目标发布>, "plan": <计划> }`；计划采用 [严格合同](../src/admin/evaluation-admission.ts)：

```json
{
  "datasetId": "business-eval-001",
  "assignments": [
    { "caseId": "cal-001", "conversationGroup": "conversation-001", "split": "calibration" },
    { "caseId": "hold-001", "conversationGroup": "conversation-101", "split": "holdout" }
  ],
  "currency": "CNY",
  "maximumTurnCostMicros": 10000,
  "maximumP95LatencyMs": 10000
}
```

上例只展示字段，必须替换并补足至少 100 条校准、200 条留出、30 个独立留出会话。费用使用币种的百万分之一为单位，上例 10000 表示 0.01 CNY；这是假设的格式示例，实际预算由业务方确定。完整会话不能跨两组。冻结记录和批准最多有效 30 天，批准有效期不延长冻结记录期限。

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts freeze-evaluation --tenant your-company --account employee-1-wework --file .local/evals/freeze.json
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts approve-evaluation --tenant your-company --account employee-1-wework --run REPLACE_WITH_RUN_ID --file .local/evals/submission.json
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts evaluations --tenant your-company --account employee-1-wework
```

提交文件为 `{ "dataKind": "business", "currency": "CNY", "dataset": <EvaluationDataset>, "measurements": [...] }`。dataset 使用 [评测合同](../../evals/jev/metrics.ts)，`experimentSnapshotHash` 使用冻结命令的 `snapshotHash`；案例 ID、完整会话和切分必须与计划完全相同，实际模型、问题集和策略版本一致。`adjudicatedBy` 必须是本企业启用员工且不同于当前批准管理员。每个案例的 A、B、C 都必须提供一个测量记录：

```json
{
  "caseId": "hold-001",
  "arm": "C",
  "executedAt": 1790810000000,
  "billedCostMicros": 5000,
  "stageLatencyMs": { "retrieval": 10, "pre": 100, "text": 200, "post": 100 }
}
```

时间是 Unix 毫秒；留出执行必须不早于服务器冻结时间，所有记录不能晚于审核时的服务器时间。费用使用实际计费记录，各阶段耗时合计不能超过原评测的端到端耗时。服务端固定以种子 534、2000 次完整会话配对重采样重算指标，拒绝上传的“通过”摘要、样本不足、未达准确度目标、缺少测量及超预算。批准后只把返回的 `evaluationApprovalId` 添加到原目标发布，再执行 publish；其他内容变化必须重新冻结和评测。

数据库保存快照、样本分组、聚合报告和原提交哈希，不保存完整原始标签提交；保留本地私有提交文件供复核。管理员会在发布、加载、生成结束、候选登记和许可签发时重新校验批准；撤销后拒绝新执行，已有许可仍保留并须核对。评测记录对普通服务只读，冻结记录不能由管理角色修改，撤销不能由该角色撤回。

数据来源、人工盲评、执行时间和费用真实性仍由受信任业务人员与运维确认。系统能校验提交的一致性，不能仅凭 `business` 字符串证明它来自真实客户；迁移角色及管理员数据库写权限同样属于受信任边界。当前全为合成协议测试，没有完成真实业务准确度评测、自动费用采集、平台收发或多人试点验收。

中央暂停成功只表示服务器已经拒绝新的申请，不等于员工设备已停止；修改命令返回 `devicePauseAcknowledged=null`。在线 Agent 在续租、配置和最终发送检查中停下，离线 Agent 依本地到期停止，已有许可仍需核对。主进程停止汇总及取证协议已实现，管理员结案及本地原子恢复已通过合成验证，真实平台取证和生产恢复仍待验收。`resume` 拒绝未结或未知执行；不会用“已过期”代替“明确未发送”。

## Jev 回放的独立审核身份

[迁移 048](../migrations/048-jev-blind-label-reviews.sql) 创建 `autoreply_jev_reviewer`（NOLOGIN、NOSUPERUSER、NOBYPASSRLS）和 `jev_reviewer_database_principals`。迁移运维人员为独立审核环境建立普通 LOGIN，并绑定已经存在、启用的本企业员工和目标账号。以下只展示身份配置；登录认证通过秘密管理工具配置，不把密码写入 SQL、文档或命令日志：

```sql
CREATE ROLE jev_business_reviewer LOGIN NOSUPERUSER NOBYPASSRLS;
GRANT autoreply_jev_reviewer TO jev_business_reviewer;
INSERT INTO autoreply.jev_reviewer_database_principals
  (login_name, tenant_id, account_id, employee_id)
VALUES ('jev_business_reviewer', 'COMPANY', 'ACCOUNT', 'INDEPENDENT_REVIEWER');
```

审核登录不能属于 `autoreply_admin`、`autoreply_app`、`autoreply_learning_worker`，也不能是 superuser/BYPASSRLS 角色的成员。实际 `session_user`、启用的账号、员工及映射共同决定身份；`app.tenant_id` 或标签里的姓名不能取得审核权限。`INDEPENDENT_REVIEWER` 不能是原执行管理员或冻结 run 的创建者。审核者无权读取私有执行、盲评映射或登录绑定表，也不能直接写、改、删审核记录；只可调用限定参数的标签提交函数。

`eval:jev` 现有九种模式：`plan`、`limit`、`execute`、`blind`、`review-submit`、`import`、`declare`、`calibrate`、`freeze-holdout`。只有 `execute` 调用模型。新校准/留出流程须依次升级至迁移 051；`freeze-holdout` 在完整原始封存和最新独立审核上重算推荐并冻结原定留出计划，使用步骤及回执边界见 [留出冻结命令](../../evals/jev/README.md#校准后冻结原定留出集)。原评测管理员负责冻结、执行、生成盲评包和导入；审核者只接收完整匿名视图、packetId、企业/账号/run 编号及评判规范。审核终端只注入 `REVIEW_DATABASE_URL`，不回退到管理员或普通服务连接，不需要文本模型配置或模型密钥。

```powershell
npm.cmd run eval:jev -- review-submit --tenant COMPANY --account ACCOUNT --run RUN_ID --packet-id PACKET_UUID --labels .local/evals/blind-labels.json --out .local/jev-review-001
```

标签格式见 [Jev 独立盲评说明](../../evals/jev/README.md#执行与独立盲评命令)；`adjudicatedBy` 必须等于该登录实际绑定的员工编号，完整匿名 reviewId 不重复且最多 6000 项。中央 SQL 自算规范内容哈希，并保存不可变标签、真实审核人/登录、原包哈希、run/execution 绑定、全局每包修订号及数据库时间。身份字符串、调用者上传的哈希和本地回执不能替代这些中央记录。

成功输出 `review-receipt.private.json`，包含 `reviewId`、`packetHash`、`labelsHash`、`reviewerId`、`revision`、`reviewedAt`。原评测管理员在配置 `ADMIN_DATABASE_URL` 与相同文本生成器指纹的终端，使用回执 ID 和同一份标签导入：

```powershell
npm.cmd run eval:jev -- import --tenant COMPANY --account ACCOUNT --run RUN_ID --packet .local/jev-blind-001/sealed-mapping.private.json --artifacts .local/jev-execution-001/artifacts.manifest.private.json --labels .local/evals/blind-labels.json --review-id REVIEW_UUID --out .local/jev-adjudication-001
```

更正标签会追加新修订，原记录保留；不同审核者共用同一包的修订序列。相同登录重复提交相同的最新标签幂等返回原回执。导入先检查原管理员、当前有效审核身份、原封包及当前最高修订；读取完整分片、核验封包并计算指标后，在创建输出目录前再次检查审核记录，旧 `reviewId` 或处理期间出现的新修订、撤权均拒绝。`status.json` 中的 `reviewReceipt.centralReviewVerified=true` 仅表示当次核验快照，不表示此后仍为最新修订；最终准入必须在账号锁内重查，当前 `jev-abc-v1` 的审批入口仍拒绝。

如果中央提交已成功而本地回执/目录写入或响应失败，数据库原记录保留。在没有后续修订的前提下，用相同审核登录、相同最新标签及新的输出目录重跑 `review-submit`，可以取回原回执；不覆盖失败目录。如果已有后续修订，重新提交旧标签会成为新更正，应先核对。映射或员工禁用、角色撤销后，历史记录不会消失，后续提交与核验会被拒绝。

已通过独立标签 PGlite SQL 12/12 和最新六模式 CLI 14/14 测试，后者使用完整 100 案例、300 臂及真实 Windows 私有文件权限，并拒绝导入中途实际提交的新审核修订。合法完整导入记录 1351 ms，中途修订拒绝记录 1491 ms；原期限保留，先前超时失败未覆盖，报告及查询优化见 [主线安排](../../docs/mainline-development.zh-CN.md)。供应商响应为模拟。分片读取每批最多 64 个文件，每批重新检查全部路径与 ACL，不缓存权限或省略内容/中央记录校验。审核身份记录不证明人确实实施了盲评或标签正确。供应商请求 ID 仅用于对账，不证明实际费用；真实账单、微信/企微收发及业务效果仍未验收，真实聊天测试继续暂缓。

PostgreSQL 16 原生独立审核 6 项与既有调用账本 4 项定向合跑，10/10 通过、零跳过、零未处理错误；运行结果（本地历史证据：`.local/reports/postgres-concurrency/37ac246c-97ef-4e52-b1de-347cbe199291/result.json`）确认容器已清理。普通 LOGIN 使用不同连接池，`pg_locks` / `pg_blocking_pids` 确认真实等待；覆盖同标签单回执、双审核者全局修订、排队提交期间映射/员工禁用，以及核验持有 `FOR SHARE` 阻止禁用直到提交。完整 300 案例冻结计划与 100 校准案例 × 3 臂保留；SQL 运维角色建立合成零调用夹具，实际执行 047 封包核验，没有真实模型、聊天或生产数据库活动。

清理前已确认测试后端为零，未使用 `FORCE` 删库；hook 改用 `vi.waitFor`，驱动异常只记录 SQLSTATE。失败报告及修复沿革见 [主线安排](../../docs/mainline-development.zh-CN.md)。角色成员资格撤销不保证已进入 SQL 的在途调用立即终止；当前回执只是核验快照，之后的撤销或新修订须在最终准入账号锁内重查，不能据此开放审批或自动发送。

本轮完整 `verify` 退出 0，Node、Web、Services 类型检查、quiet lint、101 文件 930 项单元测试及 2 文件 34 项回归测试通过；lint 元数据为 0 个 error、8188 个 warning。该命令不包含原生并发测试，两类验证分别留证，真实账单、业务效果与部署仍待验收。

## 发送结果未知时的核对准备

先用 `unresolved` 定位许可，再 `open-reconciliation` 开单。开单绑定企业/账号与原许可，保存原任务、草稿、登录轮次、设备实例、租约、用途和结算哈希；历史许可缺失字段保持 null，不补造。账号暂停、开单与审计全部提交或全部回滚。已有许可和租约不被修改，返回的 `devicePauseAcknowledged=null` 明确表示尚无设备停止证明。

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts unresolved --tenant your-company --account employee-1-wework
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts open-reconciliation --tenant your-company --account employee-1-wework --permit REPLACE_WITH_PERMIT_ID
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts reconciliation --tenant your-company --account employee-1-wework --case REPLACE_WITH_CASE_UUID
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts record-reconciliation-note --tenant your-company --account employee-1-wework --case REPLACE_WITH_CASE_UUID --file .local/admin/reconciliation-note.json
```

备注文件只接受 [严格合同](../src/admin/reconciliation.ts) 的五个字段：`noteId`（新 UUID）、`snapshotHash`（开单返回的哈希）、`referenceId`（私有证据系统编号，仅 ASCII 字母/数字/点/下划线/横线，最多 128 字符）、`evidenceHash`（原证据文件的 SHA-256 小写十六进制）及 `observedAt`（实际观察时间的 Unix 毫秒）。观察时间不能早于许可签发或晚于数据库当前时间。证据文件、客户聊天和截图留在私有证据系统，本命令不读取证据文件、不下载地址，也不能证明所填哈希对应真实发送。

每份单最多 100 条备注；同一备注 ID/内容重试仍成功，修改内容或用于另一份单被拒绝。纠正使用新 ID 追加记录并保留原记录。快照不随后续普通回执变化而覆盖，详情另列当前许可状态。读取不会自动暂停；只有开单实施中央暂停。查询最近 200 份单，已知历史单可通过 UUID 单独查询，列表完整分页仍待开发。

这一阶段用于整理核对证据，不能宣布“已发送/未发送”、解除未知阻断、启动员工端或重发。仅凭设备离线、窗口未见消息、许可到期、撤销凭据或管理员备注均不结案。缺失许可响应且无法确定服务器是否建单的记录，需使用下文请求封存流程，不能凭本节开单或备注清除。

## 验证范围

### 设备报告、管理员结案与恢复

`reconciliation` 详情现在返回独立的 `deviceReport`（没有时为 null），包含设备 ID、快照/报告哈希、停机断言、原执行绑定、观察时间和证据哈希。原开单返回的 `devicePauseAcknowledged=null` 保持其原含义：开单本身不是设备确认。报告是已认证 Agent 对受信任执行器结果的断言，不能仅凭 JSON 布尔值独立证明实际物理停止。

员工主进程通过具名 `agent-workbench:reconcile` 接收任务 ID 和当前记录版本，先停止本机观察、续租及单一 Sender，再凭原不可变许可请求读取已有核对单。中央要求账号暂停、原许可到期、账号没有活租约，且 Agent/原任务/草稿/登录轮次/租约/用途完整匹配。已缺失元数据的历史许可不补造；被撤销的设备不能提交报告。

受信任平台须实现只读 `inspectExecution`：明确未触发的持久化执行日志，或原操作对应的已核验新出站回显。没有可见消息、停止超时及不确定观察均不能报告未发送。本地拒绝原动作前已存在的回显，报告先持久化至当前 SQLite v10，再补交 HTTP；断网重试使用完全相同的报告，不重新取证、不再签发许可或调用发送。服务将报告与审计原子保存，同快照相同内容幂等，变更内容被拒绝。

单独提交设备报告时，原未知回执、消息处理水位和未知阻断全部保留。员工界面现提供核对按钮：已有许可须可信取证器或既有持久报告；许可响应丢失且本地确证尚未进入发送步骤的记录可走下文请求封存。管理员结案和本地恢复使用下述独立协议；真实平台取证仍未安装，不能据此宣布实际微信/企微恢复已验收。观察时间使用 Unix 毫秒，不得早于开单及许可到期、不得晚于数据库当前时间，部署需保证时钟同步。

集成测试在 PGlite 中重复运行迁移、执行真实 SQL、切换合成数据库会话身份，并检查角色、RLS、登记、不可变发布、故障事务回滚、暂停和撤销。CLI 子进程测试验证帮助、独立环境凭据要求及离线指纹。PGlite 是串行单连接；上文原生 PostgreSQL 专项只覆盖 Jev 调用账本与独立审核，本节恢复流程的真实多连接验收、生产登录/TLS、可部署管理员 GUI 和真实多员工电脑仍待完成。

## 审核证据后结案

先用 `reconciliation` 查看设备报告，人工核对私有证据，再追加当前管理员的备注。用于结案的备注 `observedAt` 不得早于设备报告的观察时间；同一管理员完成备注和结案。仅有备注或无有效设备报告不能结案，不能用“窗口未见消息”证明未发送。

结案文件只接受五项：`decisionId`（新 UUID）、`snapshotHash`、`reportHash`、`noteId`（已保存的核对备注 UUID）及 `outcome`（`confirmed` 或 `not_sent`）。企业、账号和核对单通过 CLI 参数确定，审核人和时间由数据库确定，不能上传角色或自动放行字段。

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts decide-reconciliation --tenant your-company --account employee-1-wework --case REPLACE_WITH_CASE_UUID --file .local/admin/reconciliation-decision.json
```

`outcome` 必须与原设备报告一致，快照、报告、备注、设备和原执行必须同属一单。账号仍须暂停、原许可过期、无活租约。决定与审计原子保存，相同 ID/内容重试返回原决定，不能修改、删除或改判。详情返回 `decision` 和 `applied_at`；历史许可及原未知结算哈希保持原值。

员工再次点击“核对发送结果”读取管理员决定。主进程在停止确认后，以同一 SQLite 事务保存决定、修改发送状态并处理原入站区间；确认未发送还会保留人工接管。两种结果都消费原消息区间，后续新消息不消费，原回复不自动重放。随后以相同决定 ID/哈希补交应用确认，服务器应用确认与审计原子提交。本地保存失败不确认；断网或确认响应丢失保持阻断，重启/同步只重试同一确认。管理员决定本身不解除阻断，直到原 Agent 应用确认后才能显式 `resume`，员工也须手动启动；无有效发布仍不能恢复。

撤销设备、缺失历史绑定、设备无法提供确切证据等情形继续阻断。旧设备永久不可用时的独立人工核验迁移及生产恢复演练仍待开发；不能通过直接编辑 SQL 清除。许可申请从未创建时的恢复见下文。

## 许可申请响应丢失：先永久封存原请求

1. 管理员显式 `pause --tenant 企业ID --account 账号ID`，等待中央旧租约到期。保持账号暂停，不通过直接 SQL 修改拦截状态。
2. 员工点击同一个“核对发送结果”按钮。请求仍只有任务 ID / 当前记录版本。主进程确认观察、续租、Sender、结算和驱动全部停止，从 SQLite 读取原请求；只有 `phase=unresolved`、没有许可/回执/物理发送标记、原任务及草稿哈希一致时，才生成未进入发送步骤的日志断言，并先持久化原取证请求。
3. 私有 `POST /v1/reconciliation/seal` 与许可签发使用同一账号锁。若服务器已有原许可，返回严格绑定且 `newlyIssued=false` 的只读原许可；本地保持 unresolved，不发送、不消费消息，进入原许可的管理员核对流程。若没有原许可，则永久保存 `execution_request_seals` 和审计。迟到自动/人工请求、改草稿/租约、换 Agent 和以后显式恢复，均不能再为该原任务签发许可；数据库触发器同时拦截直接许可 INSERT / 改任务归属。
4. **中央永久封存 + 本地原日志未进入发送步骤**两项同时成立时，这是明确的未发送结果，不是对未知物理动作的改判。主进程同一 SQLite v10 事务保存封存结果、消费仅原入站区间并保留人工接管；后续新消息不消费。此分支不伪造许可、核对单或管理员决定，也不需要打开聊天窗口来证明“没有可见消息”。日志断言来自受信任主进程，哈希和 JSON 布尔值本身不能独立证明物理事实。
5. 保存成功后向私有 `POST /v1/reconciliation/seal-applied` 补交精确封存 ID、封存/原请求哈希及执行 ID。中央应用确认与审计原子提交，外键绑定账号、原 Agent、封存哈希和执行。服务器未收到确认时不允许恢复/取租约/签发新任务；本地未收到对应确认时继续拦截。断网、丢响应及重启只补交同一个请求/确认，不重新发送、不重新取证。
6. 管理员可用下述只读命令查看封存与应用时间；`accounts` 另显示 `unapplied_request_seals`。应用完成不自动恢复账号或员工端，仍须显式 `resume`（有效发布及其他原有条件依然适用），员工手动启动。原客户由员工处理，原回复不会自动重放。

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' --import tsx server/scripts/admin.ts request-seals --tenant your-company --account employee-1-wework
```

SQL / HTTP / SQLite / 主进程 / 隔离 Electron 合成验证已通过；PGlite 为串行单连接，不能代替真实 PostgreSQL 并发签发与封存争锁演练。未知物理发送、老设备不可用、撤销、缺绑定等情况不适用此未发送恢复分支。

## 恢复暂停声明查询

恢复核对单的目标设备可通过私有 `/v1/restorations/challenge`、`/v1/restorations/report` 提交主进程暂停声明（迁移 020）。挑战绑定完整来源、目标及全部许可快照，有效期 30 秒；提交时重查设备撤销、暂停和活租约/许可。原账号继续暂停，原许可不改写，没有恢复放行。回执是历史记录收据，不是全部设备已物理停止或消息已对账的证明；旧开单元数据 `devicePauseAcknowledged` 保持 null。

```powershell
npm run admin -- restore-pause-reports --tenant COMPANY --account ACCOUNT --case CASE_UUID --limit 50
npm run admin -- restore-pause-reports --tenant COMPANY --account ACCOUNT --case CASE_UUID --after LAST_CHALLENGE_UUID --limit 50
npm run admin -- restore-pause-report --tenant COMPANY --account ACCOUNT --case CASE_UUID --challenge CHALLENGE_UUID
```

只使用独立 ADMIN_DATABASE_URL；参数、UUID、分页及重复选项严格校验，摘要列表不含完整报告，详情返回原声明及绑定元数据。查询重算全部许可快照并验证原 nonce/报告/来源摘要与身份、时间，错绑或损坏拒绝。禁用管理员及跨企业/账号/单拒绝；设备后来撤销后仍可读取历史，不能据此取得新设备权限。列表按 UUID 游标分页，每页是当前读取时点；期间追加报告时应重新核对。查询不结案、不放行。员工入口与完整恢复决定/应用/确认继续待接入，见 [恢复协议说明](../../docs/ledger-recovery.zh-CN.md)。

## 恢复许可差异核对

独立管理员可比较恢复开单时的全部许可快照与当前许可。该命令在管理员鉴权和账号锁内读取，返回完整统计、身份变化、状态变化、过期未结算及缺失元数据，不读取聊天正文，不改写执行结果。

```powershell
npm run admin -- restore-permit-audit --tenant COMPANY --account ACCOUNT --case CASE_UUID --limit 50
npm run admin -- restore-permit-audit --tenant COMPANY --account ACCOUNT --case CASE_UUID --after LAST_PERMIT_ID --limit 50 --basis PREVIOUS_BASIS_SHA256
```

下一页携带上一页的 `basisHash`；期间许可结算、身份或到期状态变化会返回 `RESTORE_REVIEW_CONFLICT`，应重新核对。统计及摘要覆盖所有记录，包含未返回的页面；分页使用数据库排序，等价时区不制造变化，微秒变化仍可识别。

`settlementRecorded` 只表示中央保存过结算，`outcomeReviewRequired` 只描述中央元数据。历史未知许可仍保持原状态，独立核对单的决定及应用确认须另查 `reconciliation`；本命令不验证那些决定。许可过期不能证明未发送。所有结果均为 `canRelease=false`、`localWatermarksRequired=true`，仍需核对恢复前后本地消息和执行记录，不能凭零未结算计数恢复账号。

## 模型调用记录和每日请求额度

迁移 011 建立 `model_call_limits`、只追加的 `model_call_attempts` / `model_call_results`，并提供受底层 RLS 约束的 `decision_runs` / `draft_reviews` 只读视图。生产服务的 Jev 与文本 HTTP 客户端统一使用任务上下文记录器；前置、文本、后置以及每次 HTTP 重试分别预占一次额度。管理员用独立凭据配置，设备及普通 API 角色不能修改额度、历史尝试或结果。

额度文件最大 1 KiB，只允许整数 `dailyAttemptLimit`（0–100000）。例如文件内容 `{"dailyAttemptLimit":3000}` 是运维示例，不是容量承诺；实际额度由部署方决定。零表示禁止新模型请求，尚未配置也不发模型请求，两者均明确交人工。设置同一值幂等，改变值增加修订号并与审计同事务提交，不清零当日记录，也不会启动或恢复员工设备。

```powershell
npm run admin -- set-model-limits --tenant COMPANY --account ACCOUNT --file C:\private\model-limits.json
npm run admin -- model-limits --tenant COMPANY --account ACCOUNT
npm run admin -- model-runs --tenant COMPANY --account ACCOUNT --task TASK
npm run admin -- model-usage --tenant COMPANY --account ACCOUNT --date 2026-10-02
```

计数日固定为数据库时钟的 UTC 日期。账号锁内预占，数据库触发器再次检查当天数量；不同服务实例共用同一数据库记录。重试、失败、超时、取消、未实际发出的已提交预占和进程崩溃都不退还额度。服务仅允许原账号、Agent、运行任务、有效登录租约和当前发布版本继续申请新调用。响应持久化失败不放行候选；停用/撤销后的原服务句柄仍可保存该已开始调用的元数据，不获得新调用、发送或设备权限。

`model-runs` 最多 100 条，含任务/版本/问题集/请求哈希、阶段、尝试编号、请求和实际模型、单次结果及用量。保存经请求合同验证的 Jev 答案，不保存聊天正文、文本草稿、完整状态、Authorization 或供应商错误正文。`draft_reviews` 只读既有最终审核对象，不能替代执行许可或评测批准。

`model-usage` 按供应商/阶段统计预占、未完成、未知用量、结构有效响应、已知 token 和完成调用 p50/p95。token 总数使用精确十进制字符串；这些是供应商响应中观察到的数字，尚未核对实际账单。`schema_valid_responses` 不代表策略通过、业务事实正确或自动发送。耗时是单次 HTTP 响应读取耗时，包含失败和取消的已完成记录，不是整个客户回复时延。缺用量、超时、异常和未完成请求不按零计费；已知 token 总数必须连同未知数量查看。

这是一项跨实例共享的**请求次数额度**，不是货币预算、token 硬上限或全局并发许可。实际费用/价格版本、账单核对、货币预占、未知费用核验和集群并发上限仍待实现。PGlite 单连接检查不证明真实 PostgreSQL 多连接争锁。生产部署仍需真实供应商及业务效果评测，不能据此直接开放员工客户自动发送。

# 桌面管理员入口

通过独立服务接入「企业连接 → 企业管理员」。使用专用管理员数据库登录，不向员工机器分发数据库连接。部署与权限边界见 [管理员界面说明](../../docs/admin-console.zh-CN.md)。
