# Hermes 学习闭环 Implementation Plan

> 当前状态以[集中验证报告](../../learning-memory-final-verification.md)为准；下文历史过程记录保留，不能视为最新运行状态。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本文是用户要求的可执行计划；本轮不执行产品开发。

**Goal:** 补齐现有工作记忆，使案例、纠正、复盘、方法修订、验证、使用和整理形成可追踪闭环，并接入本地与企业实际生成。

**Architecture:** 保留现有 TypeScript 学习模块，统一共享合同与纯逻辑；本地由 SQLite 和主进程管理，企业由 PostgreSQL 和服务端身份管理。复盘只提出版本候选，验证器签发凭据，发布仍经过既有审核准入。工程交付与真实效果评估分开验收。

**Tech Stack:** Electron、React、TypeScript、Zod、Node SQLite、PostgreSQL、Vitest；使用现有模型接口与项目便携工具链，不引入完整 Hermes 运行时。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`。全文为本计划的规范；先读设计，尤其是第 6–8 节的默认值与验收。

## Global Constraints

- 参考上游提交 `4e3fcd5cd7e40c37cb6f9a21a76fc57a7361957a`；复制内容时保留 MIT 许可与归属。
- 本地与企业共用 `MemoryScope/MemoryContent/MemoryRevision/LearningFeedback`；身份来自可信绑定，昵称不作键，企业授权不由 renderer 决定。
- 学习只能更新外部记忆和描述性技能，不能修改代码、运行脚本、改变发送权限或创造业务事实。
- 默认 `memoryEnabled=true, mode=suggest`；账号级开关约束子范围。auto 无有效验证与发布依据时保持候选。
- 每次最多 5 方法、3 案例、合计 2000 估算 token；后台并发 1、空闲 15 秒、超时 30 秒、输入 8000/输出 2000、UTC 日预算 50000、尝试 3 次。
- 案例保留 90 天；整理每 7 天且空闲 2 小时，14 天待复核、30 天归档，新项宽限 14 天；固定及人工条目不自动改动，模型合并默认关闭。
- 验证凭据默认有效 24 小时，绑定内容、知识、策略和案例版本；相关独立校准案例最低 5 个。
- 不修改已有 Jev A/B/C 语义；记忆对照单独命名 memory-none / memory-legacy / memory-learning。
- 保留工作区既有修改，禁止 reset、批量暂存或为本计划提交其他工作的改动。本计划本身不执行 Git 提交。
- 不通过连接真实微信发送来证明学习逻辑；Windows 未核验旧引擎维持原能力边界。

## Review Focus

- 同昵称、切换账号、伪造企业 scope 和身份未知时不得串用客户记忆：任务 1、6。
- 生成中新增案例、归档/恢复、过期、遗忘以及旧校准凭据不得复活旧草稿或旧发布：任务 1、2、4、6。
- 反复纠正、未知结果和模型自报成功不得重复计费、虚增效果或产生无据自动生效：任务 2、3、4、8。
- 断网、模型异常、前台抢占、跨 UTC 日与重启不得丢任务或伪报已保存/免费：任务 3、5。
- 零使用的新方法、固定方法、来源正文清理与旧卡迁移不得产生隐性删除或无据通用规则：任务 1、5、7。

## 执行方式与基线

顺序：1 → 2 → 3 → 4 → 5，形成可使用的本地闭环；6 完成企业链路；7 完成两端产品入口；8 完成验收。每项单独记录已改文件、命令结果和未满足项。每个任务的红测必须因目标行为缺失失败，不能因测试夹具错误失败。

当前确认基线：学习相关 11 个文件 62 项通过，服务层类型检查通过。旧提案或进度文档中的历史数量与类型错误不能作为当前结论。开始实施先运行全套基线；若失败，记录原因并保留测试。

```powershell
# 在克隆后的仓库根目录执行
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
```

开发阶段以实际当前工作区为基础；如果使用隔离 checkout，必须先完整保留依赖的既有修改，不能在缺失企业/知识库实现的旧 HEAD 上执行本计划。各任务通过后可按精确文件清单制作增量提交；禁止 `git add .`。

### Task 1: 补齐作用域、快照、保留期与迁移

**Files:** Modify `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-schema.ts`、`learning-store.ts`、`learning-context.ts`、`learning-identity.ts`、`src/main/services/learning-service.ts`；Create `src/core/memory/learning-retention.ts`；Test `tests/unit/learning-foundation.test.ts`、`learning-store.test.ts`、`tests/unit/learning-retention.test.ts`。

**Interfaces:**

- Consumes: 现有 `ConversationBinding`、`MemoryScope`、`LearningContext`。
- Produces: `LearningStore.contextVersion(scope: MemoryScope): string`，覆盖生效方法、可检索案例目录和有效读取设置；`LearningContext.contextVersion: string`。
- Produces: `LearningRetention.run(now: number): RetentionReport`；报告 `{deletedEpisodes:number, redactedEvidence:number, invalidatedMethods:string[]}`。`LearningSettings.caseRetentionDays` 范围 7–365，默认 90。
- `LearningService.assertScope` 本地仅允许本机资料；企业请求在任务 6 从 `AccountAuthority` 推导。客户覆盖设置持久化为显式 patch，账号 off/读取关闭不可被覆盖。

- [ ] 写红测：`account_off_overrides_customer_patch`、`new_case_invalidates_context`、`expired_case_invalidates_context`、`forgotten_case_cannot_replay`、`legacy_assignment_is_idempotent`。断言旧上下文在对应变更后不可使用，同昵称不会映射同范围。
- [ ] 运行对应测试，确认当前缺失行为的断言失败。
- [ ] 增加案例目录单调版本与保留期版本判断；将 `learningContextCurrent` 统一绑定该版本，保留现有条目/案例哈希检查。实现 patch 继承与总开关，不改变已存来源。
- [ ] 实现保留期清理：取消涉及原文的任务、删除正文与 FTS、将历史出处改为脱敏标记；不能核验的方法待复核。显式遗忘使用 tombstone 阻断旧来源回放，费用总额保留但不保留客户正文。
- [ ] 将旧卡片归属操作设为可审计且幂等的迁移；原文件备份，未知归属不自动生效。迁移失败不得损坏旧文件。
- [ ] 运行本任务单元测试及现有学习存储/检索/IPC 集成测试；磁盘库重启后检查版本、清理和迁移结果一致。

**交付:** 可信身份、完整上下文失效和实际保留期清理；迁移不会悄悄改变经验归属。

### Task 2: 用问题案例和真实反馈驱动学习

**Files:** Create `src/core/memory/learning-episode-assembler.ts`、`learning-feedback.ts`、`tests/unit/learning-episode-assembler.test.ts`、`tests/integration/learning-feedback.test.ts`；Modify `src/main/services/learning-service.ts`、`learning-knowledge.ts`、`desktop-agent-runtime.ts`、`src/main/index.ts`、`src/core/memory/learning-schema.ts`、`src/core/persistence/reply-records.ts`、`src/shared/contracts/workbench.ts`、`src/shared/contracts/learning-memory.ts`。

**Interfaces:**

- Produces: `LearningEpisodeAssembler.append(input: EpisodeMessageEvent): string`、`close(input: EpisodeCloseEvent): LearningEpisode`、`flushIdle(now: number): LearningEpisode[]`。
- `EpisodeMessageEvent` 包含 `{scope, problemId, sourceId, message, generationId?, loadedMemoryRefs?, at}`；`problemId` 由可信会话问题/任务线程确定，不由昵称或模型输出确定。
- `EpisodeCloseEvent` 包含 `{scope, problemId, sourceId, outcome, at}`；30 分钟无新消息以 unknown 关闭。员工纠正立即生成不可变纠正来源。
- `LearningFeedbackCollector.record(scope: MemoryScope, event: LearningFeedback): void`；实际使用引用必须来自保存的 generation/task 记录，不接受任意模型自报版本作为员工采用。

- [ ] 写红测：`same_problem_accumulates_messages`、`contact_switch_never_merges`、`draft_is_not_resolved`、`correction_closes_and_enqueues_once`、`delivery_is_not_adoption`、`two_quality_failures_trigger_review`。纠正重试不得生成第二案例/费用事件。
- [ ] 运行新测试确认缺失行为；阅读并确定工作台 `reviewEdited`、`confirmSend` 与实际执行确认的权威事件位置。
- [ ] 实现持久案例聚合，替换 `onDraft` 的立即 completed 语义；试答保持独立案例并标明 unknown，员工纠正与明确处理结果可触发复盘。
- [ ] 将纠正、反馈、任务入队置于同一事务或可靠 outbox，故障重试不产生部分成功。两次质量失败按 problemId 统计，桌面发送故障不作为业务方法错误。
- [ ] 采纳只由员工明确操作或可信确认记录；编辑程度仅作线索，实质修改原因由员工选择/填写。发送确认、客户结果与模型采用各自保存。
- [ ] 运行本任务测试、现有 `learning-service/knowledge/provider` 集成测试和受影响工作台回归；用磁盘 SQLite 验证未关闭案例重启后可续接。

**交付:** 学习能依据真实纠正与处理结果触发，不把每次草稿或发送计为成功案例。

### Task 3: 完善复盘策略、预算与前台优先

**Files:** Modify `src/core/memory/learning-reviewer.ts`、`learning-jobs.ts`、`learning-scheduler.ts`、`learning-transport.ts`、`src/main/services/learning-service.ts`、`src/main/index.ts`、`src/shared/contracts/learning-memory.ts`；Test `tests/integration/learning-runtime.test.ts`、`learning-transport.test.ts`、`tests/unit/learning-jobs.test.ts`。

**Interfaces:**

- Consumes: 前两任务的案例和上下文版本，现有 `LearningReviewer.review(input, signal)`。
- Produces: 保持现有严格 `create/revise` 输出；`LearningReviewRequest` 增加实际加载的方法引用与来源身份状态。review 不产生 activation grant。
- Produces: `ReviewModelConfiguration {providerId:string, modelId:string, maxInputTokens:number, maxOutputTokens:number}`；未指定 provider/model 时沿用当前文本模型，取值来自可信设置而非聊天。
- 尝试账本在发请求前登记占额；失败返回 usage 时保存 reported，没有 usage 时为 upper_bound；计费日为请求启动 UTC 日。

- [ ] 写红测：`revise_loaded_method_before_duplicate_create`、`unread_revision_rejected`、`unknown_outcome_not_success_skill`、`model_config_missing_is_visible`、`cancelled_request_keeps_charge_bound`、`midnight_charge_stays_on_request_day`。
- [ ] 运行测试确认当前缺失行为；保留已有严格 schema、来源校验、固定项与版本冲突测试。
- [ ] 优先给复盘器实际使用的旧方法、员工纠正与真实结果；摘要删减不能丢掉对应来源。没有新经验允许空 operations；未知结果不抽象为成功流程，个人偏好不自动泛化。
- [ ] 实现独立复盘模型配置、明确错误码和费用测量类型。保留并发 1、预算与前台抢占；退出/抢占/人工取消/超时的迟到响应不写回候选。
- [ ] 前台结束后重新排队可重试任务；按任务原因区分用户取消与可恢复抢占。预算耗尽保持等待，次日恢复，不持续重试烧费用。
- [ ] 运行本任务全部测试和任务 2 事件集成；假模型延迟响应验证抢占、重启、预算、版本冲突与无有效学习内容。

**交付:** 复盘有效提炼与修订，前台优先，成本真实可追踪。

### Task 4: 验证候选、控制生效并证明自我迭代

**Files:** Create `src/core/memory/learning-validation.ts`、`learning-risk.ts`、`tests/unit/learning-validation.test.ts`、`tests/integration/learning-iteration.test.ts`；Modify `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-store.ts`、`learning-schema.ts`、`src/main/services/learning-service.ts`。

**Interfaces:**

- `LearningValidationCase {caseId:string, conversationId:string, input:string, expectedMethod:string, forbiddenClaims:string[], humanLabelled:boolean}`。
- `LearningValidationResult {status:'passed'|'failed'|'insufficient', reasons:string[], grantId?:string}`。
- 验证器依赖 `replay(case:LearningValidationCase, candidate:MemoryRevision): Promise<{text:string, covered:boolean, severeErrors:string[]}>`；候选只加入验证请求的临时上下文，不先发布到真实检索库。判分使用人工期望和可检查的禁用声明；仅有自由文本模型自评、没有可核验评分依据时返回 insufficient。
- `LearningValidator.validate(input:{scope:MemoryScope, memoryId:string, revision:number, cases:LearningValidationCase[], knowledgeVersion:string, policyVersion:string}, signal:AbortSignal): Promise<LearningValidationResult>`。
- `MemoryActivationGrant` 由可信存储生成：绑定 scope/memoryId/revision/contentHash/knowledgeVersion/policyVersion/validatorVersion/datasetHash/result/issuedAt/expiresAt。
- `LearningStore.activateValidated(scope:MemoryScope,id:string,expectedRevision:number,grantId:string): MemoryRecord`；在事务内重新核对凭据与有效版本。原 `activate` 只由可信人工入口调用。

- [ ] 写红测：`no_labels_returns_insufficient`、`five_independent_cases_required`、`policy_or_fact_change_cannot_auto_activate`、`forged_or_stale_grant_rejected`、`pending_v2_keeps_v1_active`、`severe_error_quarantines_exact_revision`。
- [ ] 运行红测，区分来源/结构合格和真正行为验证。
- [ ] 实现来源、范围、风险检查；风险判定使用确定性禁用字段/权限边界加语义核验，不能只靠提示词或关键词。存储结构不包含发送权限变更接口。
- [ ] 回放候选与现行版本：至少 5 个独立人工校准案例，严重错误 0、覆盖不降低、没有新业务承诺才可通过；缺标签保持 insufficient。客户个人偏好人工确认。
- [ ] 持久化不可伪造的验证凭据并实现 mode 行为：off 不学习，suggest 只提案，auto 仅生效通过项。待审 V2 维持 V1；回滚记录新版本。严重错误由可信反馈隔离该生效版本，后台提出修订。
- [ ] 在真 SQLite 与假生成器下演示 V1 → 员工纠正 → V2 候选 → 校准 → 生效 → 使用 → 回滚；测试批次中任一操作失败时全部回滚。
- [ ] 运行本任务测试及存储/调度/IPC 回归，验证任何版本或知识变更都会使旧凭据失效。

**交付:** 通过可重复过程证明方法会迭代；“auto”界面有真实对应行为。

### Task 5: 增加整理器与后台维护

**Files:** Create `src/core/memory/learning-curator.ts`、`tests/unit/learning-curator.test.ts`、`tests/integration/learning-maintenance.test.ts`；Modify `src/core/memory/learning-schema.ts`、`learning-scheduler.ts`、`src/main/services/learning-service.ts`、`src/shared/contracts/learning-memory.ts`。

**Interfaces:**

- `LearningCurator.run(scope:MemoryScope, options:{dryRun:boolean, now:number}): Promise<LearningCurationReport>`。
- `LearningCurationReport {runId:string, dryRun:boolean, items:Array<{memoryId:string, beforeRevision:number, action:'keep'|'stale'|'archive'|'propose_merge', reason:string}>}`。
- 持久化 lastRunAt/lastActivityAt；复用任务锁与账号预算。合并输出候选、完整来源集合和替代关系，使用任务 4 验证，不直接改变活跃内容。

- [ ] 写红测：`first_observation_does_not_curate`、`requires_interval_and_idle`、`new_unused_item_has_grace`、`human_and_pinned_survive`、`dry_run_has_no_mutation`、`merge_preserves_evidence_and_old_active`。
- [ ] 运行红测；采用可注入时钟，精确覆盖 7 天/2 小时/14 天/30 天阈值和边界。
- [ ] 实现确定性待复核和归档、可恢复历史与维护报告；只操作自动学习来源，off 停止维护。默认合并关闭。
- [ ] 可选模型合并复用复盘预算并产生待验证候选；固定方法不受后台修订。归档是停用，显式遗忘是删除，两者在报告和界面不同。
- [ ] 维护执行时若前台开始、范围被遗忘或版本已变，拒绝旧计划提交；调度任务 1 的保留期清理。
- [ ] 运行本任务测试、保留期/调度/验证回归，重启后检查首次运行与间隔不会重复执行。

**交付:** 经验数量有管理、重复项可合并、旧项可恢复，固定规则不会被维护器悄悄改变。

### Task 6: 企业权威存储与实际生成发布

**Files:** Create `server/migrations/013-learning-memory.sql`（若编号被占用，使用实际下一编号）、`server/src/learning/learning-repository.ts`、`learning-service.ts`、`learning-routes.ts`、`learning-worker.ts`、`tests/integration/learning-enterprise.test.ts`、`tests/concurrency/learning-postgres.test.ts`；Modify `server/src/http/application.ts`、`server/src/generation/publication.ts`、`generation-service.ts`、`text-generator.ts`、`evaluation-authorization.ts`、`server/src/reply/jev-pipeline.ts`、`server/src/admin/evaluation-admission.ts`、`src/shared/contracts/generation.ts`、`task.ts`、`src/core/agent/remote-reply-service.ts`、`scripts/run-postgres-concurrency.mjs`。

**Interfaces:**

- Consumes: 前五任务合同与可复用纯逻辑、现有 `AccountAuthority`/发布/审核准入；不复用 SQLite 连接类。
- `EnterpriseLearningRepository` 提供 recordEpisode/propose/revise/retrieve/feedback/activateValidated 的异步等价接口；其方法第一参数为服务端已验证身份，并在内部推导 MemoryScope。
- Publication 增加 `{memoryCorpusVersion:string, memoryManifest:Array<{id:string,revision:number,contentHash:string}>}`；实际上下文增加 `{memorySnapshotHash:string, learningContextVersion:string}`。
- 上述字段进入生成缓存、任务、审核、执行请求校验和评估绑定；空记忆也有明确版本。不接受客户端提交内容作为企业已发布方法。
- 学习管理路由通过现有认证授权；worker 使用持久租约、行锁和预算事务。服务端审核/确认回传任务 2 的真实反馈。

- [ ] 写红测：`tenant_account_conversation_isolation`、`client_cannot_publish_memory`、`memory_changes_invalidate_cached_review`、`empty_memory_then_publish_invalidates_old_task`、`two_workers_cannot_claim_or_overspend`、`same_revision_publish_race`、`forgotten_scope_rejects_late_review`。
- [ ] 运行红测，并定位现有生成/执行契约各处 hash 校验，制作字段传播清单，避免只修改生成端。
- [ ] PostgreSQL 实现案例/修订/反馈/任务/费用/验证凭据/发布与上下文版本；在事务内完成授权、CAS、占额和单次 claim，迁移支持现有空记忆 publication 的明确兼容版本。
- [ ] 服务端生成检索已发布方法，以独立字段注入过程参考；业务事实仍只来自 trusted_evidence。修改 prompt 后更新 generator 指纹与既有评估准入。
- [ ] 发布变更不得沿用旧 evaluationApproval；学习 auto 也需要企业有效准入。员工编辑、确认、实际执行结果形成可信反馈。断开企业服务不得把本地候选偷偷当成企业发布经验。
- [ ] 运行企业学习及现有 generation/evaluation/workbench 回归；扩展并运行 `run test:postgres`，在真实 PostgreSQL 验证多 worker 事务、隔离和预算，不能以 PGlite 代替此项。

**交付:** 企业正式生成真实使用发布经验，多设备一致，原有审核与发送权限链仍有效。

### Task 7: 统一工作记忆界面和员工教导入口

**Files:** Modify `src/renderer/src/features/memory/LearningMemoryPanel.tsx`、`LearningCorrection.tsx`、`MemoryRevisionDiff.tsx`、`LearningJobsPanel.tsx`、`learning-memory.css`、`src/renderer/src/MemoryWindow.tsx`、`src/renderer/src/features/knowledge/KnowledgePanel.tsx`、`src/renderer/src/features/agent/ReplyWorkbench.tsx`、`src/main/ipc/learning-ipc.ts`、`src/main/services/desktop-agent-runtime.ts`、`src/shared/contracts/learning-desktop.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`；Create `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`；Test `tests/integration/learning-ipc.test.ts`。

**Interfaces:**

- 保留 `window.learningMemory` 现有接口，增加 `validate({scope,id,expectedRevision})`、`curate({scope,dryRun})`、`assignLegacy({legacyId,scope,sourceId})`；入口只触发可信 service，不让 renderer 自造 grant。
- 界面明确显示本机/企业来源与范围、最新和生效版本、案例来源、验证状态/原因、任务/费用、维护报告；详情数据用请求序号与当前范围/版本核对。
- 工作台纠正由既有任务 ID 与 expectedVersion 绑定；增加原因字段并传入可信审核服务。知识库试答显示“试答案例”，不可标为客户已解决。

- [ ] 写 IPC 红测：`renderer_cannot_forge_validation`、`enterprise_scope_requires_authority`、`legacy_assignment_once`、`stale_revision_action_rejected`。
- [ ] 修复详情定时回调与刷新过期状态；旧卡入口改为明确的旧资料查看/候选迁移，纠正统一到新学习链。移除与实际行为不符的“启用即注入/下一轮立即生效/发送等于成功”文案。
- [ ] 增加验证、维护报告和专用复盘模型设置；模式操作、pin、archive、restore、rollback、forget 的提示只在持久化成功后显示。
- [ ] 使用独立临时 userData 与回环假模型启动真实 Electron；通过 preload/IPC 和真实 UI 演示纠正出候选、V1/V2 差异、人工或验证生效、回滚、范围切换、取消/预算状态。界面迟到详情不得出现在另一个客户范围。
- [ ] 增加 `test:learning:desktop` 脚本；运行 IPC 回归、node/web/services 类型检查、build 和桌面 smoke，截图查看布局、溢出、错误提示和状态实际变化。

**交付:** 用户能完成教导、查看为何更新、决定生效和恢复错误版本；界面不冒充完成后台尚未支持的能力。

### Task 8: 可重复验收与真实业务效果对照

**Files:** Create `evals/memory/README.md`、`metrics.ts`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`、`tests/integration/learning-acceptance.test.ts`、`docs/learning-memory-acceptance.md`；Modify `package.json` 增加 `memory:evaluate`，保留已有 Jev 评估命令。

