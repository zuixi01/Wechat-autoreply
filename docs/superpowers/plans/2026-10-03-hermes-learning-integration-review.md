# Hermes 学习机制接入工作记忆执行计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. 按复核、实现、验证顺序执行，不将文件存在或历史测试报告当作当前验收通过。

**Goal:** 让工作记忆从真实案例和人工纠正中提炼处理方法，经过审核或独立验证后参与后续回复，再根据真实反馈修订、整理和回滚。

**Architecture:** 在现有 TypeScript 架构内适配 Hermes 的记忆、后台复盘、技能修订、历史检索与整理机制。本地使用现有 SQLite 和主进程，企业使用 PostgreSQL 与服务端身份；复盘器提出候选，验证与发布决定生效，实际回复记录所用版本。

**Tech Stack:** Electron、React、TypeScript、Zod、SQLite、PostgreSQL、Vitest、现有模型传输和便携 Node 工具链。

**Spec:** `docs/superpowers/specs/2026-10-03-hermes-learning-feasibility.md`。该文档部分“当前缺口”属于历史盘点；本计划以任务 0 的新基线决定已有实现是否需要补齐。设计与验收要求继续适用，实施阶段如需变更须明确记录。

状态：本轮仅调研和计划，没有修改产品代码、运行产品验收或授权实施。以下阈值是建议默认值及拟议业务目标。

## 可行性和参考依据

结论：可行，适合抽取学习机制，在现有架构内实现。这里的自我学习指外部记忆和处理方法的更新，不包含模型权重训练或应用代码自动修改。

本轮固定上游提交为 `b2860025adc1478eca63a0b2a82440798eadbfd1`，通过 GitHub commits API 获取。已读取该提交的 `agent/background_review.py`、`agent/curator.py` 和 `tools/skill_manager_guards.py`；历史检索依据官方说明。部分 raw 请求受限，后两份源码通过 contents API 获取，不把失败请求当作已核对来源。

| Hermes 机制 | 本项目适配 | 依据 |
| --- | --- | --- |
| 有限容量持久记忆与冻结快照 | 复用版本存储，每次生成绑定有界记忆快照 | [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/) |
| 回合后后台复盘与工具白名单 | 持久队列，空闲运行，只输出候选 JSON，前台抢占 | 上述提交的 `agent/background_review.py`；Memory 文档 |
| 经验形成技能、先读后改、按需加载 | 保存场景、步骤、坑点和验证项，修订实际已读版本 | `tools/skill_manager_guards.py`；[Skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/) |
| 跨会话回忆 | 按可信作用域检索历史案例 | Memory 文档及仓库说明 |
| 定期整理、固定保护、可恢复归档 | 确定性维护先行，模型合并默认关闭 | `agent/curator.py`；[Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator/) |

推荐机制适配，而不是引入完整 Hermes Python 进程：现有项目已有对应模块，双运行时会增加身份、预算、版本和部署协调成本。第一版不增加脚本型技能、外部画像服务或向量数据库。若直接复制上游源码或提示词，记录上游提交并保留 MIT 许可和归属。

当前已看到案例合同、SQLite 存储、后台复盘、校准验证、整理器、IPC、学习界面和企业存储/任务绑定等实现文件。这说明可以复用基础，但不能证明整条产品链路已完成。本轮没有重新运行测试，历史进度记录只作为线索。

## Global Constraints

- 学习内容用于沟通偏好、处理步骤、遗漏提醒。价格、订单、退款规则、发送权限和收件人仍由原有权威来源决定。
- 作用域沿用 workspace/platform/tenant/account/conversation；企业身份由服务端凭据推导，昵称和模型文本不能建立身份。
- 生成草稿、模型自评、发送成功均不能证明客户问题解决。未知结果保留 unknown。
- 候选修订不覆盖旧生效版本；所有修改保留来源、哈希、修订和原因，使用 expectedRevision 检查并发冲突。
- 默认 suggest 只产生建议；off 停止学习；是否读取记忆由独立 memoryEnabled 控制。auto 只处理具备有效验证证据的低风险项。
- 每次最多 5 条方法和 3 条案例，合计最多 2000 个保守估算 token，包括包装与边界说明。
- 后台并发 1，空闲 15 秒后复盘，超时 30 秒，最多 3 次尝试；输入 8000、输出 2000、账号 UTC 日预算 50000 个 token。验证和模型整理也纳入账号预算。
- 原始案例默认保留 90 天；遗忘删除正文和关联检索信息，取消相关任务，并阻断旧来源重新导入。历史匿名费用可保留。
- 整理默认每 7 天且空闲 2 小时；自动项未用 14 天待复核、30 天可恢复归档。保护人工和固定项，新项有 14 天宽限，模型合并默认关闭。
- 企业学习生效必须接入原有发布和评估准入，不能靠本地记忆绕过审核。
- 旧快照发生相关版本、来源、设置或保留期变化时失效；后台故障不能授予发送权限。

