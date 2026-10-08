# 工作记忆独立效果评估

> 当前状态以[集中验证报告](E:/wechat-autoreply/auto-reply/docs/learning-memory-final-verification.md)为准；下文历史过程记录保留，不能视为最新运行状态。

`memory:evaluate` 读取已经生成、已经独立标注的三组数据：无记忆（none）、现行静态记忆（baseline）、学习方法（learned）。它只计算报告。配套 `memory:replay` 通过隔离的实际知识试答管线采集三组回复；`memory:adjudicate` 导入独立标签和实际费用。三个命令均不激活方法、发布企业版本或发送消息。

```powershell
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:evaluate', '--', '--dataset', '.local/evaluations/business.json', '--out', '.local/reports/memory-evaluation/business-001')
```

输入业务资料必须放在被 Git 忽略的 `.local/` 或 `evals/private/` 下。输出必须是 `.local/` 下尚不存在的新目录；原报告不会被覆盖。输出 `report.json` 和中文 `report.md`，仅含汇总、配置摘要和匿名样本数量，不含回复正文、标注人或私密证据引用。命令只打印状态与样本数，错误不会打印原资料。不要把客户身份、密钥或原始敏感聊天放入匿名 ID。

新输出目录在写入正文前设置实际私有权限：Windows仅当前用户与SYSTEM，其他系统0700。回放及标签导入的JSON写入前检查目录、wx写入后检查文件；evaluate的JSON/Markdown报告逐文件复核。权限失效保持失败，不能只凭.local路径宣称私有；输入路径和输出权限也不鉴定人工标注真实性。最新实际四项ACL红测及3文件23项通过、真实PG选定8项复核见验收文档，合成报告继续insufficient。

评估退出码按照原计划统一为：0 通过，1 输入/执行错误，2 资料不足或业务门槛未通过。两种非通过结论在 report.json 的 assessment.status 区分。原 `--dataset/--out` 形式继续支持，也支持 `memory:evaluate INPUT OUTPUT_DIRECTORY`。旧 version=1 两组数据仍可读取，但判为 insufficient（legacy_two_arm_contract）；不得仅修改版本号来补造证据。合成示例用于核验格式，**应退出 2**：

```powershell
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:evaluate', '--', '--dataset', 'evals/memory/fixtures/synthetic.json', '--out', '.local/reports/memory-evaluation/synthetic-001')
```

## 用户确认的门槛

2026-10-06 用户明确确认：实质修改率相对下降至少 20%，学习组严重错误为 0，覆盖率下降不超过 5 个百分点，新增 p95 时延不超过 500ms。命令不能放宽这些门槛。

学习 100、校准 100、评估 200 条和至少 30 个独立评估会话是计划的工程起点，本工具采用它作为资料下限。达到数量不代表统计充分；需要同时审阅会话分布、业务代表性和置信区间。缺真实人工资料只能判定 insufficient，不能以合成或模型自评补足。

## 数据准备流程

1. 用匿名 caseId、conversationId 分为 `learn`、`calibrate`、`evaluate`。同一真实会话只能属于一个 split。学习方法的全部来源必须列入 learn，不得遗漏；独立校准与评估资料不得参与方法提炼。
2. 固定人工评分标准 rubricRef。实质修改是需要改事实或流程，不包括纯措辞修改。validAnswer 表示能提供有效答复；拒答、空答或答非所问不算覆盖。严重错误的业务定义应在生成评估回复前冻结。
3. 冻结共同模型、知识、提示词、policyVersion、retrievalVersion；记录 frozenAt、sharedConfigurationHash、三组 memoryManifestHash、latencyScope 和后台学习/校准的实际 backgroundCostUsd。methods 列出 id、revision、contentHash 和全部 sourceCaseIds。冻结时不得使用留出标签选方法。
4. 对同一评估问题分别通过三组冻结内容生成结果，随机调整请求顺序，避免学习组固定处于预热后的时段。模型不能看到 rubric、来源标签或标准答案。记录实际配置/记忆清单哈希、generatedAt、latencyMs、token 和费用；未知用量不能填零，费用来自实际计费凭据。
5. 隐藏组名、哈希、调用次序、费用和时延，由独立人工按固定 rubric 盲评。保留私密 assignmentRef、evidenceRef 和原始记录。每组显式记录 humanReviewed、substantialCorrection、severeError、validAnswer；没有实际评审的草稿不能标为采用或有效答复。label 的 reviewerId 为匿名 ID，origin 必须反映真实来源，blinded=true，labelledAt 不早于生成。禁止用模型身份填写 human。
6. 把数据保存到私密目录并运行命令。由独立业务验收人员核对原始资料、盲评分配、全部来源和冻结配置。工具只检查声明的一致性，不能鉴定是否确有真人或记录是否造假；输入 human 文字本身不是真实性证明。

