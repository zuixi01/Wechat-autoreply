# Jev 配对效果评测

> 本地历史证据路径仅标识原验证记录；相关报告、截图或安装包未随仓库发布，无法通过 GitHub 访问，也不证明当前提交已重新通过检查。

### 离线结算逐请求关联

`jev:settlements` 读取供应商适配器归一化后的私有声明，按逻辑供应商、声明的计费账号和区分大小写的请求编号关联全部 HTTP attempts，包括失败和重试。输入协议为 `jev-settlement-reconciliation-input-v1`，严格字段见 [输入与算法](settlement-reconciliation.ts)。须保留完整冻结计划、不同 run/快照的 100 校准与 200 留出、全部三臂原始 artifacts，以及每个请求最终净结算的一条记录；金额为同币种的整数百万分之一，不估算 token 价格、不换汇。`settled` 必须有非负安全整数金额，`pending` 必须为 null。当前没有供应商原始 CSV/API 解析或认证适配器，不能直接输入原始账单或把手填值视为真实费用。

```powershell
& .\scripts\dev-tools.ps1 @('run','jev:settlements','--','.local/evals/settlements-input.private.json','.local/settlements-001/summary.private.json')
```

输入仅允许 `.local`/`evals/private` 的真实私有普通文件，按原有权限、严格 UTF-8 和 64 MiB 上限检查；输出仅允许新的 `.local` 私有文件，沿用原 1 MiB 排他、同步写入约束。摘要包含逐切分、逐臂总额及目标 C 最大单轮费用、p95、未知次数、源行数，以及 `inputHash`、`fullReportHash`、`summaryHash`。逐案例/阶段/attempt 明细由保留的私有输入调用 `reconcileJevSettlements` 重算；摘要不包含客户文本或这些明细，请保留输入。仅命令正常结束时关闭权限解释器，导入复用的宿主不受影响。

缺请求编号、缺账单行、待结算及未确认派发均保留未知；阶段、单轮、切分和全部费用不能补零，也不能从已知小计计算完整 p95。合法无模型调用的交人工记录标为 `not_started`，空账本算术和为零，不生成供应商零费用凭证。候选记录缺阶段、账本或结果矛盾拒绝。重复请求归属、重复源/原始账单行、账号或币种不匹配、整数溢出均拒绝。完整账号导出声明的无关行显式计数但不计入实验；声明为实验子集的额外行拒绝。

冻结预算比较使用留出 C 的**最大单轮费用**，不能以 p95 替代；已知小计超限也报告超支。`within_declared` 仅是声明数值的算术结果。报告固定 `dataKind=unverified`，中央证据、原始导出字节、供应商真实性、计费账号所有权、费用预算验收和发送放行均为 false。有效命令退出 **2**，包括费用已完整关联或已经超支；错误退出 1，帮助退出 0。此命令不连接数据库/模型、不验证中央封存或真实账单，不改变原 artifact 的 null 费用，也不提交批准；后续仍须接供应商可验证来源与中央最新审核，再实施最终准入。

### 中央校准与留出证据核验

`JevCalibratedHoldouts.verify({ calibration, holdout })` 是服务内部核验入口。`calibration` 使用冻结留出时的完整请求（原始校准包、三臂结果、最新审核 ID、标签、事先登记的设置及新策略/配置版本）；`holdout` 包含目标冻结的完整留出包、三臂结果、标签和最新独立审核 ID。所有输入均为私有证据，不能把它们输出到日志或普通客户端。

核验先要求已有 lineage，在同一账号事务内重新验证完整校准证据并重算推荐，再确认目标冻结、完整留出执行封存和最新独立审核，重建逐案例标签。缺少关联不会创建新冻结；源版本不能替代目标版本，缺少结果、改标签或旧审核均拒绝。返回的 `evidenceHash` 仅用于关联本次核验，不能作为发送许可。

校准与留出仍各自保留实际快照，不能把旧策略的 100 条校准观察改写成新策略结果并拼成单快照数据集。`centralEvidenceVerified=true` 表示中央记录通过核验，不证明业务声明、人工标签或供应商响应真实。缺少真实结算时费用保持 null，`monetaryBudgetVerified=false`、`releaseAuthorized=false`，没有批准提交；当前新协议生产准入继续关闭。

公开入口 `eval:jev verify-holdout` 读取下面结构的私有文件。所有路径按命令当前工作目录解析；`artifacts` 可为原完整聚合文件或完整私有分片清单，每片仍检查权限、字节、哈希和范围。两份审核 ID 使用各自最新独立审核回执，策略/配置版本使用冻结目标时的原值，不能另起版本。

```json
{
  "calibration": {
    "packet": ".local/calibration/sealed-mapping.private.json",
    "artifacts": ".local/calibration/artifacts.manifest.private.json",
    "labels": ".local/calibration/labels.private.json",
    "settings": ".local/calibration/settings.private.json",
    "reviewId": "11111111-1111-4111-8111-111111111111",
    "policyVersion": "holdout-policy-v2",
    "configVersion": "holdout-config-v2"
  },
  "holdout": {
    "packet": ".local/holdout/sealed-mapping.private.json",
    "artifacts": ".local/holdout/artifacts.manifest.private.json",
    "labels": ".local/holdout/labels.private.json",
    "reviewId": "22222222-2222-4222-8222-222222222222"
  }
}
```

将示例占位值替换为真实回执和文件，保存为受保护的 `.local/holdout/verify-request.private.json`，使用专用 `ADMIN_DATABASE_URL` 与原 `TEXT_MODEL_BASE_URL/ID/EXPECTED_ID` 配置执行：

```powershell
& .\scripts\dev-tools.ps1 @('run','eval:jev','--','verify-holdout','--tenant','TENANT','--account','ACCOUNT','--run','SOURCE_RUN','--request','.local/holdout/verify-request.private.json','--out','.local/holdout/verified-001')
```

核验全部成功后才创建新的私有输出目录，保存 `verified-evidence.private.json`、用量完整时的 `statistical-report.private.json` 和 `status.json`。有效核验退出 **2**，表示真实结算和业务准入仍待完成；输入/运行失败退出 1，帮助退出 0。没有真实模型请求，也不会解除账号暂停；输出目录已存在或证据被修订时不能覆盖原文件。