## Review Focus

1. 同昵称、切换客户或未绑定身份：不能读取另一客户经验或泛化个人偏好。任务 1、4 验证。
2. 纠正重试、进程重启、多 worker：不能重复案例、候选、占额或失去真实费用。任务 1、2、4 验证。
3. 模型迟到、暂停、前台抢占、版本变更：不能生效旧响应或继续使用旧草稿。任务 2、3、4 验证。
4. 遗忘、保留期到期、配置改动后恢复旧值：旧来源和旧验证凭据不能重新有效。任务 3、4 验证。
5. 少量重复案例、模型自评和合成数据：不能宣称自动生效资格或真实业务改善。任务 3、6 验证。

## Task 0 核对当前基线

**Files:** `docs/learning-memory-progress.md`；现有学习测试；本计划。只检查嵌套项目 `auto-reply`，保留现有未提交改动。

- [ ] 核对学习实际入口、数据存储、后台调度、企业生成和执行链；逐项标为“代码存在、已验证、未接通”。历史进度不能替代当前输出。
- [ ] 运行现有完整测试与 node/web/services 类型检查，记录失败和环境，区分旧问题与新增问题。
- [ ] 对已实现且通过检查的行为直接复用；后续任务只补缺口和必要回归，不重复搭建模块。

**Deliverable:** 当前基线和缺口清单；不宣称当前全套已通过。任务 1–6 依次执行。

## Task 1 真实案例和反馈闭环

**Files:** `src/shared/contracts/learning-memory.ts`、`src/core/memory/learning-episode-assembler.ts`、`learning-feedback.ts`、`src/main/services/learning-service.ts`；企业工作台对应事件服务。

**Interfaces:** 复用 LearningEpisode、LearningFeedback、MemoryScope；员工纠正、明确结果和实际使用方法引用作为可信输入，来源 ID 用于幂等。

- [ ] 补充缺失测试：同问题累计消息，切换客户不合并，草稿不等于解决，纠正重试只入队一次，发送确认不等于采用，重启续接未关闭案例。
- [ ] 接通员工修改、采纳、失败原因、解决和转人工事件。纠正、反馈、案例更新和入队使用同事务或可靠 outbox。
- [ ] 无明确结果的问题空闲 30 分钟关闭为 unknown；两次明确质量失败可触发复盘，桌面发送故障不作为方法质量失败。
- [ ] 运行 episode-assembler、learning-feedback、learning-service、learning-correction-atomic、learning-knowledge 集成测试。

**Deliverable:** 真实纠正可以自动形成有来源案例和唯一复盘任务；重启后可恢复。

## Task 2 后台复盘与方法修订

**Files:** `src/core/memory/learning-reviewer.ts`、`learning-scheduler.ts`、`learning-jobs.ts`、`learning-transport.ts`、`learning-model-configuration.ts`；`server/src/learning/learning-queue.ts`。

**Interfaces:** 复用 LearningReviewRequest/Result 与 LearningReviewer.review；输入包含案例、反馈、实际加载修订和当前修订，输出只允许有限 create/revise 候选操作。

- [ ] 测试未知结果不生成成功技能、先修订已有方法、未读版本拒绝修改、空结果不造经验、来源不存在拒绝、迟到取消不写回。
- [ ] 补齐专用复盘模型配置、前台优先、持久认领和共享预算。跨日、失败和取消保留真实或保守费用，不把取消当作免费。
- [ ] 将企业队列接到真实受限复盘 worker；worker 身份必须由服务端授权，不能保存设备明文凭据作为后台长期权限。
- [ ] 运行 learning-review-strategy、learning-runtime、learning-transport、learning-enterprise-queue、learning-validation-budget 测试。