严格合同在 `src/shared/contracts/learning-evaluation.ts`，格式模板在 `fixtures/synthetic.json`。新合同 version=2；evaluate 必须有 none、baseline、learned 和 category（inquiry/complaint/handoff/multiple_intents）。reply=null 表示没有回复，不能算已评审草稿或有效答复；严重错误必须同时标记实质修改。未评审而非空的回复导致 insufficient。覆盖率保留全部样本，不能删除失败或拒答案例来改善指标。

## 可执行的隔离回放与盲评流程

输入模板 `fixtures/replay.synthetic.json` 明确为合成资料；回放只读取私有路径，先复制到 `.local/evals/` 再准备真实脱敏资料。knowledge 使用实际知识导出 bundle；legacy 是冻结静态卡片；methods 是已审核的冻结方法和学习来源。每个留出案例的 memoryIds 是预先冻结的检索选择，不能参照留出标签调整；选择超过 5 条禁止，生产渲染仍限制 2000 UTF-8 字节。方法总数超过 5 时每个案例必须显式提供 memoryIds。

model.model 是请求模型名，expectedModel 是预期返回的实际固定模型版本，漂移或截断响应会终止回放。API 密钥只从主机环境 MEMORY_REPLAY_API_KEY 读取，不能放进资料 JSON。maxRequests 必须至少覆盖 3×案例数，最多 6000；命令串行调用、不自动重试，不代表企业预算或生产调用授权。

```powershell
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:replay', '--', '.local/evals/replay-input.json', '.local/reports/memory-replay/run-001')
# 仅将 blind.json 交独立评审，packet.private.json 和 requests.jsonl 留给计费/验收核查人。
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:adjudicate', '--', '.local/reports/memory-replay/run-001/packet.private.json', '.local/evals/independent-labels.json', '.local/reports/memory-replay/labels-001')
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:evaluate', '--', '.local/reports/memory-replay/labels-001/labelled.json', '.local/reports/memory-evaluation/business-001')
```

回放输出 `blind.json`（匿名题目、回复及 assignmentId）、`packet.private.json`（原始冻结资料、来源与三组回执）、`requests.jsonl`（请求/用量状态，不含正文或密钥）、`status.json`。失败不生成完整 packet，status=incomplete，已派发请求需核对账单；失败调用费用不能当零。输出目录必须全新，禁止覆盖或通过 junction 指向其他位置。

私有 JSON 输入及输出均不得超过 64 MiB，按实际 UTF-8 字节计数。过大输出在创建文件前拒绝，采集标记 incomplete；已经发生的调用仍需依据请求账本核对费用。学习/校准来源与留出案例的总量不得超过 100000 条，本地及企业采集在模型调用前检查，避免生成后无法导入评估数据。

独立标签文件是数组，每个 assignmentId 恰好一项：origin、reviewerId、evidenceRef、labelledAt、blinded、humanReviewed、substantialCorrection、severeError、validAnswer、costUsd、costEvidenceRef；模型未返回 token 时，还必须补充来自计量凭据的 inputTokens/outputTokens，不能改写已报告 token。评审者只看 blind.json；计费核查人补齐实际费用及凭据。不提供标签、不盲评、混入合成/模型标签、缺用量或费用时，不能据此通过验收。示例标签结构：

```json
[
  {
    "assignmentId": "填写 blind.json 中的实际 ID",
    "origin": "human",
    "reviewerId": "匿名评审者",
    "evidenceRef": "私密评审记录",
    "labelledAt": 1791320000000,
    "blinded": true,
    "humanReviewed": true,
    "substantialCorrection": false,
    "severeError": false,
    "validAnswer": true,
    "costUsd": 0.001,
    "costEvidenceRef": "实际计费记录"
  }
]
```

示例中的时间、判断、费用和身份均为占位值，不能用作人工记录。labelledAt 必须使用实际评审时间。缺标签、计量 token 或实际费用/费用凭据时，导入退出 2 并只写 status.json 的 insufficient 原因，不生成 labelled.json；其他格式错误退出 1。

