# 工作记忆自我学习 Implementation Plan

> **For agentic workers:** 使用 superpowers:executing-plans 在原生会话中按任务执行。每任务先写有效的失败测试，再实现和验证。当前只有分析与计划授权，不执行产品代码修改。

**Goal:** 在现有工作记忆中实现案例、复盘、方法修订、验证、相关调用与反馈整理的持续学习闭环。

**Architecture:** 保留现有 TypeScript/Electron/React 技术栈，复核已有 learning 模块；本地 SQLite 与企业 PostgreSQL 各自作为权威存储。学习异步生成候选，检索只使用生效快照，反馈和验证控制后续版本。

**Tech Stack:** TypeScript、Zod、node:sqlite、pg、Vitest，现有模型和企业生成/审核基础设施；首版不增加 Python 或向量服务。

**Spec:** [需求与设计约束](../specs/2026-10-03-hermes-memory-proposal-design.md)

## Global Constraints

- 本次交付的是计划。执行须遵循用户后续指令，不能从工作区其他文档推断产品修改授权。
- 保留已有未提交修改，先登记基线；每次只暂存本任务明确文件，禁止整体 reset/stash/stage。
- 固定研究 Hermes `1a4508e2aff2db5f50409893a2115be777bd5643`；引用实现保留 MIT 归属，不引入全套运行时。
- 可信身份和客户作用域先于学习；显示名不作为 conversationId，跨客户通用经验必须单独泛化与发布。
- 默认 suggest；读取开关与学习模式独立；auto 不绕过事实、权限和企业发布审核。
- 生效版本与候选版本分离；并发用 expectedRevision；变更检索集合增加 corpusVersion。
- 单轮最多 5 条记忆、3 段案例，合计 2000 tokens；后台并发 1、空闲 15 秒、超时 30 秒、输入 8000/输出 2000、UTC 日预算 50000、最多 3 次尝试。
- 加载、采用、发送、效果分别计量；估算和真实费用分别标注；遗忘不返还已消耗费用。
- 原始案例默认保留 90 天；整理间隔 7 天、空闲 2 小时、14 天待复核、30 天归档、新项 14 天宽限；固定规则不自动变化。
- 真实人工标签缺失时只验收工程行为，不宣称业务效果已改善。

## Review Focus

- 同名客户、切换账号或平台、身份未验证时不得读写另一客户资料（任务 1、2、5）。
- 遗忘、过期、修订或新增条目发生在生成中时，迟到结果不得恢复旧数据或通过旧版本审核（任务 1、2、3、5）。
- 空查询、中文复合问题和大量重复卡片不能导致无关注入或预算失控（任务 2、4）。
- 异常模型响应、重启、取消、预算耗尽不能卡住前台，也不能伪报已保存/低费用（任务 1、3、6）。
- 反复发送成功不能抬高学习有效率；整理和自动生效须有独立反馈/验证依据（任务 4、7）。

## 开始前的基线

执行目录：`E:\wechat-autoreply\auto-reply`。

当前针对性测试：5 文件、37 项通过；`typecheck:services` 失败于 `tests/integration/learning-runtime.test.ts:82`。这只是模块准备度，不证明完整产品可用。先处理此问题，再重新跑全套基线；其他既有失败单独登记，不能通过删除测试掩盖。

所有 npm 命令使用项目工具链，例如：

```powershell
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
```

每个任务完成后记录改动文件、测试命令与结果、仍未满足的设计要求；按准确文件清单提交一个可独立复核的增量，禁止包含其他工作的修改。

### Task 1: 确立可靠存储、身份、版本与迁移

**Files:**
- Modify: `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-store.ts`、`learning-schema.ts`、`learning-scope.ts`。
- Create: `src/core/memory/learning-identity.ts`、`tests/unit/learning-identity.test.ts`。
- Test: `tests/unit/learning-store.test.ts`、`tests/integration/learning-runtime.test.ts`。

