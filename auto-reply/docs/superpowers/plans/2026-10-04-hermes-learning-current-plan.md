# Hermes 自我学习接入工作记忆：可行性与执行计划

> **For agentic workers:** 后续开发使用 `superpowers:executing-plans`，逐项核对现有实现、补缺和验收。当前只交付调研与计划；不执行产品修改、迁移、安装、部署或真实发送。

**Goal:** 工作记忆从实际客服问题、员工纠正和明确处理结果中沉淀方法，在后续回复中按需复用，持续修订，并允许查看依据、拒绝、回滚和遗忘。

**Architecture:** 适配 Hermes 的记忆、程序性技能、后台复盘和整理机制，复用项目已有学习模块。本地 SQLite 与企业 PostgreSQL 共享合同和规则；企业身份、发布评估与发送授权继续由现有权威服务管理。

**Tech Stack:** TypeScript、Electron、React、Zod、SQLite、PostgreSQL、Vitest、现有文本模型及 Jev 回复管线。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`；本文件补充当前代码核对和执行顺序。原八任务计划 `2026-10-03-hermes-learning-completion.md` 保留，不能以本文件缩减原有验收范围。

## 需求理解与可行性

需求理解：让应用积累“怎样处理问题”的经验，而不是只保存对话或手动卡片。例如员工纠正“退款回复先核对订单状态、再查当前政策”，系统形成带来源的方法；下次相似问题加载；新的纠正产生 V2，经验证替代 V1。

技术上可行。这里的学习更新外部记忆和描述性处理技能，不更新模型参数。它能改善经验复用，但是否降低人工修改率，需要真实对照评估。

可选路线：

| 路线 | 影响 | 判断 |
| --- | --- | --- |
| 在现有 TypeScript 中适配机制 | 复用已有存储、权限、版本及回复管线 | 推荐 |
| 将 Hermes 作为独立 Python 服务 | 引入另一套运行时、身份、工具权限和部署 | 当前不需要 |
| 只把历史对话或提示词塞进上下文 | 实现容易，但缺少验证、版本与纠错闭环 | 不满足自我迭代需求 |

## 上游依据与复用范围

2026-10-04 通过 GitHub API 查询 `main`，得到提交 `1298c8e74baa73e1a2b90124228d017261ac6bc4`；读取了该提交的 LICENSE、后台复盘、技能管理和会话搜索源码。此次参考固定在该提交，开发时避免直接依赖会变动的 `main`。现有规范此前锁定的提交保持为历史设计依据，升级差异单独核对。

| Hermes 机制 | 源码/文档 | 本项目适配 |
| --- | --- | --- |
| 持久事实与用户记忆 | `tools/memory_tool.py`、`memory_tool_store.py` | 有可信身份的沟通偏好；有容量、来源、过期和遗忘约束 |
| 技能作为程序性记忆 | `tools/skill_manager_tool.py` | 场景、指导、步骤、陷阱、检查点；保存不可变修订 |
| 后台复盘 | `agent/background_review.py` | 从纠正和处理结果提炼候选，受预算、取消和前台优先约束 |
| 会话搜索 | `tools/session_search_tool.py` | 在授权范围内查找原案例，返回出处，遵守保留期 |
| 先读后改、受控写入 | 技能管理工具的 read-before-write guard | 只能修订已读取且仍是当前版本的方法 |
| 定期整理 | `agent/curator.py`、`curator_backup.py` | 去重、待复核、可恢复归档；合并先成为候选 |

项目使用描述性客服技能，当前不引入技能脚本、任意终端执行、完整 Hermes Gateway 或额外用户画像服务。业务事实仍从当前企业知识库读取；经验不能自行创造价格、库存、退款政策或扩大业务承诺。

上游为 MIT，复制源码或实质提示内容时保留版权与许可声明；机制适配与直接源码复制分别记录。

来源：

- [Hermes 仓库](https://github.com/NousResearch/hermes-agent)
- [记忆与后台复盘](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [技能系统](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [整理机制](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/)
- [本次固定提交](https://github.com/NousResearch/hermes-agent/tree/1298c8e74baa73e1a2b90124228d017261ac6bc4)

## 当前代码状态：存在不等于已验收

本次是读取源码和文档，不运行测试、模型、后台服务或数据库迁移。历史进度中的测试结果不能替代当前工作区验证。

| 能力 | 当前读取证据 | 后续处理 |
| --- | --- | --- |
| 案例、内容、版本、设置及反馈合同 | `src/shared/contracts/learning-memory.ts` | 复用，核对可信事件接线 |
| 案例聚合、复盘、任务、检索、验证、整理 | `src/core/memory/learning-*.ts` | 行为回归，补缺，不重建 |
| 本地主服务 | `src/main/services/learning-service.ts` | 已有纠正、结果、验证和整理方法；核验实际工作台输入 |
| 企业存储、复盘、验证与维护 worker | `server/src/learning/` | 核验配置、真实事件及多设备行为 |
| 企业模型合并与替代关系 | `learning-curation-merge.ts`、迁移 `022-learning-curation-merges.sql` | 已有代码；需验证人工修订后仍保留替代约束等行为 |
| 工作记忆界面与 IPC | `LearningMemoryPanel.tsx`、`learning-ipc.ts` | 初步界面存在，完整验证/整理/校准管理未暴露 |
| 企业 HTTP 管理入口 | `server/src/http/application.ts` 的应用 options 与路由 | 当前未发现学习管理接线，补服务和路由 |
| 学习专用桌面验收与效果评估 | package scripts 与现有计划 | 未发现完整交付；需独立端到端证据与业务数据 |

已有只读计划中将企业维护、模型合并列为待新建的描述已落后于当前源码。执行时直接复用实际类名和签名；不要创建平行的 curator 或第二套替代关系表。

## Global Constraints

- 读取记忆与学习开关独立；默认 `memoryEnabled=true, mode=suggest`。`off` 停止学习；`suggest` 只产生待审候选；`auto` 仅允许经验证的低风险方法生效。个人偏好默认人工确认。
- 账号级关闭约束客户级设置。身份从可信账号/客户绑定推导，不使用昵称或请求正文中的 tenant/account 声明作为授权。
- 一次回复最多 5 条方法、3 条案例、合计 2000 个保守估算 token，包含包装。只加载相关、有效、已生效修订。
- 后台并发 1，前台优先；默认空闲 15 秒、单次模型请求 30 秒、复盘输入 8000/输出 2000 token、账号 UTC 日预算 50000、最多 3 次尝试。验证的多次请求累计计费，不把每次额度当整次额度。
- 案例默认保留 90 天，可配置 7–365 天；30 分钟无消息的问题关闭为 unknown。草稿、发送或模型自评不能当作问题解决或员工采纳。
- 整理每 7 天且空闲 2 小时；新方法宽限 14 天，闲置 14 天待复核、30 天可恢复归档。保护人工与固定项，模型合并默认关闭。
- 自动生效至少使用 5 个独立会话的实际人工标注校准案例，且与学习来源不重叠；缺标签返回 insufficient。凭据有效 24 小时，绑定范围、修订、内容、来源、上下文、模型/知识/策略、验证器与数据集。
- V2 待审时继续使用 V1。企业记忆生效后仍需既有正式发布评估；学习不能获得发送权限。
- 遗忘实际删除对应正文、索引与派生身份数据，并阻断旧任务和迟到结果。保留已经发生费用的匿名占额；不为结算重新恢复被遗忘内容。
- 保留共享工作区既有修改，不 reset、stash 或批量暂存。重型验证串行执行，不部署、不发送真实消息。

## Review Focus

- 相同昵称、账号切换和伪造身份不串用记忆：任务 1、4、6。
- 重复纠正、重启、断网和多 worker 不重复案例、候选或计费：任务 1、2、4。
- 遗忘、政策变化、编辑候选以及合并来源变化使旧验证失效：任务 3、5。
- 前台抢占、关闭学习、设备撤销和停机后的迟到结果不生效：任务 2、3、5。
- 模型自评、合成标签和发送确认不能证明业务改善：任务 1、3、7。

## 执行约定与基线

执行目录为 `E:\wechat-autoreply\auto-reply`。每个任务先核对已有实现；已有行为通过检查则保留，不重复开发。缺失行为按“写失败测试 → 确认因行为缺失失败 → 最小实现 → 定向验证 → 记录证据”完成。

开发启动时建立 `docs/learning-memory-acceptance.md`，记录 Git 状态、实际接线、各验收项、运行命令、退出码和报告。基线和最终验证均使用以下项目工具链；此列表是未来执行命令，本次未运行：

```powershell
Set-Location 'E:\wechat-autoreply\auto-reply'
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
```

### Task 1：真实问题、员工纠正与反馈

**Files:** 核验/修改 `src/core/memory/learning-episode-assembler.ts`、`learning-feedback.ts`、`src/main/services/learning-service.ts`、`src/shared/contracts/workbench.ts`、`src/renderer/src/features/agent/ReplyWorkbench.tsx`。测试 `tests/unit/learning-episode-assembler.test.ts`、`tests/integration/learning-feedback.test.ts`、`learning-correction-atomic.test.ts`。

**Interfaces:** 复用 `EpisodeMessageEvent`、`EpisodeCloseEvent`、`LearningCorrectionInput`、`LearningResultInput`。现有 `LearningService.correct(scope, episodeId, input): LearningEpisode`、`confirmResult(...)` 与 `humanFeedback(...)` 保留；工作台先经可信任务绑定再调用。

- [ ] 为同问题聚合、跨客户不合并、草稿/发送不标 resolved、重复纠正一次入队、重启恢复未结束案例写/核验测试。
- [ ] 运行上述三组测试，确认缺失行为的失败；接通实际生成、人工纠正原因、明确采纳和结果入口。
- [ ] 纠正、案例更新和复盘入队原子保存；没有明确结果时保留 unknown。
- [ ] 再运行定向测试，保存实际记录和错误重试证据。

**通过条件:** 员工纠正一次，产生一个有来源的学习任务；点击发送不增加学习成功数。

### Task 2：后台提炼与版本迭代

**Files:** 核验/必要时修改 `src/core/memory/learning-reviewer.ts`、`learning-jobs.ts`、`learning-scheduler.ts`、`learning-model-configuration.ts`、`learning-transport.ts`，企业对应 `server/src/learning/learning-reviewer-service.ts`、`learning-reviewer-worker.ts`。测试 `learning-runtime.test.ts`、`learning-transport.test.ts`、`learning-iteration.test.ts`、`learning-enterprise-worker.test.ts`。

**Interfaces:** `LearningReviewer.review(input: LearningReviewRequest, signal: AbortSignal): Promise<LearningReviewResult>`；复用严格复盘输出合同。复盘可以新建候选或提出已读取版本的修订，可以返回“没有可学内容”。

- [ ] 核验/补测未知结果不提炼成功技能、未读版本拒绝、优先修订实际使用方法、无新经验空结果、重复来源不重复创建。
- [ ] 实测重启认领、预算、UTC 跨日、超时、前台抢占、off/撤销/遗忘后的迟到响应；失败保留可解释原因。
- [ ] 补独立复盘模型选择入口，模型目录和凭据由主机管理；后台不能任意指定端点或获得业务工具。
- [ ] 运行对应测试，确认 V2 候选不覆盖 V1 的生效引用。

**通过条件:** 真实纠正能提炼候选；后台成本可见且受控，前台回复可抢占。

### Task 3：真实管线验证、激活与回滚

**Files:** 核验 `learning-validation.ts`、`learning-risk.ts`、`learning-validation-store.ts`、本地/企业 `learning-product-validation.ts`、企业 `learning-validation-budget.ts`、`learning-validator-worker.ts`。测试 `learning-product-validation.test.ts`、`learning-enterprise-product-validation.test.ts`、`learning-enterprise-budget.test.ts`、`learning-iteration.test.ts`。

**Interfaces:** 本地 `validateCandidate(scope, id, revision, signal?): Promise<LearningValidationResult>`；企业现有 `validate(reference, conversationId, memoryId, revision, external?): Promise<EnterpriseProductValidationResult>`。人工标签使用 `LearningCalibrationInput`；可信验证存储签发凭据，不提供客户端 issue-grant 接口。

- [ ] 补/核验五个独立人工会话、训练来源不重叠、缺标签 insufficient、评分标准不进入生成提示词的断言。
- [ ] 用同一生产回复管线成对回放 V1/V2；保持知识、模型、策略和其他方法一致；验证不创建可发送任务。
- [ ] 核验严重错误为零、覆盖不降低、无新增业务承诺，以及凭据过期、版本变化、环境变化再恢复的拒绝行为。
- [ ] 激活、单次消费与审计同事务，失败全部回滚；演示 V1 → V2 待审 → 验证 → 生效 → 实际加载 → 回滚。
- [ ] 运行定向测试；企业方法目录变化仍需正式发布准入。

**通过条件:** 新版本经可信检查才自动生效，真实回复使用正确版本，错误版本可隔离并回滚。

### Task 4：企业管理与真实反馈闭环

**Files:** 新增 `server/src/learning/learning-service.ts`、`learning-routes.ts`、`learning-events.ts`；修改 `server/src/http/application.ts`、`server/src/index.ts`；复用 repository、queue、publication 和 generation/context 模块。新增 `tests/integration/learning-enterprise-routes.test.ts`、`learning-enterprise-events.test.ts`，扩展 `tests/concurrency/postgres-authority.test.ts`。

**Interfaces:** 管理适配复用 `LearningWorkbenchSnapshot`、`LearningAction` 和 settings/correction/result 合同。新增 `EnterpriseLearningEvents.recordCorrection(credential, {taskId, expectedVersion, sourceId, text, reason}): Promise<LearningEpisode>`；范围由当前认证和服务端任务推导。

- [ ] 写伪造 tenant/account、跨客户、过期任务、撤销设备、纠正重试、发布竞争的失败测试。
- [ ] 实现认证管理入口：快照、详情、设置、版本动作、纠正/结果/反馈、校准导入、验证与整理报告。复用 `withLearningAccount`；worker 签发权不下放普通角色。
- [ ] 真实问题事件原子保存案例与学习入队；任务身份与 generation 方法引用从服务端读取，不相信 renderer 自报。
- [ ] 核验 `memoryCorpusVersionId`、`memorySnapshotHash`、`learningContextVersion` 在生成、缓存、审核和执行中传播；企业断网不能切换到未发布本地候选。
- [ ] 运行路由/事件专项和真实 PostgreSQL 多连接池检查，保存报告与清理结果。

**通过条件:** 企业多设备共享权威经验，真实纠正能进入后台，发布和发送继续遵守原有审核。

### Task 5：维护、合并、案例搜索与遗忘

**Files:** 复用 `src/core/memory/learning-curation-plan.ts`、`learning-curator.ts`、`learning-retention.ts`，企业 `learning-maintenance-service.ts`、`learning-maintenance-worker.ts`、`learning-maintenance-factory.ts`、`learning-curation-merge.ts`、`learning-repository.ts`、迁移 021/022。扩展 `learning-enterprise-maintenance.test.ts`、`learning-curator-merge.test.ts`、`learning-retention-lifecycle.test.ts`；案例搜索扩展 `learning-retrieval.test.ts` 与 Task 4 路由测试。

**Interfaces:** 企业现有 `curate(reference, conversationId, {dryRun?}, signal?): Promise<LearningCurationReport>`、`runOnce(...)` 和 `reports(...)` 保留。本地 `LearningService.curate(scope, dryRun)` 保留。管理适配新增 `searchEpisodes(credential, {conversationId, query, limit}): Promise<LearningEpisode[]>`，query 1–240 字符，limit 1–20，默认 10；本地按可信 scope 调用相同搜索规则。

- [ ] 核验首次观察不立即整理、时间门槛、人工/固定项保护、dryRun 无写入/模型费、多 worker 单次维护；已有实现通过则不重做。
- [ ] 核验合并完整来源、候选人工修订后替代关系仍存在、删来源或固定旧项使候选验证失效；验证对照“整个旧方法组”和“新方法”，不把旧方法偷偷带进候选组。
- [ ] 合并候选生效和旧方法归档同事务；未生效前旧方法继续可用。归档可恢复，模型合并默认关闭。
- [ ] 查找案例先授权再检索，按 query 命中、时间倒序和稳定 ID 排序；无匹配返回空。复用现有存储，初版不加向量数据库；过期/遗忘案例不出现在搜索结果或索引中。
- [ ] 验证正文实际删除、引用脱敏、旧任务阻断、迟到结果不能恢复内容；运行定向测试及真实 PostgreSQL 竞争检查。

**通过条件:** 经验不会无限堆积；整理不误改人工方法，合并有完整出处，遗忘后历史搜索与后台均不能恢复旧内容。

### Task 6：工作记忆界面与桌面端到端

**Files:** 修改 `src/shared/contracts/learning-desktop.ts`、`src/main/ipc/learning-ipc.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/MemoryWindow.tsx`、`features/memory/LearningMemoryPanel.tsx`、`LearningCorrection.tsx`、`MemoryRevisionDiff.tsx`、`LearningJobsPanel.tsx`。新增 `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`，注册 `test:learning:desktop`；扩展 `learning-ipc.test.ts`。

**Interfaces:** 保留 `window.learningMemory`；增加 `validate({scope,id,expectedRevision})`、`curate({scope,dryRun})`、`importCalibration({scope,input:LearningCalibrationInput})`、`searchEpisodes({scope,query,limit?})` 及验证/整理报告读取。返回共享报告合同；不能接受 renderer 自报验证通过或 grant。

- [ ] 写 IPC 范围伪造、过期版本、客户端伪造通过、切换范围后的迟到详情、旧卡重复迁移的失败测试。
- [ ] 界面显示候选/生效版本、来源、差异、验证原因、实际加载/采纳/纠正指标、费用和任务状态；接通校准、验证、整理与搜索入口。
- [ ] UI 成功提示以持久化结果为准；自动学习与手动教导走同一来源/版本管理；修复详情响应跨范围写状态。
- [ ] 用临时 userData、回环假模型和真实 Electron，通过 UI/preload/IPC 演示纠正、候选、验证、实际使用、再修订、回滚、范围切换与遗忘；保存截图及机器报告。
- [ ] 运行 IPC 专项、web/node 类型检查、build 和新增 `test:learning:desktop`。

**通过条件:** 用户能在工作记忆窗口完成整套教导与迭代，界面状态与数据库及实际回复一致。

### Task 7：工程验收与真实效果评估

**Files:** 新增 `evals/memory/README.md`、`metrics.ts`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`、`tests/integration/learning-acceptance.test.ts`；更新 `docs/learning-memory-acceptance.md`、README 和服务配置说明；注册 `memory:evaluate`。

