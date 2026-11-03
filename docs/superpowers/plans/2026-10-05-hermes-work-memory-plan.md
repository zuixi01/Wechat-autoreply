# Hermes 学习机制接入工作记忆：可行性与执行计划

> **执行说明：** 本次只读调查并新增本计划，不修改产品代码、数据库或配置，不安装 Hermes，不调用业务模型或发送消息。后续实施使用 `superpowers:executing-plans`，逐项核验现有行为，只补实际缺口。

**Goal:** 让微信自动回复项目的工作记忆从真实经历、员工纠正和处理结果中提炼方法，经过验证后用于下一次回复，再根据反馈修订、回滚和整理。

**Architecture:** 将 Hermes 的学习机制适配到现有 TypeScript 学习模块，复用 SQLite、企业 PostgreSQL、后台队列、账号权限及实际回复管线。业务事实继续来自当前知识库，学习内容保存为有出处、范围和版本的偏好、经验与处理步骤。

**Tech Stack:** TypeScript、Electron、React、Zod、SQLite、PostgreSQL、Vitest、现有模型适配和 Jev 回复管线。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md` 提供已有设计背景；历史缺口以本计划的当前源码调查为准。既有完整验收范围不因本次重新计划而缩减。

**调查日期：** 2026-10-05。对象按当前仓库的“工作记忆”理解；若实际指 Codex/ChatGPT 应用内部记忆，不能通过修改这个项目替换其内部实现，需要另行确定官方扩展接口。

## 1. 需求理解与结论

可行。目标是“用过后能学会，并能纠错”，而不是仅保存更多聊天记录。

例如：员工将退款回复纠正为“先核对订单状态，再查询当前退款政策”。系统保存实际纠正及原因，后台提炼为处理方法，验证后在相似问题中复用。后续纠正形成 V2；V2 待审时仍使用已生效的 V1；V2 不适用时能回滚，并在下一次实际生成中核对使用版本。

本计划中的自我学习更新外部记忆和方法，不更新模型权重，也不自动修改应用源码。能实现持续积累与迭代；能否降低业务修改率，必须通过独立人工标注与对照评估判断，不能用模型自评或记忆数量代替效果。

| 路线 | 适配成本 | 判断 |
| --- | --- | --- |
| 将学习机制适配到已有 TypeScript 模块 | 复用现有身份、版本、存储、队列和生成链 | 推荐 |
| 运行完整 Hermes Python 旁路服务 | 需增加运行时、身份映射、同步和工具权限管理 | 当前阶段不采用 |
| 只追加提示词与历史聊天 | 无可靠来源、验证、修订及回滚闭环 | 不满足需求 |

## 2. 上游来源与抽取范围

通过 GitHub commits API 取得本次固定参考提交：`765342435609cc82cbeb3d664dcec24126da58ee`。实施时固定此提交，升级另行评估，不能自动追随 main。

| 上游机制 | 本次读取依据 | 在本项目中的对应行为 |
| --- | --- | --- |
| 持久记忆、保存审核及容量控制 | [官方 Memory 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) | 带来源的长期经验、读取/学习独立开关、容量与保留期 |
| 从经历创建和修订技能 | [官方 Skills 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) | 场景、指导、原因、步骤、坑点、检查项的结构化方法 |
| 后台复盘、取消和输入预算 | [background_review.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/agent/background_review.py) | 空闲复盘、有界成本、前台优先、迟到结果不提交 |
| 修改前必须读取目标 | [skill_manager_guards.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/tools/skill_manager_guards.py) | 只能修改输入中实际读过且修订号仍匹配的方法 |
| 历史会话检索 | [session_search_tool.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/tools/session_search_tool.py) | 按需检索实际案例与来源，采用权限过滤和返回长度限制 |
| 技能生命周期与可恢复归档 | [curator.py](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/agent/curator.py)、[官方 Curator 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/) | 定期整理、保护固定项、合并先提案、归档可恢复 |

后台复盘、整理、检索和 LICENSE 的固定提交原文已成功获取并检查相关段落。技能守卫的 raw 请求曾遇到 429，随后通过固定 ref 的 GitHub Contents API 成功读取，不能把第一次失败记为成功。Memory 的具体存储实现未逐段源码核验，表中该项依据为官方文档。

上游 [LICENSE](https://github.com/NousResearch/hermes-agent/blob/765342435609cc82cbeb3d664dcec24126da58ee/LICENSE) 为 MIT。若实施中复制源码或实质提示内容，保留对应版权和许可，记录文件、提交与适配点；本计划未复制实现。

抽取的是机制，不引入完整 Hermes、终端工具、脚本执行型技能或外部用户画像系统。本项目复盘只输出经过严格解析的候选数据；Hermes 的 Python 线程、文件写入和工具调度不直接搬入 Electron。

## 3. 当前源码与缺口

本次只读源码及已有记录，未重跑测试。下表表示代码现状，不表示已经完成验收。

| 能力 | 当前情况及文件 | 本轮计划重点 |
| --- | --- | --- |
| 案例、方法、版本和反馈合同 | `src/shared/contracts/learning-memory.ts` 已有 preference/lesson/skill 与版本、范围、设置 | 复用，不新建第二套记忆结构 |
| 后台提炼及按版本修订 | `src/core/memory/learning-reviewer.ts` 已有结构化 operations、来源检查及 expectedRevision | 核验真实链路、取消、冲突和成本 |
| 相关检索与回复上下文 | `src/core/memory/learning-context.ts` 已有方法/案例检索和上下文版本 | 核验实际新回复采用的方法和版本 |
| 验证、整理及企业运行桥接 | `learning-validation.ts`、`learning-curator.ts`、`server/src/learning/` 已存在 | 补剩余撤销时序与正式发布流程 |
| 桌面企业接口 | `learning-desktop.ts`、IPC、preload 与企业 adapter 已有具名操作 | 增加主机模型目录、可靠窗口提交 |
| 窗口校准/验证/报告/搜索/反馈 | 已有 `LearningValidationPanel.tsx`、`LearningReportsPanel.tsx`、`LearningEpisodeFeedback.tsx` 等 | 核验并保留；不能继续列为全部缺失 |
| 手工方法编辑与来源查看 | 当前教导表单只输入场景/指导，固定 lesson，步骤等为空；版本页只列案例 ID | 增加完整字段、修订编辑及可打开的真实来源 |
| 窗口跨重启提交 | manual/correct/feedback 来源保存在组件 ref；工作台已有 outbox | 增加窗口专用持久传输意图，复用学习服务 |
| 模型、预算及保留期设置 | 合同已有设置，未发现 modelDirectory 或对应完整窗口控制 | 接通实际主机配置目录及设置界面 |
| 桌面工程演示 | `test:learning:desktop` 和 smoke 已存在；已有记录明确完整闭环仍未完成 | 扩展现有 harness，不重新建立替代品 |
| 独立效果评价 | 未注册 `memory:evaluate`，缺足够真实人工标签证据 | 交付评价工具，数据不足返回 insufficient |

旧计划中的“未注册学习桌面脚本”“缺校准按钮”等描述已过时。本次以实际 package.json 和 renderer 源码为准。已有工程测试记录不等同于当前工作区或真实业务效果通过。

## 4. 产品规则与默认值

以下采用现有合同/设计中的初始规则；业务效果阈值在任务 8 中单独列为建议。

- 读取记忆与学习独立：`memoryEnabled=true`，`mode=suggest`。off 停止学习；suggest 生成待审候选；auto 只允许可信验证通过的低风险方法生效。客户级配置不能突破账号总开关。
- 方法有明确范围：工作区、平台、企业、账号、可选客户。身份从主机绑定或服务端认证取得，昵称、模型文字和 renderer 自报身份不能产生权限。
- 每次回复最多 5 条有效方法和 3 条案例，总计不超过 2000 个保守估算 token，包含包装文本。待审、归档、隔离、无关内容不进入生成。
- 默认后台并发 1，空闲 15 秒开始；单次复盘请求 30 秒，输入上限 8000、输出上限 2000 token，最多尝试 3 次。复盘、验证、模型整理共享账号日预算与后台互斥；默认 UTC 日预算 50000 token。
- 案例默认保留 90 天，可配置 7–365 天；无明确结果的问题空闲 30 分钟后关闭为 unknown。草稿生成、发送确认、模型自评不等于采纳或解决。
- 自动验证至少需要 5 个独立会话的实际人工标注案例，并排除学习来源重叠；不足返回 insufficient。这是最低准入条件，不是业务效果的统计证明。
- 验证凭据有效 24 小时，绑定范围、内容、修订、证据、模型、知识、策略、数据集及验证环境。任何绑定项变化都使旧凭据失效。
- V2 待审时继续使用 V1。企业记忆生效后仍须经过现有正式发布准入；学习不能自行授予发送、退款或改价权限。
- 整理每 7 天且空闲 2 小时；新项宽限 14 天，闲置 14 天标记待复核、30 天可恢复归档。人工与固定项受保护，模型合并默认关闭。
- 遗忘清理正文、索引和派生关联，阻断旧队列与迟到结果；归档则保留可恢复内容。计费仅保留必要匿名占额。

## 5. 执行顺序与共同验收方法

执行目录：仓库根目录。

顺序：**基线与反馈核验 → 配置/编辑窗口 → 持久提交 → 后台复盘 → 验证/正式发布 → 整理/遗忘 → 完整桌面闭环 → 效果评估与最终交付**。

每项按“核对已有行为 → 对缺口写失败测试 → 确认失败原因 → 最小实现 → 定向检查 → 记录证据”推进。已实现且通过的行为不重复重写，也不删除代码来制造红测。

先记录 `git status --short` 和现有变更；共享工作区不 reset/stash/批量暂存，不覆盖其他作者修改。数据库版本实施时重新确认最大值后追加；当前读到本地 schema 12、备份合同 11/12，不能直接改成任意版本号。产品发布与真实消息不属于测试步骤。

专项测试使用项目 portable Node；以下是未来实施命令，本次未执行：

```powershell
# 在克隆后的仓库根目录执行
$learningNodeVersion = (Get-Content -LiteralPath '.node-version' -Raw).Trim()
$learningNodeExe = Join-Path $PWD ('.local/toolchain/node-v' + $learningNodeVersion + '-win-x64/node.exe')
git status --short
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:services
```

重型测试串行运行；每次保存实际命令、退出码、案例断言及同次截图/报告到 `docs/learning-memory-acceptance.md`，失败和限制也保留。

### 任务 1：核验真实案例和员工反馈

**文件：** `src/main/services/learning-service.ts`、`learning-episode-assembler.ts`、`server/src/learning/learning-events.ts`、`learning-episode-closure.ts`、`server/src/generation/generation-service.ts`；复用已有 task/episode 反馈合同和 023/024 迁移。

**接口：** 保留 `LearningTaskReference` 的 taskId/contextHash/draftHash/draftRevision；窗口 episode 反馈由服务端精确追溯实际生成任务。renderer 不自行构造生产任务或加载引用。

- [ ] 运行 `learning-enterprise-events.test.ts`、`learning-enterprise-closure.test.ts`、`learning-correction-atomic.test.ts`、`learning-episode-assembler.test.ts`。
- [ ] 对尚未覆盖的行为添加断言：生成草稿为 unknown；重复 sourceId 仅一份案例/队列；事务失败不留下部分记录；跨账号与变更草稿被拒绝；发送不增加 adopted/resolved。
- [ ] 按缺口修补生成/反馈事务与可信问题聚合。无可靠问题标识时保留独立片段，不根据昵称或模型推测强行合并。
- [ ] 重启后核验实际出处和开放问题仍一致；记录通过的测试及限制。

**专项命令：** `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-enterprise-events.test.ts tests/integration/learning-enterprise-closure.test.ts tests/integration/learning-correction-atomic.test.ts tests/unit/learning-episode-assembler.test.ts`

**通过条件：** 实际草稿可追溯，纠正和结果不是伪造数据，同一事件不重复学习。

### 任务 2：补齐可操作的设置、方法编辑与来源

**文件：** `learning-desktop.ts`、`learning-management.ts`、IPC/preload、`agent-registration.ts`、`enterprise-learning-desktop-adapter.ts`、`server/src/learning/learning-routes.ts`、`learning-service.ts`、`server/src/index.ts`；新增 `src/renderer/src/features/memory/LearningSettingsPanel.tsx`，扩展 `LearningMemoryPanel.tsx`、`MemoryRevisionDiff.tsx`。

**新增接口：** `modelDirectory({scope}): Promise<{id:string;label:string}[]>`。请求/响应严格 Zod 校验，拒绝重复 ID，目录最多 1000 项，ID/label 各不超过 128 字符；只返回当前主机实际配置且可用于复盘的模型标识，不返回密钥、端点或任意请求能力。

企业客户端对应新增 `AgentRegistration.learningModelDirectory(scope:MemoryScope,signal?:AbortSignal)`；adapter、具名路由和 preload 对应同一操作。本地目录从现有主机模型解析逻辑取得，企业目录从服务端实际 reviewer 配置取得；保存非空 reviewModelId 时再次检查属于当前可用目录，配置变化造成的旧选择不能静默换成另一个模型。

**复用接口：** `settings({scope,patch})`、`manual({scope,sourceId,content,reason})`、`act({scope,id,expectedRevision,action:'revise',content,evidence,reason})`。方法字段沿用 `MemoryContentSchema`，不建立另一种技能格式。

- [ ] 扩展 `learning-ipc.test.ts`、`learning-enterprise-desktop-client.test.ts`、`learning-enterprise-desktop-adapter.test.ts`：无授权目录拒绝；异范围响应、额外密钥字段、重复模型 ID 拒绝；切换账号时迟到目录不可显示。
- [ ] 接通主机目录及真实 reviewModelId 选择，目录为空明确提示配置不足；继承模型显示实际默认路线，不静默选择未配置模型。
- [ ] 增加日预算、保留期、学习模式和读取开关的控制及保存结果。表单限制采用现有 schema，服务端再次校验账号约束。
- [ ] 教导/修订支持 preference/lesson/skill、原因、步骤、坑点和检查项；修订附 expectedRevision，版本冲突提示重读。
- [ ] 从版本详情打开授权来源案例及纠正原因；已遗忘来源显示已删除，跨范围或迟到详情不泄露正文。
- [ ] 扩展既有 Electron smoke，经实际表单保存设置和完整方法，再读取持久结果核对。

**专项命令：** `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-ipc.test.ts tests/integration/learning-enterprise-desktop-client.test.ts tests/integration/learning-enterprise-desktop-adapter.test.ts tests/unit/learning-view-state.test.ts`

**通过条件：** 用户能完成配置、完整教导/修订及来源查看；显示状态与主机保存一致。

### 任务 3：窗口提交跨断网、重启可靠恢复

**新增文件：** `src/core/persistence/learning-submissions.ts`、`src/main/services/learning-submission-sync.ts`、`tests/integration/learning-submissions.test.ts`。

**修改文件：** `ledger-schema.ts`、`ledger.ts`、`ledger-backup.ts`、恢复兼容合同；主机 learning IPC/runtime、严格 desktop 合同及窗口。复用已有 `learning-outbox.ts`，不拿伪造 task/draft 支撑历史窗口提交。

**新增接口：** `LearningSubmissionStore.enqueue(intent)`、`pending(scope)`、`acknowledge(scope,sourceId)`、`forget(scope,conversationId?)`。意图为 manual/correct/result/feedback 的具名请求，包含稳定 sourceId、可信 scope、完整内容哈希、首次提交时间及实际案例来源时间；状态 pending/saved/forgotten。`submissions({scope})` 返回来源 ID、种类、状态、时间、可读错误，不返回其他范围正文或凭据。

- [ ] 写失败测试：`restart_replays_same_source_once`、`response_lost_after_commit_is_idempotent`、`same_source_changed_body_conflicts`、`account_switch_blocks_replay`、`forgotten_submission_never_returns`、`retry_does_not_extend_retention`。
- [ ] 新表追加到现有私有 SQLite；主进程校验实际范围并持久写意图后再发 HTTP。重放复用同一注册客户端及已有教导/episode 服务，不创建第二套学习 worker。
- [ ] 窗口重启从主机 pending 列表恢复原 sourceId；不能重新生成 ID 自动再教一遍。以后明确再次教导同一文字是新意图，不永久按文字去重。
- [ ] 只有匹配响应得到确认才 acknowledge；保存成功但刷新失败保持真实成功提示。断网显示待同步，权限撤销暂停重放。
- [ ] 保留期按原始来源时间计算：企业案例时间由服务端保存记录取得；人工教导的服务端权威时间按首次接受记录固定。客户端首次提交时间不产生更高权限，网络重试不能刷新证据年龄。
- [ ] saved/forgotten/过期项清理正文；遗忘联动账号各设备的本地待提交项，关闭取消并等待在途操作。
- [ ] 同步更新备份/恢复版本合同，核验旧 11/12 数据升级、新数据备份恢复、恢复后仍不得越权重放；不能仅修改建表语句。

**专项命令：** 新文件落地后运行 `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-submissions.test.ts tests/integration/learning-outbox.test.ts tests/integration/learning-outbox-policy.test.ts tests/unit/ledger-backup.test.ts`。

**通过条件：** 主进程重启和响应丢失后同一意图只保存一次，待同步/已保存提示真实，遗忘资料不会复活。

### 任务 4：核验后台学习和局部自我修订

**文件：** `learning-reviewer.ts`、`learning-jobs.ts`、`learning-scheduler.ts`、`learning-model-configuration.ts`、`learning-transport.ts`，企业 reviewer service/worker。

**接口：** 保留 `LearningReviewer.review(input,signal): Promise<LearningReviewResult>` 和现有 create/revise operations；revise 仅针对实际读取且 expectedRevision 匹配的方法，最多 5 项，也允许空结果。

- [ ] 运行并补足 `learning-runtime.test.ts`、`learning-iteration.test.ts`、`learning-transport.test.ts`、`learning-enterprise-worker.test.ts`。
- [ ] 断言：一条纠正产生有出处候选或明确无可学内容；相关新纠正局部修订为 V2；未读取的方法、伪造证据和陈旧修订被拒绝。
- [ ] 核验学习不保存过期业务政策，不把未知/失败结果写成成功流程；模型返回额外字段或工具调用不进入存储。
- [ ] 核验前台抢占、超时、预算耗尽和重复 worker；取消后的迟到结果不提交，真实已消耗费用仍计入预算。
- [ ] 实际模型请求正在挂起时撤销设备或关闭服务，再释放响应：不能新增候选/激活，不能回写已关闭数据库。使用可控制的回环模型测试时序，而不是仅在模型调用前撤销。

**专项命令：** `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-runtime.test.ts tests/integration/learning-iteration.test.ts tests/integration/learning-transport.test.ts tests/integration/learning-enterprise-worker.test.ts`

**通过条件：** 学习确实由真实反馈驱动，修订可追溯、可取消，后台预算和前台优先规则成立。

### 任务 5：可信验证、生效、企业发布与回滚

**文件：** `learning-validation.ts`、`learning-validation-store.ts`、`src/main/services/learning-product-validation.ts`、企业 product validation/management runtime；`server/src/learning/learning-publication.ts`、`server/src/generation/publication.ts`、`server/src/admin/evaluation-admission.ts`、`administration.ts` 及既有管理入口。

**接口：** 保留 `validateCandidate(scope,id,revision,signal?)`、`validate({scope,id,expectedRevision})` 与版本动作；企业正式发布复用 `Administration.publish(tenantId,accountId,input:Publication)` 及既有管理认证。renderer 不签发验证凭据或获取管理员密钥。

- [ ] 运行并补足 `learning-auto-validation.test.ts`、`learning-product-validation.test.ts`、`learning-enterprise-product-validation.test.ts` 和现有企业发布准入测试。
- [ ] 少于 5 个独立人工案例、来源重叠及纯模型标注返回 insufficient；严重错误/事实越界拒绝；冻结环境变化与 24 小时过期使凭据失效。
- [ ] 用同一实际回复管线、相同案例做无候选/有候选配对回放；风险检查和覆盖率不能只听复盘模型自报。
- [ ] 核验 suggest 不自动激活，auto 只激活可信低风险候选；负面反馈隔离与 V2 待审沿用 V1。
- [ ] 接通企业正式版本发布的准备、评估、差异预览和既有管理员发布操作；学习窗口只能提出/查看发布状态。没有管理发布权限时显示待发布，不能显示已供企业自动回复使用。
- [ ] 回滚是有来源的新修订，走既有准入；核验方法、缓存、审核与执行上下文版本一致，实际下一次回复确实恢复正确方法。

**专项命令：** `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-auto-validation.test.ts tests/integration/learning-product-validation.test.ts tests/integration/learning-enterprise-product-validation.test.ts`

**通过条件：** 候选不会越过验证/发布；V2 和回滚在实际生成中使用正确生效版本。

### 任务 6：整理、历史检索和彻底遗忘

**文件：** `learning-curator.ts`、`learning-curation-plan.ts`、`learning-curation-store.ts`、`learning-retention.ts`、`learning-context.ts`、企业 maintenance/curation/queue-forget。

**接口：** 复用 `curate({scope,dryRun})`、`searchEpisodes({scope,query,limit?})`、`reports({scope})`、`forgetScope({scope})`。窗口搜索默认 10、最多 20 条；生成仍最多 3 案例，不混用限额。

- [ ] 运行并扩展整理/保留期/合并/遗忘测试，使用可控制时间核验 7 天/2 小时、14/30 天、首次观察宽限及人工/固定项保护。
- [ ] 预览不改变存储；模型合并默认关闭；打开时只产生待审提案，来源/修订变化拒绝陈旧替代。
- [ ] 遗忘同时清正文、索引、派生来源、待提交意图与任务；释放迟到模型/网络响应后搜索仍为空。
- [ ] 归档保留恢复能力；实际生成不加载归档、隔离或待审内容，预算包括包装文字。

**专项命令：** `& $learningNodeExe node_modules/vitest/vitest.mjs run tests/integration/learning-maintenance.test.ts tests/integration/learning-retention-lifecycle.test.ts tests/integration/learning-curator-merge.test.ts tests/unit/learning-context-version.test.ts`

**通过条件：** 经验库可维护，归档可恢复，遗忘不可通过缓存或重试复活。

### 任务 7：完整真实 Electron 闭环

**文件：** 扩展 `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs` 及已有学习窗口，不另造假界面。

**运行边界：** 实际 Electron、React、preload、可信 IPC 和存储；隔离 userData、回环模型、独立工程样例。企业场景使用隔离服务器/数据库及真实认证、发布链。合成模型和模拟标签只证明工程流程。

- [ ] 在既有场景上扩展：真实试答 → 窗口纠正及结果 → 后台候选 V1 → 独立验证 → 本地生效/企业正式发布 → 相似新问题实际加载 V1。
- [ ] 再纠正 → V2 待审仍用 V1 → V2 验证/生效/发布 → 回滚 → 实际新回复核对恢复后的版本与方法引用。
- [ ] 加入窗口重启待同步恢复、账号切换、多客户隔离、撤销挂起模型、预算耗尽、遗忘迟到响应及保存后刷新失败。
- [ ] 同次运行输出 result.json、截图、实际方法/上下文版本、模型请求数、限制和每场景断言；不能只靠界面文字判断已生效。

**命令：** `& '.\scripts\dev-tools.ps1' run build`，通过后再运行 `& '.\scripts\dev-tools.ps1' run test:learning:desktop`。

**通过条件：** 全闭环在实际桌面、存储和生成结果中一致；企业发布与本地生效分别得到证明。

### 任务 8：独立效果评估与最终交付

**新增文件：** `evals/memory/README.md`、`contracts.ts`、`metrics.ts`、`fixtures/synthetic.json`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`；package.json 注册 `memory:evaluate`。