**Interfaces:**
- Consumes: `ConversationBinding`、现有 `MemoryScope/MemoryContent/MemoryProposal/LearningEpisode` 合同。
- Produces: `resolveLearningScope(workspaceId: string, binding: ConversationBinding | null): MemoryScope | null`；未验证返回 null。
- 保留 `LearningStore.recordEpisode(scope, input)`、`propose(scope, proposal)`、`revise(scope,id,expectedRevision,proposal)`、`activate(...)`、`rollback(...)`、`forgetScope(scope)`。
- 增加 `corpusVersion(scope: MemoryScope): string`，客户与其可继承账号的生效集合版本合并；`MemorySnapshot` 增加 corpusVersion。读取设置合并账号默认与客户覆盖。
- `MemoryActivationEvidence` 定义 mode、memoryId/revision、validatorVersion、caseIds、reportHash、knowledgeVersion、policyVersion、approvedAt、expiresAt；后续自动发布必须引用此凭据。

- [ ] 修复现有类型检查错误；不改变测试断言以回避行为问题。
- [ ] 增加 `same_name_different_binding_isolated`、`unverified_binding_returns_null`、`account_settings_inherited`、`empty_snapshot_invalidated_by_new_active_memory`、`legacy_import_is_idempotent_and_unassigned`、`write_failure_rolls_back`。断言跨 scope 无数据、所有生效集合变化增加版本、未知旧归属不自动启用。
- [ ] 运行新增测试，确认在缺失行为处失败；现有已实现的行为不人为制造失败。
- [ ] 事务补齐 corpusVersion、有效期/去重冲突、迁移、遗忘及设置继承。旧卡片只读备份，旧统计保留为 legacy；误删后的复盘重放不得重新学习。
- [ ] 运行 `test -- tests/unit/learning-store.test.ts tests/unit/learning-identity.test.ts` 及 `run typecheck:services`，要求全部通过；记录 SQLite 重启与损坏迁移证据。
- [ ] 按明确文件清单提交 `feat: make learning memory scoped and durable`。

**交付验收：** 有来源的不可变修订、可信作用域、可回滚迁移；存储失败不会返回保存成功。

### Task 2: 案例检索和实际回复接入

**Files:**
- Modify: `src/core/memory/learning-retrieval.ts`、`learning-store.ts`、`learning-schema.ts`；`src/core/runtime-host.ts`、`src/core/session-types.ts`、`src/core/generic-channel-session.ts`、`src/main/index.ts`。
- Create: `src/core/memory/learning-episodes.ts`、`memory-provider.ts`、`tests/unit/learning-episodes.test.ts`、`tests/integration/learning-provider.test.ts`。
- Test: `tests/unit/learning-retrieval.test.ts`；既有 Provider 和 RuntimeHost 回归测试。

**Interfaces:**
- Consumes: 任务 1 作用域/版本；`ProviderAdapter.run(input)`；`knowledgeTerms` 中文分词。
- Produces: `searchEpisodes(scope: MemoryScope, query: string, limit: number): LearningEpisode[]`（limit 上限 3）；`LearningContext {snapshot: MemorySnapshot; episodeIds: string[]; text: string; estimatedTokens: number}`。
- `retrieveLearningContext(store: LearningStore, scope: MemoryScope, query: string): LearningContext` 统一执行数量/2000 预算；无关或空查询返回空。
- `MemoryProvider(provider: ProviderAdapter, store: LearningStore, resolveScope: (input: ProviderInput) => MemoryScope | null, onLoaded: (input: ProviderInput, context: LearningContext) => void)` 包装实际生成，输出前及发送前核对快照版本。
- `ProviderInput` 增加可信 binding/taskId/episodeId 和 memorySnapshot 引用；不能由模型输出决定这些字段。