**Interfaces:** 新增 `evaluateMemory(dataset: MemoryEvaluationDataset): MemoryEvaluationReport`。数据集包含真实/合成 provenance、会话分组及冻结版本；报告包含 status、原因、样本量、各组指标、按会话分组区间、前台耗时、后台 tokens 和费用。

- [ ] 红测固定：关联会话不能跨分组，留出集不能参与学习，缺标签为 insufficient，基线零分母不产生无限改善率，版本漂移终止对照，合成标签不能声明业务成功。
- [ ] 同一留出案例比较 `memory-none`、`memory-legacy`、`memory-learning`；冻结模型/知识/策略，关闭留出集学习，人工盲评。保持现有 Jev A/B/C 命名不变。
- [ ] 建议学习/校准/留出分别 100/100/200 条，留出至少 30 个独立会话；这是一份分组评估数据，不强塞进单次最多 200 条的校准合同。
- [ ] 拟议业务目标：相对旧卡片实质人工修改率下降至少 20%，观察严重错误 0，覆盖损失不超过 5 个百分点，前台 p95 新增耗时不超过 500ms。以上为建议验收目标，未经业务方采纳不能当作保证；同时报告样本不确定性。
- [ ] 串行运行全套 test、node/web/services 类型检查、test:scenarios、test:postgres、build、test:desktop、test:learning:desktop，逐项记录退出码；做全范围最终审查并修复发现的问题。

**通过条件:** 工程闭环可复现；真实效果有留出对照证据。没有真实标签时，交付工程验收报告并标注业务效果证据不足，不以合成案例替代。

## 最终演示与交付清单

必须演示：员工纠正 → 单次后台复盘 → 有出处候选 → 校准验证 → 正式允许使用 → 下一条相关回复实际加载 → 新纠正产生 V2 → 回滚；另演示不相关问题不加载、跨账号隔离、前台抢占、预算耗尽、来源变化、遗忘后迟到结果拒绝。

交付包括可操作的学习工作记忆、模型/预算配置说明、来源与版本记录、验证/整理报告、桌面演示证据、真实 PostgreSQL 并发报告，以及区分工程完成与业务效果的验收文档。

顺序：基线 → Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7。任何失败均保留诊断，不能删除测试或以历史总数宣称完成。已有模块通过验收的部分直接复用，工程工作集中在未接通的入口和缺失行为。

本次只新增此计划文档。未来开发、迁移和真实效果实验均未在本次执行。