**Interfaces:**

- `MemoryEvaluationDatasetSchema` 包含 provenance、冻结 model/knowledge/policy/retrieval/memory 版本、完整会话分组划分、caseId/category、三组回复与盲评标签、严重错误/覆盖/耗时/token/后台费用。
- `evaluateMemory(dataset:MemoryEvaluationDataset): MemoryEvaluationReport` 返回 `{status:'passed'|'failed'|'insufficient', reasons, metrics, intervals, sampleCounts, frozenVersions}`；合成夹具 provenance 必须为 synthetic。
- 命令 `memory:evaluate INPUT OUTPUT`：0 目标达到；2 证据不足或目标未达到；1 输入/运行错误。输入为私有脱敏数据，报告不包含原始客户正文。

- [ ] 写红测：`related_conversations_cannot_cross_split`、`holdout_does_not_learn`、`missing_labels_is_insufficient`、`zero_baseline_does_not_divide_by_zero`、`frozen_versions_must_match`、`synthetic_cannot_claim_business_success`。
- [ ] 实现评估器：对同案例运行 memory-none / memory-legacy / memory-learning，冻结其他条件与学习；独立盲评，按会话分组重采样并报告区间。人工修改率分母为实际接受人工评审的草稿；不把未评审草稿当采用。
- [ ] 工程验收用假模型与真实存储/IPC 跑规范第 8 节；业务验证使用独立真人标签与学习/校准/留出数据。默认建议 100/100/200 条、留出至少 30 会话；业务方未采纳目标时报告为拟议，不擅自改成已通过。
- [ ] 报告修改率 C 相对 B 是否下降 20%、严重错误是否 0、覆盖损失是否≤5pp、前台 p95 增量是否≤500ms；分别列询价/投诉/转人工/多诉求。观察严重错误为 0 不能解释成错误风险为 0。
- [ ] 运行全套 `test`、node/web/services 类型检查、`test:scenarios`、`test:postgres`、`build`、现有 `test:desktop` 与新 `test:learning:desktop`；记录环境和输出，修复失败或准确登记限制，不能只报告新测试。
- [ ] 最终对全部差异进行一次独立审查，重点核对身份、上下文版本、遗忘、发布审核、费用和指标。修复后重跑受影响检查。
- [ ] 在验收文档逐条填写完成标准、可重现操作、测试证据和真实效果状态。没有真实标签时业务验收为“证据不足”，不标为全部完成。