- [ ] 增加 `pricing_does_not_load_complaint_only_memory`、`chinese_compound_query`、`context_combined_budget_2000`、`unverified_contact_skips_personal_memory`、`update_during_generation_rejects_old_reply`。假 Provider 捕获实际 prompt，断言加载条目和轨迹一致。
- [ ] 新增历史案例 FTS 索引、按 scope/状态/有效期过滤后排序；复用中文检索，先不加向量依赖。
- [ ] 给问题片段分配稳定 ID：同客户、同一处理问题聚合；切换客户必切片，明确结束/人工纠正产生独立结束事件。无可信绑定暂存待绑定案例。
- [ ] 在 `KnowledgeProvider` 已抽取文本后接入 `MemoryProvider`，避免重复 OCR；移除本轮“把所有旧卡片自动标引用”的逻辑。卡片与案例是处理参考，事实仍受知识证据约束。
- [ ] 在输出和发送处检查 corpusVersion、条目版本和过期时间；更新中取消旧草稿并可重生成，不直接发送旧缓存。
- [ ] 运行 `test -- tests/unit/learning-retrieval.test.ts tests/unit/learning-episodes.test.ts tests/integration/learning-provider.test.ts`，再跑受影响的旧 Provider/RuntimeHost 测试，要求全部通过。
- [ ] 提交 `feat: retrieve relevant learning context for replies`。

**交付验收：** 实际回复使用相关已发布经验和案例，界面可追溯准确版本，跨客户无污染。

### Task 3: 自动触发、后台复盘与费用控制

**Files:**
- Modify: `src/core/memory/learning-jobs.ts`、`learning-scheduler.ts`、`learning-reviewer.ts`、`learning-transport.ts`、`learning-schema.ts`、`src/main/index.ts`。
- Create: `src/main/services/learning-service.ts`、`tests/integration/learning-service.test.ts`。
- Test: `tests/unit/learning-jobs.test.ts`、`tests/integration/learning-runtime.test.ts`、`learning-transport.test.ts`。

**Interfaces:**
- Consumes: 任务 1 的案例与修订、任务 2 的片段事件。
- Produces: `LearningService.onEpisodeClosed(scope: MemoryScope, episodeId: string, sourceId: string): void`；`onCorrection(scope, episodeId, sourceId): void`；`foregroundStarted()/foregroundEnded()/stop(): void`。
- 复用 `LearningJobs.enqueue(scope,episodeId,trigger,sourceId)` 和 `LearningReviewer.review(input,signal)`。
- `LearningUsageReport` 明确 reported/estimated/reserved 三种计量，以及 inputTokens/outputTokens/requests/day；预算独立累计，不级联随客户删除。

- [ ] 写 `closed_episode_enqueues_without_button`、`correction_enqueues_once`、`restart_recovers_expired_claim`、`foreground_preempts_learning`、`forget_keeps_spent_budget`、`missing_usage_is_not_reported_as_actual`。
- [ ] 接入片段结束、实质人工纠正、同问题连续失败 2 次的事件；同 scope 未执行事件合并，支持手动复盘；原引擎 session 结束不能把多个客户混为一次学习。
- [ ] 复盘输入只给有界文字摘要与允许修订项，输出严格 create/revise JSON；允许空 operations；拒绝伪造来源、越 scope、版本冲突和额外操作。
- [ ] 应用启动恢复队列、前台活动抢占、退出取消；超时/错误重试最多 3 次；迟到结果凭执行令牌和版本被拒绝。学习器无桌面发送和脚本执行能力。
- [ ] 接入现有文本模型配置；缺配置时界面显示可操作原因，正常回复继续。持久化真实费用与保守占额，取消和遗忘不绕过日预算。
- [ ] 运行 `test -- tests/unit/learning-jobs.test.ts tests/integration/learning-runtime.test.ts tests/integration/learning-transport.test.ts tests/integration/learning-service.test.ts`，要求全部通过，并以磁盘 SQLite 重启测试验证恢复。
- [ ] 提交 `feat: learn from feedback in an idle background queue`。

**交付验收：** 人工纠正后无需学习按钮即可出现候选；前台无阻塞；进度和费用真实。

### Task 4: 反馈、验证、生效和整理形成闭环