若实际响应缺少用量，完整调用和独立标签仍可核验；状态为 `usage_incomplete`，用量未知的结果保留 null，数据集和统计为 null，不产生独立统计文件或补成零费用。成功核验仍退出 2。独立命令在全部权限检查、写入及数据库关闭后结束权限解释器；导入复用命令的宿主不会因此关闭共享解释器。

统计协议 `jev-calibrated-holdout-metrics-v1` 分别列出校准的快照、策略、审核者和实际样本数，以及留出的真实快照与统计结果。至少 100 个校准案例/30 个校准会话、200 个留出案例/30 个留出会话；跨快照 case ID 或会话重叠拒绝，模型、问题集和数据集必须一致。校准观察只证明样本资格，不参与目标误放率、覆盖、时延、token 或置信区间。默认保留 2000 次完整会话配对重采样，原改善/覆盖/严重错误及证据不足门槛不变。校准或留出缺失用量则不补造统计报告；零基线错误仍为证据不足，不能把“全部回答正确”的合成夹具当作精准度提升证明。独立调用纯统计函数只计算输入数据，不能认证中央 lineage 或取得发送权。

单独统计报告保留 `dataKind`：纯统计函数为 `unverified`，中央核验后继承封存声明，两边任一为合成即标为 `synthetic`；`business` 仅表示声明来源，不证明真实业务内容或人工标签正确。`businessTruthVerified` 始终为 false，统计观察达标也不代表业务真实性或自动发送获得批准。会话隔离验证冻结的分组标识，不能独立证明人员已正确归并现实中的同一会话。

### 将结算声明关联到中央最新证据

`eval:jev correlate-settlements` 使用上面的原始 `verify-request.private.json`，另读取仅含账单声明的私有文件。`--tenant`、`--account`、`--run` 必须是原校准冻结的企业、账号和源 run；目标 run、两个不同快照、完整冻结计划及两边三臂 artifacts 由已核验的中央证据推导，不能由账单文件替换。配置专用 `ADMIN_DATABASE_URL` 与原文本生成器指纹后，从项目根目录执行：

```powershell
& .\scripts\dev-tools.ps1 @('run','eval:jev','--','correlate-settlements','--tenant','TENANT','--account','ACCOUNT','--run','SOURCE_RUN','--request','.local/holdout/verify-request.private.json','--settlements','.local/evals/settlement-claims.private.json','--out','.local/holdout/correlated-001')
```

`--settlements` 的严格 schema 是 [JevSettlementClaimsSchema](settlement-reconciliation.ts)，顶层只能含 `declaredBillingAccounts` 和 `exports`；未知字段或试图加入 `scope`、`plan`、`artifacts`、校准/留出快照、聚合报告均拒绝。归一化声明的完整字段如下：

| 对象                      | 必填字段与约束                                                                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `declaredBillingAccounts` | 仅含 `jev`、`text` 两个计费账号 ID，均为非空且最多 128 字符的标识。它们是声明，不是账号所有权认证。                                                                                                                                                                                               |
| `exports[]`               | `sourceId`、`provider`（`jev` 或 `text`）、`billingAccountId`、`currency`（`CNY` 或 `USD`）、`rawExportSha256`（64 位小写十六进制）、`scope`（`provider_account_export` 或 `experiment_subset`）、`rows`。账号须与对应声明一致，币种须与原冻结计划一致。最多 100 个来源，每个来源最多 200000 行。 |
| `rows[]`，已结算          | 仅含 `requestId`、`status: "settled"`、`settledCostMicros`、`lineRef`。金额为非负安全整数，单位是原币种的百万分之一，代表该请求最终净结算；请求号须为原响应实际记录的精确值。                                                                                                                     |
| `rows[]`，待结算          | 仅含 `requestId`、`status: "pending"`、`settledCostMicros: null`、`lineRef`。不能以零金额替代待结算。                                                                                                                                                                                             |

`sourceId`、`billingAccountId`、`lineRef` 使用上述标识约束；请求号使用供应商请求 ID 的严格格式并区分大小写。全部开始过的 attempts 都参与关联，包含失败和重试；重复请求归属、重复原始账单行、账号/币种矛盾或金额溢出拒绝。整账号导出的无关行显式计数；实验子集的多余行拒绝。缺行、缺请求号、待结算或未确认派发保持未知，不能通过 token 估价或补零。

所有输入和引用文件只允许受保护的 `.local` 或 `evals/private` 路径，须通过真实文件、权限、严格 UTF-8 和大小检查；账单声明最多 64 MiB。输出须为新的 `.local` 私有目录，不覆盖已有目录。关联成功后保存完整的 `correlated-evidence.private.json` 和摘要 `status.json`，不把客户内容、请求号、账单行或错误原文输出到日志。完整输出协议为 `jev-central-settlement-correlation-v1`，包含 `verifiedEvidence`、逐案例/阶段/attempt 的 `settlementReport` 及覆盖整个结果正文的 `correlationHash`；摘要模式为 `central_settlement_correlation_pending_authentication`，包含证据/关联哈希、结算状态、声明预算状态和统计状态。

服务入口 `JevCalibratedHoldouts.correlateSettlements({ evidence, settlements })` 在任何等待前复制并严格解析整个请求，在同一个真实数据库连接与账号锁事务内复用原 `verify`，核验完整封存、源/目标冻结及最新独立审核，再关联声明并计算哈希。审核者已禁用、审核已修订、跨账号或证据不完整时拒绝，不能用旧的核验文件跳过本次中央检查。外层 `centralEvidenceVerified=true` 只表示本次中央证据通过；纯 `settlementReport.centralEvidenceVerified=false`、`dataKind=unverified`，单独算术报告不认证中央来源。外层 `dataKind` 继承封存声明，任一合成即为 `synthetic`。

完整关联可以产生 `declaredSettledCostMicros` 和目标 C 最大单轮费用/p95；这些仍只是声明金额。原始导出内容、供应商来源、计费账号所有权均未认证，`rawExportContentVerified`、`supplierAuthenticityVerified`、`providerBillingAccountVerified`、`monetaryBudgetVerified`、`businessTruthVerified`、`releaseAuthorized` 均为 false。未知账单费用仍为 null；实际响应缺用量时，即使声明费用完整，原数据集和统计仍为 null，不改写原 artifact 的费用，也不生成批准或发送许可。有效命令始终退出 **2**，包含完整、未知或超支声明；错误退出 1，帮助退出 0。此模式不调用模型或聊天客户端，真实微信/企微与付费供应商试验继续暂缓；供应商认证、真实业务验收和生产准入仍待完成。