**Deliverable:** 空闲时产生可解释的新候选或旧方法候选修订，不获得发送、脚本或代码修改能力。

## Task 3 候选验证、生效和整理

**Files:** `src/core/memory/learning-validation.ts`、`learning-validation-store.ts`、`learning-risk.ts`、`learning-curator.ts`、`learning-retention.ts`；企业对应验证和维护服务。

**Interfaces:** 沿用候选与 activeRevision 的分离；可信验证凭据绑定作用域、内容/修订、案例集、知识/策略/验证器版本与环境。建议有效期 24 小时。

- [ ] 测试待审 V2 保留 V1、无人工标签返回 insufficient、重复会话不能凑 5 条、伪造/过期凭据拒绝、知识变更失效、严重错误隔离实际使用版本、回滚有新审计版本。
- [ ] 自动生效至少使用 5 个独立会话的人工标注相关校准案例，要求严重错误 0、覆盖不降低且不新增业务承诺。个人偏好默认人工确认；不合格保持候选并显示原因。
- [ ] 核对风险约束由合同、权限和语义验证共同执行，不能只依靠复盘提示词。
- [ ] 测试首次整理只初始化、固定/人工方法保护、可恢复归档、dry-run 不修改、来源过期后停用、遗忘不能复活、模型合并先候选再验证。
- [ ] 将企业验证/整理接到实际 worker、保留期维护和权威发布接口。
- [ ] 运行 learning-iteration、learning-auto-validation、learning-validation、learning-curator、learning-retention-lifecycle、learning-maintenance 测试。

**Deliverable:** 完整展示 V1 → 纠正 → V2 候选 → 验证/人工批准 → 生效 → 回滚。数据不足时准确停止在候选阶段。

## Task 4 接入实际回复和企业发布

**Files:** `src/core/memory/memory-provider.ts`、`learning-context.ts`、`src/core/agent/remote-reply-service.ts`、`reliable-agent.ts`、`src/core/reply/generation-validation.ts`；`server/src/learning/learning-generation-context.ts`、`learning-publication.ts`、`server/src/generation/generation-service.ts`、`model-call-authority.ts`、`text-generator.ts`、`server/src/reply/jev-pipeline.ts`、`server/src/http/application.ts` 与执行授权服务。

**Interfaces:** 复用 LearningTaskBinding 的 memoryCorpusVersion、memorySnapshotHash、learningContextVersion，三个字段完整传播；企业准备接口由服务端生成绑定，设备账本在绑定后开始记录。

- [ ] 测试同作用域检索、无关问题不注入、5/3/2000 总预算、候选不注入、过程参考不能成为业务事实证据。
- [ ] 接通准备任务 → 实际模型输入 → 审核结果 → 缓存 → 模型调用前核验 → 发送许可签发；人工编辑和确认也必须绑定原始来源和相应快照。
- [ ] 测试方法修订/遗忘/案例到期/总开关变化使旧缓存、旧草稿和旧许可申请失效；任务身份与绑定不能由客户端篡改。
- [ ] 验证实际 HTTP 传输中的独立过程参考字段，更新生成器指纹，并重新走已有评估发布准入。
- [ ] 在真实 PostgreSQL 下验证多连接池认领、并发修订、账号预算、租户/账号隔离、撤销凭据和上下文版本变化；模拟库测试不替代该项。
- [ ] 运行 learning-task-binding、generation-service、remote-reply-service、text-generator、execution-authority、model-call-transport 测试及 test:postgres。

**Deliverable:** 已生效方法确实参与产品实际回复，能追溯具体修订；旧或跨客户快照不能继续执行。

## Task 5 统一工作记忆界面

**Files:** `src/renderer/src/MemoryWindow.tsx`、`src/renderer/src/features/memory/LearningMemoryPanel.tsx`、`LearningCorrection.tsx`、`LearningJobsPanel.tsx`、`MemoryRevisionDiff.tsx`；`src/main/ipc/learning-ipc.ts`、`src/shared/contracts/learning-desktop.ts`、preload。