上述 `memory:replay` 只创建隔离 SQLite 知识存储，使用生产 KnowledgeReplyService、静态记忆/学习记忆渲染和冻结选择；它没有 LearningService、复盘队列、生产案例写入或发送能力。**该命令覆盖知识试答路径，不能替代企业 Jev/生成/审核或真实客户端的前台 p95 验收。** 本地和企业现在共用部署文件内容指纹，采集及导入进程必须使用相同实现；缺部署文件、实现变更或改写成自洽的旧版本字符串均不能导入。旧函数文本指纹 packet 需重新采集，禁止人工改哈希。指纹检查不是业务真实性或密码学认证；输入、回执和标签仍需独立核查。

单次时延包括该组冻结方法装载/限额处理、渲染、知识检索及模型请求。留出 memoryIds 已预选，因此此计时不包含生产 FTS 方法选择、历史案例装载、Jev 审核、队列、桌面截图或发送；不能把这个局部计时解释为完整前台性能已达到 500ms 门槛。

## 企业三组采集

`memory:replay:enterprise` 从已认证的 learning worker 数据库登录读取实际生效的企业发布、知识证据、策略、方法和历史案例，并对同一留出案例运行实际 `JevReplyPipeline` 的判断、文本生成和审核。学习组复用生产任务准备的同一个方法/历史案例选择函数；无记忆组和静态组使用相同企业配置。采集器只写评估运行与用量账本，不创建学习案例、任务、准备记录、方法激活许可或发送许可。

输入必须是私密 JSON：`version=1`、`datasetId`、真实 `origin`、预先冻结 `rubricRef`、`maxRequests`、实际后台 `backgroundCostUsd`、冻结静态 `legacy`、`sources` 和 `cases`。sources 沿用上面的案例合同，必须列出**实际选中方法的全部来源 episode UUID 以及实际选中历史案例**，split=learn，并提供真实原始 conversationId；账号级手工教导案例使用分组 `account`。留出 cases 每项提供 caseId、原始会话分组 conversationId、category、inbound 字符串数组，可选生产 ConversationContext。完整会话分组不可跨 split；不得修改会话 ID 来规避检查。这里只传案例资料，账号身份由数据库登录和 worker reference 绑定。

主机环境需配置 `MEMORY_REPLAY_DATABASE_URL`（已授权的 learning worker 登录）、`MEMORY_REPLAY_WORKER_REFERENCE`、`MEMORY_REPLAY_TEXT_BASE_URL`、`MEMORY_REPLAY_TEXT_MODEL`、`MEMORY_REPLAY_TEXT_EXPECTED_MODEL`、`MEMORY_REPLAY_TEXT_API_KEY`、`MEMORY_REPLAY_JEV_API_KEY`。不要把密钥或数据库 URL 放入案例、命令参数、聊天或版本控制。text 模型配置必须与实际发布的 fingerprint 一致。

```powershell
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:replay:enterprise', '--', '.local/evals/enterprise-replay-input.json', '.local/reports/enterprise-memory-replay/run-001')
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:adjudicate', '--', '.local/reports/enterprise-memory-replay/run-001/packet.private.json', '.local/evals/independent-labels.json', '.local/reports/enterprise-memory-replay/labels-001')
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:evaluate', '--', '.local/reports/enterprise-memory-replay/labels-001/labelled.json', '.local/reports/enterprise-memory-evaluation/business-001')
```

`maxRequests` 至少覆盖 9×案例数，最多 18000；该上限是三组每组最多三阶段的调用数，不会放宽账号共享每日 token、单次输入、单次输出、尝试次数或并发额度。账号必须已启用学习、未暂停且满足空闲条件；整个冻结采集占用同一个后台槽。来源泄漏、发布/知识/方法/历史上下文变化、前台抢占或账号撤销会停止采集。显式转人工的确定性分支没有 HTTP 调用，其零 token 有可核对的空调用清单；未知调用用量保持 null，不能填零。每组回执的 modelCallRefs 对应实际共享账本，包含 Jev、文本和审核全部阶段的 token。

同一冻结 run 的请求次数由持久 `learning_attempts` 行数核对，限制值来自服务端保存的原始输入；每次准入在账号锁事务内读取，未达到上限才可插入下一次预留。已报告用量、未知用量、发送前取消均计次数，不因 UTC 费用日期不同或新建服务实例而恢复额度。同一冻结来源已有 checkpoint 时，新的 `collect` 被拒绝，必须用原 runId 恢复。来源指纹包含实际部署配置；部署变化不能混入旧批次。

