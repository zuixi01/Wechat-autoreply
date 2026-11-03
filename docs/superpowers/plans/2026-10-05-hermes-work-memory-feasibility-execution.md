# Hermes 自我学习机制接入工作记忆：可行性与执行计划

> **For agentic workers:** 后续实施使用 `superpowers:executing-plans`，按复核、失败测试、最小修补、通过验证的顺序逐项执行。本次只交付分析与计划，不授权修改产品代码、运行迁移或发布。

**Goal:** 让现有工作记忆从真实处理经历及员工纠正中提炼方法，在后续实际回复中使用，并根据新反馈持续修订、验证、整理和回滚。

**Architecture:** 将 Hermes 的经验保存、后台复盘、技能修订、历史检索及生命周期管理适配到现有 TypeScript 学习模块。复用 SQLite/PostgreSQL、模型适配、持久队列、企业认证及实际回复管线；不新增另一套学习数据库或完整 Python Agent。

**Tech Stack:** TypeScript、Electron、React、Zod、SQLite、PostgreSQL、Vitest、现有 Jev 回复管线。

**Spec:** 参考 `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md` 的需求背景。本计划以 2026-10-05 当前源码为准；上游参考提交及当前状态以本文件为准，历史测试不作为当前通过证据。

## 1. 需求理解和可行性

按这个仓库里的“工作记忆”理解需求：员工纠正一次，系统保留实际依据，提炼适用方法；相似问题出现时使用已生效方法；再次纠正时形成新版本；新版本待审时仍使用旧的有效版本；不适用时可以停用或回滚。

例如退款场景学到“先核对订单状态，再查询当前退款政策”，而不是把历史聊天里的退款天数永久写成当前政策。流程经验来自记忆，价格、库存、订单及政策事实继续从当前业务知识获取。

**结论：技术可行，适合在现有模块上补齐闭环。** 自我学习在此表示更新外部经验及处理方法，不训练模型权重、不自行改应用代码。它能持续积累与纠错；能否减少员工修改，需要独立对照评估，不能由模型自评或记忆数量证明。

| 路线 | 收益与代价 | 决策 |
| --- | --- | --- |
| 适配 Hermes 学习机制到已有模块 | 使用现有存储、权限、版本及生成链，避免两套状态同步 | 推荐 |
| 完整 Hermes 作为 Python 旁路服务 | 增加运行时、身份映射、跨进程同步及工具权限管理 | 第一版不采用 |
| 只追加聊天摘要及提示词 | 容易开始，但缺来源、版本、验证及可靠纠错 | 不满足需求 |

如果“工作记忆”实际指 Codex/ChatGPT 客户端内部记忆，本项目无法直接替换其内部实现；本计划针对微信自动回复项目的记忆功能。

## 2. 上游机制及调查依据

固定参考提交：`765342435609cc82cbeb3d664dcec24126da58ee`。后续执行固定这个版本，不能自动追随 main。

| 可迁移机制 | 已读取的上游依据 | 本项目适配 |
| --- | --- | --- |
| 有界、跨会话持久记忆及保存审核 | [Memory 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) | 作用域隔离、有界读取、候选审核及独立开关 |
| 从经历形成可复用技能 | [Skills 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) | 场景、正确做法、依据、步骤、坑点、检查项 |
| 后台复盘、预算及取消 | [background_review.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/agent/background_review.py) | 空闲后台队列、前台优先、成本限制及迟到结果拒绝 |
| 修改前读取目标 | [skill_manager_guards.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/tools/skill_manager_guards.py) | 只修订实际读取且修订号匹配的方法 |
| 按需找历史经历 | [session_search_tool.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/tools/session_search_tool.py) | 授权范围内检索、有界返回、可打开真实来源 |
| 整理与可恢复归档 | [curator.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/agent/curator.py)、[Curator 官方文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/) | 保护人工固定项、过期复核、合并先提案、归档可恢复 |

本次 web 对上述 raw 源码请求失败，随后使用固定 ref 的 GitHub Contents API 成功读取后台复盘、技能守卫、整理、历史检索及 LICENSE，检查相关段落；不将失败请求当成成功证据。Memory 的存储行为依据官方文档，本次未逐段审查其存储源码。

