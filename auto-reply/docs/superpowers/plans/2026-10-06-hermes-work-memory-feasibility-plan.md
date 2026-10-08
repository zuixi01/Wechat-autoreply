# Hermes 学习机制接入工作记忆：可行性与执行计划

> **For agentic workers:** 后续使用 `superpowers:executing-plans` 逐项实施。每项按检查现有能力、补缺失失败测试、观察失败、最小修补、验证的顺序推进。本次仅交付分析与计划；用户明确要求先不改代码。

**Goal:** 从实际处理经历、人工纠正和明确结果中提炼可复用方法，使下一次实际回复使用正确版本，并持续修订、验证、整理和回滚。

**Architecture:** 把 Hermes 的学习机制适配为现有 TypeScript 学习模块中的受限数据处理流程。复用当前 SQLite/PostgreSQL、模型适配、企业认证、持久队列及实际回复管线；复盘仅产生结构化候选，后续由主机验证、持久化和决定生效。

**Tech Stack:** TypeScript、Electron、React、Zod、SQLite、PostgreSQL、Vitest、现有回复/Jev 管线。

**Spec:** 需求背景见 `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`；本文件的需求、约束和当前状态作为此次计划的具体依据。历史计划 `2026-10-05-hermes-work-memory-feasibility-execution.md` 可供参考，但其中账本版本及“尚无提交日志”已过时。

## 需求与结论

按 `E:\wechat-autoreply\auto-reply` 项目的工作记忆模块理解需求。你希望系统从经历中积累经验，并根据后续反馈改进经验：第一次纠正形成 V1，相似新问题使用 V1；再次纠正形成 V2，验证通过后替换，出错可回滚。

**可行，建议基于现有模块补齐闭环。** 自我学习在本方案中更新外部记忆与处理方法，不涉及训练模型权重或让模型修改应用代码。外部经验改善实际回复的可能性成立，但效果必须经过独立人工对照评估。

例如退款流程可以学到“先核对订单状态，再查当前退款政策”，不能把某次聊天里的退款天数永久当成现行政策。价格、库存、订单和业务规则仍由当前权威知识决定。客户原话是证据数据，不是授予模型权限的指令。

可选路线：

| 路线 | 代价与能力 | 判断 |
| --- | --- | --- |
| 抽取机制，适配到已有学习模块 | 保持现有存储、权限、版本和生成链一致；重点补接线与验收 | 推荐 |
| 完整 Hermes 作为 Python 旁路服务 | 需要额外运行时、跨进程身份和两套记忆同步；运行部署更复杂 | 本轮不采用 |
| 仅增加聊天摘要和提示词 | 可以保存内容，但缺少验证、可靠修订和回滚闭环 | 不满足目标 |

## 上游依据与迁移边界

2026-10-06 查询 GitHub 当前 main 后，固定参考提交为 `85db7c3a6886762773827598793b0b51ef4e3325`。实施时固定这个提交，不自动跟随 main。通过 GitHub Contents API 读取以下源码并检查相关机制；官方文档用于解释产品行为。本次没有运行 Hermes。