成功输出 packet.private.json、blind.json、status.json 及 ledger.jsonl；输出目录必须新建，并在首个写入前设置私有权限（Windows 当前用户及 SYSTEM；其他系统 0700），文件继承目录权限。只把 blind.json 交给独立评审。账本日志保留 runId 和本次完成组的调用 UUID；evidence_exported 只表示导出，不表示新的模型调用。失败后的完整已派发/上限估计用量，以数据库 learning_attempts 中该 runId 的记录为准，再与供应商账单核对。USD 仍需计费凭据补充，失败收费、后台学习/校准费和未知用量不得当零。一般失败 status=incomplete、退出 1，不输出完整 packet；共享日预算等待 status=waiting_budget、退出 2，包含 runId 和 retryAfterUtc（UTC 毫秒时间戳），没有业务批准。

服务端 `learning_evaluation_checkpoints` 与 `learning_evaluation_arms` 在首个 HTTP 前保存冻结依据、实际账号绑定及随机分组顺序，每组在下一组开始前耐久保存原始回执和费用 UUID。导出回调故障不会删除已完成组；它只能修改副本。冻结写入事务复核所有案例当前版本，防止快照读取后的遗忘重新写回旧正文。独立 worker 登录才能读取或写入正文，伪造账号 GUC 不绕过绑定；应用角色仅有清理所需元数据读取和删除权限。账号任一范围遗忘会删除该账号冻结批次，过期记录通过保留期清理删除；对应后台槽及运行取消，费用与迟到用量继续保留。正文依据最大 32 MiB，整批已保存证据限制 64 MiB。

恢复入口读取服务端原始 checkpoint，不接受客户端私有 packet 作为恢复依据。它保留原 runId、随机组顺序、assignmentId 和全部费用记录；已完成组直接复用，未完成组复用已经耐久保存的判断/文本/审核阶段。迁移 039 的阶段正文只允许绑定 worker 读取，随 checkpoint 的遗忘或过期删除级联清理，不能进入学习检索。

```powershell
$resumeRunId = (Get-Content -LiteralPath '.local/reports/enterprise-memory-replay/run-001/status.json' -Raw | ConvertFrom-Json).runId
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:replay:enterprise', '--', 'resume', $resumeRunId, '.local/reports/enterprise-memory-replay/resume-001')
```

每次恢复使用新的输出目录。waiting_budget 释放后台槽，同一 UTC 日仍退出 2；下一桶重新鉴权、核对全部冻结版本并取得原共享槽，预算等待不增加失败重试次数。一般中断恢复仍受原最多三次尝试及指数退避限制，跨进程和新建批次不能重置。完整组都已保存但导出失败时，仅重新导出，不消耗新尝试或模型调用。已付费但没有耐久结果、仍未结算或费用引用缺失时要求费用核对，不自动重复请求。不要修改私有 packet、数据库状态、日期或额度来拼接不同批次。

已完成批次可通过实际worker登录进行只读核验。该入口只需要 `MEMORY_REPLAY_DATABASE_URL` 和 `MEMORY_REPLAY_WORKER_REFERENCE`，不需要provider密钥：

```powershell
$completedRunId = (Get-Content -LiteralPath '.local/reports/enterprise-memory-replay/run-001/status.json' -Raw | ConvertFrom-Json).runId
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:replay:enterprise', '--', 'verify', $completedRunId, '.local/reports/enterprise-memory-replay/run-001/packet.private.json', '.local/reports/enterprise-memory-replay/verified-001')
```

每次读取重新鉴权并核对当前服务端原始checkpoint、全部随机三组分配、完整回执、有效期和费用用量；改写回复、盲评、费用缺失、未完成或过期批次均拒绝。核验不调用resume/claim、不增加模型请求、不改变重试次数或后台槽。新私有输出 `frozen-verification.private.json` 只含批次、哈希和分配元数据，实际Windows DACL/0700在写入前设置、写入后复核。该文件不是可移植认证凭据，后续前台关联/导入必须再次在线核验；它明确 `foregroundVerified=false`、`businessVerified=false`。当前实际前台三组关联/原始证据导入尚未完成，现有adjudicate仍只做内容一致性检查，不能把此核验输出或局部时延升格为业务通过。最新真实PG选定8项报告51407963-873d-48b7-8868-2ae6fbf3b8c6已读取passed=true/cleanedUp=true；早期7项结果、实际权限失败及后续复合测试超时/拆分记录均保留在验收文档，没有提高原有超时或生产参数。