MIT 允许按许可复用；若复制源码或实质提示内容，保留 [版权和许可](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/LICENSE)，记录文件、提交及适配点。本计划没有复制上游实现。Hermes 的工具调度、线程、文件写入及脚本执行型技能不直接移入 Electron；复盘仅产出严格校验的候选数据。

## 3. 当前项目：已有基础和剩余缺口

执行目录：仓库根目录。本次只读检查，没有运行测试、构建、数据库迁移或业务模型。下表的“存在”仅表示当前源码存在，不能解释为验收通过。

| 能力 | 当前源码情况 | 执行重点 |
| --- | --- | --- |
| 案例、方法、反馈、版本 | `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-store.ts` 已存在 | 复用单一合同及存储，核验实际生产来源 |
| 结构化复盘与版本修订 | `learning-reviewer.ts` 已限制来源及 expectedRevision | 核验真实纠正触发、局部修订和取消时序 |
| 方法/案例参与回复 | `learning-context.ts` 已检索并返回上下文版本 | 证明新回复实际使用已生效的指定版本 |
| 模型目录及设置 | `learning-model-directory.ts`、`LearningSettingsPanel.tsx`、主机及企业接口已存在 | 核验当前模型、保存一致性、目录变化及越权拒绝，不重建接口 |
| 完整方法编辑和来源 | `LearningMethodEditor.tsx`、`LearningSourceDetails.tsx`、`MemoryRevisionDiff.tsx` 已存在 | 核验完整字段、修订冲突、过期/遗忘/迟到来源与私密表单清除 |
| 校准、验证、搜索及报告 | 已有具名 desktop 接口和窗口组件 | 核验真实授权和可信验证，不把按钮存在当闭环完成 |
| 跨重启窗口提交 | 手工教导 sourceId 仍保存于组件 ref；工作台已有 `LearningOutbox` | 新增窗口持久提交意图，复用服务；解决重启/响应丢失后的重复或丢失 |
| 企业正式发布 | 已有方法目录和 `Administration.publish` | 补齐准备、准入及正式发布的用户路径；候选生效和正式发布分别验收 |
| 实际桌面验收 | `test:learning:desktop` 及 smoke 已注册 | 扩展完整自动学习→验证→新回复→V2→回滚及企业场景 |
| 独立效果评估 | 尚未注册 `memory:evaluate`，缺足够真实人工标签 | 实现评价工具；数据不足报告 insufficient |

已有计划中的“缺模型目录”“表单只能填写两个字段”“只能看到来源 ID”等描述已被当前源码超越。本计划要求先验证现有实现，测试通过的能力不重复开发。

## Global Constraints

- 记忆读取与学习独立：现有默认 `memoryEnabled=true`、`mode=suggest`；off 停止学习，suggest 仅产出待审候选，auto 仅让可信验证通过的低风险候选自动生效。客户设置不能突破账号总开关。
- 作用域沿用 `MemoryScope`：workspaceId、platform、可选 tenantId/accountId/conversationId；账号身份由主机绑定或服务端认证取得，renderer 或模型文字不授予权限。
- 每次回复最多 5 条有效方法、3 条案例，含包装的保守估算上下文最多 2000 token；待审、归档、隔离及无关方法不得进入生成。
- 默认后台并发 1、空闲 15 秒、单次复盘 30 秒、输入 8000/output 2000 token、最多尝试 3 次、UTC 日共享预算 50000 token。复盘、验证和模型整理不得各自获得独立无限预算。
- 案例默认保留 90 天，可配置 7–365 天；未知问题空闲 30 分钟关闭为 unknown。生成或发送成功不代表采纳、正确或问题解决。
- 自动验证最低需要 5 个独立会话的实际人工标注案例，排除学习来源重叠；不足为 insufficient。凭据绑定候选内容、版本、来源及冻结环境，24 小时失效；环境变化立即失效。
- 整理沿用现有 7 天周期、2 小时空闲、14 天新项宽限/待复核、30 天归档规则；人工及固定项受保护，模型合并默认关闭。
- 遗忘清除正文、索引、依赖方法、待提交项、缓存及在途回写；匿名费用记录可保留。归档可恢复，遗忘不可恢复。
- 本地候选生效不等于企业正式发布，不增加发送权限；复盘器不能调用终端、文件修改或发送工具。
- 实施前复核共享工作区及数据库版本。当前账本版本 12、备份支持 11/12；新增提交表需要完整迁移及备份兼容，不能只补建表语句。

