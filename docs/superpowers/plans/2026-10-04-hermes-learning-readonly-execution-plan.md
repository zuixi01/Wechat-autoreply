# Hermes 自我学习接入工作记忆：可行性与执行计划

**只读复核日期：2026-10-05。** 本计划根据当前共享工作区源码更新；已有实现和已有测试文件不代表本轮运行验收通过。本次仅修改这份计划文档。

> **For agentic workers:** 后续实施使用 `superpowers:executing-plans`，按任务核验现有代码、补齐缺口并记录验收证据。用户本次要求“先不要改代码”：本次只做只读调查和交付计划，不实施产品变更、数据库迁移、安装、发布或真实消息发送。

**Goal:** 让工作记忆从真实客服经历、员工纠正和明确处理结果中提炼方法，供后续回复按需使用，并通过反馈、验证、版本修订、回滚和整理形成持续学习闭环。

**Architecture:** 在现有 TypeScript 学习模块内适配 Hermes 的持久记忆、程序性技能、后台复盘、历史检索和整理机制。复用本地 SQLite 与企业 PostgreSQL 存储；企业场景以服务端身份、正式发布版本和现有回复管线为权威。学习成果是带出处的处理方法；当前企业知识库继续提供业务事实。

**Tech Stack:** TypeScript、Electron、React、Zod、SQLite、PostgreSQL、Vitest、现有文本模型与 Jev 回复管线。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`。其中的旧代码缺口是历史调查；本计划以下面的当前源码核对为准。原 `2026-10-03-hermes-learning-completion.md` 的验收范围保留，本计划不缩减其范围。

## 需求理解与可行性

需求是把“保存对话和经验卡片”提升为“从经历学习怎样处理问题”。例如员工纠正退款回复，系统形成“先核对订单状态，再查询当前退款政策”的方法；遇到相似问题时使用；员工再次纠正时形成 V2，验证后替代 V1，并可查看改动和恢复旧做法。

技术上可行，且现有项目已有大量基础。不需要把完整 Hermes Python 程序搬入 Electron。推荐抽取机制、规则和适用的提示设计，接入已有学习模块；第一版只学习描述性的客服方法。

本次“自我学习”指更新外部记忆和技能内容；模型权重训练、自动修改应用源码属于其他工程。经验复用可以实现，业务效果仍需独立对照评价，不能预先保证每次学习都改善回复。

| 路线 | 代价和适配性 | 选择 |
| --- | --- | --- |
| 适配机制到现有 TypeScript 模块 | 复用权限、存储、版本、后台任务和生成链 | 推荐 |
| Hermes 独立 Python 旁路服务 | 增加运行时、存储、身份映射和工具权限管理 | 第一版不采用 |
| 仅追加历史对话或提示词 | 无法证明来源、控制错误扩散或可靠回滚 | 不满足迭代闭环 |

## 上游调研依据

本次通过 GitHub commits API 获取的 main 提交为 **`439334127f012e1ee0685acd5dba288e459af0ec`**，后续抽取以此固定版本为参考，不自动追随 main。本次读取了当前 README、官方 Memory/Skills/Curator 文档，以及该固定提交的 `agent/background_review.py` 和 `tools/skill_manager_guards.py`。固定提交的 curator、memory_tool_store、session_search 和 LICENSE raw 请求受到 429 限流；这些文件不算本次成功源码核验。历史规范中的其他 SHA 仅代表历史调查。实施涉及复制的文件时，先读取固定版本的完整原文和许可，记录路径、SHA、适配点及归属；不以文档介绍冒充源码核验。

| 机制 | 上游依据 | 接入工作记忆后的功能 |
| --- | --- | --- |
| 持久记忆 | Memory 文档、`tools/memory_tool.py`、`memory_tool_store.py` | 保存有来源的偏好和经验，控制容量、保留期与遗忘 |
| 程序性技能 | Skills 文档、`tools/skill_manager_tool.py` | 保存场景、指导、原因、步骤、坑点和检查项 |
| 后台复盘 | `agent/background_review.py` | 从纠正和处理结果提炼候选；前台优先、可取消、受成本限制 |
| 先读再改 | `tools/skill_manager_guards.py` | 只能修订已读取且仍是当前版本的方法 |
| 历史检索 | `tools/session_search_tool.py` | 按需查找授权范围内的实际案例和出处 |
| 定期整理 | 官方 Curator 文档；本次固定提交的 `agent/curator.py` 请求被限流 | 标记待复核、可恢复归档、保护人工与固定项；模型合并先提案 |

注意适配差异：Hermes 当前会话搜索支持全文发现、定位和浏览，源码与文档说明不依赖模型摘要；其后台工具和文件权限属于自己的运行框架。本项目后台复盘只输出受校验的候选数据，不获得终端、发送或任意文件写入能力。持久任务继续使用本项目的队列，而非照搬进程内线程状态。

来源：

- [固定上游提交](https://github.com/NousResearch/hermes-agent/tree/439334127f012e1ee0685acd5dba288e459af0ec)
- [后台复盘源码](https://github.com/NousResearch/hermes-agent/blob/439334127f012e1ee0685acd5dba288e459af0ec/agent/background_review.py)
- [技能修改守卫源码](https://github.com/NousResearch/hermes-agent/blob/439334127f012e1ee0685acd5dba288e459af0ec/tools/skill_manager_guards.py)
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/)

上游为 MIT；若实际复制源码或实质提示内容，随复制内容保留版权与许可，并记录来源。机制适配不要求引入完整 Hermes、脚本型技能、外部用户画像服务或向量数据库。

## 当前源码核对：复用与补缺

本次只读取源码，不启动测试、模型或后台服务。代码存在不代表完成产品验收，历史测试总数不作为本次验证结果。

| 当前能力 | 已读取的文件证据 | 后续工作 |
| --- | --- | --- |
| 案例、技能、版本、设置和反馈合同 | `src/shared/contracts/learning-memory.ts`、`learning-events.ts`、`learning-management.ts` | 复用严格具名请求/响应合同；新增操作同时增加运行时校验 |
| 本地问题聚合、纠正和结果服务 | `learning-episode-assembler.ts`、`src/main/services/learning-service.ts` | 核验实际工作台和真实生成的接入 |
| 持久复盘、检索、风险验证和整理 | `src/core/memory/learning-*.ts` | 按行为验收；已有行为通过就保留 |
| 企业存储、队列、真实管线验证和维护 | `server/src/learning/` | 复用，不新建第二套 worker 或存储 |
| 企业管理 HTTP 路由 | `learning-service.ts`、`learning-routes.ts`、`http/application.ts` | 已有快照、版本动作、手动教导、校准、搜索、验证与整理入口；核验客户端接入 |
| 手动验证/整理的 worker 桥接 | `learning-management-runtime.ts`、`server/src/index.ts` | 已有代码；补模型进行中撤销、关闭和迟到返回的端到端验证 |
| 企业合并候选和替代约束 | `learning-curation-merge.ts`、迁移 022 | 已有实现；核验修订、来源变化和原子替代 |
| 企业实际生成案例和任务事件 | `server/src/generation/generation-service.ts`、`learning-events.ts`、迁移 023/024、`learning-episode-closure.ts` | 已有实际 unknown 草稿采集、任务反馈及 30 分钟空闲关闭；核验迟到纠正优先、可信问题聚合与完整用户流程 |
| 桌面实际反馈与持久同步 | `agent-registration.ts`、`desktop-agent-runtime.ts`、`learning-outbox-sync.ts`、`learning-outbox.ts`、`WorkbenchLearning.tsx` | 工作台反馈、企业有效保留期和遗忘联动已有实现；窗口人工教导/纠正的跨重启持久重试仍需补齐 |
| 企业管理客户端与 adapter | `agent-registration.ts`、`learning-management.ts`、`enterprise-learning-desktop-adapter.ts` | 已有完整管理方法及三个 episode 反馈方法；复用同一注册客户端，核验取消与权限时序 |
| 桌面 IPC/preload | `learning-desktop.ts`、`learning-ipc.ts`、`src/main/index.ts`、`src/preload/index.ts` | 已有 18 个具名操作和主机 backend resolver；六个校准/验证/整理/搜索/报告操作已公开，主要缺 renderer 控制和模型目录 |
| 工作记忆窗口 | `LearningMemoryPanel.tsx`、`LearningCorrection.tsx` | 企业范围选项仍伪造部分范围，详情采用定时回调；纠正每次生成新来源，人工教导来源仅组件内保存；需完整界面与迟到保护 |
| 学习桌面验收与专用效果评估 | `package.json`、`scripts/`、`evals/` | 未发现完整学习 smoke 或记忆对照评估脚本；需要交付 |

因此，不能把企业管理入口、维护、模型合并或桌面 adapter 继续列为“从零新建”。工程重点是可靠提交、完整界面、正式发布入口、剩余权限时序检查与完整验收。

### 本轮复核后的执行起点

服务端已有实际草稿采集和任务绑定事件实现。工作台的 task 反馈与工作记忆窗口的 episode 反馈是两种明确入口：窗口使用 `/v1/learning/episode-correction`、`episode-result`、`episode-feedback`，服务端精确追溯实际生成任务，再复用原任务验证与反馈事务。不能要求 renderer 为历史 episode 自造 task/draft，也不能把人工教导案例冒充实际生产任务。

主进程 `registerLearningIpc` 已接入 `runtime.learningBackend(scope)`，企业 adapter 使用当前设备同一注册客户端，并在范围变化、遗忘和关闭时取消请求；明确本地范围仍走本地服务。`LearningOutbox` 已接入企业有效保留期、匹配账号遗忘和原始时间清理。`LearningStore.teach` 已原子保存案例/候选；管理搜索已有 `searchEpisodeHistory`。以上均应复用，不能重新建一套。

`package.json` 尚未注册 `test:learning:desktop` 或 `memory:evaluate`。本地 Ledger 当前 schema 为 **12**，备份/恢复合同支持 11 和 12；企业迁移目录本次已出现 **027**（其他恢复功能），不得占用或改写这些版本。需要迁移时重新检查实际最大版本和运行时 schema 后追加。历史验收文档记录过 1178 项全量测试及 41 项真实 PG 测试通过；本轮未运行它们，不能宣称当前工作区通过验收。

执行时先记录工作区基线，并定向核验任务 1、5 已实现行为；随后优先完成任务 6 的范围/详情保护、持久提交与完整窗口，再核验任务 2、3、4 并完成正式发布接线，最后执行任务 7、8。任务编号表示验收归属。依赖顺序为 **基线 → 1/5 核验 → 6 → 2/3/4 补缺 → 7 → 8**；重型检查串行。任何已实现部分只补缺口，不重复创建学习存储、worker 或管理服务。

### 成果形态与三个里程碑

闭环为：真实案例 → 可信纠正/结果 → 后台复盘 → 候选方法 → 独立验证/人工审核 → 生效版本 → 下一次相关回复 → 使用反馈 → V2/回滚。案例保留原始事实；经验保存有出处的规则；技能保存适用场景、步骤、坑点和检查项。

- **M1 可操作：** 工作记忆窗口能可靠教导、纠正、记录结果、查看来源/版本、搜索、校准、验证、整理和遗忘；断网/重启不会重复学习或误报保存。
- **M2 闭环可复现：** 真实回复管线加载生效方法；V2 待审仍用 V1；生效/回滚符合企业正式准入；撤销、停机、遗忘和预算用例通过真实桌面与数据库验收。
- **M3 效果可判定：** 独立留出集完成无记忆/旧记忆/学习记忆对照；有足够人工标签才判业务效果，缺标签明确报 insufficient。

## Global Constraints

- 工作记忆读取与学习开关独立：默认 `memoryEnabled=true`、`mode=suggest`；`off` 停止学习，`suggest` 只产生待审候选，`auto` 仅允许可信验证后的低风险方法生效。账号总开关约束客户级设置。
- 身份由可信绑定或服务端认证推导；昵称、模型文本和 renderer 请求中的 tenant/account 不产生权限。未核验身份不能学习成客户专属资料。
- 每次回复最多 5 条有效方法、3 条案例，总计最多 2000 个保守估算 token，包含包装文字。无关、归档、隔离或待审内容不进入实际生成。
- 默认后台并发 1、空闲 15 秒开始、单次模型请求 30 秒、复盘输入 8000/输出 2000 token、账号 UTC 日预算 50000、最多 3 次尝试。复盘、验证、模型整理共享账号占额和后台互斥。
- 案例默认保留 90 天，可配置 7–365 天。无明确处理结果的问题空闲 30 分钟后关闭为 unknown。草稿、发送确认、模型自评不等于员工采纳或解决。
- 整理每 7 天且空闲 2 小时；新项宽限 14 天，闲置 14 天待复核、30 天可恢复归档。保护人工与固定项；模型合并默认关闭。
- 自动生效最低回放 5 个独立会话的实际人工标注案例，排除学习来源重叠；证据不足返回 insufficient。验证凭据有效 24 小时，绑定范围、修订、内容、来源、记忆和环境版本、模型、知识、策略、验证器及数据集。
- V2 待审时仍使用 V1。记忆在存储中生效不代替企业正式发布评估，也不授予发送或退款等业务权限。
- 遗忘删除正文、索引和对应派生身份资料，并阻断旧任务和迟到模型结果；费用保留匿名占额，不能为结算恢复遗忘资料。归档和遗忘是不同操作。
- 保留工作区已有修改，不 reset/stash/批量暂存，不在本次实施任何产品修改。未来重型验证串行执行；测试使用隔离数据，不发送真实消息。

## Review Focus

1. 同昵称不同客户、账号切换和伪造身份：范围不能串用；任务 1、5、6 的测试覆盖。
2. 重试、重启、断网和双 worker：同一事件只保存一次，不重复候选或计费；任务 1、2、5 覆盖。
3. 遗忘、政策/模型变化和候选修改：旧验证失效，旧结果不能覆盖新状态；任务 3、4、6 覆盖。
4. 前台抢占、设备撤销、关闭学习和停机：后台不能继续生效，已发生费用正确结算；任务 2、3、5 覆盖。
5. 草稿、发送和合成标签：不能被统计为解决或真实效果改善；任务 1、7、8 覆盖。

## 执行方法与基线

执行目录：仓库根目录。按上述当前依赖顺序实施八项任务；先核验任务 1/5，完成任务 6，再核验/补齐任务 2/3/4，最后完成任务 7/8。缺失行为按“写失败测试 → 运行确认失败原因 → 最小实现 → 定向验证 → 记录证据”推进。已通过行为不为了显示红测而删除或改坏。

启动实施时更新已有 `docs/learning-memory-acceptance.md`，保留历史失败记录，并新增工作区状态、各要求与任务映射、实际命令、退出码、截图/报告和剩余限制。使用项目自带工具链；以下均为未来执行命令，本次未运行：

```powershell
# 在克隆后的仓库根目录执行
git status --short
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
```

共享工作区存在大量已有修改，提交仅在归属清晰时对本任务文件进行，不批量提交他人的变更。

### Task 1：接通真实问题、生成与员工反馈

**Files:** 复用已有 `src/shared/contracts/learning-events.ts`、`server/src/learning/learning-events.ts`、`server/migrations/023-learning-events.sql`、`024-learning-episode-closures.sql`、`server/src/learning/learning-episode-closure.ts`；按缺口修改企业 generation/repository/queue/routes/service，以及本地 `learning-service.ts`、`learning-episode-assembler.ts`。复用 `tests/integration/learning-enterprise-events.test.ts`、`learning-enterprise-closure.test.ts`，扩展 `generation-service.test.ts`、`learning-correction-atomic.test.ts`、`learning-episode-assembler.test.ts`。023/024 已存在，不重建；问题聚合如需新迁移，应在实施时确认下一空号并同步迁移清单。

**Interfaces:** 复用已有 `LearningTaskReference = { taskId: string; contextHash: string; draftHash: string; draftRevision: number }` 及 Hash/Id/Version 校验。已有 `LearningTaskCorrection = { reference: LearningTaskReference; sourceId: string; text: string; reason: string }`；`LearningTaskResult` 与 `LearningTaskFeedback` 分别在 reference 上组合现有 result/humanFeedback 输入。

企业沿用 `EnterpriseLearningManagement` 中已存在的 correction/result/feedback 操作与 `recordEnterpriseTaskEventWithin`；对应 POST `/v1/learning/correction`、`/result`、`/feedback`。服务端从已保存的实际生成任务读取身份、客户、草稿和方法引用，不接收客户端声明的 scope、problemId 或 memoryRefs。本地继续复用 `LearningService.correct/confirmResult/humanFeedback`。

- [ ] 写 `generated_draft_is_unknown`、`same_event_is_idempotent`、`audit_failure_rolls_back_event_and_queue`、`cross_account_reference_is_denied`、`changed_draft_is_rejected` 测试，断言真实生成记录 unknown；重复纠正只一个案例/任务；审计失败无部分写入；跨账号与草稿哈希失配不产生学习。
- [ ] 运行新增测试确认缺失接线的失败，再在生成完成事务中保存实际案例、`enterpriseDraftSource(task)` 来源与真实加载引用。使用已绑定事务端口，不嵌套申请第二次账号锁。
- [ ] 将同一可信客户的开放问题持久聚合；以明确结果或 30 分钟空闲关闭，最多 100 条消息。客户并行问题只有可信问题绑定时才合并；不能以昵称或模型判断合并。没有绑定时保持独立片段。
- [ ] 纠正/结果/反馈在一个授权事务中保存事件、案例、审计和必要复盘队列。事件键稳定，重试内容变化返回冲突；服务端生成事件时间，客户端不能改写来源时间。
- [ ] 历史反馈允许对已过发送有效期的保留案例提交；发送权限过期不使历史学习凭空失效。记录必须属于当前授权账号且对应实际草稿；遗忘、身份撤销及伪造引用仍拒绝。
- [ ] 核验现有 task 和 episode 两组反馈 operations、严格合同与错误映射；同账号另一授权设备可纠正真实案例，跨账号/跨客户、无实际任务的人工案例和已变更草稿拒绝。已有操作不重复添加。执行本任务四组专项测试，确认全部通过并保存证据。

**通过条件:** 真实生成有出处；员工纠正一次只入队一次；发送不增加 resolved/adopted；问题聚合与重启恢复可重现。

### Task 2：核验后台提炼与自我修订

**Files:** 核验/必要时修改 `learning-reviewer.ts`、`learning-jobs.ts`、`learning-scheduler.ts`、`learning-model-configuration.ts`、`learning-transport.ts` 与企业 reviewer service/worker。测试 `learning-runtime.test.ts`、`learning-iteration.test.ts`、`learning-transport.test.ts`、`learning-enterprise-worker.test.ts`。

**Interfaces:** 复用 `LearningReviewer.review(input: LearningReviewRequest, signal: AbortSignal): Promise<LearningReviewResult>` 与严格 operations 合同。输出最多 5 个新候选或修订，也允许空结果；修订附带已读取版本的依据，不引入第二种输出格式。

- [ ] 核验或补测 `unknown_is_not_success`、`unread_revision_cannot_be_patched`、`used_method_is_revised_before_duplicate_create`、`no_new_lesson_returns_empty`。
- [ ] 核验持久队列恢复、3 次默认尝试、UTC 跨日预算、实际 usage 和估算费用、模型超时与非配合取消；失败保留原因，不伪报零成本。
- [ ] 接通任务 1 的纠正/结果信号；达到明确质量失败条件时只生成候选，不将未知结果描述为成功经验。候选 V2 不覆盖 activeRevision V1。
- [ ] 核验前台抢占、off、撤销、遗忘与停机后的迟到提交拒绝；专用复盘模型配置复用主机模型目录，凭据不传 renderer。
- [ ] 执行四组专项测试，记录真实队列状态与预算账目。

**通过条件:** 一条纠正产生有来源的方法或解释“没有可学内容”；下一条纠正形成 V2；后台不影响前台权限和优先级。

### Task 3：核验生产管线验证、激活与回滚

**Files:** 复用 `learning-validation.ts`、`learning-risk.ts`、validation-store、local/enterprise `learning-product-validation.ts`、`learning-validation-budget.ts`、`learning-management-runtime.ts`。测试 `learning-product-validation.test.ts`、`learning-enterprise-product-validation.test.ts`、`learning-enterprise-budget.test.ts`，新增 `tests/integration/learning-enterprise-management-runtime.test.ts`。

**Interfaces:** 本地复用 `validateCandidate(scope, id, revision, signal?): Promise<LearningValidationResult>`；企业复用 runtime 的 validate 桥接及现有 product validation。renderer 只请求验证，不签发 grant。

- [ ] 核验人工标签最低 5 个独立会话、来源不重叠、标签不放入生成提示、缺标签 insufficient；合成标签不宣称真实效果。
- [ ] 用实际回复管线成对比较基线/候选，冻结知识、策略、模型与其他方法；候选侧不偷带被替换的方法。回放不得创建发送任务或许可证。
- [ ] 核验凭据过期、编辑、来源变化、环境变化后再恢复均使旧凭据失效；激活、单次消费和审计同事务。
- [ ] 新增“模型请求已发出后撤销调用设备”“停机后模型迟到返回”测试，要求无生效、无新增候选，已发生费用仅按现有规则结算。ordinary application role 不能获得 worker 签发能力。
- [ ] 正式发布接线复用 `server/src/generation/publication.ts`、`server/src/learning/learning-publication.ts`、`server/src/admin/administration.ts` 和既有 admin 命令。为管理员补冻结当前方法 manifest、评估、发布及撤回的具名操作/说明；窗口显示实际已发布版本和当前生效版本是否一致。员工只获得有权限的状态读取，不能取得管理员凭据或绕过评估。冻结版本过期、方法修改、遗忘或知识/模型漂移时拒绝原发布。新增发布专项，证明候选/未发布方法不会进入企业正式生成。
- [ ] 运行本任务专项；演示 V1 生效 → V2 待审仍用 V1 → 验证 → V2 生效 → 回滚生成新修订。

**通过条件:** 自动生效必须由可信验证授予；错误可隔离；回滚后实际加载正确版本。

### Task 4：整理、合并、检索与遗忘

**Files:** 复用 `learning-curation-plan.ts`、`learning-curator.ts`、`learning-retention.ts`；企业 maintenance/merge/repository 与迁移 021/022。测试 `learning-enterprise-maintenance.test.ts`、`learning-curator-merge.test.ts`、`learning-retention-lifecycle.test.ts`、`learning-retrieval.test.ts`、`learning-enterprise-routes.test.ts`。

**Interfaces:** 企业沿用 maintenance `curate(reference, conversationId, { dryRun? }, signal?)`；本地沿用 `LearningService.curate(scope, dryRun)`。桌面已有 `searchEpisodes({scope,query,limit?})`；本地管理使用 `LearningStore.searchEpisodeHistory(scope,query,limit=10)`，企业使用既有 search。回复侧 `searchEpisodes` 保留最多 3 条，不为管理页面扩大生成上下文。

- [ ] 核验 7 天/2 小时、14 天宽限、14/30 天维护、人工/固定保护、首次观察不整理、dryRun 不写入或产生模型费。
- [ ] 核验合并的完整来源、人工修订后保留替代约束、旧项固定或来源被遗忘使候选失效；新方法生效和所有旧方法归档同事务。
- [ ] 搜索 query 1–240 字符、limit 1–20 默认 10；NFKC/大小写归一化，按时间倒序和稳定 ID 排序。只搜索授权范围内尚在保留期的案例，无匹配返回空。
- [ ] 核验实际清理正文与索引，脱敏来源，取消旧任务，迟到响应不恢复数据；共享费用账保留匿名占额。
- [ ] 执行五组专项测试，记录 dryRun/实际整理/恢复/遗忘前后的持久状态。

**通过条件:** 方法可整理且可恢复；不误改人工方法；遗忘内容不能通过搜索、索引或迟到任务重新出现。

### Task 5：企业桌面客户端与真实反馈入口

**Files:** 核验并按缺口修改 `src/main/services/agent-registration.ts`、`desktop-agent-runtime.ts`、`learning-outbox-sync.ts`、`src/shared/contracts/workbench.ts`、`src/main/ipc/agent-ipc.ts`、preload、`src/renderer/src/features/agent/ReplyWorkbench.tsx`、`WorkbenchLearning.tsx` 和 `src/core/persistence/ledger.ts/learning-outbox.ts/ledger-schema.ts`。复用已有 `tests/integration/learning-management-client.test.ts`、`learning-outbox.test.ts`、`learning-enterprise-events.test.ts`，扩展工作台/IPC 测试与 `tests/concurrency/postgres-authority.test.ts`。

**Interfaces:** 复用 `AgentRegistration` 的三个具名方法：`recordLearningCorrection(task: ReplyTask, draft: ReplyDraft, input: LearningCorrectionInput, signal?: AbortSignal): Promise<LearningEpisode>`、`recordLearningResult(task, draft, input: LearningResultInput, signal?): Promise<LearningEpisode>`、`recordLearningFeedback(task, draft, input: LearningHumanFeedbackInput, signal?): Promise<void>`。复用私有 authorized 请求和认证前后范围检查；不暴露通用凭据请求给 renderer。任务/草稿必须校验当前身份、对应 taskId 和真实文本哈希；响应必须严格解析并匹配实际范围、原草稿和提交内容。复用已有 `WorkbenchLearningInput`，以本地 `{taskId, expectedVersion}` 加纠正/结果/反馈数据为输入，由 runtime 构造任务 1 的服务器引用。

`LearningOutbox` 已提供 `enqueue(event: LearningOutboxEvent): string`、`pending(scope: WorkbenchScope, now?: number, retentionDays?: number): LearningOutboxEvent[]`、`acknowledge(scope: WorkbenchScope, sourceId: string): void`、`discard(scope, sourceId)` 与 `forget(scope, conversationId?)`。事件包含稳定 sourceId、kind、当前可信账号/任务/草稿引用和对应输入，不保存明文凭据。已同步或遗忘后保留指纹而清理正文；内容变化不能复用旧 sourceId，当前范围不匹配的项禁止重放。复用 schema 12 与旧版 11 恢复兼容，不重建 outbox；新增结构时确认当前 `user_version` 后追加。范围遗忘要覆盖当前账号相应客户在各设备的待同步事件，不能只清除当前设备的行；迟到网络与模型结果同样受服务端遗忘约束。

- [ ] 运行已有模型引用伪造、账号切换时迟到响应、离线重试和跨账号事件测试；只为未覆盖的行为添加失败测试。
- [ ] 核验工作台已有“纠正并教给系统”“明确采纳”“问题处理结果”和错误分类。纠正必须提供原因；发送按钮只记录送达，不自动采纳或解决。提交已保存但刷新失败时仍保留真实保存结果；状态不能误报未保存。
- [ ] 本地 WorkbenchRow.version 在本地检查；服务端验证 task/context/draft 的权威引用。禁止把本地工作台状态哈希当成服务器可验证的草稿版本。
- [ ] 工作台在本地版本核验后将学习事件持久写入 outbox，再提交网络请求；收到匹配的服务端响应后才 acknowledge。断网、主进程重启和服务端成功但响应丢失时保留同一 sourceId 重放；同一事件最终只保存一次。界面分别显示“待同步”和“已保存”，不得把本地入队显示成服务端成功。outbox 按可信范围、保留期和遗忘策略清理，切换账号不重放旧账号事件。企业不回退到未正式发布的本地候选；认证凭据始终留在主进程。
- [ ] `learning-outbox.test.ts` 覆盖断网后的重启恢复、响应丢失后单次服务端保存、跨账号禁止重放、过期/遗忘清理和 sourceId 内容冲突。客户端现有测试覆盖伪造草稿、额外 scope 字段、返回异账号/异会话内容，以及请求期间账号变化。
- [ ] 核验已接入的服务端有效保留期与遗忘联动：过期基于原始证据时间，不因重试或纠正延期；确认后清理匹配账号各本地设备的正文，服务端拒绝其他设备旧事件。核验永久拒绝不阻塞后续有效事件、临时网络故障仍可重试；窗口提交新路径遵循同一策略。
- [ ] 核验设备变更和关闭 runtime 时同步立即取消、发送暂停先启动、迟到返回不能确认 outbox；并发关闭只关闭一次数据库。对应实际请求取消测试和数据库关闭测试均需通过。
- [ ] 核验 memoryCorpusVersion/memorySnapshotHash/learningContextVersion 在生成、缓存、审核和执行链传播；发布仍走原准入。
- [ ] 运行客户端与工作台专项，再运行真实 PostgreSQL 双池测试，证明事件幂等、账号锁等待时撤销阻断和 worker 并发单次处理。

**通过条件:** 用户的真实工作台操作进入企业权威学习记录；多设备共享同一账号经验；发布与发送仍受现有审批控制。

### Task 6：完整工作记忆窗口

**Files:** 复用现有 `learning-desktop.ts`、`learning-management.ts`、`learning-ipc.ts`、`src/main/index.ts`、`agent-registration.ts`、`desktop-agent-runtime.ts`、`enterprise-learning-desktop-adapter.ts`、preload、`MemoryWindow.tsx`、`LearningMemoryPanel.tsx`、`LearningCorrection.tsx`、`MemoryRevisionDiff.tsx`、`LearningJobsPanel.tsx`。新增 `LearningValidationPanel.tsx`、`LearningReportsPanel.tsx`、`LearningEpisodeFeedback.tsx`、`src/core/persistence/learning-submission-store.ts`、`src/main/services/learning-submission-sync.ts`；后两者只管理窗口传输意图，复用现有学习服务/凭据/预算，不另建学习 worker。扩展 `learning-ipc.test.ts`、`learning-management-client.test.ts`、`learning-enterprise-desktop-adapter.test.ts`、`learning-enterprise-events.test.ts`；新增窗口提交持久恢复测试。

**Interfaces:** 保留 `window.learningMemory`，复用已存在的 `calibration({scope})`、`importCalibration({scope,input})`、`validate({scope,id,expectedRevision})`、`curate({scope,dryRun})`、`searchEpisodes({scope,query,limit?})`、`reports({scope})`。增加严格具名 `modelDirectory({scope}): Promise<{id:string;label:string}[]>`，目录仅来自当前主机实际配置；需要显示待同步意图时增加 `submissions({scope})`，返回来源 ID、类别、状态、时间和可读错误，不包含凭据或其他范围正文。具体合同、preload、主机服务和 adapter 在同一任务内逐项对应。

复用 `src/shared/contracts/learning-management.ts` 的严格响应合同和 AgentRegistration 已有完整管理方法；以实际 HTTP 非空记录、任务、设置、错误和范围专项核验。企业请求只传合法会话选择/动作数据，tenant/account 由服务端确定。模型目录从本地主机 settings 或企业实际启用的复盘模型配置读取，仅返回 ID/标签；企业目录增加与当前认证范围绑定的具名 route/client 方法。空目录显示“未配置”，不能允许界面传任意端点，也不能伪造可用模型。

现有 `EnterpriseLearningDesktopAdapter` 和 `runtime.learningBackend(scope)` 已完成主机选择：当前注册企业工作区走同一 AgentRegistration，明确本地范围返回本地处理，认证失败不回退。保留这条路径及关闭/遗忘取消语义。企业 `assignLegacy` 已明确不支持，旧卡必须明确归属后通过授权人工教导接入。renderer 企业范围选项只能来自 snapshot 当前范围和授权范围列表；本地平台选项只能在可信本地模式下构造。

已有映射为 `snapshot→snapshot`、`detail→detail`、`settings→settings`、`act→action`、`manual→manual`、`review→review`、`cancel→cancel`、`forgetScope→forget-scope`、`calibration/importCalibration→calibration`、`searchEpisodes→search`、`reports→reports`、`validate→validate`、`curate→curate`；窗口 `correct/confirmResult/feedback` 分别映射现有三个 episode route，由服务器精确追溯真实任务。body 不传客户端声明的企业身份。sourceId 是幂等键，不产生授权；当前组件生成的稳定键需在主进程校验后持久保存，重启恢复复用同一键，不再以组件 ref 作为唯一重试记录。

**按此顺序执行任务 6：**

1. 范围与迟到保护：先写账号变化、卸载、范围切换、详情迟到和权限失效的用例。移除 `setTimeout` 写详情；所有详情、变更回包和提示绑定操作发起时的范围/请求序号，旧响应不覆盖新范围。权限失效清除旧正文；服务端明确保存后的刷新失败显示“已保存，刷新失败”，不重新提交。
2. 可靠提交：新增 `LearningSubmissionStore` 保存窗口传输意图，放在现有私有 SQLite，通过追加 schema 迁移创建 submission 表；同步更新备份/恢复合同和兼容测试。现有 workbench outbox 继续保存真实 task/draft，不为历史窗口伪造 ReplyTask。提交意图包含可信 scope、稳定 sourceId、类别、完整内容哈希、原始证据时间及必要输入。接口为 `enqueue(intent)`、`pending(scope)`、`acknowledge(scope,sourceId)`、`forget(scope,conversationId?)`，状态为 pending/saved/forgotten，范围和来源摘要参与唯一键。主进程在 HTTP 前写入；同来源不同内容冲突，使用同一注册客户端及已有教导/episode 服务重放，不另建学习存储或 worker。教导时间由主机确定；实际反馈时间来自授权案例，重试不能重置保留期。已确认/遗忘/过期删除正文保留摘要；撤销和切换账号不重放。刷新/renderer 或主进程重启从待同步列表恢复同一来源；同一内容以后明确再次教导是新意图，不永久按文本去重。
3. 控制面：接入校准读取/导入、验证、整理预览/执行、历史搜索、报告和模型目录；校准 JSON 校验失败有可读原因，人工标签不发送给待评回复模型。展示版本差异、来源、验证不足原因、任务/费用。review 返回 jobId=null 时显示实际未入队原因，不声称已排队。
4. 人工信号：增加明确采纳、已解决/未解决/未知，以及事实错误、重复问询、不当承诺；纠正需要说明原因。实际生成案例才提供生产反馈入口，人工教导案例保持人工来源。发送/草稿不自动变成成功信号。
5. 逐项运行对应测试、类型检查和受影响文件 lint；保留供任务 7 使用的实际 DOM 标签和按钮。

**必须新增的行为用例：** 企业选项没有缺 tenant/account 的伪范围；A 范围的迟到详情不会显示在 B；HTTP 已保存但回包丢失，重启后同 sourceId 最终只有一个案例/候选；窗口纠正与教导跨重启恢复；内容变化不能复用旧 sourceId；遗忘期间不能发起新读取、遗忘后旧提交不能复活；未配置模型目录为空且不泄露密钥；jobId=null 不显示已排队。

- [ ] IPC 测试覆盖范围伪造、旧版本、假 grant、范围切换后的迟到详情和旧卡迁移幂等。
- [ ] 核验已接入的主机 resolver 和同客户端 adapter；新增操作保持严格范围/响应校验、取消及无权限不回退。
- [ ] 显示候选/生效版本、来源、版本差异、验证不足原因、加载/采纳/纠正指标、费用与任务状态；接通校准、验证、整理预览、报告和搜索。
- [ ] 暴露独立复盘模型选择、学习模式、预算与保留期；模型选择仅返回主机提供的目录 ID，不暴露密钥。
- [ ] 修复详情和刷新跨范围迟到写入；保留既有教导原子事务，补跨重启持久来源与同步；旧卡入口统一到可追踪管理。
- [ ] 运行 IPC 专项与 node/web 类型检查。

**通过条件:** 用户能在工作记忆窗口完成教导、查看出处、验证、启用、纠正、回滚和遗忘，提示与实际持久化状态一致。

### Task 7：真实 Electron 学习链路演示

**Files:** 新增 `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`、`tests/integration/learning-acceptance.test.ts`；注册 `test:learning:desktop`，更新验收文档。

**Interfaces:** smoke 使用真实 Electron、隔离临时 userData、回环假模型和独立业务样例；报告保存 `{status, scenarios, screenshots, modelRequests, learningState, limitations}`。假模型仅用于工程证明。

- [ ] 实现 UI → preload → IPC → 服务 → 存储路径；不能通过直接改数据库伪装操作成功。
- [ ] 演示纠正 → 后台候选 → 校准验证 → 生效/企业准入 → 新回复实际加载 → V2 → 回滚，保存真实请求的记忆引用和文本边界。
- [ ] 演示无关问题不加载、跨账号隔离、前台抢占、预算耗尽、关闭学习、遗忘和迟到返回；实际发送替换为隔离模拟。
- [ ] 截图和机器报告须对应相同运行，并记录用例是否经 UI、主进程或测试夹具触发；不能把主进程调用称为按钮操作证据。
- [ ] 运行 `test:learning:desktop`，所有用例通过，证明草稿/发送不增加学习成功数。

**通过条件:** 学习闭环在真实桌面运行中可复现，界面与数据库、实际生成内容一致。

### Task 8：工程交付与真实效果评估

**Files:** 新增 `evals/memory/README.md`、`evals/memory/contracts.ts`、`evals/memory/metrics.ts`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`；注册 `memory:evaluate`；更新验收文档、README 与配置说明。