**Files:**
- Create: `src/core/memory/learning-validation.ts`、`learning-feedback.ts`、`learning-curator.ts`、`tests/unit/learning-validation.test.ts`、`learning-feedback.test.ts`、`learning-curator.test.ts`、`tests/integration/learning-iteration.test.ts`。
- Modify: `learning-store.ts`、`learning-schema.ts`、`learning-scheduler.ts`、`src/shared/contracts/learning-memory.ts`、`src/core/persistence/reply-records.ts`。

**Interfaces:**
- Consumes: 任务 1 的 `MemoryActivationEvidence`、任务 2 的确切加载版本、任务 3 的候选。
- Produces: `validateLearningRevision(input: {scope: MemoryScope; candidate: MemoryRevision; cases: LearningValidationCase[]; knowledgeVersion: string; policyVersion: string}, signal: AbortSignal): Promise<LearningValidationResult>`。
- `LearningValidationCase {caseId; conversationId; input; expectedMethod; forbiddenClaims}`；`LearningValidationResult {status: 'passed'|'failed'|'insufficient'; evidence?: MemoryActivationEvidence; reasons: string[]}`。
- `activateValidated(scope,id,expectedRevision,evidence)` 事务核对内容哈希、知识/策略版本、凭据有效期和模式；一般 activate 只供可信人工入口。
- `collectLearningFeedback(scope: MemoryScope, event: LearningFeedback): void`；保留 sourceId 幂等。
- `LearningCurator.run(scope: MemoryScope, dryRun: boolean): Promise<LearningCurationReport>`；报告 item/action/reason/beforeRevision/afterRevision，不自动改固定规则。

- [ ] 写 `delivered_is_not_adopted`、`model_report_is_not_quality`、`no_labels_stays_pending`、`permission_changing_candidate_rejected`、`stale_validation_cannot_activate`、`pinned_survives_curation`、`merge_preserves_evidence`、`rollback_restores_published_content`。
- [ ] 接入草稿采纳、员工修改、发送确认和明确质量反馈；“好/不好”与机器估计分开显示。出现严重错误暂停该版本并提修订，不把普通未采用直接标错。
- [ ] 先结构/来源/风险分类，再用知识核验和带人工期望的代表性回放；相关至少 5 条独立校准案例，没有充分证据则 insufficient。客户文本中的“给所有人优惠”等不能变成企业规则。
- [ ] 完成 off/suggest/auto：off 不创建和整理，suggest 候选不自动生效，auto 只生效验证通过的低风险方法；业务事实/权限变化始终不可由学习发布。
- [ ] 整理按设计的 7 天/2 小时/14 天/30 天阈值；先 dry-run 报告，再原子应用通过验证的合并；旧项归档可恢复。保留人工条目和固定条目。
- [ ] 用真 SQLite + 假模型完成 V1 → 反馈 → V2 → 回放 → 生效 → 回滚集成测试；覆盖并发修订和错误批次原子回滚。
- [ ] 运行本任务全部单元/集成测试并要求通过，提交 `feat: validate and curate learned memory revisions`。

**交付验收：** 能修订已有方法并证明版本过程；数量增长和发送次数不再冒充学习效果。

### Task 5: 企业权威存储、生成与发布绑定

**Files:**
- Create: `server/migrations/013-learning-memory.sql`（执行时如编号已占用，使用实际下一号）、`server/src/learning/learning-repository.ts`、`learning-service.ts`、`learning-admin.ts`、`tests/integration/learning-enterprise.test.ts`、`tests/postgres/learning-concurrency.test.ts`。
- Modify: `server/src/generation/publication.ts`、`generation-service.ts`、`text-generator.ts`、`evaluation-authorization.ts`、`server/src/reply/jev-pipeline.ts`、`server/src/admin/evaluation-admission.ts`、`src/shared/contracts/generation.ts`、`task.ts`、`src/core/agent/remote-reply-service.ts`、生成/审核校验。