## Review Focus

1. 提交已在服务端保存但响应丢失：恢复同一来源 ID，不重复案例或候选（任务 2）。
2. 切换账号、撤销设备或关库时模型请求尚未结束：迟到响应不得写入或显示（任务 1、3）。
3. V2 待审或验证依据改变：继续使用有效 V1，不能偷换版本或沿用失效凭据（任务 4、7）。
4. 遗忘发生在编辑、离线提交或复盘期间：表单、队列及回写不得让私密内容复活（任务 2、6、7）。
5. 合成标签、自评或同一会话交叉出现在训练和测试集：不得获得真实效果 passed（任务 8）。

## 4. 可直接执行的任务

每项先检查现有测试；缺覆盖才添加失败测试，观察预期失败，再修补并跑通过。提交按任务涉及文件精确暂存，保留其他工作区改动。不要因局部检查通过跳过后续任务。

### 任务 1：复核当前界面与真实学习来源

**Files:** 合同 `src/shared/contracts/learning-{memory,desktop,management,model-directory}.ts`；`src/main/ipc/learning-ipc.ts`；`src/main/services/agent-registration.ts`、`enterprise-learning-desktop-adapter.ts`；`src/renderer/src/features/memory/` 的现有组件；企业 learning events/episode closure 路由。

**Interfaces:** 沿用 `modelDirectory({scope})`、`episode({scope,episodeId})`、`settings({scope,patch})`、`manual({scope,sourceId,content,reason})`、`act({scope,id,expectedRevision,action,...})`，不扩大成任意 HTTP 或任意 IPC。

- [ ] 逐项检查模型目录/设置、完整方法、来源、校准、反馈及版本 UI，记录真实通过/失败，不依据历史日志宣布通过。
- [ ] 用真实生成任务绑定来源：草稿是 unknown；员工纠正必须指向实际草稿；昵称和发送状态不能当证据。同一 sourceId 只保存及排队一次，事务失败不得留半份记录。
- [ ] 添加缺失断言：跨账号/客户、伪造模型目录或额外密钥字段拒绝；已删除或过期来源不可读取；切换范围后迟到详情不可显示；刷新不覆盖未保存表单。
- [ ] 运行 `learning-ipc.test.ts`、`learning-enterprise-desktop-client.test.ts`、`learning-enterprise-routes.test.ts`、`learning-enterprise-events.test.ts`、`learning-correction-atomic.test.ts`；当前源码 build 通过后再运行实际桌面现有场景，不能使用旧构建作为当前证据。

**通过条件：** 界面能配置、教导、纠正和追溯真实来源，已存在功能的状态得到当前运行证据。

### 任务 2：窗口提交跨断网和重启可靠恢复

**Files:** 新建 `src/shared/contracts/learning-submissions.ts`、`src/core/persistence/learning-submissions.ts`、`src/main/services/learning-submission-sync.ts`、`tests/integration/learning-submissions.test.ts`；修改 ledger/schema/backup、具名 IPC/preload、窗口；沿用现有学习服务和注册客户端。

**Interfaces:** 新建 `LearningSubmissionIntent`，以 type=manual/correct/result/feedback 区分现有具名请求，保存其稳定 sourceId、可信 scope、完整请求哈希及首次提交时间；不保存凭据。`LearningSubmissionStore.enqueue(intent): SubmissionReceipt`、`pending(scope): LearningSubmissionIntent[]`、`acknowledge(scope,sourceId): void`、`forget(scope,conversationId?): void`。`SubmissionReceipt` 为 sourceId/type/state(pending|saved|forgotten)/createdAt/可读错误；desktop `submissions({scope}): Promise<SubmissionReceipt[]>` 不返回其他范围正文。