**Interfaces:** `evaluateMemory(dataset: MemoryEvaluationDataset): MemoryEvaluationReport`；合同定义在 `evals/memory/contracts.ts`，包含 provenance、会话组、冻结模型/知识/策略/记忆版本、人工盲评结果、token/费用和时延。报告 status 为 passed/failed/insufficient，并显示原因与样本量。

- [ ] 写测试：关联会话不能跨组；留出集不得参与学习；缺标签 insufficient；基线零分母无无限改善；版本漂移中止对照；合成数据不能声明业务通过。
- [ ] 对相同留出案例比较 memory-none、memory-legacy、memory-learning；冻结环境并关闭留出学习，人工盲评。不得混用既有 Jev A/B/C 指标命名。
- [ ] 建议学习/校准/留出集分别 100/100/200 条、留出至少 30 个独立会话；这是评估数据集，不一次塞进最多 200 条的校准导入合同。
- [ ] 拟议业务门槛：相较旧卡片实质人工修改率相对下降 20%，观察到的严重错误为 0，覆盖损失不超过 5 个百分点，前台 p95 新增耗时不超过 500ms。以上是待业务方采纳的目标，不能直接宣称已承诺或已达成。报告会话分组区间和样本局限。
- [ ] 最终串行运行下列检查，每项保存退出码与报告；针对失败修复并复测受影响范围，不能以历史绿色结果替代当前代码验证。
- [ ] 新 CLI 接口固定为 `memory:evaluate -- --dataset <path> --out <report-directory>`；报告包含三组样本数、独立会话数、冻结版本、实质修改率、严重错误、覆盖率、p95、token/费用、分组置信区间、排除原因及数据来源。合同或冻结环境失配退出非零；证据不足仍输出机器可读 insufficient，不能显示 passed。使用合成 fixture 验证报告算法，真实留出数据另行由实际业务资料与人工标注产生。
- [ ] 完成全范围最终审查和配置/操作文档；分别报告工程验收与业务效果。缺真实标注时工程可交付，业务结果必须标注证据不足。