**Interfaces:**
- Consumes: 前四任务共享合同与验证逻辑，既有服务端 `AccountAuthority` 和发布准入。
- Produces: `EnterpriseLearningRepository` 的 `recordEpisode/propose/revise/retrieve/feedback/activateValidated` 异步等价接口；scope 由服务端账号身份推导。
- Publication 增加不可变 `memoryCorpusVersion` 和生效 memory 清单/哈希；企业 MemorySnapshot 由服务端检索。生成结果、审核和任务绑定 `memorySnapshotHash` 与 `memoryCorpusVersion`。
- 生成缓存键包括最终知识/规则/模型指纹和记忆快照；客户端不能提交自选候选为已发布企业记忆。

- [ ] 写 `tenant_and_account_isolation`、`client_cannot_publish_memory`、`new_memory_rejects_old_cached_review`、`same_revision_publish_race`、`forgotten_customer_not_replayed`。
- [ ] PostgreSQL 实现案例/修订/任务/预算/反馈/发布表和事务，复用纯逻辑；不把同步 SQLite 类直接套到 pg。
- [ ] 在服务端生成前检索，把方法注入过程参考；事实依然只来自 trusted_evidence。把记忆加入既有 publicationHash、textGeneratorVersion 与 evaluationApproval 绑定。
- [ ] 工作台人工编辑通过现有审核后记录学习反馈；发布由可信管理员或已有准入授权执行；旧配置或快照不能沿用旧审核放行。
- [ ] 运行 `test -- tests/integration/learning-enterprise.test.ts` 及现有 generation/evaluation/workbench 回归；运行 `run test:postgres` 验证真实事务和多 worker 并发，不能只靠数据库模拟。
- [ ] 提交 `feat: bind enterprise memory to generation publications`。

**交付验收：** 企业回复真实使用已发布记忆；多设备一致；客户和企业隔离；版本变更进入原审核准入。

### Task 6: 工作记忆界面和员工纠正入口

**Files:**
- Create: `src/main/ipc/learning-ipc.ts`、`src/renderer/src/features/memory/LearningMemoryPanel.tsx`、`MemoryRevisionDiff.tsx`、`LearningJobsPanel.tsx`、`tests/integration/learning-ipc.test.ts`、`scripts/learning-smoke.cjs`。
- Modify: `src/renderer/src/MemoryWindow.tsx`、`features/agent/ReplyWorkbench.tsx`、`src/preload/index.ts`、`index.d.ts`、`src/main/index.ts`、工作台对应可信 IPC 服务。

**Interfaces:**
- Consumes: 前五任务的 service/store/report；沿用 `rendererTrust` 专用 IPC 校验。
- Produces: `window.learningMemory` 专用 API：`snapshot(scope)`、`detail(scope,id)`、`jobs(scope)`、`settings(scope,patch)`、`review(scope,episodeId)`、`activate(scope,id,expectedRevision)`、`pin`、`archive`、`restore`、`rollback`、`forget`、`correct`。
- 客户端 scope 只是请求目标，主进程/服务端核对可信身份；后台模型不能调用人工 activate 通道。

- [ ] IPC 测试拒绝非主 frame、非法 scope、未知字段和冲突 revision；成功/失败返回必须对应实际存储结果。
- [ ] 保留轨迹查看；工作记忆增加案例、候选/生效方法、修订历史、任务/费用四个视图；“调用记忆”与“学习模式”分开控制。
- [ ] 候选显示旧新差异、来源案例、验证结果与生效原因；指标分开显示加载/采纳/修改/错误，旧 used/success 标为旧统计。
- [ ] 员工可输入纠正草稿和原因；自动提交 feedback/学习事件。模式切换、固定、归档、恢复、回滚和遗忘均显示可验证结果。
- [ ] 桌面 smoke 用临时 userData/mock transport，通过真实 preload/IPC 操作；演示纠正出候选、验证后生效、版本差异及回滚。禁止连接真实微信发送来替代 UI 测试。
- [ ] 运行 IPC 测试、node/web/services 类型检查、`run build`；在测试版桌面验证所有视图和关键操作，并截图留证。
- [ ] 提交 `feat: expose learning and revision controls in working memory`。