### 校准文件入口

`jev:calibrate` 使用与回放相同的私有输入检查：输入须为 `.local` 或 `evals/private` 内真实普通文件，通过当前操作系统权限校验，最多 16 MiB，并按严格 UTF-8 解码。输出只允许新的 `.local` 文件；先保护目标目录，再排他创建、同步落盘，报告最多 1 MiB。输入或输出目录链接、公开可读输入、超限和无效编码会被拒绝，已有报告不会覆盖。固定工具链用法：

```powershell
& .\scripts\dev-tools.ps1 @('run','jev:calibrate','--','.local/evals/calibration-input.json','.local/calibration-report-001/report.json')
```

此入口仍是离线阈值比较，不连接供应商、不写发布策略。输入中的业务类型及人工标签不是中央来源证明；独立审核、完整原始执行、真实账单、未用于选阈值的留出集和最终准入仍须另外核验，不能用该报告放行自动发送。

## 真实 A/B/C 回放的当前实现状态

`jev:evaluate` 仍只计算已经人工标注的配对结果，`jev:calibrate` 只筛选离线文件中的阈值。`eval:jev` 已提供 `plan`、`limit`、`execute`、`blind`、`review-submit`、`import`、`declare`、`calibrate`、`freeze-holdout`、`verify-holdout`、`correlate-settlements` 十一种模式。`execute` 才会调用供应商；其余模式不会调用模型。独立数据库审核身份与标签修订已实现，真实业务样本、供应商账单与实际人工盲评尚未验收，不能将工作记忆实验的 none/baseline/learned 三组称为 Jev A/B/C。

配置独立 `ADMIN_DATABASE_URL` 和 `TEXT_MODEL_BASE_URL`、`TEXT_MODEL_ID`、`TEXT_MODEL_EXPECTED_ID` 后，可运行：

```powershell
npm.cmd run eval:jev -- plan --tenant TENANT --account ACCOUNT --run RUN_ID --input .local/evals/holdout.json --out .local/replay-plan-001/summary.json
```

固定本机工具链的帮助入口已实际运行：`& .\scripts\dev-tools.ps1 @('run','eval:jev','--','--help')`。使用数组传入脚本参数中的 `--`，避免 PowerShell 将分隔符吃掉。`plan` 须连接真实管理员数据库读取冻结记录，不接受文件自声明冻结。输入须位于私有 `.local` 或 `evals/private`、通过权限校验且不超过 16 MiB；输出为新的受保护文件，不覆盖已有报告。预检报告固定 `candidateExecutionImplemented=true`、`modelsCalled=false`、`releaseAuthorized=false`、`monetaryBudgetVerified=false`；第一个字段仅表示执行代码已存在，不证明供应商连通或业务准确度。

已新增 `Administration.readFrozenEvaluation(tenantId, accountId, runId)`：通过独立管理员数据库身份读取未过期、账号仍启用的原始 `evaluation_runs`，返回完整发布、计划和服务器时间，校验实际生成器版本与发布快照。读取不调用模型、不写生成候选、许可、租约或审批记录。

后续真实回放使用的新计划须同时声明 `replayProtocol: "jev-abc-v1"` 及每条 assignment 的 `inputHash`。哈希用 [replayCaseInputHash](replay-input.ts) 对严格解析后的完整案例计算，涵盖 caseId、完整会话分组、切分、脱敏客户编号、待处理消息及可选历史上下文。标签、期望答案和人工对错判定不属于模型输入，未知字段会被拒绝。旧冻结计划不能自行补字段变成可执行的新计划，需要重新冻结。

`validateFrozenReplayInputs` 只接受调用方从上述管理员方法取得的权威记录，并检查完整的单个校准/留出切分、逐案例内容哈希、客户及组归属、快照、有效期和文本生成器版本。输出摘要没有客户原文，只给案例数与逻辑模型调用上界（A 1次、B 2次、C 3次）；该上界不包含 HTTP 重试，也不代表费用预算或模型已经执行。自填文件不能证明数据库冻结存在。

新计划的提交结构须携带 `executionPlanHash=hashContext(plan)`；数据库审批入口对 `jev-abc-v1` 目前明确返回 `central_replay_evidence_required`。计划哈希、手填业务指标或零费用声明均不足以批准。独立标签登录与中央回执已实现；实际账单、完整校准/留出证据及最新审核修订尚未接入最终准入，生产批准继续关闭。历史手工标注提交保持原有流程；不能把它当成已经由新执行器完成。供应商费用证据、真实业务评测及实际部署仍待验收。

### 执行与独立盲评命令