**接口：** `evaluateMemory(dataset:MemoryEvaluationDataset):MemoryEvaluationReport`。数据包含来源、会话组、冻结环境、无记忆/旧记忆/学习记忆三组结果、独立人工盲评、token/费用与时延；报告 status 为 passed/failed/insufficient。

- [ ] 写失败测试：会话交叉泄漏拒绝；标签不足 insufficient；环境版本失配非零退出；合成样本不得宣称真实效果；指标计算及按会话聚类置信区间正确。基线修改率为零时相对改善不计算，不得通过除零或缺失值获得 passed。
- [ ] 以会话为单位切分学习、校准、留出评估集，冻结模型/知识/策略/方法版本。实现 CLI：`memory:evaluate -- --dataset <path> --out <directory>`，输出 JSON 与可读报告。
- [ ] 建议业务验证初始目标：学习 100、校准 100、评估 200 条且评估至少 30 个独立会话；实质修改率相对降低至少 20%，严重错误 0，覆盖率下降不超过 5 个百分点，新增回复 p95 时延不超过 500ms。这些是待业务确认的目标，不是已有实测结果。
- [ ] 缺真实人工标签时完成工程工具及 synthetic 验证，并明确“工程通过、业务效果 insufficient”；不能生成标签冒充员工评价。由实际业务资料及人工标注补足后再运行真实效果验收。
- [ ] 最终依次运行全量 test、服务类型检查、build、lint、scenarios、真实 PostgreSQL、完整 desktop 和 synthetic 评估；报告当前源码的结果，历史总数不能替代复测。
- [ ] 更新使用说明、配置/权限/来源说明、验收矩阵及剩余限制。最终审查特别检查越权、错版本、错误学习传播、提交丢失和遗忘复活。