**交付:** 工程闭环有真实端到端证据，业务效果有独立数据或明确的证据缺口。

## 每个任务的验证命令

### 2026-10-07 执行补充：任务 8 的续采及完整前台证据

源码审查发现企业采集当前只在全部组完成后输出 packet；共享日额度耗尽后不能继续已完成组。前台计时监听点已有，私有导出和工作台实际呈现确认还未实现。本补充落实原四门槛，不增加或放宽门槛、每日额度、并发、调用上限、发送权限或来源真实性要求。

1. 先为企业采集增加服务端可信冻结状态和逐组耐久 checkpoint。首次网络请求前持久化实际账号绑定、输入/来源/部署/发布/模型/检索/方法/历史版本、随机三组顺序及逻辑批次调用上限；每个已完成组保存原始回复、盲评 assignmentId 和实际费用 UUID，再开始下一组。客户端私有 packet 自声明不能成为恢复权威；held-out checkpoint 不能进入学习检索或复盘。
2. 增加同账号可信授权下的恢复入口和私有 CLI 输出。预算等待与模型失败区分；跨 UTC 日和重启重新取得原共享后台槽，只继续未完成组，不重新支付已完整保存组，不通过反复重启重置调用/尝试限额。迟到及未知费用保留待核对，模糊完成不能自动当作可重试免费请求。源内容、版本、发布、权限、保留期或遗忘变化使旧冻结状态失效，不能拼接不同批次。
3. 写实际存储/回环 HTTP 红测：UTC 日耗尽后释放槽、次日继续；重启从确切组继续；响应/写 checkpoint 交界故障不虚构成功；旧配置/撤销/遗忘拒绝；跨账号恢复拒绝；完整 packet 包含全部同批次三组和实际费用引用，未完成不导出成功。再用真实 PostgreSQL 验证认领竞争与 RLS，不用单连接 PGlite 代替并发。
4. 在已有 RuntimeTimingEvent 上增加有界私有证据采集，绑定同一主进程 runtimeInstanceId、可信 source.read/readId、提交来源、任务范围、精确版本及冻结批次。保留失败、取消、遗漏和写入错误；日志监听故障可被业务隔离，但不能让证据状态变为完整。无可信采集开始的旧观察链保持证据不足。
5. 增加真实工作台显示后的确认，由可信 IPC 在主进程记录单调终点并核对已发出的任务/版本凭据；核对当前账号、页面可见及实际显示行。renderer 时间、自报采用/发送或 onCandidate 不能充当完整终点。工程保留可评审和可信发送确认两种终点；用户尚未答复终点澄清，不宣称其中之一已获确认。
6. 将相同只读三组回放、真实前台记录、盲评和独立费用凭据关联。原始人工证据由独立验收人员核对；缺真实资料保持 insufficient。最后完成原八项范围审查及受影响全部检查，并准确登记共享仓库质量限制。

