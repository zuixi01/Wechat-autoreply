# 企业学习字段传播清单

这是任务 6 的实施清单，不是全部完成声明。当前已实现权威存储、publication / evaluation 绑定、后台队列、任务准备、过程参考注入，以及任务/审核/模型调用/执行的快照传播。已验证真实 HTTP 到本机账本及 mock send 的完整绑定，新增后台数据库身份基础；企业 worker 的实际运行和反馈管理链仍未完成。

## 服务端绑定

| 字段 | 来源与用途 | 当前状态 |
| --- | --- | --- |
| `memoryCorpusVersion` | 服务端实际可用方法目录；显式空值 `empty-enterprise-memory-v1` | 配置、任务、审核、生成缓存及自动/人工执行已传播和核验 |
| `memoryManifest` | 服务端实际生效方法的 id / revision / contentHash；按账号、客户范围与来源保留期核验 | 目录校验及实际过程参考选择/注入已接通；不进入业务事实证据 |
| `memorySnapshotHash` | 对实际选中的有界方法及案例内容计算 | 服务端准备并保存不可变引用；重建内容核对哈希，客户端只能增加三项绑定 |
| `learningContextVersion` | 实际客户/账号上下文；来源、案例目录和单调生命周期 epoch | 已进入任务；设置变化再恢复、遗忘和保留期使旧快照失效，本次自己的草稿不使自己失效 |

## 必须同时检查的入口

| 入口 | 文件 | 所需行为 |
| --- | --- | --- |
| 任务/审核合同 | `src/shared/contracts/task.ts` | 三个版本字段成组出现；审核精确复制任务绑定，拒绝不完整字段 |
| 配置同步 | `src/shared/contracts/generation.ts`、`GenerationService.configuration`、`AgentRegistration` | 返回当前正式目录版本；不返回模型密钥和未发布候选正文 |
| 准备任务 | 服务端生成准备入口、`RemoteReplyService`、`ReliableAgent.schedule` | 可信服务端先准备绑定；设备只允许增加指定绑定字段且核对原任务身份/范围/正文摘要；完成后再创建本机任务账本 |
| 本机账本 | `ReliableAgent`、reply task store、human-send preparation | 不在 begin 后替换任务；不能只替换 generation result 的字段而留下旧 taskHash |
| 缓存与实际生成 | `GenerationService.process` / `validateCurrent` | 认领前、缓存返回前、模型阶段与完成提交前核验实际绑定；忘记/来源失效拒绝迟到结果 |
| 生成器 | `JevReplyPipeline`、`DraftGenerator`、`HttpTextGenerator` | 方法/历史案例为单独的过程参考数据；不得进入 `trusted_evidence`、提升事实权威或改变 Jev A/B/C 的判断含义 |
| 生成指纹/评估 | text generator fingerprint、evaluation admission | 提示与检索语义变更更新指纹；冻结案例/记忆版本；新目录不能沿用旧批准 |
| 结果合同 | `generation-validation.ts`、`edited-review-validation.ts` | result.task 与预期任务全量哈希相等；审核绑定与任务一致，编辑不能改变源版本 |
| 模型调用占额 | `ModelCallAuthority.reserve` | 每个实际调用前仍核验当前版本与上下文；失效时不新增额度或发起请求 |
| 自动/人工执行 | `ExecutionAuthority.recordApprovedCandidate` / `issue` / `issueHuman` | 当前发布、任务、审核及原草稿绑定一致；人工确认的新任务保留原绑定并重新检查；批准方法不等于获得发送权限 |
| 设备发送与请求封印 | `AgentRegistration`、`CentralSendAdapter`、request seals / human confirmation | 继续使用完整 taskHash；不得从 renderer 接收权威记忆内容、凭据或 grant |
| 工作台反馈 | server learning routes、`ReplyWorkbench`、desktop runtime | 通过实际已保存 task/generation ID 推导加载引用；不能由 renderer 随意列举 revision 或声称投递成功 |

## 剩余企业后台链

队列具有跨 worker 账号锁、持久认领、共享预算、前台序列抢占、跨日费用与遗忘后的匿名费用保留。迁移 016 和 EnterpriseLearningWorkerAuthority 增加显式后台登录/账号/设备绑定，通过账号锁后再次核验撤销和设备指纹；普通应用角色不能读写绑定或使用后台身份函数，不保存明文设备密钥。已在实际 PostgreSQL 用独立 non-bypass 登录验证重新构造后恢复、撤销等待中的操作及凭据轮换失效。后台授权基础不等于 worker 已接入生产。

企业 reviewer worker 与实际 HTTP 模型传输已接入服务启动/关闭。它使用专用数据库登录重新枚举授权、持久认领、当前上下文与设置绑定，候选/任务同事务提交；重启、抢占、遗忘和迟到费用均有回归。服务停止先取消复盘，再等待 HTTP 请求排空与数据库关闭。模型配置在构造时固定，客户文本不能提供端点或密钥；后台角色或模型缺失时不认领。整组遗忘也清除其他客户保存的已删账号方法引用及生成映射，保留无关记录；过期报告统计实际脱敏的修订引用。

企业 validator/curator、校准集/验证凭据、管理和发布路由、真实工作台纠正及问题聚合、企业周期保留期维护尚未接入。继续复用已有纯逻辑并采用 PostgreSQL 事务，不把 SQLite 存储移到企业服务器，也不把合成测试当成业务标签。

截至准备/执行链的历史验证：91 文件/834 项完整测试通过，build/node/web/services 及 32 文件 lint 通过；实际 PostgreSQL 25 项。后台身份后实际 PostgreSQL 26 项，后台复盘构造后最新实际 PostgreSQL 27 项，报告 `.local/reports/postgres-concurrency/be649872-0465-4513-9415-4853570dad28/result.json`（passed/cleanedUp 均为 true）。包括两个 runtime 的实际账号锁等待、一次 HTTP/候选/费用，普通/管理员角色拒绝。worker 集成 13 项、九文件 lint 与最终 build 均通过。

验证诊断：第一次整套 PDF 原有 5000ms 超时，单独复测五项通过；第二次整套发现并行新增的 ledger-backup/foreground-wechat-driver 用例失败，services 也报告对应类型错误。其后相关开发更新了权威文件，两组专项 26 项通过；仅补 PNG 夹具的 Buffer 泛型标注，没有改那些功能的产品代码。最终单独整套已通过 **95 文件/878 项**（146.29s），随后最新 build（含 node/web）、services 与十文件 lint 也通过。以上是当前完整工作区结果，不将其他开发的改动算为本学习任务贡献，也不代表剩余任务已完成。

后续红测至少覆盖：客户端不能发布、准备后范围/正文变化、旧方法目录/案例快照缓存失效、编辑及人工确认的版本一致性、模型调用前版本变化、范围遗忘后的迟到复盘、两个 worker 的提交竞争，以及真实 Electron 学习入口。