- [ ] 写失败测试 `restart_replays_same_source_once`、`response_lost_after_commit_is_idempotent`、`changed_body_same_source_conflicts`、`account_switch_blocks_replay`、`forgotten_submission_never_returns`、`retry_does_not_extend_retention`，核对服务端及本地记录数，而不是只核对提示文字。
- [ ] 主机验证当前授权并持久保存意图后再调用已有 API；恢复沿用原 sourceId。手工再次明确教导同样文字是新意图，不永久按文字去重，不伪造回复任务来复用 outbox。
- [ ] 仅匹配服务端确认才 acknowledge；窗口显示待同步/已保存。服务端确认后刷新失败保留保存成功提示。
- [ ] 重放前复核授权、保留期及遗忘状态；证据年龄来自实际原始案例时间，人工来源时间由可信主机首次提交及服务端首次接受记录固定，重试不能续期。
- [ ] 按当前版本 12 追加 13 迁移，更新备份恢复合同并支持 11/12/13；若执行时其他改动已经提升版本，先复核迁移再追加，不覆盖已有迁移。测试旧库升级、新库备份恢复、恢复后权限撤销及遗忘阻断。已确认/遗忘/过期项清理正文，关闭等待在途请求结束。

**通过条件：** 断网、重启、响应丢失都不丢学习意图、不重复学习、不复活被遗忘资料。

### 任务 3：打通后台提炼与局部自我修订

**Files:** `src/core/memory/learning-{reviewer,jobs,scheduler,model-configuration,transport}.ts`；企业 reviewer service/worker/authority。

**Interfaces:** 保留 `LearningReviewer.review(input: LearningReviewRequest, signal: AbortSignal): Promise<LearningReviewResult>`；create/revise 输出严格 JSON，revise 附 memoryId/expectedRevision；最多 5 个操作，也允许没有可学内容。

- [ ] 测试“实际纠正→有出处候选”“实际使用的方法收到新纠正→V2”，拒绝未读取目标、伪造出处、过期证据和陈旧修订号；unknown/失败不写成成功技能。
- [ ] 复盘选择实际配置模型；缺配置明确报错，不静默切换。客户原话仅作为数据，不提升成企业规则。
- [ ] 使用可挂起的回环模型请求测试前台抢占、超时、预算耗尽、设备撤销及停机：请求进行中撤销/关库，释放响应后零新增候选、零关闭数据库回写；真实费用仍计账。
- [ ] 运行 `learning-runtime.test.ts`、`learning-iteration.test.ts`、`learning-transport.test.ts`、`learning-enterprise-worker.test.ts`，补缺失时序覆盖。

**通过条件：** 学习由真实反馈驱动，已有方法可持续修订，后台不抢占前台且取消确实阻止提交。

### 任务 4：验证、正确生效、企业发布和回滚

**Files:** 本地 learning validation/store/product-validation；企业 product-validation/validator/management runtime；`server/src/learning/learning-publication.ts`、`server/src/generation/publication.ts`、`server/src/admin/{evaluation-admission,administration}.ts` 及既有管理入口。

**Interfaces:** 复用 `validate({scope,id,expectedRevision})`、现有版本动作及 `Administration.publish(tenantId,accountId,input:Publication)`；桌面仅提交授权请求，不签发验证凭据或获取管理员密钥。

- [ ] 用同一实际回复管线做无候选/有候选配对回放；独立人工标准仅供主机评分，不能泄露给生成模型。测试少于 5 个独立会话、来源重叠、纯模型标签均为 insufficient。
- [ ] 测试事实越界/严重错误拒绝，环境、知识、模型或候选版本变化及 24 小时过期使旧凭据失效；负面反馈隔离相关方法。
- [ ] 核验 suggest 仅待审；auto 仅接受可信低风险准入；V2 待审使用有效 V1，固定方法不被后台改写。
- [ ] 企业发布准备冻结方法目录及环境，交既有管理员准入流程，评估期间变化必须重新准备。界面明确候选/本地生效/企业已发布状态。
- [ ] 核验回滚产生可审计版本，下一次实际生成使用恢复后的内容；旧草稿依据失效，不能继续发送。