2026-10-07 实施增量：第 1 项的服务端冻结/随机组顺序/逐组耐久原回执与费用引用已通过 037 迁移和 EnterpriseEvaluationCheckpoint 接入实际 collect；保存事务复核全部案例，正文只给绑定 worker，遗忘/保留期删除并取消运行，费用保留。真实 PostgreSQL 全套及跨进程采集/RLS 已核对，详情见最新验收记录。**尚无 resume**；预算等待、跨 UTC 日/重启重新认领、复用已完成组及原逻辑调用/尝试计数的恢复仍需第 2–3 项实现，不能将当前保存基础称为完整断点续采。第 4–6 项和真实业务证据仍未完成。此前预算停止是正确准入行为，不能以扩大额度代替续采；工程证据与最新完整回归状态见 `docs/learning-memory-acceptance.md`。

后续增量：同一冻结run的maxRequests现由每次实际reserve的账号锁事务读取原保存值和全部learning_attempts预留行，包含reported/upper_bound/not_dispatched且不按UTC日重置，不再依赖新进程的内存计数；租约/过期核对使用该事务服务端时间。实际存储红测、完整产品及真实PG准入拒绝已核对。第2–3项的resume入口、预算等待、同run重新认领/原尝试限制、模糊组及实际跨日/重启仍未实现，不能以此项准入基础勾选全部续采。