**最终命令（依次执行）：**

```powershell
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run lint
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run test:learning:desktop
# 以下命令在任务 8 创建 CLI 和 fixture 后执行：
& '.\scripts\dev-tools.ps1' run memory:evaluate -- --dataset evals/memory/fixtures/synthetic.json --out .local/reports/memory-evaluation/synthetic
```

**通过条件：** 工程检查与完整闭环有当前证据；真实效果另有独立对照报告，或如实注明数据不足。

## 6. 最终交付与验收场景

交付包括完整工作记忆窗口、可靠学习闭环、可恢复版本与来源、企业发布接线、桌面演示脚本、评估 CLI、报告和使用说明。

| 用户验收动作 | 应观察的结果 | 所属任务 |
| --- | --- | --- |
| 纠正一次，再重启并重试 | 保留相同来源，只保存和学习一次；显示状态真实 | 1、3 |
| 教完整步骤、查看依据 | 字段持久保存，能打开授权实际来源 | 2 |
| 再问相似问题 | 实际生成加载正确生效方法，企业已正式发布 | 4、5、7 |
| 再纠正并形成 V2 | 待审期间用 V1，V2 生效后使用新做法 | 4、5、7 |
| 恢复旧做法 | 新回复实际使用恢复后的内容与版本 | 5、7 |
| 换账号或客户，释放旧响应 | 不显示、不写入、不重放其他范围资料 | 1、2、3、4、7 |
| 删除经验及来源 | 搜索、索引、缓存、队列和迟到结果均不能复活 | 3、6、7 |
| 查看“变好了多少” | 独立人工对照指标；不足时明确 insufficient | 8 |

三个可验收里程碑：**M1 可操作且不丢提交（任务 1–3）→ M2 学习/修订/回滚全闭环（任务 4–7）→ M3 效果可判定（任务 8）**。没有真实业务标签时，M3 的工具可交付，但业务改善结论仍未成立。

本次只有调查与计划交付，不表示上述开发任务已执行或通过。