**通过条件：** 本地及企业各自从候选走到实际生成；企业正式发布有独立证据；错误学习可及时停止或恢复。

### 任务 5：确保下一次实际回复使用学到的方法

**Files:** `src/core/memory/learning-{context,retrieval}.ts`、`src/main/services/learning-knowledge.ts`、实际回复管线；企业 learning generation context/context lifecycle/publication。

**Interfaces:** 保留 `retrieveLearningContext(store,scope,query,includeCases?,excludedCaseSourceId?): LearningContext` 的 text、snapshot、contextVersion 和实际方法引用；消费已生效/正式发布的方法版本。

- [ ] 加入与学习来源不同的相似新问题，核对真实模型请求的上下文、实际方法 id/revision、生成任务版本及最终回复，不能只看卡片“已生效”。
- [ ] 无关问题不加载相同方法；客户专属偏好不扩散；最多 5 方法/3 案例/2000 token（含包装）；当前业务事实优先于旧经历。
- [ ] V2 生效、回滚、停用及遗忘后新生成分别核对版本；已有旧快照和待发送草稿必须按现有规则失效。

**通过条件：** 工作记忆确实影响后续合适问题，且范围、依据和版本正确。

### 任务 6：经验整理、保留和彻底遗忘

**Files:** 本地 learning curator/curation-plan/retention；企业 maintenance/curation-merge；持久提交及窗口 scope/operation guards。

**Interfaces:** 复用 `curate({scope,dryRun})`、`reports({scope})`、`forgetScope({scope})`，遗忘联动任务 2 的提交存储。

- [ ] 验证整理预览和执行一致、固定/人工项受保护、宽限与归档按真实时间计算，归档可恢复。
- [ ] 模型合并只产生带替代关系的候选，重新验证；新方法通过前旧有效方法继续可用，不能根据模型自述删掉旧方法。
- [ ] 遗忘发生在离线提交、打开来源、未保存编辑和挂起复盘期间：正文、索引、派生方法、表单及缓存清除；释放旧响应和恢复旧设备均不能复活内容。
- [ ] 运行 maintenance/retention-lifecycle/curator-merge/context-version 专项，核验关学习仍执行保留策略、预算可审计。

**通过条件：** 长期运行不会堆积失效经验或越界传播，归档和遗忘语义明确。

### 任务 7：完整实际 Electron 闭环验收

**Files:** 扩展 `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`、相关实际窗口；使用现有注册 `test:learning:desktop`。

**Interfaces:** 实际 Electron/React/preload/可信 IPC/存储和生成链；隔离 userData、数据库及回环模型。企业用真实认证、管理和发布链；合成模型只证明工程行为。

- [ ] 场景 A：实际试答→窗口纠正及结果→后台候选 V1→独立验证→本地生效→相似新问题实际使用 V1。
- [ ] 场景 B：再次纠正→后台 V2→待审仍用 V1→验证后用 V2→回滚→实际新回复恢复旧做法。
- [ ] 场景 C：在隔离企业环境重复 A/B，必须经过正式发布，不能用本地人工激活替代企业发布。
- [ ] 场景 D：断网/主进程重启恢复、响应丢失、客户/账号切换、模型进行中撤销、预算耗尽、保存后刷新失败及遗忘迟到结果。
- [ ] 同次运行输出 result.json、截图、实际请求及方法/上下文版本、费用与限制；手工创建/激活 V1/V2 的测试不能替代自动学习场景。

**通过条件：** 用户完整操作链和实际生成一致，本地与企业闭环分别有当前证据。

### 任务 8：独立效果评估与最终交付