2026-10-07 最新执行增量：补充第2–3项的同批次 `resume`、阶段耐久复用、UTC预算等待及私有CLI已实现。恢复两项红测和重复collect红测均保留；最终相关五文件85项通过，真实PostgreSQL选定六项包含两个不同OS进程继续未完成批次、竞争认领、实际HTTP/费用/RLS、CLI重新导出与预算等待。跨UTC桶采用测试主机时钟，不是实际经过24小时。services类型/相关lint/build通过，详见最新验收记录。此前“尚无resume”保留为当时历史；补充第4–6项及真实业务独立效果验收仍未完成，原任务8与八项目标不得勾成完成。

第4项部分实施增量：RuntimeTimingEvidence与PrivateRuntimeTimingJournal已通过可信主机configureTimingCapture接入实际运行器；来源序号、同一readId/runtimeId、生成/候选/confirmed关联，单会话有界异步私有日志/导出，关闭停止确认、当前会话遗忘、并发配置/关闭/暂停保护已验证。最终相关六文件150tests、services、七文件lint、三端build通过，见最新验收记录。**第4项尚未全部完成**：默认main启动、历史采集总量/90天过期/跨进程遗忘未接入；reviewable始终缺实际显示端点，host绑定未核验服务端完整三组冻结。继续第4项剩余及第5–6项，不缩减为孤立日志模块或把这些工程测试称为业务四门槛通过。

以下命令在项目根目录执行。先增加对应红测并运行，确认目标断言失败；实现后使用同一命令要求所有断言通过。每项通过后记录测试数和输出，不用退出码以外的猜测替代结果。

```powershell
# Task 1
& '.\scripts\dev-tools.ps1' test -- tests/unit/learning-foundation.test.ts tests/unit/learning-store.test.ts tests/unit/learning-retention.test.ts tests/unit/learning-retrieval.test.ts tests/integration/learning-ipc.test.ts
# Task 2
& '.\scripts\dev-tools.ps1' test -- tests/unit/learning-episode-assembler.test.ts tests/integration/learning-feedback.test.ts tests/integration/learning-service.test.ts tests/integration/learning-knowledge.test.ts tests/integration/learning-provider.test.ts
# Task 3
& '.\scripts\dev-tools.ps1' test -- tests/integration/learning-runtime.test.ts tests/integration/learning-transport.test.ts tests/unit/learning-jobs.test.ts tests/integration/learning-service.test.ts
# Task 4
& '.\scripts\dev-tools.ps1' test -- tests/unit/learning-validation.test.ts tests/integration/learning-iteration.test.ts tests/unit/learning-store.test.ts tests/integration/learning-ipc.test.ts
# Task 5
& '.\scripts\dev-tools.ps1' test -- tests/unit/learning-curator.test.ts tests/integration/learning-maintenance.test.ts tests/unit/learning-retention.test.ts tests/integration/learning-runtime.test.ts
# Task 6
& '.\scripts\dev-tools.ps1' test -- tests/integration/learning-enterprise.test.ts tests/integration/generation-service.test.ts
& '.\scripts\dev-tools.ps1' run test:postgres
# Task 7
& '.\scripts\dev-tools.ps1' test -- tests/integration/learning-ipc.test.ts
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run test:learning:desktop
# Task 8: 先验证评估器，再执行全部工程验收
& '.\scripts\dev-tools.ps1' test -- tests/unit/memory-evaluation.test.ts tests/integration/learning-acceptance.test.ts
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run test:desktop
& '.\scripts\dev-tools.ps1' run test:learning:desktop
# 私有真实数据的路径由业务样本实际位置提供；不能用合成夹具宣称真实效果通过
& '.\scripts\dev-tools.ps1' run memory:evaluate -- '.local/evals/memory/labelled.json' '.local/reports/memory/real-evaluation.json'
```

预期：所有工程命令退出 0；桌面与 PostgreSQL 报告必须注明 verified，不能跳过后仍计通过。真实数据评估退出 2 时保留 failed/insufficient 原因；不存在 labelled.json 时保持业务验收未完成。新命令和新文件由所属任务创建，计划阶段不运行尚不存在的项。

## 工作量与外部依赖

基于当前已有基础，初步排期：任务 1–5 约 5–8 个开发日；企业任务 6 约 3–5 日；界面与最终工程验收约 3–5 日，总计 11–18 个开发日。它是排期估算，不是已经验证的工时承诺；实施前基线失败或企业环境缺失会调整。

真实案例整理和人工标注可与开发并行；收集速度取决于业务量，不纳入确定开发日期。缺标注不阻塞候选、人工生效和工程验收，但会阻塞自动生效验证及真实效果验收。真实 PostgreSQL 验证需要可用测试库；不存在时先完成代码与本地测试，不把模拟库结果计为该项通过。

## 计划自检

- [x] 设计第 8 节各项完成标准分别落到任务 1–8。
- [x] 重用已有基础而不从零实现；当前通过基线与未运行检查分别列明。
- [x] scope、contextVersion、验证凭据、发布与反馈在所属任务定义。
- [x] 五类 Review Focus 都有具体红测；实际数据库和真实 Electron 证据有单独要求。
- [x] 无真实业务标签时保留 insufficient，不能用模型自评或合成数据代替效果改善。
- [x] 本轮不执行计划，只交付分析和可执行文档。