进程崩溃丢失的计时间隔标为 `latencyComplete=false`；评估器报告 incomplete_latency_observation，相关 p95、新增 p95 和 bootstrap 时延区间均不能被当作完整测量。恢复后的企业回放仍固定 enterprise_pipeline，不升级为完整前台时延。

企业单组时延包含账号鉴权、状态读取、学习组实际检索/装载、三阶段实际管线和用量核对。**它仍不包含生产前台排队、截图、RPA 操作或发送，不能单独证明真实客户端新增 p95 ≤500ms。** 业务验收必须同时检查实际前台观察记录及采集范围。部署文件内容指纹和冻结哈希检查一致性，不能替代真实独立人工核查或防伪认证。采集期间每次调用准入、定时监控及结果完成检查均重新核对部署版本；代码、目录、配置或权限变化使运行失效，不能将旧结果作为冻结采集成功导出。

评估器强制区分 `knowledge_preview`、`enterprise_pipeline` 与 `foreground_end_to_end`：两个采集命令分别固定前两种范围；不能通过修改 packet 将局部计时升级。范围缺失或只测局部时，报告包含 foreground_latency_not_measured，整体只能 insufficient。完整前台观察数据须记录各组从同一业务触发起点到同一完成终点的实际时延，并在每个 none/baseline/learned outcome 提供私密 latencyEvidenceRef；缺凭据也是 insufficient。这个声明和凭据必须独立核对原始观察，禁止给局部时延改名为完整前台时延。

前台证据接线正在进行：可信主机可订阅 DesktopAgentRuntime 第四个构造参数的 RuntimeTimingEvent，同一 runtimeInstanceId 下包含真实 source.read 开始/提交/失败/取消，以及消息接收、排队后的生成、候选可用和自动发送结果；atMs 使用同一主进程的单调时钟，不使用客户消息 observedAt 作为开始。生成阶段增加实际SQLite sourceMessageId/sequence/verified元数据，查询或核验失败保持不足；没有正文或发送许可。事件副本的更改、同步抛错或异步拒绝不能改变业务结果；监听器应只作有界快速入队，业务不等待磁盘。

默认生产 `registerAgentIpc` 现在会在开放运行 IPC 和加载首个窗口前，等待 `configureManagedTimingCapture(userData/agent/runtime-timing)` 安装主机私有采集；初始化失败保留原运行准入规则，不能伪造证据。可信主机也可在第一次运行操作前调用 `await runtime.configureTimingCapture(freshEmptyDirectory)` 安装单个工程会话；`bindTimingEvaluation(task, frozenHostBinding)` 只接受与已观察任务一致的冻结元数据。这些接口没有暴露给 renderer。正常关闭在实际停止确认后封存托管报告；`exportTimingEvidence(endpoint)` 重新核对私有索引和文件，不能返回已被另一主机遗忘或过期的缓存报告。

托管私有索引通过 SQLite 事务限制至多128个会话、合计256MiB（包含32MiB元数据预留），每个活跃会话先预留完整64MiB。封存后按实际文件字节计数，新准入和库存读取再次核对实际字节。90天清理采用主机时钟，每60秒重试；过期、范围撤销或异常退出不重建完整计时报告。实际跨进程范围遗忘持久保存范围撤销屏障，匹配的封存记录被删除，仍存活的其他写进程返回 writer_busy 并拒绝后续写入，不能报告遗忘成功；不相干账号或会话保留。Windows实际DACL/POSIX私有目录、普通单链接文件、已知文件名及目录身份均复核；只删除已验证的已知文件与空目录，不递归删除。队列/记录/字节或写入失败仍为证据不足，footer及报告flush后才完成封存。实际桌面默认启动/退出和跨进程工程证据见 `docs/learning-memory-acceptance.md`，90天测试使用受控主机时钟，不代表实际运行90天。