**Files:** 新建 `evals/memory/{README.md,contracts.ts,metrics.ts,fixtures/synthetic.json}`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`；在 package.json 注册 `memory:evaluate`。

**Interfaces:** `evaluateMemory(dataset:MemoryEvaluationDataset):MemoryEvaluationReport`。数据包含来源、会话分组、冻结模型/知识/策略/方法版本、三组输出（无记忆/现有静态记忆/新学习记忆）、独立人工盲评、token/费用和时延；结果 status=passed|failed|insufficient，并输出各基线对照。

- [ ] 按会话划分学习/校准/留出评估，避免同一客户问题片段泄漏；确认真实人工标签出处，boolean 标志或模型自评不能独立证明标签真实。
- [ ] 测试指标计算、按会话聚类置信区间、来源交叉拒绝、冻结环境失配、标签不足 insufficient；基线修改率为零时相对改善不可计算。合成数据不得产出真实业务效果 passed。
- [ ] 实现 `memory:evaluate -- --dataset <path> --out <directory>`，输出 JSON/可读报告。CLI passed 退出 0、failed 退出 1、insufficient 退出 2；synthetic 只可声明工程验证通过，并保留业务 insufficient。
- [ ] 建议初始业务样本：学习 100、校准 100、评估 200 条，评估至少 30 个独立会话；相对现有静态记忆的实质修改率降低至少 20%，严重错误 0，覆盖率下降不超过 5 个百分点，新增 p95 时延不超过 500ms。以上为待业务确认目标，不能当成现有实测或统计充分性保证。
- [ ] 缺真实标签时仍完成工具、工程场景与数据模板，明确业务效果不足；后续导入真实标签再验收，不伪造成功数据。
- [ ] 最后顺序运行当前全量 test/services/build/lint/scenarios/真实 PostgreSQL/desktop；处理实际失败并复核，交付版本、来源、配置、权限和使用说明。

**通过条件：** 工程闭环有当前证据；业务改善由独立报告判定，没有资料时明确不足。

## 5. 执行命令及验收交付

以下是实施时命令，本次没有执行。先确认当前目录及 `.node-version`；专项使用项目便携 Node 直接运行 Vitest，避免 wrapper 吞掉测试过滤参数。

```powershell
# 在克隆后的仓库根目录执行
$learningNodeVersion = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
$learningNodeExe = Join-Path $PWD ('.local/toolchain/node-v' + $learningNodeVersion + '-win-x64/node.exe')
& $learningNodeExe 'node_modules/vitest/vitest.mjs' run tests/integration/learning-ipc.test.ts tests/integration/learning-iteration.test.ts

# 最终检查顺序；上一步完成并检查退出状态后再执行下一步。
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run lint
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run test:learning:desktop

# 任务 8 创建 CLI 后执行；synthetic 预期业务 insufficient，退出 2。
& '.\scripts\dev-tools.ps1' run memory:evaluate -- --dataset evals/memory/fixtures/synthetic.json --out .local/reports/memory-evaluation/synthetic
```

| 用户验收动作 | 必须观察到的结果 | 任务 |
| --- | --- | --- |
| 纠正一次，重启后重试 | 来源相同，只保存/学习一次，提示真实 | 1、2 |
| 教完整处理步骤并查看依据 | 全字段持久化，打开授权真实来源 | 1 |
| 下一次问相似问题 | 实际请求使用正确生效版本，企业经过正式发布 | 3、4、5、7 |
| 再次纠正 | 后台形成 V2，待审期间 V1 可用 | 3、4、7 |
| 恢复旧做法 | 新回复确实用恢复后的内容及版本 | 4、5、7 |
| 换账号/客户或撤销设备 | 不显示、不重放、不回写其他范围内容 | 1、2、3、7 |
| 遗忘来源和方法 | 表单、搜索、队列、缓存及旧响应不复活 | 2、6、7 |
| 看效果和成本 | 独立人工对照报告；不足明确显示 insufficient | 8 |

里程碑：**M1 可操作且不丢提交（任务 1–2）→ M2 自动学习、使用、修订与回滚闭环（任务 3–7）→ M3 工具交付及效果可判定（任务 8）**。真实业务资料不足时，可以完成工程交付，但不能宣称业务改善已通过。

本次交付只有可行性分析及执行计划，没有进行上述开发或验收。