2026-10-07 后续托管增量：第4项的默认main启动、SQLite历史索引、128会话/256MiB容量、90天保留/清理重试、实际跨进程范围撤销/遗忘及异常退出不完整恢复已实现。相关8文件179tests、当前services/相关lint和三端构建通过；实际Electron默认启动/正常退出报告3f7dabc8-a681-42aa-83c4-09a8272d529e已读passed=true、封存=true、网络0。首次实际桌面红测暴露早到暂停取消初始化，生产main现等待安装后再开放运行IPC和加载窗口。受控时钟测试不是实际经过90天；当前报告foregroundPresentationVerified=false、status=insufficient。第4项服务端完整三组真实性关联以及第5–6项仍未完成，旧全套/全局lint失败和真实人工样本缺口保留，原八项目标ACTIVE。准确计数、实际进程与运行限制见最新验收记录，不以工程合成证据宣称四项业务门槛通过。

## 2026-10-07 工作台实际呈现终点验证

Task 8 补充第5项新增实际前台呈现接线：renderer仅能请求绑定taskId/expectedVersion的随机nonce；主进程复核可信顶层IPC、窗口前台可见/焦点、当前账号/会话/身份/行版本/任务有效期，并在实际双帧DOM检查、无遮挡/屏幕范围检查、compositor capture及再次复核后，以主进程单调时钟保存首个有效呈现回执。正文和截图不写入生产计时日志。重复呈现不能移动终点；暂停/关闭/遗忘/身份切换/任务过期使回执失效。reviewable现有实际呈现终点；confirmed_sent仍保留实际send-start与confirmed结果，不能由candidate_ready或renderer时间代替。

实际产品红测：runtime-timing-evidence-red包含2项针对性断言失败；workbench-presentation-expiry-red包含1项实际过期任务仍可申请凭据的失败，已补有效期保护。原生夹具最初使用windowsHide:true，实际native窗口虽focused但isVisible=false；四次失败均保留，不算产品呈现通过。专用前台夹具改用windowsHide:false并等待实际visible/focused，没有伪造可见性或放宽主机检查。

最终相关9文件192项通过，日志2026-10-07-workbench-presentation-related-final.log；实际采集器另1文件14项通过，collector-final.log，不能合称同一次10文件运行。16个本轮文件lint通过；node/web/main/preload/renderer最终构建通过。services-final首次因并发作者restore-history-records测试查询返回unknown失败；该作者随后补泛型，我们未改其文件，services-checked重新执行退出0。没有弱化规则、断言或超时。

实际Electron前台报告.local/reports/workbench-presentation/54fd3f91-d040-4d44-8fb2-be96f35d36d7/result.json和runner-result.json均已读取：passed=true、actualForegroundPresentation=true、displayedReceipts=1、隐藏/遮挡/伪造时间/旧桥访问均拒绝、正常关闭后保留完成区间；exitCode=0、timedOut=false、elapsedMs=4699。visible-workbench.png已查看确实显示当前合成客户及回复。单次2157.772ms包含夹具启动/负向检查，不是三组业务新增p95。network=0、sends=0、businessEffectVerified=false、serviceFrozenBatchVerified=false、nativePlatformVerified=false，不能升格为真实业务验收。

最终基础桌面报告.local/reports/desktop-smoke/ede9fc97-1ecc-4375-9706-2c04e82a22c1/result.json已读取passed=true，runner退出0/未超时/25910ms；生产默认托管启动及退出封存通过，该无注册任务烟测仍foregroundPresentationVerified=false/status=insufficient。

原八项完整目标ACTIVE。补充第4/6项仍须同一服务端完整冻结none/baseline/learned与实际只读前台原始凭据的真实性关联、独立人工盲评与费用核对；当前host传入batch/hash只是一致性检查。真实人工业务数据尚未提供，四门槛不变：修改率相对下降至少20%、严重错误0、覆盖率下降最多5个百分点、新增p95最多500ms。原八项最终全范围独立审查及质量修复仍未完成；本轮未重跑全套/PG，旧完整153文件通过/7文件失败、1560项通过/6失败/22未执行与全局lint162错误/11135警告保留，专项不替代。未提交、推送、部署、调用真实收费模型或发送业务消息。本轮所有工具均终态，目标未complete/paused/blocked。

## 2026-10-07 服务端原始冻结凭据只读核验

补充第4/6项增加可执行的真实性核对基础：EnterpriseEvaluationCheckpoint.readCompleted每次使用实际学习worker数据库登录及绑定reference重新鉴权，账号锁事务中核对原始冻结依据/随机分配、完整completed状态、有效期、容量、全部真实费用引用及已报告token总量。它只读取，不调用claim/resume，不修复批次、不重试或释放后台槽。EnterpriseEvaluationEvidence逐项比较服务端原始input/publication/model/methods/episodes/frames/frozen/receipts及派生blind，不接受自洽但改写的私有packet。只返回有界元数据；导出hash不是可移植认证凭据，后续关联/导入仍需重新在线核验。

新增 memory:replay:enterprise verify RUN_ID PACKET OUTPUT_DIRECTORY；只需MEMORY_REPLAY_DATABASE_URL及MEMORY_REPLAY_WORKER_REFERENCE，不需要provider密钥。实际私有目录在写入前设DACL/0700并复核，输出后检查文件权限；输出serverFrozenBatchVerified=true、foregroundVerified=false、businessVerified=false，不能升级局部enterprise_pipeline时延、标签真实性或授予发布/发送许可。

真实PG红测8a43577e-6f07-4f48-aeca-105459b023bc：1项readCompleted缺失失败/5项通过，47.76s，report已读passed=false/cleanedUp=true。首次实现4c335bee-5036-49af-b0ed-ea21df002054：6通过/1失败，实际Windows私有权限断言暴露新verify输出目录未保护；不把它归为无效夹具，不弱化断言。补写入前protect及写入后verify后，最终1388ff31-677e-4b79-a788-353b26dccde9实际PostgreSQL16报告已读passed=true、cleanedUp=true、testsPassed=7，53.39s；日志2026-10-07-frozen-evidence-postgres-final.log。包含旧独立OS进程付费阶段恢复、受控UTC预算恢复及新增CLI无provider配置/无额外HTTP，伪reference、异账号、普通worker/设备登录、过期、未完成、改写回复/盲评及费用不一致全部拒绝，原始批次/重试状态/费用数量不变。受控UTC不是实际跨24h。

本地2文件18项通过9.01s（frozen-evidence-local）；5个本轮文件lint最终通过（lint-checked）；services首次新增夹具env索引类型错误已修正为NodeJS.ProcessEnv，最终services-checked退出0。没有重跑前台/基础Electron：本次只改服务端及私有CLI，前台最新实际证据仍是此前54fd3f91-d040-4d44-8fb2-be96f35d36d7，基础桌面ede9fc97-1ecc-4375-9706-2c04e82a22c1，不能改写为新验证。