- [ ] 补齐模式、模型、候选/生效版本、验证原因、费用、整理报告、纠正/结果反馈和回滚/遗忘操作。
- [ ] 统一旧卡与新学习入口的语义；操作只有持久化成功才显示成功。客户切换时拒绝迟到详情，renderer 不能伪造验证凭据。
- [ ] 新增 test:learning:desktop，使用独立临时 userData、回环假模型和真实 Electron，通过实际 UI/preload/IPC 完成纠正、生效、使用、回滚、范围切换和取消。
- [ ] 运行 learning-ipc、类型检查、build 和学习桌面 smoke；检查截图与实际持久状态。知识库试答 smoke 不替代学习工作台验收。

**Deliverable:** 用户能直接查看学到了什么、为何修改、是否生效、花了多少、如何撤销。

## Task 6 工程验收和真实效果对照

**Files:** 新增 `evals/memory/` 对照评估模块、`tests/unit/memory-evaluation.test.ts`、`tests/integration/learning-acceptance.test.ts`、验收报告和 memory:evaluate 脚本。

- [ ] 测试相关会话不能跨数据组、留出集不学习、缺标签是 insufficient、合成数据不能作为业务成功证据、零基线不除零、冻结版本失配拒绝比较。
- [ ] 对相同案例比较不使用记忆、旧卡片、新学习机制；冻结模型、知识、策略和数据版本，独立盲评，按会话报告分组结果和区间。
- [ ] 建议学习/校准/留出样本 100/100/200 条，留出至少 30 个独立会话。拟议目标：相对旧卡片实质人工修改率降低 20%，严重错误样本 0，覆盖损失不超过 5 个百分点，同环境前台 p95 增量不超过 500ms。达不到就报告结果，不调整口径凑通过。
- [ ] 运行完整测试、类型检查、scenarios、真实 PostgreSQL、build、已有桌面回归和新学习桌面验收，记录报告路径与实际退出码。
- [ ] 完成整体差异审查，修复后复跑受影响检查；逐项填写工程证据与业务证据。无真实人工标签时，工程与业务验收分别报告，业务保持证据不足。

**Deliverable:** 可复现工程验收报告及独立业务效果报告，不用经验条数或发送次数代替效果。

## 执行命令

以下是后续实施/验收命令，本轮未执行。工作目录为 `E:\wechat-autoreply\auto-reply`。

```powershell
& '.\scripts\dev-tools.ps1' test
& '.\scripts\dev-tools.ps1' run typecheck:node
& '.\scripts\dev-tools.ps1' run typecheck:web
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run test:postgres
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run test:desktop
```

任务 5 创建后再运行 `run test:learning:desktop`。任务 6 创建脚本并提供真实标注后再运行 `run memory:evaluate -- <实际标注文件> <报告文件>`。不执行不存在的命令，也不以跳过检查作为通过。

任务 0 先检查，后续每项对缺失行为先写失败测试、确认断言失败、实现、运行同一测试与受影响回归；已实现且通过的行为不重写。最终要求所有必要工程命令退出 0，真实 PostgreSQL 和桌面报告有实际验证证据。故障必须修复或明确标为未完成。

## 分阶段交付和外部依赖

第一阶段完成任务 0–2，得到可靠的候选学习；第二阶段完成任务 3–4，得到可控生效并用于真实回复；第三阶段完成任务 5–6，得到可操作界面和完整验收。

排期必须在任务 0 后按真实剩余工作估算。历史计划的工期不能直接用于本轮已有大量实现的工作区。真实业务标注可与工程并行收集；缺标注不阻止人工审核和工程开发，但会阻止自动生效证据及真实效果验收。需要可用的真实 PostgreSQL 测试环境和模型测试配置。

最小现场验收案例：员工纠正“报价前先确认型号和数量” → 保存原问题、原草稿、纠正和原因 → 自动复盘得到有来源候选 → suggest 下不自动启用 → 人工核对或独立校准通过 → 下一次相关询价实际加载该版本 → 显示使用引用 → 新纠正产生新候选且旧版继续生效 → 回滚可恢复 → 遗忘后旧来源、旧草稿和旧缓存不能再使用。