`reviewable` 现在使用工作台实际呈现回执：可信主机绑定当前任务/行版本/账号及短期随机nonce，复核真实前台窗口、双帧DOM内容/无遮挡/屏幕范围及实际compositor capture，再以同一主进程单调时钟记录首个有效终点。renderer只提供nonce，不能提供时间、正文、分组或范围；过期/暂停/关闭/遗忘/身份或版本变化均拒绝。正文及截图不写入生产计时日志。`confirmed_sent` 仍仅使用实际发送开始及confirmed结果。candidate_ready、人工填写时间、task.createdAt均不是完成端点。两者尚未与同一服务端冻结批次的none/baseline/learned原始观察完成独立关联；host传入hash只能检查一致性，不能替代冻结真实性或业务人工核验。因此当前导出 **不能直接作为已通过的foreground_end_to_end验收数据**。没有collectionSource的旧观察回调还缺读取开始，也不能据此声称覆盖截图/采集耗时。

工程验证可执行 `memory` 的上述命令之外的 `test:timing:desktop`：它使用独立合成采集来源/假模型和实际Electron前台窗口，实际验证隐藏、遮挡、伪造时间、旧桥访问拒绝及正常关闭后的私有证据封存。最新报告 `workbench-presentation/54fd3f91-d040-4d44-8fb2-be96f35d36d7` 已读取通过并查看真实截图，但明确 `businessEffectVerified=false`、`serviceFrozenBatchVerified=false`、`nativePlatformVerified=false`；单次夹具时长不是三组业务新增p95。准确红测、192+14项相关测试、16文件lint、services、构建及基础桌面终态见 `docs/learning-memory-acceptance.md` 的2026-10-07实际呈现记录。真实业务四门槛、三组真实性关联、独立人工样本及全范围最终审查仍待完成。

## 计算及结论

- 实质修改率：需要改事实/流程的已评审草稿数 ÷ 该组实际人工评审草稿数，分别报告每组分母。空回复不进入修改率分母；未评审草稿不能被视作已采用。
- 覆盖率：能提供有效答复的样本数 ÷ 同一评估样本数。
- 相对改善：(基线修改率 − 学习组修改率) ÷ 基线修改率。基线为零时不可定义，结果为 insufficient。
- p95：将每组时延排序，取第 ceil(0.95×N) 个值。新增 p95 为学习组 p95 − 基线 p95，不平均每条差值。
- 成本：报告实际 token 和 USD 费用总和、费用变化，不设未授权成本验收线。
- 不确定性：按独立会话有放回抽样 1000 次，保留会话内三组对应关系，报告总体和四类业务的相对改善、覆盖变化、p95 变化区间。不足两个独立会话时不生成 bootstrap 区间。Wilson 比例区间忽略会话相关性，仅用于描述。
- 观察到严重错误为 0 不代表严重错误风险为 0；四个门槛使用整体点估计，各类业务结果仍需独立审阅。

缺少真实人工来源/盲评、配置或记忆清单变化、训练/评估重叠、学习/校准标注晚于冻结、评估生成早于冻结、评估标注早于生成及资料过少均为 insufficient。资料充分后，只按四个确认的点估计门槛判断 passed/failed；区间仍需独立审阅。任何结果都不构成模型权重训练、方法自动生效、企业发布或消息发送许可。

## 2026-10-07 协同执行绑定增量及验收限制

企业采集新增私有learning_evaluation_execution_tasks，严格GenerationInput/context在每次实际HTTP前进入原账号锁及费用准入事务；绑定实际scope、冻结case/conversation和config/knowledge/policy/question四版本，每assignment最多9项，计入原64MiB总量。stage/回执记录实际task hash及费用对应关系，在线原始核验拒绝错case/版本或跨arm引用。原付费阶段及assignment恢复不重付，丢失时延区间仍为不完整。host-only foregroundTask/foregroundResult回调严格验证上下文，取消/超时有界；**生产桌面三组桥尚未接通，不能将hooks或enterprise_pipeline升格为foreground_end_to_end**。

当前专项本地4文件38项通过22.46s、services及最终7文件lint退出0；真实PG选定一个文件10项通过67.50s，报告postgres-concurrency/0553c81b-3efb-4f90-98b6-d6f77f5229ef已亲读passed=true/cleanedUp=true。它覆盖实际9HTTP前保存、context/费用引用、错case/版本/第10任务/跨arm费用拒绝、RLS及独立OS恢复，不是完整PG；UTC为受控时钟。准确日志与保留红测见docs/learning-memory-acceptance.md。

原1–7已有实现及专项工程证据，Task8仍未完成。当前全局lint独立报告multiagent-global-lint.json：596文件163错误11182警告，20错误文件；历史全套7文件失败仍待当前复核，正在运行的专项不计全套通过。真实100/100/200人工资料、30独立会话、盲评和费用未提供，四确认门槛不变，业务仍insufficient。仍须生产完整三组前台关联/导入及最终全范围审查，不以合成标签或host声明hash替代。未提交、推送、部署、调用真实收费模型或发送业务消息，原八项目标ACTIVE。