原八项完整目标仍ACTIVE。这只是在线验证已完成服务端原始三组的基础；实际只读前台三组采集、绑定与原始证据导入还未接通，host声明batch/hash没有因此自动可信。真正业务100学习/100校准/200评估、至少30独立会话、独立人工盲评和实际费用仍未提供；四门槛不变。全范围最终审查及全套/全局lint历史失败仍未解决，新7项选定PG不代替全部数据库测试。审查另发现本地replay/adjudicate及evaluate输出目前仅限制路径，未统一设置实际私有目录权限，需专门真实ACL红测及修复。没有commit/push/deploy/真实付费模型/业务消息；当前工具全已终态，目标未complete/paused/blocked。

## 2026-10-07 本地评估输出实际私有权限与最终企业复核

继续原八项目标，补齐审查发现的真实输出权限缺口。createPrivateOutput现在对新空目录设置实际Windows当前用户/SYSTEM DACL或POSIX0700；writePrivateJson在写正文前检查目录、wx写入后检查实际文件。64MiB UTF-8上限仍在创建文件前拒绝，旧文件仍不覆盖。memory:evaluate在JSON/Markdown汇总报告写入前设置私有目录，并逐文件复核。权限失败保持失败，不输出成功或业务批准。输入路径限制不等于标注真人真实性；本项没有鉴定人工来源。

实际RED local-memory-private-output-red：13项中4项真实权限断言失败/9通过，13.60s，分别覆盖实际回放packet/blind/status/journal、缺标签status、独立CLI标签导入及实际evaluate报告。修复后3文件23项通过30.17s（local-memory-private-output-green），包含实际超过64MiB中文UTF-8写前拒绝、私有文件往返/拒覆盖、未保护目录写前拒绝及真实六次loopback采集/跨进程导入。合成报告仍insufficient，未升级业务证明。

首次企业复查1744b5e6-8127-4430-8d32-2d477aa526ef真实报告已读passed=false/cleanedUp=true：首个采集+独立CLI复合测试超过原10s，未结束操作随后造成completedEvidence缺失/后台槽占用等七项失败，不能用前一绿色替代。将原九HTTP采集与CLI导入分成两个独立测试，保留原有全部断言及超时（没有提高生产参数或测试上限）；新增无正文阶段计数只用于定位，不是p95证据。中间7722da4a-4475-4327-8717-26495dc1ee32为8项通过57.75s，初版nine_http_completed诊断标签误放在采集前，requests=0据实保留；已移到真正collect完成后再验证。

最终当前代码实际PostgreSQL16报告51407963-873d-48b7-8868-2ae6fbf3b8c6/result.json已读取passed=true、cleanedUp=true、testsPassed=8，48.66s，日志2026-10-07-memory-evidence-private-final-postgres.log。同run阶段日志已按明确UUID读取，顺序为started→frozen_before_http(requests0)→nine_http_completed(requests9)→readonly_completed→evidence_exported；不使用共享目录latest代替本轮报告。含真实独立OS进程/HTTP/费用/私有CLI恢复，UTC仅受控工程时钟。最终9文件lint和services均退出0，日志memory-evidence-private-final-lint/services。代码改动限服务端及私有CLI，实际Electron最新仍为既有54fd3f91…与ede9fc97…，未将它们重新标记为本次运行。

本轮自己发起的工具已全部终态；共享目录可能另有作者运行，未操作或重启其进程。原八項完整目标ACTIVE，仍缺完整只读三组前台采集/原始导入与在线服务端关联、真实独立人工样本/费用/业务四门槛，以及最终全范围审查和全套/全局lint历史问题修复。合成工程成功不算业务通过，没有commit/push/deploy/真实收费模型或消息发送，目标未complete/paused/blocked。下一步继续原Task8第4/6项的真实服务端冻结与主机原始三组关联，不能把现有私有核验JSON作为可移植认证凭据。

## 2026-10-07 多智能体协同：实际执行任务与冻结三组绑定

用户授权协同提效，继续原八项完整目标；本段保留全部历史失败，不替代完整验收。原任务1–7已有实现和专项工程证据：范围/快照/保留期/迁移、问题案例与可信反馈、复盘预算及前台优先、校准与版本迭代/回滚、整理维护、企业权威生成/发布、工作记忆及员工教导入口。独立只读审计亲读已有管理13场景、实际双进程恢复、企业发布6场景及自动迭代报告通过；工程模拟人工声明不能证明真实业务效果。Task8仍未完成，原目标ACTIVE。

本次新增learning_evaluation_execution_tasks：实际严格GenerationInput及其context随任务贯穿生成，在每次实际模型HTTP前于原账号锁/费用准入事务持久保存；绑定冻结case、conversation、config/knowledge/policy/question四版本及实际scope，每个assignment最多9个任务，计入原64MiB批次容量。已付费stage保存对应execution_task_hash，回执列出实际task hashes，在线只读核验拒绝错case/版本、跨arm费用或stage引用及正文/哈希篡改。恢复保持原assignment、已付费阶段和费用，不重置次数；不同任务实例造成的丢失前台区间仍标不完整。FORCE RLS继续按实际登录和worker绑定保护原始任务。host-only foregroundTask/foregroundResult回调经严格上下文验证、冻结版本复核、取消/超时有界执行，结果副本不能改写权威packet；**尚无生产桌面三组桥，hooks专项不等于完整前台证据接通**。

本地相关4文件38项通过22.46s，日志.local/reports/2026-10-07-foreground-execution-binding-local-checked.log；services退出0，multiagent-binding-services.log。7文件lint首轮退出0但5项格式警告保留（multiagent-binding-lint.log）；随后限定格式修正，最终multiagent-binding-lint-final.log退出0且无警告。真实PostgreSQL16报告.local/reports/postgres-concurrency/0553c81b-3efb-4f90-98b6-d6f77f5229ef/result.json已亲读passed=true/cleanedUp=true/testsPassed=10，67.50s，multiagent-binding-postgres.log；scope=selected，仅learning-memory-replay一个文件，不是完整PG。包含9次实际回环HTTP前耐久任务/精确context与费用引用、错case/四版本/第10任务/跨arm费用拒绝、实际RLS与独立OS进程恢复；UTC为受控工程时钟，不是真实经过24小时。

协同只读全局lint独立运行退出1：596文件、163错误/11182警告、20错误文件，完整JSON及执行日志.local/reports/2026-10-07-multiagent-global-lint.{json,log}。其中既有19文件162错误计数与历史一致；新增foreground-batch.ts:9的no-control-regex来自共享的另一功能改动，本次未修改该文件或关闭规则。不能宣称全仓库通过。旧完整permission-isolation-full仍153文件通过/7失败、1560项通过/6失败/22未执行；旧7文件正在multiagent-prior-failures.log专项复核，原5s/20s时限不变，未终态前不算通过，专项也不算全套。

真正业务100学习/100校准/200评估、至少30独立会话、独立人工盲评与原始费用尚未提供，四门槛仍为实质修改率相对下降至少20%、学习组严重错误0、覆盖率下降最多5个百分点、学习组p95减基线组p95最多500ms。完整同冻结三组的实际只读前台采集/原始证据导入与在线关联、最终全范围审查及工程检查仍须完成。未commit/push/deploy、调用真实收费模型或发送业务消息；目标未complete/paused/blocked。

