# Hermes 学习机制接入工作记忆：当前工作区执行计划

> **For agentic workers:** 后续实施使用 superpowers:executing-plans，按任务核验并记录证据。本次只分析与编写计划，不修改产品代码，不启动实施。

**Goal:** 让工作记忆从实际问题、员工纠正和处理结果中学习方法，经验证用于后续回复，并支持持续修订、整理、追溯和回滚。

**Architecture:** 在已有 TypeScript 模块内适配 Hermes 的持久记忆、技能修订、后台复盘和整理机制。本地使用现有 SQLite，企业使用 PostgreSQL 权威存储；共享学习合同与算法，不引入完整 Hermes Python 运行时。

**Tech Stack:** Electron、React、TypeScript、Zod、SQLite、PostgreSQL、Vitest、现有文本模型与 Jev 回复管线。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`。原始八任务细化见 `2026-10-03-hermes-learning-completion.md`；本文件补充当前工作区状态和执行顺序，实施时以实际签名为准，不能重新创建已存在模块。

## 当前核对与需求边界

2026-10-04 只读检查确认：已有案例、版本、检索、反馈、持久复盘队列、本地验证/整理、企业存储和企业回放验证代码。`LearningMemoryPanel.tsx` 已有初步界面，但版本详情仍有延迟写状态，桌面合同尚未暴露完整验证/整理接口；企业 HTTP 入口尚未接通学习管理。

这些是代码存在的证据，不是本轮测试通过的结论。本轮不运行模型、学习后台、迁移、真实发送或产品测试，也不把进度文档中的历史结果当成当前验收。

默认按本项目客服回复场景设计。学习更新的是外部记忆与描述性处理技能，不训练模型参数、不自行改应用代码。企业知识库仍提供价格、退款条件、库存等事实；记忆学习沟通方式、处理顺序、遗漏提醒和转人工经验。

## Global Constraints

- 默认 `memoryEnabled=true, mode=suggest`；读取和学习开关独立，账号级关闭约束客户级设置。
- `off` 停止学习；`suggest` 生成待审候选；`auto` 只使验证合格的低风险方法生效，企业正式使用仍需现有发布与评估准入。
- 每次最多 5 条方法、3 条案例、合计 2000 个保守估算 token，包含提示包装；无关内容不注入。
- 后台并发 1，前台优先；默认空闲 15 秒、单次模型请求超时 30 秒、复盘输入 8000/输出 2000 token、账号 UTC 日预算 50000、最多 3 次尝试。
- 案例默认保留 90 天，可配置 7–365 天；遗忘阻断旧任务和迟到结果，不能只隐藏界面。
- 整理每 7 天且空闲 2 小时；新方法宽限 14 天，闲置 14 天待复核、30 天可恢复归档；人工与固定项保护，模型合并默认关闭。
- 验证凭据有效 24 小时，绑定身份范围、修订、内容、来源、知识、策略、验证器和人工校准集；至少 5 个独立人工标注会话，且与学习来源不重叠。
- 身份使用可信账号/客户绑定，不能使用昵称或客户端自报身份；未知身份不能自动形成客户偏好或通用方法。
- 保留现有工作区修改；实施只处理明确文件，不 reset、批量暂存或替其他工作提交。所有重型验证串行执行。
- 上游实施参考沿用原设计锁定提交 `4e3fcd5cd7e40c37cb6f9a21a76fc57a7361957a`；实际复用前确认文件和许可，复制源码/提示词保留 MIT 归属。

## Review Focus

- 同昵称、切换账号与企业身份伪造不能串用记忆：任务 1、5。
- 重复纠正、重启、断网不能重复案例/入队/计费：任务 1、2。
- 候选 V2 不替换 V1；知识变化或遗忘使旧凭据、草稿和缓存失效：任务 3、5。
- 前台抢占、停机、撤销后迟到模型结果不能生效；已发生费用仍真实结算：任务 2、3、4。
- 模型自评、发送确认、合成标签不能证明业务改善：任务 1、7。

## 执行流程

每个任务：先核对现有实现与签名 → 为缺失行为写失败测试 → 确认因行为缺失失败 → 最小实现 → 定向测试 → 记录改动、证据和剩余项。已经满足且验证通过的能力不重复开发。

### Task 0：建立当前基线

**Files:** 只读 `package.json`、`scripts/dev-tools.ps1`、`docs/learning-memory-progress.md`、原设计与八任务计划；后续实施时记录到 `docs/learning-memory-acceptance.md`。

- [ ] 记录 Git 状态，区分本任务与已有修改；核对学习模块实际接线，按“已实现并验证 / 有实现待验证 / 缺失”建表。
- [ ] 串行执行以下命令，保存退出码与失败原因；已有失败不能删测试掩盖。

```powershell
# 在克隆后的仓库根目录执行
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
```

**通过条件:** 当前状态和未完成点可复现，后续有可比较基线；不以历史测试总数判断完成。

### Task 1：接通问题案例与员工教导

**Files:** 修改 `src/core/memory/learning-episode-assembler.ts`、`learning-feedback.ts`、`src/main/services/learning-service.ts`、`src/shared/contracts/workbench.ts`、`src/renderer/src/features/agent/ReplyWorkbench.tsx`；企业接线与任务 5 一起完成。测试 `tests/unit/learning-episode-assembler.test.ts`、`tests/integration/learning-feedback.test.ts`、`learning-correction-atomic.test.ts`。

**Interfaces:** 复用 `EpisodeMessageEvent`、`EpisodeCloseEvent`、`LearningCorrectionInput`、`LearningResultInput`；问题 ID 由主机可信事件给出，纠正绑定真实任务、生成和实际加载的方法修订。

- [ ] 核验同问题聚合、客户切换不合并、草稿不是解决、发送不是采纳、重复纠正只入队一次的断言；缺失项补红测。
- [ ] 工作台增加纠正原因、明确结果和质量反馈入口，接通可信主进程/服务端事件。
- [ ] 纠正、案例更新与复盘入队使用事务或可靠 outbox；同问题 30 分钟无消息关闭为 unknown。
- [ ] 重启真实 SQLite 后续接未关闭案例，并复测纠正故障重试。

**通过条件:** 员工纠正一次，可追溯地产生一个学习任务；未知结果不被记录为成功经验。

### Task 2：核验后台复盘与受控修订

**Files:** 复用/必要时修改 `src/core/memory/learning-reviewer.ts`、`learning-jobs.ts`、`learning-scheduler.ts`、`learning-transport.ts`、`learning-model-configuration.ts`、`server/src/learning/learning-reviewer-worker.ts`。测试 `learning-runtime.test.ts`、`learning-transport.test.ts`、`learning-enterprise-worker.test.ts`。

**Interfaces:** 复盘输出沿用 `LearningReviewResponseSchema`；只允许有来源的新候选或读过的修订，不允许获得发送、脚本执行或业务授权。

- [ ] 核验优先修订实际使用的方法、未读版本拒绝、未知结果不提炼成功技能、无新经验允许空结果。
- [ ] 核验持久任务恢复、单次认领、账号预算、UTC 跨日、前台抢占及迟到费用结算；模型错误显示明确状态。
- [ ] 补独立复盘模型配置的产品入口，凭据保存在主机，不由 renderer 任意指定生产端点。
- [ ] 运行对应本地与企业集成测试，验证取消后候选不落库。

**通过条件:** 后台能从真实教导提炼待审方法，预算与前台回复不受失控后台影响。

### Task 3：验证、生效、回滚与迭代

**Files:** 复用 `src/core/memory/learning-validation.ts`、`learning-risk.ts`、`learning-validation-store.ts`、`src/main/services/learning-product-validation.ts` 与 `server/src/learning/learning-product-validation.ts`、`learning-validator-worker.ts`、`learning-validation-budget.ts`。测试 `learning-iteration.test.ts`、`learning-product-validation.test.ts`、`learning-enterprise-product-validation.test.ts`、`learning-enterprise-budget.test.ts`。

**Interfaces:** `LearningValidationCase` 为人工标签；`LearningValidationResult` 输出 passed/failed/insufficient；可信存储签发 `MemoryActivationGrant`，客户端不能提交自行声明的通过结果。

- [ ] 核验五个独立校准会话、无训练重叠、来源与语义风险检查、无标签为 insufficient。
- [ ] 同一真实回复管线成对回放现行/候选，保持知识、模型和其他方法一致；评分标签不进入生成提示词。
- [ ] 核验严重错误为零、覆盖不降低、无新增业务承诺才可通过；绑定变化、过期、撤销、前台抢占阻止旧凭据生效。
- [ ] 演示 V1 生效 → 纠正 → V2 待审且仍使用 V1 → 验证 → V2 生效 → 实际加载 → 回滚；严重错误隔离准确修订。
- [ ] 企业生效更新目录后，要求现有发布评估重新准入，不绕过原发送审核。

**通过条件:** 自我迭代改变真实使用的方法版本，可追踪、可拒绝、可回滚；回放不创建可发送任务。

### Task 4：补齐企业整理与周期清理

**Files:** 复用 `src/core/memory/learning-curator.ts`、`learning-retention.ts`、`learning-curation-store.ts`；新增 `server/src/learning/learning-curator-worker.ts`、`learning-maintenance-service.ts`，修改 `learning-repository.ts` 和 `server/src/index.ts`。新增 `tests/integration/learning-enterprise-maintenance.test.ts`，复用本地 maintenance/retention 测试。

**Interfaces:** 共用 `LearningCurationReport`、`RetentionReport`；新增维护服务 `runOnce(): Promise<{curation: LearningCurationReport[]; retention: RetentionReport[]}>`，身份引用取自主机注册 worker，不来自请求正文。

- [ ] 红测覆盖首次只初始化、7 天/2 小时门槛、14 天宽限、人工/固定项保护、多 worker 单次维护、dryRun 不写入。
- [ ] 企业维护使用权威身份、持久调度和现有后台租约；前台开始、off、撤销或遗忘后旧维护计划拒绝提交。
- [ ] 真正删除过期案例正文与索引，保留脱敏出处；无法核验的方法进入待复核，遗忘阻止旧数据复活。
- [ ] 默认只做确定性整理；可选模型合并走相同费用与候选验证，不覆盖旧生效修订。

**通过条件:** 记忆规模受控，过时经验可恢复归档，人工经验不会被自动误改，原文按保留期实际清理。

### Task 5：企业管理、反馈与发布闭环

**Files:** 新增 `server/src/learning/learning-service.ts`、`learning-routes.ts`、`learning-events.ts`；修改 `server/src/http/application.ts`、`server/src/index.ts`、`learning-repository.ts`、`learning-publication.ts`，复用 generation/context/queue 模块；测试新增 `learning-enterprise-routes.test.ts`、`learning-enterprise-events.test.ts`，扩展 `tests/concurrency/postgres-authority.test.ts`。

**Interfaces:** 管理适配使用现有 `LearningWorkbenchSnapshot`、`LearningAction`、settings/correction/result 合同；企业调用传认证 credential 和 conversationId，服务端推导 scope。事件适配 `recordCorrection(credential, {taskId, expectedVersion, sourceId, text, reason}): Promise<LearningEpisode>`，校验真实任务版本及其客户范围，原子保存学习事件/入队。

- [ ] 红测覆盖伪造账号、客户跨范围、过期任务、普通角色伪造凭据、纠正重试、权限撤销与发布竞争。
- [ ] 提供快照、详情、设置、纠正、结果、版本动作、校准/验证和整理报告管理入口；用户管理与专用 worker 签发权分离。
- [ ] 将实际审核、明确采纳、执行确认分别回传；发送仅记录交付，不增加方法成功率。
- [ ] 核验已有 memoryCorpusVersionId/memorySnapshotHash/learningContextVersion 在真实生成、缓存、审核、编辑和执行传播；离线不得改用本地未发布企业候选。
- [ ] 串行运行企业集成及真实 PostgreSQL 并发检查，保存清理结果；嵌入数据库测试不能代替真实多连接池检查。

**通过条件:** 企业各设备使用相同权威经验，真实纠正进入学习，方法变更遵守发布审核。

### Task 6：统一工作记忆 UI 与桌面验收

**Files:** 修改 `src/shared/contracts/learning-desktop.ts`、`src/main/ipc/learning-ipc.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`、`src/renderer/src/MemoryWindow.tsx`、`features/memory/LearningMemoryPanel.tsx`、`LearningCorrection.tsx`、`MemoryRevisionDiff.tsx`、`LearningJobsPanel.tsx`；新增 `scripts/learning-smoke.cjs`、`scripts/run-learning-smoke.mjs`，在 `package.json` 注册 `test:learning:desktop`。

**Interfaces:** 保留 `window.learningMemory`，增加 `validate({scope,id,expectedRevision})`、`curate({scope,dryRun})` 及可信校准导入/验证报告读取；返回共享验证/整理合同，不接受 renderer 提供的 grant。

- [ ] IPC 红测覆盖伪造验证、无企业身份、过期修订操作、重复旧卡迁移。
- [ ] 显示来源范围、学习模式、候选/生效修订、差异、证据、验证原因、任务与费用；修复跨范围迟到详情和刷新后过期状态。
- [ ] 统一旧卡迁移与员工教导；持久化成功后才显示保存成功。
- [ ] 独立临时 userData、回环假模型、真实 Electron，通过 UI/preload/IPC 演示纠正、验证、生效、回滚、范围切换和预算状态，保存截图与机器报告。

**通过条件:** 用户在工作记忆窗口能完成整个教导与管理流程，UI 状态与真实数据库一致。

### Task 7：工程验收与业务效果对照

**Files:** 新增 `evals/memory/README.md`、`metrics.ts`、`server/scripts/memory-evaluate.ts`、`tests/unit/memory-evaluation.test.ts`、`tests/integration/learning-acceptance.test.ts`、`docs/learning-memory-acceptance.md`，注册 `memory:evaluate`。

**Interfaces:** `evaluateMemory(dataset: MemoryEvaluationDataset): MemoryEvaluationReport` 返回 status/reasons/metrics/intervals/sampleCounts/frozenVersions；provenance 必须区分真实人工标注与 synthetic。

- [ ] 红测覆盖关联会话不能跨分组、留出集不学习、缺标签 insufficient、基线零分母、版本漂移、合成数据不能声明业务成功。
- [ ] 对同一留出案例比较 memory-none / memory-legacy / memory-learning，冻结模型/知识/策略与学习，人工盲评并按会话分组报告区间；保持已有 Jev A/B/C 命名不变。
- [ ] 建议学习/校准/留出 100/100/200 条、留出至少 30 独立会话。拟议目标：实质人工修改率相对旧卡下降至少 20%，观察严重错误 0，覆盖损失不超过 5 个百分点，前台 p95 新增延迟不超过 500ms；这些是待采纳目标，不是保证。
- [ ] 串行执行全套 test、node/web/services 类型检查、test:scenarios、test:postgres、build、test:desktop 与新增 test:learning:desktop，记录真实退出码、版本和报告。
- [ ] 对完整学习差异做独立审查并修复；验收文档逐条记录证据。没有真实标签，业务效果标为证据不足，不能宣称越用越好。

**通过条件:** 工程闭环有端到端证据；真实效果有独立对照数据，或明确列出证据缺口。

## 来源与交付边界

- [Hermes 仓库](https://github.com/NousResearch/hermes-agent)
- [持久记忆与后台学习](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
- [技能系统](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [整理器](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/)
- [后台复盘源码](https://github.com/NousResearch/hermes-agent/blob/main/agent/background_review.py)

本轮交付为可行性结论与执行计划。用户要求“先不要改代码”，因此实施、迁移、安装依赖、部署及真实发送均未执行。