```powershell
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run test:desktop
& '.\scripts\dev-tools.ps1' run test:learning:desktop
# 下列脚本由任务 8 新增；路径是实施时准备的隔离合成夹具。
& '.\scripts\dev-tools.ps1' run memory:evaluate -- --dataset evals/memory/fixtures/synthetic.json --out .local/reports/memory-evaluation/synthetic
```

合成评估的 expected status 是 insufficient（业务证据不足），工程夹具可以证明 CLI 和指标实现正确。真实业务门槛只在真实独立人工标签足够时判定。受影响文件 lint 先于最终全量检查执行；不运行会重写整个共享工作区的 format。

**通过条件:** 工程检查和端到端通过且证据可重放；真实效果有独立对照数据，或明确报告 insufficient。

## 最终交付与执行入口

交付：可操作的学习工作记忆；真实案例与反馈接线；模型/预算配置；版本来源、验证和整理报告；桌面截图/机器报告；实际 PostgreSQL 并发报告；区分工程完成与业务效果的验收文档。

开始开发可直接使用以下任务说明：

> 读取本计划和引用规范，在 仓库根目录 完整实施八项任务。先记录基线并核验任务 1/5 已有实际事件、同步、保留期和遗忘；优先完成任务 6 的范围/迟到保护、窗口持久提交、完整控制和模型目录；然后核验/补齐任务 2/3/4 的后台复盘、验证、撤销/停机、正式发布、检索与整理，最后完成任务 7 的真实 Electron 演示和任务 8 的独立评估及最终检查。复用当前企业 adapter 和学习服务，不创建平行学习实现。对缺失行为先写失败测试，逐项实现并记录真实验收证据；不以模型自评或合成数据宣称业务效果，不部署或发送真实消息。保留共享工作区已有变更，新增迁移先检查实际 schema 和当前最大序号。每个里程碑报告真实通过/失败和剩余项，不以测试数量代替验收。

本轮仅复核并更新本计划文档；产品代码、数据库结构和运行配置未在本轮修改。本轮没有运行测试、模型或桌面程序；计划中的命令与验收均留待开发阶段执行。