专项终态追加：2026-10-07-multiagent-prior-failures.log（session71986/d3fefd）退出1，7文件中6通过/1失败，77项中76通过/1失败，77.04s；当前唯一失败restore-review.test.ts:75预期ledger_restore_guard_owner_invalid，实际permission denied for function restore_admission_current。原超时本次未复现，未弱化断言或修改时限；这是旧7文件专项，不能代表全套通过，另协同代理正在只读定位权限根因。本次专项已终态，前文“执行中”保留为当时状态。

专项最终追加：2026-10-07-multiagent-prior-failures-final.log（58942/fda40d）退出0，旧7文件77项全部通过，68.60s；已恢复019中既有owner检查，恢复迁移由共享作者改名为044且保留修复。中间checked日志3个套件ENOENT、44通过/33未执行、51.27s，源于运行间共享043文件改名及夹具时间窗，保留为失败诊断，不计新增产品红测；夹具补043-learning-evaluation-executions及现有044后，原断言/时限全部通过。此结果仍不是全套，历史完整失败保留。父代理新增实际PostgreSQL owner测试并运行两个选定恢复文件（session43033），当前正在验证，未终态前不计通过，不升级业务验收。

恢复PG终态追加：2026-10-07-multiagent-restore-guard-postgres.log（43033/84df3b）退出0，两个选定文件3项通过、5.65s；实际PostgreSQL报告d7aef9e6-23b4-4cfd-b49b-eff8fb707500/result.json已亲读passed=true/cleanedUp=true/testsPassed=3、scope=selected。新增受限owner用实际登录在privileged helper调用前明确以ledger_restore_guard_owner_invalid拒绝，当前状态不变；另两项保留实际backend95/96串行恢复、apply一次审计/日志且不可解除暂停，以及51条completion和account-lock waiter。restore-guard-lint（9bea34）两文件退出0且无警告。本次两个文件PG已终态，前文“正在验证”为当时记录；选定PG不替代完整PG/全套，Task8和真实业务验收仍未完成。

## 2026-10-07 协同前台桥接：代码已实现，实际联合验证未通过

协同当前变更已增加ForegroundEvaluationHost、host-only assignment合同、DesktopAgentRuntime只读评估接线、封存私有计时日志读取/重放及EnterpriseForegroundEvidence在线关联。桥接按原真实source.read、同一任务/上下文、主进程呈现回执及服务端耐久execution/费用记录核对三组；主机生成与返回结果会合，评估禁止审核/发许可/发送，正文和平台能力不由renderer自报。此前“尚无桥接代码”是历史；当前代码存在，但尚未得到实际联合通过证据，不能据此标已交付完整三组前台链路。

已亲读foreground-bridge-local.log：7文件166项通过38.51s，构建foreground-bridge-build.log通过；这只是专项和构建。最新实际PostgreSQL+可见Electron联合运行foreground-bridge-joint-postgres-anchored.log为1文件11项中10通过/1失败、48.00s；原始PG报告68ea2194-a576-4c21-b07c-4ab3d743e230/result.json已亲读passed=false、cleanedUp=true。实际桌面报告foreground-evaluation/f3036224-bc7b-4785-9a91-710adb264f20/result.json已亲读passed=false、phase=three-arms、code=evaluation_foreground_runtime_unavailable、http=0、sends=0、presentations=0、nativePlatformVerified=false、businessEffectVerified=false。失败发生于模型HTTP和三组实际呈现之前，不能把166专项、旧77项或旧10项PG替代本次失败，更不能声称已完整foreground_end_to_end。

剩余收敛步骤：定位实际运行器start未进入running的精确准入原因，在保留只读/身份/版本/源能力检查下修复；先确认对应行为检查，再执行一次同原冻结三组的实际PG+Electron联合验证，亲读其报告并核对9HTTP/3实际呈现、原task/context/费用/私有封存与在线关联。联合通过后，按实际改动刷新受影响检查及原计划最终全范围测试/完整PG/桌面/场景/构建/质量审查，避免仅重复无修改专项；当前全局lint此前163错误/11182警告快照及历史全套失败仍保留，未重跑不能当已通过。