| 机制 | 上游依据 | 项目中的适配 |
| --- | --- | --- |
| 有界跨会话记忆 | [Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) | 偏好与经验分层，按作用域持久保存，控制每次加载量 |
| 从经历形成技能 | [Skills 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) | 场景、做法、依据、步骤、坑点和检查项，而非堆积聊天日志 |
| 后台复盘与前台抢占 | [background_review.py](https://github.com/NousResearch/hermes-agent/blob/85db7c3a6886762773827598793b0b51ef4e3325/agent/background_review.py) | 空闲队列、受限输出、共享预算、取消及迟到结果拒绝 |
| 修改前读取目标 | [skill_manager_guards.py](https://github.com/NousResearch/hermes-agent/blob/85db7c3a6886762773827598793b0b51ef4e3325/tools/skill_manager_guards.py) | 修订仅针对实际读取的方法；附 expectedRevision 防止覆盖新版本 |
| 按需找历史 | [session_search_tool.py](https://github.com/NousResearch/hermes-agent/blob/85db7c3a6886762773827598793b0b51ef4e3325/tools/session_search_tool.py) | 授权范围检索、有界返回、可打开真实来源 |
| 整理与归档 | [curator.py](https://github.com/NousResearch/hermes-agent/blob/85db7c3a6886762773827598793b0b51ef4e3325/agent/curator.py)、[Curator 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/) | 定期复核、保护固定项、合并先候选、归档可恢复 |

上述四份源码的 blob SHA 与旧计划参考版本一致，学习机制并未因此重新变成待从零开发的功能。Hermes 原生后台复盘可经工具写记忆/技能；本项目采用更严格的候选数据→主机验证→生效流程，不直接移入它的 Agent、文件写入、脚本或工具调度能力。

[上游 LICENSE](https://github.com/NousResearch/hermes-agent/blob/85db7c3a6886762773827598793b0b51ef4e3325/LICENSE) 为 MIT。后续若复制源码或实质内容，保留版权与许可，并记录来源提交、文件和适配点。本次没有复制实现。

## 当前源码状态

以下为本次只读检查结果。存在源码不代表已完成或通过验收；本次未运行测试、构建、迁移、模型请求或真实消息发送。

| 能力 | 已有源码 | 本轮执行重点 |
| --- | --- | --- |
| 案例、反馈、方法及修订 | `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-store.ts` | 核验生产来源、事务一致性和实际触发 |
| 结构化复盘与局部修订 | `learning-reviewer.ts`、jobs/scheduler | 核验实际纠正、已读取目标、来源和取消时序 |
| 校准与验证 | `learning-validation.ts`、主机/企业 product-validation | 核验独立人工案例、版本绑定及准入 |
| 方法参与实际回复 | `learning-context.ts`、企业 generation context | 证明新回复使用指定有效版本 |
| 模型目录、完整编辑与来源查看 | 现有合同、IPC 和 `src/renderer/src/features/memory/` | 复核完整操作和范围保护，不重建已有功能 |
| 窗口提交日志 | `learning-submissions.ts` 合同/存储、ledger schema 13 | 复用现有基础，补错误状态、可靠同步、窗口接线 |
| 提交同步服务 | `src/main/services/learning-submission-sync.ts` | 已有核心；当前 IPC/preload/窗口仍直接调用旧管理请求，未构成完整持久提交路径 |
| 企业发布 | `server/src/learning/learning-publication.ts`、既有 Administration | 补发布准备及用户路径，区别候选生效和正式发布 |
| 桌面场景 | `scripts/learning-smoke.cjs`、`test:learning:desktop` | 补完整自动学习和企业发布场景 |
| 独立效果评估 | `evals/jev/` 已有基础；没有 `memory:evaluate` 脚本 | 新增学习对照评估和数据模板 |

同步层需要重点复核的具体问题：非手工提交目前先远程读取 episode，断网时缺少已观察的可信时间缓存；收据缺可读错误；按最新 100 条查单条收据可能漏掉旧提交；过期清理位于获取当前授权之后，无授权时可能跳过正文清理；缺与窗口、恢复复核、范围遗忘的完整接线。这些是源码检查发现的缺口，不作为本次测试结论。

## Global Constraints

- 记忆读取和学习独立：沿用 `memoryEnabled=true`、`mode=suggest`。off 停止学习；suggest 只产生待审候选；auto 仅允许可信验证通过的低风险候选自动生效。客户设置不能突破账号总开关。
- 作用域沿用 MemoryScope；身份来自主机注册或服务端认证。renderer 和模型不能声明权限、授权摘要、首次时间或验证凭据。
- 每次回复最多 5 条有效方法、3 条案例；包含包装的上下文最多 2000 token。待审、隔离、归档及无关方法不得进入生成。
- 沿用后台并发 1、空闲 15 秒、复盘超时 30 秒、输入 8000/output 2000 token、重试最多 3 次、UTC 日共享预算 50000 token。复盘、验证和模型整理共用预算；前台优先。
- 案例默认保留 90 天，可配置 7–365 天。unknown 空闲 30 分钟关闭；生成、发送或关闭 unknown 不代表正确、采纳或解决。
- 自动准入至少 5 个独立会话的人工标注案例，排除学习来源重叠。资料不足为 insufficient；最低数量不等于业务效果评估充分。
- 验证凭据绑定候选、内容版本、来源和环境；24 小时到期，相关环境变化立即失效。V2 待审期间有效 V1 继续使用。
- 整理沿用 7 天周期、2 小时空闲、14 天宽限/待复核、30 天可恢复归档。人工与固定项受保护，模型合并默认关闭。
- 遗忘清正文、索引、依赖方法、待提交、缓存和在途回写。可以保留匿名费用；归档可恢复，遗忘不可恢复。
- 本地生效不等于企业正式发布，不扩大发送权限。复盘不具备文件修改、终端执行或消息发送工具。
- 账本当前 schema 13，兼容 11/12/13。不要重复做 12→13；新增迁移前复核当时实际版本及备份恢复合同。
- 保留共享工作区其他改动，禁止整体 reset、stash 或批量暂存。当前历史通过记录不能替代修改后的新检查。

## Review Focus

1. 服务端保存后丢响应：同一 sourceId 恢复，仅一份案例/候选（任务 2）。
2. 模型请求挂起时撤销设备、切账号或停机：迟到结果无回写、无关闭数据库访问（任务 3）。
3. V2 待审或验证环境改变：保持有效 V1，不消费旧凭据（任务 4、5）。
4. 遗忘或授权失效期间有离线提交、打开的来源和私密表单：清正文且不复活（任务 2、6）。
5. 合成标签、自评或训练/评估会话重叠：不能获得业务效果 passed（任务 8）。

## 任务 1：复核真实来源和现有工作台

**Files:** `src/shared/contracts/learning-{memory,desktop,management,model-directory}.ts`；`src/main/ipc/learning-ipc.ts`；`src/main/services/agent-registration.ts`、`enterprise-learning-desktop-adapter.ts`；现有 memory 窗口组件；企业 events 路由。

**Interfaces:** 沿用 `modelDirectory({scope})`、`episode({scope,episodeId})`、`manual({scope,sourceId,content,reason})`、`act({scope,id,expectedRevision,action,...})` 和现有反馈请求。

- [ ] 检查现有模型设置、完整编辑、来源、校准、版本与反馈操作；记录哪些当前可用、哪些缺证明。
- [ ] 补缺失失败测试：`draft_is_not_adopted_or_resolved`、`correction_requires_actual_draft_binding`、`foreign_scope_and_secret_fields_are_rejected`、`late_source_after_scope_switch_is_not_displayed`。
- [ ] 运行既有 IPC、enterprise desktop client/routes/events、correction atomic 测试，观察缺失行为失败，再最小修补；不存在的缺口不要重复实现。
- [ ] 用当前构建跑现有桌面场景，核对真实来源及全字段持久化。

**验收：** 教导、纠正、反馈能对应真实来源；界面完整；范围切换、过期、遗忘和迟到详情不泄露内容。

## 任务 2：完成持久提交、同步和窗口接线

**Files:** 现有 `src/shared/contracts/learning-submissions.ts`、`src/core/persistence/learning-submissions.ts`、`src/main/services/learning-submission-sync.ts`；`desktop-agent-runtime.ts`、IPC、preload、窗口；ledger/schema/backup；两份 submission 集成测试。新增具名桌面合同 `src/shared/contracts/learning-submission-desktop.ts` 与 IPC `src/main/ipc/learning-submission-ipc.ts`。

**Interfaces:** 保留 `LearningSubmissionRequest` 的 `kind=manual|correct|result|feedback`。在现有 Store 增加 `prune(scope,now):void` 和 `receipt(scope,authorityId,sourceId):LearningSubmissionReceipt|undefined`。收据增加 `errorCode?:'network_unavailable'|'permission_revoked'|'source_unavailable'|'submission_conflict'|'retention_expired'`，窗口映射固定可读文案，不保存远程正文/密钥。

新增主机桌面接口 `submit(request):Promise<LearningSubmissionReceipt>`、`submissions({scope}):Promise<LearningSubmissionReceipt[]>`。该接口单独定义，不给企业管理 API 增加任意转发入口；renderer 不能提供 authorityId、evidenceAt 或 firstSubmittedAt。

- [ ] 补 `restart_replays_same_source_once`、`response_lost_after_commit_is_idempotent`、`changed_body_same_source_conflicts`、`old_receipt_beyond_latest_100_is_found` 的失败测试，核对实际记录数。
- [ ] 使用同一 AgentRegistration 和当前主机范围绑定，持久保存意图再提交。重试沿用 sourceId；新的明确教导生成新 sourceId。服务端保存确认前不得标 saved。
- [ ] 对已授权读取的 episode 缓存仅 id/scope/startedAt 等可信元数据，供断网纠正保留原证据年龄；没有可信来源的提交明确拒绝，不能让 renderer 自报时间。重放仍需服务端核对当前来源和授权。
- [ ] `prune` 在获取当前授权之前执行，已知短保留期照常清正文；未知策略以 365 天最大上限清理，不因此允许重放。清理不得延长原始证据年龄。
- [ ] 补 `revoked_authority_still_prunes_private_payload`、`forgotten_offline_intent_never_returns`、`restore_review_blocks_replay`、`shutdown_joins_inflight_sync`；挂起响应验证账号切换不 ACK 旧身份。
- [ ] runtime 启动、设备变化、关闭、遗忘和恢复复核统一控制同步；每轮清理前检查停止状态，关闭等待在途操作结束再关库。窗口显示待同步/已保存/已遗忘/失败原因。pending 保持原提交身份；刷新失败不覆盖已确认保存状态。
- [ ] 若新增可信时间缓存需要表，按实际 schema 追加迁移及完整备份恢复测试；现有 13 提交表直接复用。补真实 HTTP 丢响应与真实主进程/renderer 重启，而非仅 mock 重试。

**验收：** 断网、响应丢失和重启不会丢意图、重复学习、续保留期或复活遗忘资料；权限失效仍按期清正文。

## 任务 3：后台提炼、局部修订和取消

**Files:** `src/core/memory/learning-{reviewer,jobs,scheduler,model-configuration,transport}.ts`；`src/main/services/learning-service.ts`；企业 reviewer service/worker/authority。

**Interfaces:** 沿用 `LearningReviewer.review(input,signal):Promise<LearningReviewResult>`；输出严格 create/revise 数据，revise 必须带 memoryId/expectedRevision；最多五项，也可零项。

- [ ] 补实际纠正→候选、已使用 V1 收到新纠正→V2、未读取目标/假来源/陈旧修订拒绝测试，先观察失败再修补。
- [ ] 核对复盘使用实际配置模型，缺配置明确失败；unknown 不提炼成成功技能，业务事实不写成流程规则。
- [ ] 建立可挂起的回环模型服务，测试 `held_model_revoke_prevents_commit`、`held_model_shutdown_prevents_closed_database_write`、前台抢占、预算和超时。释放旧响应后候选新增为零，真实费用仍结算。
- [ ] 运行 runtime/iteration/transport/enterprise worker 专项，验证停止不仅发出 abort，还禁止迟到持久化并排空必要资源。

**验收：** 真实反馈能驱动候选和持续修订，前台优先，取消及权限变化阻止迟到学习。

## 任务 4：可信验证、生效、企业发布和回滚

**Files:** 现有 validation/store/product-validation；企业 validator/management runtime；`server/src/learning/learning-publication.ts`、`server/src/generation/publication.ts`、`server/src/admin/administration.ts` 和现有管理入口。

**Interfaces:** 沿用 `validate({scope,id,expectedRevision})`、版本动作及现有 `Administration.publish(...)`。新增发布准备流程应冻结目录/环境并复用既有管理员准入；桌面不签凭据、不接收管理员密钥。

- [ ] 用同一实际回复管线做有/无候选配对回放。独立人工标准只用于评分，不泄露给生成模型。
- [ ] 补 `fewer_than_five_independent_human_cases_is_insufficient`、`training_source_overlap_is_insufficient`、`synthetic_labels_do_not_grant_activation` 的失败测试。
- [ ] 补候选/知识/模型/校准变化及 24 小时到期使旧凭据失效；严重错误拒绝并隔离实际使用方法。
- [ ] 证明 suggest 仅待审、auto 仅可信低风险候选生效、固定方法受保护、V2 待审继续用 V1。
- [ ] 企业窗口完成准备→准入→正式发布，期间变化重新准备；明确显示候选、生效与企业已发布状态。
- [ ] 验证回滚产生可审计修订，旧依据草稿失效；下一次回复使用恢复内容。

**验收：** 候选正确走到使用；企业正式发布有单独证据；无可靠资料时不会伪造自动准入。

## 任务 5：证明下一次实际回复使用方法

**Files:** `src/core/memory/learning-{context,retrieval}.ts`、`src/main/services/learning-knowledge.ts`、实际回复管线；企业 generation context/context lifecycle/publication。

**Interfaces:** 沿用 `retrieveLearningContext(...)` 的 text/snapshot/contextVersion，以及实际方法 id/revision。

- [ ] 添加与学习来源不同的相似问题，断言真实模型请求加载指定方法 id/revision，生成任务绑定一致且最终回复体现该流程。
- [ ] 添加无关问题、其他客户偏好、5 方法/3 案例/2000 token 边界；历史经验不得覆盖现行业务事实。
- [ ] 分别验证 V2 生效、回滚、停用和遗忘后的实际新生成；不能只检查卡片状态或方法列表。

**验收：** 方法在合适的新问题中实际发挥作用，范围、依据与版本正确。

## 任务 6：整理、保留和遗忘闭环

**Files:** 现有 curator/curation-plan/retention、企业 maintenance/curation-merge；submission store/sync；窗口范围与隐私保护。

**Interfaces:** 沿用 `curate({scope,dryRun})`、`reports({scope})`、`forgetScope({scope})`；遗忘联动任务 2 的正文、时间缓存和同步。

- [ ] 补预览/执行一致、人工/固定项保护、真实时间宽限、归档可恢复测试。
- [ ] 合并只生成带替代关系候选，新候选验证前旧方法继续使用；模型自述不能授权删除有效方法。
- [ ] 在离线提交、私密编辑、来源读取及挂起复盘时遗忘；查数据库/索引/表单/缓存，不只查页面列表。释放旧响应和恢复旧设备均无资料复活。
- [ ] 运行 retention-lifecycle/maintenance/curator-merge/context-version 专项，关闭学习仍执行保留策略。

**验收：** 失效经验按规则处理，隐私资料按期清理，归档和遗忘可清楚区分。

## 任务 7：完整 Electron 和企业闭环场景

**Files:** `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`、相关窗口。使用已有 `test:learning:desktop`。

**Interfaces:** 真实 Electron/React/preload/IPC/存储/回复管线；隔离 userData，回环模型；企业链使用真实认证、管理及发布接口。

- [ ] 场景 A：实际试答→窗口纠正和明确结果→后台提炼候选→独立校准→生效→不同来源的新回复使用 V1。
- [ ] 场景 B：新回复再次纠正→后台 V2→待审用 V1→生效用 V2→回滚→新回复用恢复内容。
- [ ] 场景 C：断网、保存后丢响应、主进程重启、切账号、撤销、遗忘及恢复复核；核对真实持久状态。
- [ ] 场景 D：企业候选→准备/准入/正式发布→新任务使用发布版本；越权拒绝与后续版本失效。
- [ ] 保存同次构建标识、截图、结构化报告、来源与方法修订、模型请求上下文及限制。合成模型/标签只证明工程行为。

**验收：** 自动闭环、可靠恢复和企业发布都有实际产品路径证据；人工编辑 V1/V2 不能替代自动学习场景。

## 任务 8：独立效果评估与最终交付

**Files:** 新建 `src/shared/contracts/learning-evaluation.ts`、`evals/memory/metrics.ts`、`evals/memory/README.md`、`evals/memory/fixtures/synthetic.json`、`scripts/memory-evaluate.ts`、`tests/integration/learning-evaluation.test.ts`；注册 `package.json` 的 `memory:evaluate`。

**Interfaces:** CLI `memory:evaluate --dataset <json> --out <directory>`；输出 JSON 和 Markdown 报告。退出码：通过 0、执行/合同错误 1、资料不足 2、业务门槛失败 3。

数据合同记录每条 caseId、conversationId、split(learn|calibrate|evaluate)、labelOrigin(human|synthetic|model)、人工纠正依据，以及基线/学习后的成对输出、评价、时延和费用。冻结候选与配置后评估；会话不能跨 split，评估案例不能被学习/校准使用。匿名导出不包含客户身份或凭据。

- [ ] 补重叠拒绝、合成标签 insufficient、无人工标签 insufficient、成对结果缺失、严重错误和指标公式的失败测试，再实现 CLI。
- [ ] 对同一冻结模型/知识配置比较“现行静态记忆”和“加入学习方法”。由人工按固定标准盲评成对结果，报告实质修改率、严重错误、覆盖率、成本和 p95 时延；报告样本量、会话分布与不确定性。
- [ ] 指标按同一评估集合计算：实质修改率=人工判定需要改事实/流程的回复数÷评估数；覆盖率=能提供有效答复的条数÷评估数；相对改善=(基线修改率−学习后修改率)÷基线修改率。基线为零时相对改善不可定义，报告该项不足，不能除零或虚报改善。p95 采用排序后第 ceil(0.95×N) 个值，新增时延=学习组 p95−基线组 p95。
- [ ] 业务样本起点：学习 100、校准 100、评估 200 条，评估至少 30 个独立会话。用户于 2026-10-06 明确确认效果门槛：修改率相对下降至少 20%，严重错误 0，覆盖率下降不超过 5 个百分点，新增 p95 时延不超过 500ms。门槛已确认；样本起点仍不构成统计充分性保证，不能称为现有实测。
- [ ] 无真实标签仍交付工具、模板及工程验收，业务效果明确 insufficient；不可用模型自评或造标签补足。
- [ ] 顺序完成当前完整测试、类型检查、构建、lint、scenarios、真实 PostgreSQL 和桌面场景；记录全部终态及报告，不以历史总数宣称当前通过。
- [ ] 复核全部受影响源码，包括未跟踪文件；交付来源/许可、默认配置、迁移恢复说明、使用方式、成本及已验证限制。

**验收：** 工程闭环完整可复核；业务改善仅由独立真实评估判定，缺数据明确报告不足。

## 执行命令与里程碑

以下命令供后续实施使用，本次没有执行。每条检查退出状态后再执行下一条，失败则诊断修补。

```powershell
Set-Location -LiteralPath 'E:\wechat-autoreply\auto-reply'
$learningNodeVersion = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
$learningNodeExe = Join-Path $PWD ('.local/toolchain/node-v' + $learningNodeVersion + '-win-x64/node.exe')

# 首项及提交层专项，后续每个任务运行其对应测试。
& $learningNodeExe 'node_modules/vitest/vitest.mjs' run tests/integration/learning-ipc.test.ts tests/integration/learning-submissions.test.ts tests/integration/learning-submission-sync.test.ts

# 最终检查，逐条执行。
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run lint
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run test:learning:desktop

# 任务 8 注册后执行；合成数据的业务结果必须 insufficient，退出 2。
& '.\scripts\dev-tools.ps1' -NpmArgs @('run', 'memory:evaluate', '--', '--dataset', 'evals/memory/fixtures/synthetic.json', '--out', '.local/reports/memory-evaluation/synthetic')
```

**M1（任务 1–2）：** 工作台可靠教导、纠正和恢复，不丢提交。

**M2（任务 3–7）：** 自动提炼、验证、实际使用、迭代、回滚及企业发布都有工程证据。

**M3（任务 8）：** 评估工具及工程交付完成；真实效果由独立报告决定。缺真实标签不阻碍完成工具，但不能宣称业务效果通过。

本次仅新增本计划文档；没有修改产品代码、修复上述缺口或执行验收。