专项终态追加：2026-10-07-multiagent-prior-failures.log（session71986/d3fefd）退出1，7文件中6通过/1失败，77项中76通过/1失败，77.04s；当前唯一失败restore-review.test.ts:75预期ledger_restore_guard_owner_invalid，实际permission denied for function restore_admission_current。原超时本次未复现，未弱化断言或修改时限；这是旧7文件专项，不能代表全套通过，另协同代理正在只读定位权限根因。本次专项已终态，前文“执行中”保留为当时状态。

专项最终追加：2026-10-07-multiagent-prior-failures-final.log（58942/fda40d）退出0，旧7文件77项全部通过，68.60s；已恢复019中既有owner检查，恢复迁移由共享作者改名为044且保留修复。中间checked日志3个套件ENOENT、44通过/33未执行、51.27s，源于运行间共享043文件改名及夹具时间窗，保留为失败诊断，不计新增产品红测；夹具补043-learning-evaluation-executions及现有044后，原断言/时限全部通过。此结果仍不是全套，历史完整失败保留。父代理新增实际PostgreSQL owner测试并运行两个选定恢复文件（session43033），当前正在验证，未终态前不计通过，不升级业务验收。

恢复PG终态追加：2026-10-07-multiagent-restore-guard-postgres.log（43033/84df3b）退出0，两个选定文件3项通过、5.65s；实际PostgreSQL报告d7aef9e6-23b4-4cfd-b49b-eff8fb707500/result.json已亲读passed=true/cleanedUp=true/testsPassed=3、scope=selected。新增受限owner用实际登录在privileged helper调用前明确以ledger_restore_guard_owner_invalid拒绝，当前状态不变；另两项保留实际backend95/96串行恢复、apply一次审计/日志且不可解除暂停，以及51条completion和account-lock waiter。restore-guard-lint（9bea34）两文件退出0且无警告。本次两个文件PG已终态，前文“正在验证”为当时记录；选定PG不替代完整PG/全套，Task8和真实业务验收仍未完成。

## 2026-10-07 协同前台桥接：代码已实现，实际联合验证未通过

协同当前变更已增加ForegroundEvaluationHost、host-only assignment合同、DesktopAgentRuntime只读评估接线、封存私有计时日志读取/重放及EnterpriseForegroundEvidence在线关联。桥接按原真实source.read、同一任务/上下文、主进程呈现回执及服务端耐久execution/费用记录核对三组；主机生成与返回结果会合，评估禁止审核/发许可/发送，正文和平台能力不由renderer自报。此前“尚无桥接代码”是历史；当前代码存在，但尚未得到实际联合通过证据，不能据此标已交付完整三组前台链路。

已亲读foreground-bridge-local.log：7文件166项通过38.51s，构建foreground-bridge-build.log通过；这只是专项和构建。最新实际PostgreSQL+可见Electron联合运行foreground-bridge-joint-postgres-anchored.log为1文件11项中10通过/1失败、48.00s；原始PG报告68ea2194-a576-4c21-b07c-4ab3d743e230/result.json已亲读passed=false、cleanedUp=true。实际桌面报告foreground-evaluation/f3036224-bc7b-4785-9a91-710adb264f20/result.json已亲读passed=false、phase=three-arms、code=evaluation_foreground_runtime_unavailable、http=0、sends=0、presentations=0、nativePlatformVerified=false、businessEffectVerified=false。失败发生于模型HTTP和三组实际呈现之前，不能把166专项、旧77项或旧10项PG替代本次失败，更不能声称已完整foreground_end_to_end。

剩余收敛步骤：定位实际运行器start未进入running的精确准入原因，在保留只读/身份/版本/源能力检查下修复；先确认对应行为检查，再执行一次同原冻结三组的实际PG+Electron联合验证，亲读其报告并核对9HTTP/3实际呈现、原task/context/费用/私有封存与在线关联。联合通过后，按实际改动刷新受影响检查及原计划最终全范围测试/完整PG/桌面/场景/构建/质量审查，避免仅重复无修改专项；当前全局lint此前163错误/11182警告快照及历史全套失败仍保留，未重跑不能当已通过。

原1–7已有实现及专项工程证据，Task8仍未完成，目标ACTIVE。真实100学习/100校准/200评估、至少30独立会话、独立人工盲评及原始费用未提供；四确认门槛仍为实质修改率相对下降至少20%、学习组严重错误0、覆盖率下降最多5个百分点、新增p95最多500ms，业务保持insufficient。当前工程合成来源/假模型和窗口证据不授予真实native能力或业务效果证明。未commit/push/deploy、调用真实收费模型或发送业务消息；本次只读审计及文档追加未启动任何重型检查。

联合失败定位追加：协同foreground_review已确认f303启动失败由工程夹具提供60秒租约超过真实LeaseGrantSchema的30秒上限造成；父代理已将夹具改为20秒，生产身份/租约保护未放宽。此为夹具准入错误，不算新增产品行为红测。host启动失败无正文runtimeStatus诊断及非法租约拒绝用例仍待相应检查；修正后的实际三组联合结果尚未取得，不能提前销账。

联合终态补充：2026-10-07-foreground-bridge-joint-final-postgres.log退出0，选定1文件12项通过69.54s；精确PG报告0b931594-0c41-4b1b-89a8-4d01ec169ff9已独立亲读passed=true、cleanedUp=true、scope=selected。实际Electron报告foreground-evaluation/79db8d48-a0ce-4bb5-9bb2-3a9e56493e60已亲读passed=true、9HTTP/0发送/3呈现；同原DBrun88b2fb6b-0da4-42de-9b5e-a604472c5abc及封存session2f9cd770-8648-4dad-bfee-4b7a0ddb96b6的三组分别绑定不同runtime/read/呈现回执，原task/context、冻结依据、费用与主机日志在线关联通过。runner退出0/未超时/14409ms；真实PNG已由父代理视检。独立CLI verify-foreground及adjudicate-foreground通过，原packet字节/回复/用量/费用不变，派生数据只变更已核前台时延，synthetic仍insufficient。此前联合失败与60s非法夹具租约记录保留，不计有效产品红测。当前reviewable原始前台链路已有合成工程联合证据；nativePlatformVerified=false、businessEffectVerified=false，单个合成会话不是200业务样本或500ms门槛证明。原Task8仍待真实100/100/200人工资料、30独立会话/费用及最终全范围验收；本次12项选测不替代完整PG/全套。此前全局163错误/11182警告快照限制保留；父代理单次最终构建及随后完整PG/全套/场景/基础桌面检查尚待各自终态。原目标ACTIVE，未提交/推送/部署、真实收费模型或业务发送。

当前完成状态和最新终态证据统一见[当前验证报告](../../learning-memory-final-verification.md)。本文保留原计划及按时间记录的历史结果；历史失败、待执行和执行中描述不能代替最新结论。真实业务四门槛仍需独立真人样本及原始证据。