原1–7已有实现及专项工程证据，Task8仍未完成，目标ACTIVE。真实100学习/100校准/200评估、至少30独立会话、独立人工盲评及原始费用未提供；四确认门槛仍为实质修改率相对下降至少20%、学习组严重错误0、覆盖率下降最多5个百分点、新增p95最多500ms，业务保持insufficient。当前工程合成来源/假模型和窗口证据不授予真实native能力或业务效果证明。未commit/push/deploy、调用真实收费模型或发送业务消息；本次只读审计及文档追加未启动任何重型检查。

联合失败定位追加：协同foreground_review已确认f303启动失败由工程夹具提供60秒租约超过真实LeaseGrantSchema的30秒上限造成；父代理已将夹具改为20秒，生产身份/租约保护未放宽。此为夹具准入错误，不算新增产品行为红测。host启动失败无正文runtimeStatus诊断及非法租约拒绝用例仍待相应检查；修正后的实际三组联合结果尚未取得，不能提前销账。

### 可信前台原始证据核验与派生标注导入

配置实际学习worker登录的MEMORY_REPLAY_DATABASE_URL及MEMORY_REPLAY_WORKER_REFERENCE后，在项目根目录使用新私有输出目录：

```powershell
& '.\scripts\dev-tools.ps1' -NpmArgs @('run','memory:replay:enterprise','--','verify-foreground','RUN_ID','PACKET','VAULT_ROOT','SESSION_ID','NEW_VERIFY_DIRECTORY','reviewable')
& '.\scripts\dev-tools.ps1' -NpmArgs @('run','memory:replay:enterprise','--','adjudicate-foreground','RUN_ID','PACKET','LABELS','VAULT_ROOT','SESSION_ID','NEW_ADJUDICATE_DIRECTORY','reviewable')
```

RUN_ID为原服务端完整批次，PACKET为原私有packet，VAULT_ROOT/SESSION_ID指向可信主机原封存计时记录；导出的verification JSON不能代替原日志或重新鉴权。端点可显式选confirmed_sent，缺真实发送确认时拒绝；默认reviewable不代表用户已选择唯一业务验收终点。两命令不调用模型，adjudicate保留原冻结版本/方法、回复、用量、费用及synthetic/model/human来源，只从已核原始三组观察派生完整前台时延字段。缺标注/用量/费用输出insufficient状态并退出2，不产生已通过业务证据；成功导入仍须另跑memory:evaluate及独立人工核对。verification认证原packet/journal/timing，不鉴定真人标签或费用凭据来源。本次命令和对应联合验证正在检查，未取得实际联合终态前不记完整链路通过。

联合终态补充：2026-10-07-foreground-bridge-joint-final-postgres.log退出0，选定1文件12项通过69.54s；精确PG报告0b931594-0c41-4b1b-89a8-4d01ec169ff9已独立亲读passed=true、cleanedUp=true、scope=selected。实际Electron报告foreground-evaluation/79db8d48-a0ce-4bb5-9bb2-3a9e56493e60已亲读passed=true、9HTTP/0发送/3呈现；同原DBrun88b2fb6b-0da4-42de-9b5e-a604472c5abc及封存session2f9cd770-8648-4dad-bfee-4b7a0ddb96b6的三组分别绑定不同runtime/read/呈现回执，原task/context、冻结依据、费用与主机日志在线关联通过。runner退出0/未超时/14409ms；真实PNG已由父代理视检。独立CLI verify-foreground及adjudicate-foreground通过，原packet字节/回复/用量/费用不变，派生数据只变更已核前台时延，synthetic仍insufficient。此前联合失败与60s非法夹具租约记录保留，不计有效产品红测。当前reviewable原始前台链路已有合成工程联合证据；nativePlatformVerified=false、businessEffectVerified=false，单个合成会话不是200业务样本或500ms门槛证明。原Task8仍待真实100/100/200人工资料、30独立会话/费用及最终全范围验收；本次12项选测不替代完整PG/全套。此前全局163错误/11182警告快照限制保留；父代理单次最终构建及随后完整PG/全套/场景/基础桌面检查尚待各自终态。原目标ACTIVE，未提交/推送/部署、真实收费模型或业务发送。

当前完成状态和最新终态证据统一见[当前验证报告](E:/wechat-autoreply/auto-reply/docs/learning-memory-final-verification.md)。本文保留原计划及按时间记录的历史结果；历史失败、待执行和执行中描述不能代替最新结论。真实业务四门槛仍需独立真人样本及原始证据。