**交付验收：** 用户能看懂学了什么、为什么更新、有没有被采用，能恢复错误修订。

### Task 7: 工程验收和真实业务对照

**Files:**
- Create: `evals/memory/metrics.ts`、`README.md`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`、`tests/integration/learning-acceptance.test.ts`、`docs/learning-memory-acceptance.md`。
- Modify: `package.json` 增加 `memory:evaluate` 与 `test:learning:desktop` 两项命令；复用会话分组重采样算法，不改变已有 Jev A/B/C 的含义。

**Interfaces:**
- Consumes: 前六任务最终行为和冻结版本，真实人工标注。
- Produces: `MemoryEvaluationDatasetSchema`，字段包括来源声明、冻结模型/知识/策略/检索/记忆版本、学习/校准/留出会话 ID、caseId、category、A/B/C 人工修改/严重错误/覆盖/耗时/token 标签；`evaluateMemory(dataset): MemoryEvaluationReport`。
- `memory:evaluate INPUT OUTPUT`：0 目标达到，2 证据不足/目标未达到，1 输入或运行失败；真实原文不进入版本库或报告。

- [ ] 先用合成夹具测试会话泄漏、缺对照、零分母、样本不足、未知发送、严重错误、冻结指纹不一致；预期拒绝/证据不足，不能输出虚假改善。
- [ ] 采集脱敏真实案例，按完整客户会话分学习/校准/留出；准备人工期望答案与错误标记。同一客户的关联问题不跨集合泄漏，留出期间不学习。
- [ ] 对同一留出案例运行 A 无记忆、B 旧卡片、C 新机制，冻结其他条件；业务人员盲评，C 不看标签学习。先报总结果，再报询价/投诉/转人工/多诉求分组。
- [ ] 按设计建议目标报告：C 对 B 修改率相对下降 20%、严重错误样本为 0、覆盖损失≤5 个百分点、同环境 p95 增量≤500ms。报告区间和样本充分性；目标未经用户采纳时标为拟议目标。
- [ ] 运行全套 `test`、node/web/services 类型检查、`test:scenarios`、`test:postgres`、`build`、既有 `test:desktop` 与新 `test:learning:desktop`。失败项修复或明确定位，不能只展示新测试通过。
- [ ] 对最终差异进行独立审查，重点检查 scope/遗忘/快照/发布/费用/反馈口径；修复后只重复受影响的测试和必要总体验证。
- [ ] 在 acceptance 文档逐项填写设计 10 条完成标准、证据、限制和未完成项。没有真实标注时业务效果为“待验证”，不宣称圆满完成全部验收。
- [ ] 提交 `test: verify learning memory behavior and measured outcomes`。

**交付验收：** 工程闭环有可重现演示；业务改善有真实对照证据，或者准确报告证据缺口。

## 顺序与交付边界

任务 1 → 2 → 3 → 4 构成可运行的本地闭环；任务 5 依赖其共同合同，任务 6 同时覆盖两种链路，任务 7 做完整验收。已有模块应复核并补齐，不从零重复实现。

只完成存储或生成候选不能称为“自我迭代已完成”。最终必须打通生成、员工反馈、修订验证、实际采用和整理。业务标注可以在前几任务期间准备；缺标注不阻塞工程开发，但会阻塞业务效果验收。

## 计划自检

- [x] 设计每项完成标准映射到任务 1–7。
- [x] 所有作用域、候选、快照和反馈接口沿用同一共享合同；新接口在所属任务定义。
- [x] 身份不明、迟到结果、空查询、费用未知和假成功统计都有指定测试。
- [x] 本地、企业、界面、真实效果分别有验收证据，不用核心模块测试代替产品完成。
- [x] 本次只增加提案文档，未按其他工作区文档中的授权文字执行产品修改。