已有中央服务须依次升级 [045 调用账本](../../server/migrations/045-jev-replay-journal.sql)、[046 草稿结果封存](../../server/migrations/046-jev-replay-artifact-seals.sql)、[047 盲评包封存](../../server/migrations/047-jev-blind-packet-seals.sql)、[048 独立标签审核](../../server/migrations/048-jev-blind-label-reviews.sql)、[049 候选事先登记](../../server/migrations/049-jev-calibration-declarations.sql)、[050 校准到留出冻结](../../server/migrations/050-jev-calibrated-holdouts.sql)、[051 账本查询升级](../../server/migrations/051-jev-replay-scoped-lookups.sql)。评测管理员登录由现有管理员注册流程映射到本企业；独立审核登录由迁移运维人员另行配置，见 [审核身份设置](../../server/admin/README.md#jev-回放的独立审核身份)。设备和学习 worker 无权提交审核标签或创建这些评测记录。下列命令会写中央评测记录，`execute` 还需 `JEV_API_KEY`、`TEXT_MODEL_API_KEY`。本轮没有执行真实供应商请求，也未在生产数据库运行这些命令。

```powershell
npm.cmd run eval:jev -- declare --tenant TENANT --account ACCOUNT --run RUN_ID --settings .local/evals/calibration-settings.json --out .local/jev-declaration-001
npm.cmd run eval:jev -- limit --tenant TENANT --account ACCOUNT --daily-attempt-limit 1000
npm.cmd run eval:jev -- execute --tenant TENANT --account ACCOUNT --run RUN_ID --input .local/evals/calibration.json --out .local/jev-execution-001 --max-attempts 900
npm.cmd run eval:jev -- blind --tenant TENANT --account ACCOUNT --run RUN_ID --input .local/evals/calibration.json --artifacts .local/jev-execution-001/artifacts.manifest.private.json --priors .local/evals/priors.json --rubric RUBRIC_ID --kind business --out .local/jev-blind-001
```

独立审核终端只配置 `REVIEW_DATABASE_URL`，不回退到 `ADMIN_DATABASE_URL` 或 `DATABASE_URL`，不需要文本模型配置或任何模型密钥。审核者领取完整匿名视图、`packetId`、企业/账号/run 编号及评判规范，不领取私有映射包。完成标签后执行：

```powershell
npm.cmd run eval:jev -- review-submit --tenant TENANT --account ACCOUNT --run RUN_ID --packet-id PACKET_UUID --labels .local/evals/blind-labels.json --out .local/jev-review-001
```

成功写入 `review-receipt.private.json` 与 `status.json`；回执包含 `reviewId`、`packetHash`、`labelsHash`、真实 `reviewerId`、全局每包 `revision` 和数据库时间。随后由原评测管理员在配置 `ADMIN_DATABASE_URL` 及文本生成器指纹的终端导入同一份标签，`--review-id` 取审核回执中的 ID：

```powershell
npm.cmd run eval:jev -- import --tenant TENANT --account ACCOUNT --run RUN_ID --packet .local/jev-blind-001/sealed-mapping.private.json --artifacts .local/jev-execution-001/artifacts.manifest.private.json --labels .local/evals/blind-labels.json --review-id REVIEW_UUID --out .local/jev-adjudication-001
```

### 校准后冻结原定留出集

2026-10-08 新增 `freeze-holdout`。它在原账号锁事务内，重新读取完整中央冻结、候选事先登记、300 臂封存与最新独立标签，自行计算推荐；不接收手填推荐报告替代这些输入。只接受业务标记且符合已登记目标的校准推荐，要求新的策略版本和配置版本；知识、问题集、模型、自动回复意图及原 300 条分组/切分计划全部保留。

```powershell
& .\scripts\dev-tools.ps1 @('run','eval:jev','--','freeze-holdout','--tenant','TENANT','--account','ACCOUNT','--run','SOURCE_RUN','--packet','.local/jev-blind-001/sealed-mapping.private.json','--artifacts','.local/jev-execution-001/artifacts.manifest.private.json','--labels','.local/evals/blind-labels.json','--review-id','REVIEW_UUID','--settings','.local/evals/calibration-settings.json','--policy-version','NEW_POLICY_VERSION','--config-version','NEW_CONFIG_VERSION','--out','.local/jev-holdout-freeze-001')
```

输出 `holdout-receipt.private.json`、`publication.private.json`、`calibration-report.private.json` 和 `status.json`。`targetRunId` 是新留出实验编号；后续授权的 `execute` 必须使用该编号和原定完整 200 条 holdout 输入。此命令不调用模型、不发布配置，也不解除暂停或生成批准、许可、租约。

中央记录检查同账号/同数据集所有已开始执行的实际切分；原定留出案例、输入哈希或对话组已出现时拒绝新冻结，零调用的 begin 也算风险暴露。冻结后这些留出组保留给目标 run，目标只准执行 holdout。审核者被禁用或出现新标签修订时，旧目标不能启动；已经启动的目标也在每个新 assignment 和 HTTP 预留前核验同一审核与声明，拒绝新调用，但允许保存已预留调用的原始回执。尚未开始留出时，可使用最新审核和新版本重新冻结。相同内容重试返回原记录，包括目标留出已经开始的情况；改内容不覆盖旧记录。数据库已提交但输出失败时保留失败目录，用同样参数和新输出目录重试。

这些约束只描述中央同账号/数据集中的执行先后，不能证明人员未在其他来源看到样本。数据库 lineage 记录也不独立证明校准算法正确或供应商费用真实；最终准入仍须重算原始封存、验证最新审核和真实账单。新协议批准入口保持关闭，不能将这个冻结回执作为自动发送授权。

2026-10-08 已补实际并发顺序与编译命令验收。普通管理员在真实事务中先写冻结或先写原留出 execution，另一个不同 backend 实际等待同账号锁；提交后分别拒绝提前启动和提前暴露，同内容冻结并发重试只保存一个目标。原生完整协议文件 17/17，包含新增三项锁观察，报告 `.local/reports/postgres-concurrency/0c8b5399-fd84-46a4-98ce-8a3c0917c37f/`。这证明所测顺序，不能证明所有负载和所有竞态。

同一候选包 `6a601d08-4262-440b-ab62-cc1f6a421ce1` 重新在全新隔离目录/数据库中检查 53/53。新检查仅从复制包加载编译模块和锁定生产依赖，实际执行 100 条校准/300 臂/600 次模拟 HTTP，保存原始 SQL 调用及结果、封存和专用独立 LOGIN 标签，再逐个启动真实编译 `calibrate`、`freeze-holdout` 命令。合法冻结、相同重试、留出开始后重试、改版本拒绝及审核禁用拒绝均已检查；禁用后旧目标的新绑定拒绝，未生成发送或审批。全部中央记录保留账号暂停，实际 backends/子进程/容器已清理。完整 100 条臂准备各仍限 20 秒，标量准备和每个 CLI 仍限 4 秒；A/B/C 实测 7636/10780/14708 ms，不能当作业务回复时延。报告 `.local/reports/server-release/1d7e5215-8ac7-4faa-821c-7fb4c6bc1e15/result.json`。模型响应和人工标签全为模拟，尚未执行完整 200 条留出三臂，更未证明业务精度、真实结算或原员工后台私聊效果。

### 从中央封存结果校准阈值

先在冻结实验创建后、任一校准或留出执行开始前运行 `declare`。它将完整候选集合、验收目标和原冻结快照保存为每个 run 唯一的不可改写记录，由数据库计算提交的规范 JSON 字节哈希，绑定实际管理员登录、员工和账号/平台身份。只接受有有效管理员权限且不混用设备、学习、审核或特权的登录；须为原冻结创建者。登记回执写入新私有目录，不需要模型密钥。设置文件仍最多 16 MiB，规范化内容还受中央 1 MiB 上限约束。

相同内容可在执行开始后重试取得原 `declarationId` 和时间；改候选、改目标、换登录或身份都拒绝。未登记且已有任一执行的 run 不能补登记，须重新设计并冻结实验，不能把旧观察称为新实验未见结果。`calibrate` 强制核对这一记录；底层执行账本及其他回放模式仍可独立使用，若后续需要校准，必须按此顺序事先登记。中央记录只证明该 run 中的先后和内容一致性，不能证明运营人员从未在其他来源见过类似样本。

2026-10-08 新增 `calibrate`：在同一评测管理员终端，使用完整**校准切分**的原始执行清单、封存映射包和独立审核者已提交的标签。它读取实际中央冻结记录，核验全部 A/B/C 调用、结果和盲评包封存，取 C 臂的实际前置/后置观察及对应匿名人工标签计算候选阈值；不会拿 A/B 的标签替代 C 的标签。

```powershell
& .\scripts\dev-tools.ps1 @('run','eval:jev','--','calibrate','--tenant','TENANT','--account','ACCOUNT','--run','RUN_ID','--packet','.local/jev-blind-001/sealed-mapping.private.json','--artifacts','.local/jev-execution-001/artifacts.manifest.private.json','--labels','.local/evals/blind-labels.json','--review-id','REVIEW_UUID','--settings','.local/evals/calibration-settings.json','--out','.local/jev-central-calibration-001')
```

`settings` 是私有 JSON，严格包含 `candidates` 和 `targets`。`candidates` 为 1–500 个完整策略对象，以当前冻结的拟发布策略为基准，只允许变化下文列出的六个阈值。`targets` 包含 `maximumErrorReleaseRate`（0–1）、`minimumAutomaticCoverage`（大于 0 且不超过 1）、`minimumAutomaticReplies`（30–2000 的整数）；由业务验收目标设定，不在示例中预填放宽值。包最多 64 MiB，标签和设置分别最多 16 MiB，执行分片继续按原清单逐项验证私有权限、字节和哈希，输出目录必须全新。

人工请求从冻结的客户原消息按生产管线同一规则判断，要求实际零调用、无草稿和复审；完整案例、独立先验标注和原始策略保留，缺失非人工模型响应不能隐藏成未通过前提。留出切分直接拒绝。完整计算后、创建输出目录前再核验审核者资格和最新修订；中途有新审核会拒绝输出。此回执是当时的核验快照，最终准入仍须重新检查。

输出 `adjudication.private.json`、`calibration-report.private.json` 和 `status.json`；仅用量完整时另有 `labelled.private.json`。状态保存中央/审核/候选登记回执、输入和设置哈希，核验成功时 `candidatePredeclarationVerified=true`，而 `monetaryBudgetVerified=false`、`holdoutRequired=true`、`releaseAuthorized=false`。完整计算后再次核对登记内容与当前冻结。未知用量和费用保持 null，不补零。只有报告状态为 `recommended_for_frozen_holdout` 才退出 0，其他有效计算退出 2，均不产生批准或发送权限。推荐策略须按下文重新冻结，完成未参与校准的留出对照、独立盲评和真实结算证据；新协议最终批准入口继续关闭。

最新六文件 142/142、真实 PostgreSQL 并发 8/8、新发布包隔离 52/52 通过。并发检查保留完整计划 300 案例与 200 条留出执行输入，实际不同后台连接等待账号锁；登记先提交和执行先提交两种顺序均已检查。发布包直接运行编译后的登记命令，实际普通 PostgreSQL 登录、相同内容重试、改目标及晚登记拒绝和输出不存在均已验证。首次主线漏导入及锁观察器查询不匹配的失败记录保留，期限未放宽。完整编译 `calibrate` 与留出准入仍待联调；真实业务准确度、费用和聊天未测试。历史管理员帮助四秒超时仍未解释，详见 [主线记录](../../docs/mainline-development.zh-CN.md)。

示例限额只是配置写法，须按本企业授权预算设置；它们限制真实 HTTP 次数，不是硬 token 或费用上限。每日次数按数据库 UTC 日期计算，同账号所有 Jev 评测 runs 共用；与生产和学习预算独立。改变限额不清历史次数。每个 Jev 阶段最多两次尝试，文本阶段最多一次，失败重试也先落库占额。`execute` 即使全部草稿生成成功仍退出 2：费用与独立业务审核未通过，不授予发送权限。

执行先绑定完整冻结切分，逐臂保存私有文件，全部完成才生成 `artifacts.manifest.private.json`，列出完整 assignment 文件及其哈希、冻结输入和运行范围。小于等于 64 MiB 时另存兼容的 `artifacts.private.json`；较大的完整结果直接使用清单，不降低冻结样本数。`status.json` 的 `artifactInput` 指定下一步输入，`aggregateAvailable` 表示是否另有聚合文件。回读清单逐片执行相同的路径、权限、大小与内容校验，再通过中央封存复核来源。新暂停请求、账号/员工禁用、身份/冻结变化阻断后续调用；允许在初始暂停的账号上独立评测，不解除暂停。已预留但无结果的调用保持 null/unknown；相同 run/split/case/arm 不自动换编号再付费执行。首版没有付费恢复命令，失败后先核查原始中央记录与私有文件，不能把成功调用记录当作已保存草稿重新生成。

`blind` 输出随机排序的 `reviewer-view.private.json` 和独立的 `sealed-mapping.private.json`。视图超过 64 MiB 时保存 `reviewer-view.manifest.private.json` 与有序分页文件，保留全部匿名 reviewId，每页不超过同一字节上限；`status.json` 的 `reviewerInput`、`reviewerFormat` 指定完整视图入口。只向审核者提供视图（分页时含清单及全部页面）及授权的业务参考、评判规范；映射、臂身份、模型自评分和拟放行结果不进入盲评视图。`priors.json` 为 `{annotatedBy,cases:[{caseId,category,eligible,expectedHandoff,intentCount}]}`，须来自独立业务先验标注；每个案例正好一项。`blind-labels.json` 为 `{adjudicatedBy,annotationSource:"blinded_business_adjudication",labels:[{reviewId,substantialCorrection,severeFactError,unauthorizedPromise,incorrectlyBlocked,coveredIntents}]}`，每个匿名 reviewId 正好一项，最多 6000 项且不能重复。`adjudicatedBy` 必须等于实际审核登录映射的启用员工编号，不能自行填写其他人身份。有草稿时修改标记是布尔值，无草稿时是 null；严重错误/越权必须要求实质修改。

可信 `execute` 流程在每臂完成时核对完整 SQL attempts、实际 pre/post 答案、文本哈希及**有序**证据引用，再封存完整 artifact 哈希，覆盖拟放行、原因、耗时和用量；封存后不能追加调用。`blind/import` 均要求完整切分的三臂与中央原始封存一致，不接受只有本地自算哈希的结果。`blind` 先保存私有包与视图，成功封存数据库后才写 ready 状态；每个 execution 固定首个包，先验标注、评分规则、数据类型和匿名映射不能靠重算哈希替换。失败目录保留；已有封存时须使用原包，不可重新生成一个包替代。

`import` 重新读取真实数据库冻结，比较包含实际日期和账号身份的原包，验证中央封包、完整原始草稿/调用记录及标签映射。它先用原评测管理员登录核验 `--review-id`：实际审核登录仍有专用审核角色，映射及员工仍启用，标签全文与 SQL 自算哈希、原包及当前最高修订一致。读取完整分片、核验封包并计算指标后，在创建输出目录前再次核验审核记录，阻止这段处理期间出现的新修订或撤权被旧收据掩盖。其他管理员、停用/撤权的审核者、旧修订、改标签后重算本地哈希均被拒绝。`status.json` 同时保存封包回执 `centralReceipt` 和审核回执 `reviewReceipt`。

同一包的修订号由所有审核者共享。相同审核登录重复提交完全相同的最新标签，返回原回执；修改标签或由另一审核者提交则追加新修订，原记录不可改写，旧 `reviewId` 不能再导入。如果数据库已提交但本地目录创建、回执写入或进程响应失败，在没有后续修订的前提下，用同一审核登录、原始相同标签和**新的输出目录**重跑 `review-submit`，取回原回执；保留失败目录，不覆盖文件。若已有后续修订，重提旧标签会成为新的更正，应先核对当前记录。不能通过改库或伪造回执恢复。

缺失用量时 `import` 保存 `adjudication.private.json`，退出 2，不补零、不生成可计算数据集；用量完整时另外保存 `labelled.private.json`，退出 0 仅表示导入成功，费用仍未知、审批仍为 null。中央身份记录证明由哪个授权数据库登录提交，不证明人确实按盲评流程审核、业务标签正确或先验在指定时间收集。`centralReviewVerified=true` 仅描述本次核验，后续最终审批须在同一账号锁内重查最新修订；当前生产准入仍关闭。

案例/标签/先验输入最多 16 MiB，每份原始 artifact、清单和映射包最多 64 MiB，均须通过私有权限和路径校验；`execute/blind/review-submit/import` 输出为新的 `.local` 目录，不覆盖已有文件。读取按 64 KiB 分块分配内存；分片每批最多打开 64 个文件，读取前重新核验该批各文件的真实路径与 ACL，不缓存权限，不跳过逐片大小、内容哈希或中央记录核验。私有写入使用排他创建并在返回前同步文件描述符；这不等于完成断电或物理磁盘验收。相同执行已存在中央盲评包时，重复 `blind` 在创建新输出目录前拒绝；继续评审/导入应使用原包。并发创建仍由最终中央封存检查决定，预检查不授予任何权限。

独立审核 PGlite SQL 专项 12/12 通过；最新六模式 CLI 专项 14/14 通过，覆盖 PGlite 普通登录会话、SQL 权限及 Windows 私有文件权限上的完整校准切分：100 个案例、300 臂、304 个执行文件，以及 `review-submit → import --review-id` 和导入中途真实审核修订的拒绝。报告分别为 `.local/reports/jev-blind-label-reviews-first.json` 和 `.local/reports/jev-replay-review-revision-race-final.json`；合法完整导入记录 1351 ms，中途修订拒绝记录 1491 ms，原默认 5 秒期限保留。先前 13/14 的超时失败另存 `.local/reports/jev-replay-review-revision-race-first.json`，针对关联查询的优化与 profiling 边界见 [主线安排](../../docs/mainline-development.zh-CN.md)。供应商响应均为模拟，没有真实付费请求或业务准确度结论；真实微信/企微聊天测试继续暂缓，真实供应商账单及生产部署尚未验收。

新增 PostgreSQL 16 原生独立审核 6 项，与既有调用账本 4 项定向合跑，10/10 通过、零跳过、零未处理错误；运行结果（本地历史证据：`.local/reports/postgres-concurrency/37ac246c-97ef-4e52-b1de-347cbe199291/result.json`）确认容器已清理。使用普通 LOGIN、不同连接池及 `pg_locks` / `pg_blocking_pids` 证明真实等待，验证相同标签并发提交只产生一个回执、双审核者共享修订序列、排队提交期间映射/员工禁用会拒绝，以及核验持有 `FOR SHARE` 时禁用须等待提交。夹具保留完整 300 案例冻结计划、100 条校准案例 × 3 臂；SQL 运维角色只建立合成零调用记录，盲评包通过实际 047 封存流程，未调用供应商或聊天客户端。

原生测试清理前确认测试后端为零，未使用 `FORCE` 删库；hook 使用 `vi.waitFor`，驱动异常仅记录 SQLSTATE，避免序列化客户端。此前失败运行及清理修复见 [主线安排](../../docs/mainline-development.zh-CN.md)，历史报告保留。角色成员资格撤销不保证已进入 SQL 的在途调用立即终止，重新核验会检查当前角色；核验后出现的新修订仍可能使旧回执失效，最终准入须在账号锁内重查，当前审批继续关闭。

本轮完整 `verify` 退出 0：Node、Web、Services 类型检查、quiet lint、101 个单元测试文件的 930 项及 2 个回归文件的 34 项通过；lint 元数据仍有 8188 个 warning、0 个 error。`verify` 不包含上述原生并发测试，两个范围分别记录，不能相加为业务验收或整体目标完成的证明。

调用结果可保留经过格式校验的供应商请求 ID：Jev 的 `x-typesafe-request-id` 或文本接口的 `x-request-id`。它仅用于与外部账单/日志对账，缺失时保持未知，不证明已付费、实际费用或货币预算已满足。

### 三臂候选生成核心

[replay.ts](replay.ts) 提供独立的 A（文本）、B（Jev 前置+文本）、C（生产 Jev 前置+文本+复审）执行。各臂分别调用传入的真实供应商接口，不为跳过的决策阶段伪造通过响应；单元验证使用模拟接口，没有真实 API 请求或费用。B 与生产 C 共用前置判断门槛，三臂使用同一冻结知识、文本生成器版本、人工请求拦截和确定性事实核验。

A 固定采用 `automatic-intents-with-scoped-evidence-v1`：在配置允许的意图中保留有范围内知识的意图；启用词法检索时每个意图取相同的前三条相关知识。B/C 则由 Jev 选择意图。这种路由差异可能影响覆盖率，属于实验条件，不能把 A 描述为已人工判定正确的路由。改动该规则需要更换冻结实验协议。

核心在构造供应商前核对数据库读取返回的租户、账号、员工、平台身份，并校验完整切分及逐案例输入哈希。输出包含原始草稿、实际决策响应、阶段耗时和可选 HTTP 尝试记录，须按客户数据保存在私有位置；没有发送器、发送任务、审批或执行许可。`wouldRelease` 只是拟放行判断，`releaseAuthorized` 始终为 false。

只在每个实际启动阶段均有匹配的 HTTP 尝试、每次尝试都有用量时累计 token，包含重试；缺失用量为 null/unknown，费用始终为 null，不补造零费用。重复尝试编号、实际模型漂移、问题集哈希变化会使结果无效。[供应商工厂](replay-providers.ts) 用闭包核对真实执行与记录归属；案例、臂或 assignment 跨用会在占额及 HTTP 前拒绝。[中央账本](../../server/src/generation/jev-replay-journal.ts) 提供持久次数限额，但不提供硬费用预算。非空企业记忆清单暂时明确拒绝，不静默丢弃记忆后继续评测。

2026-10-07 核心与生产流水线专项 42 项通过；最终主线/回放/校准/冻结/TLS 定向整合 15 文件 166 项通过，报告分别在 `.local/reports/jev-replay-core-final.json` 和 `.local/reports/jev-replay-mainline-integrated-final.json`。完整 100 条合成校准切分确实执行了 300 个独立臂，但供应商接口均为模拟实现。这些结果验证执行和隔离逻辑，不证明 Jev 的真实业务精准度。

这套工具计算业务人员盲评后的 A/B/C 指标。A 为同等规则、知识和文本模型；B 增加 Jev 前置决策；C 再增加最终草稿审核。模型自己的评分不能作为对错标签。

输入为 `metrics.ts` 中严格校验的 `EvaluationDatasetSchema`。每条案例保留脱敏 `caseId`、完整会话分组、校准/留出切分、业务类别、人工预标注的可处理范围、应转人工与诉求数，并包含 A/B/C 各一个独立审核结果。不可把同一完整会话同时放进校准集和测试集，不能缺少对照组。模型、问题集、策略及共同上下文/知识/文本模型指纹在测试前冻结。

没有建议时 `substantialCorrection` 必须为 null；有建议时必须经独立人工判断为 true 或 false。严重事实错误及越权承诺必须标记为实质修改，不能靠空值隐藏。合成夹具仅用于验证计算代码，不证明真实业务效果。

将人工标注文件放在 Git 忽略的 `evals/private` 或 `.local` 中，从项目根目录执行：

```powershell
& '.\scripts\dev-tools.ps1' run jev:evaluate .local/evals/adjudicated.json .local/reports/evaluation-001.json
```

报告只保存脱敏编号、版本和聚合指标，不包含客户原文。输出须为新的 `.local` 路径，不覆盖原文件。退出码 0 表示在该批已标注样本中观察到目标，2 表示证据不足或目标未达到，1 表示输入或运行失败。退出码 0 不等于允许开启自动发送。

工具计算错误放行、自动回复覆盖、人工修改、无建议、应转人工却放行、错误拦截、多诉求覆盖、时延 p50/p95 和 token 总量，并分别列出 A→B、B→C、A→C 和业务类别结果。错误放行分母为拟自动回复数，覆盖分母为业务人员预先标注的可处理回合。分母为零时返回 null，不能算成零错误率。

采用完整会话配对重采样估计 A→C 改善和覆盖变化的 95% 区间，随机种子固定以便复现。各单项的 Wilson 区间仅为回合级描述，相关回合不能按独立样本解释。基线错误不足、拟自动回复不足、重采样分母为空、至少 100 条校准或 200 条留出案例未达到时，报告证据不足。另设至少 30 个独立会话、各组至少 30 条拟自动回复及至少 5 个基线错误的起始检查；这些是工程检查阈值，不能保证统计功效。

初始目标为观察到错误放行率相对减少至少 20%、覆盖下降不超过 5 个百分点，且验收样本中严重自动事实错误、越权承诺和应转人工却放行均为零。改善区间还须支持改善方向，覆盖区间不能越过损失上限。报告不声称已经以 95% 置信度证明“至少改善 20%”；零严重错误也不证明未来永远安全。实际价格预算、时延上限、客户端收发能力和多人试点仍需单独验收。

自动发布准入使用 [管理员评测流程](../../server/admin/README.md)：先冻结实际发布全文、问题集、生成器指纹、样本切分及预算，再运行留出集。提交原始配对标签和逐案例、逐组的费用与阶段耗时，服务器重算指标并记录批准 ID；CLI 的单独聚合报告不能替代这个过程。明确声明为 synthetic 的提交被拒绝。程序无法独立证明运营人员提交的人工标签、business 声明或费用来源真实；当前测试仅验证协议和拦截逻辑。

## 用自己的业务样本校准阈值

`jev:calibrate` 读取人工标注的**校准集**和每条案例实际观察到的 Jev 前置/后置响应，比较预先列出的候选阈值。它不会调用供应商、生成回复、修改发布或允许发消息。先按完整会话分组划分校准与留出样本；留出文件不要传给校准命令，同一会话不能跨两个集合。业务人员先标记是否适合自动处理、是否应交人工，再对隐藏 A/B/C 身份的草稿判断对错。不能把 Jev 的高分填成人工正确标签。

从项目根目录执行：

```powershell
& '.\scripts\dev-tools.ps1' run jev:calibrate .local/evals/calibration.json .local/reports/calibration-001.json
```

输入必须位于 `.local` 或 Git 忽略的 `evals/private`；输出必须是新的 `.local` 路径，拒绝覆盖原报告。退出码 0 表示有候选适合进入冻结留出评测，2 表示证据不足或没有候选达标，1 表示格式或运行失败。任何退出码均不授权自动发送。报告固定 `releaseAuthorized=false`、`holdoutRequired=true`。

输入是严格 JSON 对象，未知字段会被拒绝。完整校验定义见 [calibration.ts](calibration.ts)。顶层字段如下：

| 字段                     | 格式与来源                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `datasetId`              | 脱敏样本集编号，1–128 字符。                                                                                                                                                                     |
| `dataKind`               | 真实业务为 `business`，测试夹具为 `synthetic`；合成数据不会获得推荐策略。                                                                                                                        |
| `annotationSource`       | 固定 `blinded_business_adjudication`。                                                                                                                                                           |
| `adjudicatedBy`          | 独立业务审核人员编号。                                                                                                                                                                           |
| `experimentSnapshotHash` | 收集这批观察数据时的完整实验快照 SHA-256，小写十六进制 64 字符；不能用模型名代替。                                                                                                               |
| `basePolicy`             | 完整 `DecisionPolicySchema` 策略对象，来自待评测发布的 `policy`。必须为 `mode=enforced`、`evaluationApproved=true` 的**拟批准策略**；该标志仅用于重放拟批准后的候选门槛，不能代替服务端批准 ID。 |
| `candidates`             | 1–500 个完整策略对象，不能只填变化字段，不能重复。除下列六个阈值外，每个字段均须与 `basePolicy` 相同。候选及目标应在查看校准结果前声明。                                                         |
| `targets`                | 包含 `maximumErrorReleaseRate`（0–1）、`minimumAutomaticCoverage`（大于 0 且不超过 1）、`minimumAutomaticReplies`（30–2000）的对象。按业务风险预先设定；工具不把它们当作已达到的目标。           |
| `samples`                | 1–2000 个下表所列案例；业务推荐另需至少 100 条案例和 30 个完整会话。                                                                                                                             |

允许变化的六个阈值是 `minimumChoiceProbability`、`minimumChoiceConfidence`、`minimumChoiceMargin`、`presentIntentProbability`、`humanRequestThreshold`、`minimumAuditProbability`，均在 0–1；意图存在阈值必须大于 0.5。知识版本、模型解析版本、问题集、可自动处理意图、有效期、阶段预算等必须固定。改变这些条件要重新运行评测，不能仅重用旧分数。

每个 `samples` 对象必须包含：

| 字段                                     | 格式与含义                                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caseId`、`conversationGroup`            | 唯一案例编号与完整会话编号；多个回合使用同一个完整会话编号。                                                                                             |
| `split`                                  | 只能为 `calibration`；`holdout` 会被拒绝。                                                                                                               |
| `eligible`、`expectedHandoff`            | 人工事先标注的是否适合自动处理、是否应该交人工，均为布尔值。                                                                                             |
| `explicitHumanRequest`                   | 实际管线是否命中客户明确要求人工的确定性拦截。                                                                                                           |
| `deterministicPreconditionsPassed`       | 这条观察记录是否通过上下文当前性、知识可用性/范围等确定性前置条件；不能根据 Jev 的置信度推断。                                                           |
| `draftAvailable`                         | 是否确实生成并保存了草稿。                                                                                                                               |
| `assessedIntents`                        | 生成并复审该草稿时实际使用的意图数组；取值为 `faq`、`price`、`order`、`aftersales`、`other`，不能重复。有草稿时不能为空。                                |
| `factsVerified`                          | 管线对**该草稿**执行确定性事实核验的原始结果。当前只接受与审核答案块逐字一致的内容；Jev 的 `supported` 高分不等于此标志为 true。无草稿时必须为 false。   |
| `substantialCorrection`                  | 独立业务人员判断草稿是否需要实质修改：有草稿为 true/false，无草稿为 null。                                                                               |
| `severeFactError`、`unauthorizedPromise` | 独立业务人员判断的严重事实错误和越权承诺；任一为 true 时 `substantialCorrection` 必须为 true。                                                           |
| `pre`                                    | 该案例实际 Jev 前置响应完整对象：`model`、`answers`、`usage`。模型必须等于 `basePolicy.modelResolved`；明确请求人工而未执行模型时可为 null，约束见下文。 |
| `post`                                   | 该草稿实际 Jev 后置响应完整对象；未观察到后置响应时为 null，不能伪造全通过响应。                                                                         |

只有实际明确请求人工、在 Jev 调用前交接的案例才允许 `pre:null`：`explicitHumanRequest=true`，没有草稿或生成时意图，`draftAvailable=false`、`assessedIntents=[]`、`post=null`、`factsVerified=false`、`substantialCorrection=null`。不得省略 `pre` 字段，也不得把模型请求失败或其他前置条件失败改成该例外。这些案例保留在完整样本和会话计数中，各候选始终交人工；降低阈值不能令它们自动回复，不作为缺失反事实补造模型观察。独立人工 `eligible` 标签仍决定覆盖率分母，不能根据拦截结果自行改标签。

存在 `pre` 时，`pre.answers` 必须恰好包含 `primary_intent`、`human_requested`、`has_faq`、`has_price`、`has_order`、`has_aftersales`、`has_other`。`primary_intent` 是 `choice` 答案，需要 `choice`、`confidence`、包含全部五个意图的 `probabilities`；其余为 `noul` 答案，需要 `type=noul` 和 0–1 的 `noul`。概率分布须符合现有 Jev 合约，所选意图必须为最高概率。`post.answers` 必须恰好包含五个 `noul` 答案：`supported`、`within_scope`、`covers_requests`、`appropriate_tone`、`resists_instructions`。存在的响应都须有 `usage` 及非负整数 `input_tokens`、`output_tokens`，不能补造未发生的响应或用量。

候选按生产管线的阈值边界重放，统计拟自动回复数、错误放行率、覆盖率、严重错误、越权承诺、应交人工却放行。全部拦截不会被当作零错误率达标。若降低阈值后某案例本应进入生成，但原观察没有草稿/复审，或新意图集合不同于原草稿的 `assessedIntents`，该候选记录 `unobserved_counterfactuals` 并失去推荐资格。必须在隔离、禁止发送的评测环境补齐实际观察；不能将缺失结果算成正确。

符合预先声明目标且未出现严重错误/越权承诺/错误交接的候选，按覆盖率从高到低、错误率从低到高选择；最后以策略哈希保证稳定的并列排序。即使获得 `recommended_for_frozen_holdout`，这仍只是校准集上的描述性选择。把 `recommendedPolicy` 应用到新的完整拟发布配置，为策略和配置设置相应版本，再使用管理员 `freeze-evaluation` 冻结**新的**快照和原定样本切分。之后才对从未参与选阈值的留出集执行同上下文、知识及文本模型的 A/B/C 对照，取得独立人工标签和实际费用/阶段耗时，提交 `approve-evaluation`。不能把校准报告的旧 `experimentSnapshotHash` 作为新策略的冻结快照，也不能用校准报告替代配对留出标签。
