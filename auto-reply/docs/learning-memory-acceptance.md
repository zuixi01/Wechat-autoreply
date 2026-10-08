# 持续学习工作记忆验收记录

> 当前状态以[集中验证报告](E:/wechat-autoreply/auto-reply/docs/learning-memory-final-verification.md)为准；下文历史过程记录保留，不能视为最新运行状态。

更新日期：2026-10-07。完整开发目标仍在执行，本文不是完成证明。下方按时间保留历史运行结果，历史“尚需完成”不代表后续工作没有实现。

执行位置 `E:\wechat-autoreply\auto-reply`，当前分支 `codex/reliable-agent`。共享工作区存在其他开发的未提交修改；不重置、批量暂存、部署或发送真实消息。

当前业务门槛已获用户确认：实质修改率相对下降至少 20%，学习组严重错误为 0，覆盖率下降不超过 5 个百分点，学习组 p95 减基线组 p95 不超过 500ms。真实独立人工业务样本仍未提供，业务效果保持“资料不足”。

## 2026-10-07 同批次恢复、预算等待与私有 CLI 增量

四项业务门槛再次按用户回复确认，数值没有调整。新增迁移 039 和 `resume RUN_ID OUTPUT_DIRECTORY`：恢复只读服务端冻结依据，在真实账号锁事务重新认领原 runId，保留原 assignment、组顺序、已完成回执及实际费用 UUID。判断/文本/审核的规范化阶段结果在下一阶段前耐久保存，未完成组复用已保存阶段。共享 UTC 日预算耗尽时释放槽，waiting_budget/退出 2，下一桶继续且不增加失败重试次数；其他失败仍有原指数退避和三次上限。次数上限、费用及尝试均不靠新进程重置。同一冻结来源另起 collect 被拒绝，部署配置指纹进入来源身份。全部组保存后导出故障可无新调用、无新尝试重新导出。

活跃认领优先返回 busy；旧 claim 的迟到 incomplete 不能覆盖新 claim。已付费但缺耐久阶段结果、未结算或费用引用缺失要求核对，不自动重复请求。恢复前核对原模型、部署、发布、全部案例及来源、设置/上下文 epoch、账号绑定、遗忘和保留期。held-out 阶段正文只给绑定 worker，应用登录不能读取，随父 checkpoint 遗忘/过期级联删除；原匿名费用保留。数据库整批 64 MiB 上限计入阶段正文和元数据。CLI 首个写入前设置真实 OS 私有目录权限，新文件不覆盖；已完成批次重新导出也有 evidence_exported 日志，不能当新调用。

两项最初恢复红测因缺 resume 和预算错误未区分失败（evaluation-resume-red.log）；初版 8 项通过。后续真实存储红测揭示 replacement collect 仍成功并重付（evaluation-resume-replacement-red.log，1 failed/50 未选），修复后包含该断言的最终五文件 **85 项全部通过，114.45s**：`2026-10-07-evaluation-resume-final-related.log`。九项冻结变化/失落计时边界单独先通过，另见 evaluation-resume-boundaries.log。新增计时完整标志：丢失间隔为 latencyComplete=false，评估为 insufficient；相关组 p95、增加 p95 及总体/分类 bootstrap 时延区间不能被当完整测量。企业回放仍固定 enterprise_pipeline，不是完整前台时延。

最终真实 PostgreSQL 16 选定文件 **6 项全部通过，35.10s**：`2026-10-07-evaluation-resume-postgres-process-final.log`，报告 `postgres-concurrency/3c1342e6-68d4-47b3-af71-da19b5dc9a00/result.json` 已读取 selected/passed=true/cleanedUp=true/testsPassed=6。所有迁移应用两次；独立非 bypass worker；实际回环 HTTP 及费用 UUID；两个恢复者竞争与旧 claim 隔离；两个不同 OS PID 之间保留已完成组并只调用剩余阶段；独立生产 CLI 重新导出完成批次且实际私有权限验证；CLI 同日预算等待退出 2；下一 UTC 桶复用已支付判断阶段，总调用仍为 9、原尝试仍为 1。跨桶部分使用主机测试时钟和真实 SQL/HTTP，不冒充已经实际等待 24 小时。进程重启部分为真实独立进程，首次导出失败是明确注入的合成故障。先前四项/五项的 e3095a49/941d48c4 报告保留历史。

最终生产代码 services 类型、11 相关文件 lint 和 build exit0（evaluation-resume-services-final/lint-final/build.log），build 含 node/web/main/preload/renderer，保留 Zod 注释警告。最后仅增加独立进程测试夹具，随后 services 类型及其两文件 lint 再次 exit0（evaluation-resume-process-services/lint.log），并完成上述真实 PG 六项。此轮未重跑完整全仓库、场景或桌面，不能把专项替代下文保留的完整失败及旧桌面证据。没有本任务仍在运行的检查进程。

Task8 补充第 2–3 项的恢复与预算等待已实现并取得上述工程证据；第 4–6 项的有界前台私有采集、真实工作台呈现确认、三组完整前台绑定、真实独立人工业务数据及最终独立审查仍未完成。原八项目标 ACTIVE，业务效果仍 insufficient，没有 commit/push/deploy、真实收费模型请求或业务消息。下文“尚无 resume”属于较早增量，保留其当时事实。

## 2026-10-07 冻结批次持久调用上限增量

用户再次确认采用原四项业务门槛，工程开发继续；没有将合成资料改成人工业务证据。本次先修复下文登记的发布桌面夹具私有草稿目录，再补同一冻结 run 的持久调用准入。原内存 requests 在新服务实例中无法看见已有费用行，三项真实存储红测均发现已有九次预留后仍返回成功 packet（`2026-10-07-evaluation-checkpoint-request-limit-red.log`，3 failed/33 未选）。现在 `EnterpriseEvaluationCheckpoint.assertRequestBudgetWithin` 在实际 reserve 的账号锁事务内读取服务端原 maxRequests 与同 run 全部 learning_attempts，达到上限即拒绝下一次预留；限制不受费用日期、新服务对象、已报告/未知/未派发用量影响。准入、租约和过期核对共用该事务的服务端时间，不采用客户端时间。原账号日预算、输入/输出、槽位、源重试三次上限均未放宽；无新迁移。

首次六项通过（其余30未选），之后实际把三类费用预留的 UTC day 改为前一日以检查跨计费桶仍不重置次数，产品文件完整36项通过/31.95s；这只是合成历史费用桶，不冒充实际跨日续采。最后服务端时间调整后，产品36与本地共享预算5共41项通过/105.87s（`2026-10-07-evaluation-checkpoint-request-limit-final-related.log`）。真实PostgreSQL memory-replay三项通过/10.13s，原九次实际回环HTTP完成后，重新构造 budget/checkpoint 服务，第十次准入明确被 evaluation_request_budget_exceeded 拒绝，费用行仍为9；CLI零HTTP、原非bypass RLS/撤销检查保留。最终报告 `postgres-concurrency/8fd2f88e-8ca0-4b96-8904-f3f3e42f7898/result.json` 已读 scope=selected、passed=true、cleanedUp=true，不能代替全套；服务端时间调整前的8e93b5b8报告保留为历史。最终 services 类型、六文件lint、新 build（含node/web/main/preload/renderer）exit0，日志分别为 request-limit-types/lint/build。Zod Rollup 注释警告保留。

新构建基础桌面与完整学习组合最终exit0（request-limit-desktop/learning-desktop.log）。基础07a979de-82ac-4162-8aa3-0cf91c1329d5已读passed/networkAttempts=0/foregroundBridgeBlocked=true；学习管理43b06ae8-5df4-4821-ad6b-df296bee1cb7的13项全部passed，实际双进程恢复7d75ed5b-b452-4ddd-a334-60c1219a98e0、企业发布71e3bcd8-afef-4aed-81b2-7b04627a7059六场景和自动迭代934a7d08-d4e2-40b8-9058-b5e719940ef6六阶段的报告均已读通过。最后V2截图已视觉核对当前/最新/生效V2与“验证后自动生效”；定时器确实触发、没有手动复盘/验证触发。仍为合成客户/模型/模拟标签，businessEffectVerified=false。预期校准/遗忘/关闭后读取拒绝继续打印，不隐藏为无错误运行。

最后另跑企业预算11项与企业维护31项，两文件42项通过/57.85s（`2026-10-07-evaluation-checkpoint-request-limit-enterprise-budget.log`），确认原短租约、源失败退避/三次上限、共享日额度、迟到匿名结算/遗忘、真实模型契约及维护限制仍成立。这组与前述41项为不同文件，不拼成完整回归。以上本任务检查进程均已终态。

**这仍不是跨日/重启续采。** CLI尚无resume；新collect创建不同run，不能借新run重付已完成组并称为恢复。同一冻结批次重新认领、预算等待、模糊收费/未完成组处理和原尝试计数仍须完成。完整前台私有证据/实际呈现/三组绑定、真实独立样本及最终独立审查仍缺；此前完整回归6超时/22未执行未重跑、未销账。原八项目标 ACTIVE。

## 2026-10-07 企业冻结记录与逐组耐久保存增量

原任务 8 的续采基础已落地，但跨日/重启恢复入口尚未完成。新增迁移 `037-learning-evaluation-checkpoints.sql`（共享仓库的 036 已被其他恢复维护使用），以及 `EnterpriseEvaluationCheckpoint`。在首次 HTTP 前，同一授权账号事务保存实际 scope、输入/来源/发布/模型/方法/历史/部署冻结依据、随机组顺序、assignmentId 与原 maxRequests。保存事务重新核对全部案例的当前版本；每组先标为运行中，完成后把原始回执与实际 learning_attempts UUID 耐久提交，再进入下一组。导出回调拿副本，故障或篡改不能丢失或改写已保存组。basis_hash 是一致性核对，不是防伪认证。

完成回执核对实际相同 run 的调用、token 测量、配置/记忆清单及唯一费用引用。未知用量保留 null，USD 仍须独立计费凭据。依据 JSON 限 32 MiB，整批持久证据按数据库 JSON 实际字节限制 64 MiB；首次保存和追加回执均检查，超限回滚/停止，不能以本地字符串长度低估数据库 JSON 大小。运行中的模糊组保持 running/incomplete，不虚构已完成。CLI 仍只有 collect，没有 resume；重新启动 collect 仍会创建新运行，不能将现在的保存能力说成已保证跨日不重复付费。

两个新表从学习案例/生成上下文/校准/激活凭据中隔离。正文 SELECT/INSERT/UPDATE 只给 worker；应用角色仅能读清理所需 tenant/account/run/expiry 元数据并删除。RLS 同时核对租户、账号 GUC 和实际 session_user 的有效 worker 绑定，伪造 GUC 不得读取另一账号。撤销凭据后 worker 即使持有数据库登录也不能再读正文。遗忘账号任一范围会删除该账号冻结批次及组正文，取消相关运行/在途账本状态并释放后台槽；保留期按实际来源、范围和方法最早到期约束，不因评估复制而延长源保留期。过期清理同步取消对应运行；已收费/未知上限和迟到用量继续保留，不删除费用。

先运行四个实际存储红测，全部因缺持久表/保存行为而失败（`2026-10-07-evaluation-checkpoint-red.log`）；初版四个同项通过。相关四文件 85 项通过，94.89s（`2026-10-07-evaluation-checkpoint-related.log`）。补进行中遗忘/过期取消及导出副本后产品文件 32 项通过，67.66s；最后补冻结事务的遗忘窗口检查，9 项目标边界通过/24 项未选择（`2026-10-07-evaluation-checkpoint-final-boundaries.log`）。这是带筛选的专项，不把未选择项算成通过。首次 services 类型检查因测试行 unknown 退出 2，记录保留；当前行已修正，最终 types/services 与七文件 lint exit0（`2026-10-07-evaluation-checkpoint-bounds-types.log`、`2026-10-07-evaluation-checkpoint-bounds-lint.log`）。新 build exit0（`2026-10-07-evaluation-checkpoint-build.log`），含 node/web/main/preload/renderer；Zod Rollup 注释警告仍保留。

真实 PostgreSQL 全套七文件 69 项通过，53.02s，报告 `postgres-concurrency/d31415c0-3768-4dad-913a-41fec4c604d3/result.json` 已读 scope=full、passed=true、cleanedUp=true，含实际多池锁、非 bypass worker、新表 RLS、9 次实际回环 HTTP、CLI 及跨进程导入。新增的 3 个 memory-replay 检查读取已保存冻结/回执，验证伪造 GUC、应用角色正文拒绝和凭据轮换；其余共享测试不归为本功能新增。最后数据库 JSON 字节限额补正后，实际该文件 3 项复核通过（`2026-10-07-evaluation-checkpoint-postgres-bounds-final.log`），报告 `b9d0655b-1eb9-492e-abda-2b58159f0614` 已读 scope=selected、passed=true、cleanedUp=true；该报告不冒充全套。

当前构建基础桌面 c2c77983-acf2-432f-8450-d1729902c626 通过（networkAttempts=0）；学习管理13项 13b98b3b-e7ab-4365-9332-b12bd3f707ba 和实际双进程恢复 617ad2a5-d5f5-4674-a4b2-ea7b778b2ec2 的结果已读取通过。组合在企业发布失败后停止，未执行迭代；首次86bc5398报告无步骤、截图停在首次加载，原因未证实。增加不含私有正文的步骤/允许列表错误码诊断后，659457a6明确在准备草稿时拒绝 private_backup_permissions_invalid：报告根目录已有夹具/账本文件，私有写入器不能把它当空目录保护。仅把测试草稿移到新 private-publication 子目录，保留实际 Windows ACL 校验和原时限；独立发布 a04a2afe-2402-4fce-b0b2-1ffe6f7ef680 六场景、迭代 3d24e0a8-d0a3-4300-95ca-0277abc001c3 六阶段通过，结果已读（businessEffectVerified=false）。夹具定向lint通过，未将最初未知故障解释为已确定的权限故障。没有在本轮再跑完整 Vitest；此前 6 项超时/22 未执行的完整失败仍保留，不能用 85 项专项或 PostgreSQL 通过替代。仍缺预算等待/跨 UTC 日及重启恢复、原逻辑调用/尝试计数的续采、完整前台私有证据/实际呈现/三组关联、真实独立标签与最终独立审查。用户本轮再次确认原四个业务门槛。完整八项范围保持不变，目标 ACTIVE；没有 commit/push/deploy、真实付费模型调用或客户消息发送。

## 2026-10-07 回归隔离与实际权限检查修复增量

上一轮不是通过证明；下方 14 项失败保留为历史。本轮继续修复而非无修改重跑：前台单元测试改用受控时钟推进生产代码中的界面稳定等待，实际 PNG 编码/读取、像素变化、输入注入、回声和取消断言均保留。每个案例重置一次性 mock 队列，追踪未结束操作，并在清理时取消本例控制器、等待操作结束、恢复实际时钟与全局变量。5 秒测试时限和生产等待均未改变，也未以该合成时钟证明业务时延。11 项通过，记录 `2026-10-07-native-clock-isolation.log`。

Windows 私有目录检查此前每次启动一个 PowerShell。现在 `WindowsPrivatePermissionWorker` 复用短暂解释器，每个调用依然执行相同的真实根目录及子文件 ACL、所有者和权限检查；不缓存允许结果。路径只以 stdin JSON 行传递，脚本固定，隐藏窗口、不经过 shell、不打印路径/错误内容。每次随机请求 ID 严格匹配；排队和执行共用原 15 秒上限，最多 64 个在途，输出 4 KiB 上限，空闲 1 秒关闭。单个实际权限拒绝只拒绝该项；回执错配、协议损坏、超时或解释器故障拒绝未完成项，不能将上一目录的允许用于下一目录。显式 close 后不能重开。

真实 Windows 权限检查 5 项通过（`2026-10-07-private-permission-actual-isolated.log`），含 current-owner Modify 不申请 WRITE_OWNER、实际保护和继承、未保护目录拒绝、Unicode/引号/类 shell 字符作字面路径，以及先核验成功、再实际扩大 ACL 后必须拒绝。协议 8 项覆盖队列/回执/崩溃/超时/容量/关闭与空闲退出；它们是合成协议测试，不代替上述 OS 权限测试。首次四文件运行 `2026-10-07-private-permission-worker-green.log` 实际退出 1、22 通过/3 失败（含首次权限准备超时及备份清理 EPERM），名称 green 不代表成功，失败保留。

源码稳定后的六文件组合 `2026-10-07-permission-isolation-related.log` 全部 44 项通过，38.06s，包含原实际 SQLite 管理日志/HTTP 恢复、联合备份、实际私有目录、助手协议及前台驱动。没有改测试时限、模拟权限验证或移除断言。最终 services 类型及五文件 ESLint 均退出 0，记录 `2026-10-07-permission-isolation-types-final.log`、`2026-10-07-permission-isolation-lint-final.log`。

该源码快照的完整回归 `2026-10-07-permission-isolation-full.log` 已结束，exit1，160 文件中 153 通过/7 失败，1588 项中 1560 通过/6 失败/22 未执行，1033.72s。六项均为原 5000ms 超时：learning-evaluation 两项、restore-permit-audit 与 restore-pause-authority 各一项（均保留 1001 条实际 SQL 数据）、实际私有文件 ACL 扩大检查一项、memory-replay 的多进程链一项。learning-enterprise-routes 13 项与 restore-review 9 项因原 beforeAll 20000ms 超时未执行。没有本轮并行构建或其他测试；不能断言只由机器负载导致。此前前台结构失败未在此运行重现，不能将此运行说成全套成功。

随后只调整两项 CLI 集成测试的组织。learning-evaluation 将一个测试中的四次或三次实际子进程调用拆为独立用例，每次仍真实运行命令并核对 0/2/1、JSON/Markdown、目录拒绝及不泄漏内容。memory-replay 将实际 CLI/回环 HTTP 的私有生产者夹具放在原默认时限的 beforeAll，各次导入分别为一个原 5s 用例；保留独立 CLI→CLI 与 Vitest→tsx 的实际文件及部署指纹、空标签不导出、实际 6 次 HTTP 请求、正文/凭据不泄漏和缺失费用拒绝。清理前验证绝对目标属于私有测试目录，并关闭本例 HTTP 连接。未提高测试或产品时限，未以进程内 mock 替代命令。

独立评估文件 18 项通过（`2026-10-07-evaluation-single-process.log`）；两文件最终组合 30 项全部通过，10.98s（`2026-10-07-memory-cli-isolation-related.log`）。最终 services 类型检查和两文件 ESLint exit0，分别为 `2026-10-07-memory-cli-isolation-types.log` 与 `2026-10-07-memory-cli-isolation-lint.log`。首次清理边界校验在 finally 显式 throw 导致 lint 一项失败，已把校验移到 try 前，失败记录保留；不以首次 lint 冒充通过。未在组织调整后再次跑完整回归，不能凭 30 项通过销掉其余完整检查失败。

当前生产源码的新 build exit0（`2026-10-07-permission-isolation-current-build.log`），包含 node/web 类型及 main/preload/renderer。保留 Zod Rollup 注释警告。基础实际 Electron exit0，报告 `desktop-smoke/a1398f57-721e-4794-884d-10b5fa62d032/result.json` 已读取 passed=true、networkAttempts=0；配额不足的小窗口截图已查看，文本及操作区域没有可见水平溢出。不以旧构建替代本次。

学习桌面组合 `2026-10-07-permission-isolation-current-learning-desktop.log` exit0。以下实际结果均已读取通过：学习管理 `70f6d74c-7c64-48ce-bbf7-af2359904583`（13 个场景）；实际双进程提交恢复 `abef4708-019c-4c31-9ebc-d66c44afcf5d`；企业发布 `1c4d7d0c-fa3d-43bd-9fc2-ce5c6519bcc7`（6 场景，实际 HTTP/单连接 embedded PostgreSQL，不冒充真正多连接并发）；自动迭代 `22bed67e-fc5d-4161-bf1c-4f9fa6f722ee`（自动计时触发，V1→V2→恢复，24 次合成调用计费记录）。管理设置截图与 automatic-v2.png 已查看；V2 最新/生效版本、来源及双栏内容可读，画面中无可见水平溢出。业务改善均未验证，报告仍为 synthetic，人工标签声明来自工程夹具。错误注入日志中的拒绝是对应场景测试内容，不代表真实客户操作。

当前场景 `2026-10-07-permission-isolation-current-scenarios.log` exit0，3 文件/3 项、43.92s。容量 `capacity/732fed67-4c36-4a58-955b-284e656785f6/result.json` 已读取；它是实际 Agent/Scheduler/Sender/SQLite 上的合成负载，不是真实客户 p95 或业务人工效果。两份测试组织调整后没有生产代码变更；本次不无修改地再跑完整套件，也没有将专项、桌面或容量通过替代完整失败状态。

当前仍缺企业可信 checkpoint/跨日续采、私有前台证据导出/实际呈现确认/三组绑定、真实独立人工标签和最终独立审查。原任务 8 的执行补充保留这些要求；四项门槛、日预算、调用/尝试限额、并发和发送权限均不放宽。原八项目标 ACTIVE，本轮没有提交/推送/部署、付费模型调用或真实消息发送。

## 2026-10-07 异步监听修复后验证状态（此前运行）

最新完整复跑 `2026-10-07-timing-sink-serial-full.log` 已结束，退出 1：157 文件中 152 通过、5 失败；1558 项中 1544 通过、14 失败，无跳过，716.11s。本轮未同时运行构建或其他测试。失败为 admin-gateway 1、admin-pause-journal 2、joint-backup 1、enterprise product-validation 1，以及 foreground-wechat-driver 9。共 8 个超时（7 个原 5000ms、合并保护为原 15000ms）和 6 个前台响应结构/异常断言失败；不能将全部失败只记为超时，也不能宣称移除并行构建即可通过。

随后各自独立复现：前台联系人歧义 1 项在原限额内通过（`2026-10-07-timing-sink-native-isolated.log`，2.83s）；企业合并事务保护 1 项通过（`2026-10-07-timing-sink-merge-isolated.log`，10.51s）。前台 beforeEach 只 clear mock，旧未消费的 mockResolvedValueOnce 及超时后未结束的异步工作存在串扰可能，需要补真实隔离/清理的复现，当前尚未确证全部六个结构失败的成因；单项通过也不能替代全套。没有更改测试时限、跳过测试或为了绿灯删除断言。本轮检查进程全部终态，不继续无修改地反复跑全套。

本轮新增的异步诊断失败保护有独立 Node 事件循环红/绿证据，45 项相关检查、类型、lint、构建通过；但完整回归当前未通过，整体工程不能宣布验收完成。先复现并修复上述检查问题，同时继续任务 8 的可信续采与完整前台证据；最终独立审查和真实业务标签仍待完成。原八项目标保持 ACTIVE，没有 commit/push/deploy、真实付费模型请求或消息发送。

services 类型检查、12 个相关文件 lint 和 build（含 node/web/main/preload/renderer）通过，分别为 `2026-10-07-timing-async-sink-types.log`、`2026-10-07-timing-sink-final-lint.log`、`2026-10-07-timing-sink-final-build.log`。构建保留已有 Zod Rollup 注释警告，没有关闭检查。

首次完整回归 `2026-10-07-timing-sink-final-full.log` 退出 1：157 文件中 152 通过、5 失败；1558 项中 1530 通过、4 超时、24 因套件失败未执行，687.45s。企业 product-validation beforeAll 触及原 20000ms，admin-gateway / memory-replay / platform-probe-files / foreground-wechat-driver 各一项触及原 5000ms。此运行与构建、lint 同时启动，尚不能仅凭同时运行断定失败原因。日志完整保留，不能记为全部通过，不更改默认测试时限或跳过这些测试。数量含共享工作区新增文件，不全部属于本次实现；先独立复测五个文件，再在本轮没有并行构建的情况下重跑全套。

五文件独立诊断 `2026-10-07-timing-sink-timeout-diagnosis.log` 退出 1，53 项中 51 通过、2 超时，148.91s：企业 product-validation 24 项、memory-replay 8 项和 platform-probe-files 3 项通过；admin-gateway 的实际私有 SQLite 恢复仍超时，foreground-wechat-driver 本次另一条像素变更测试超时。没有改时限、模拟私有权限或删除断言；不能说移除并行构建已解决全部问题。随后全套复跑，最终结果见本节最上方。

## 2026-10-07 部署核验与前台计时接线增量

以下覆盖此前记录中的两处部署指纹缺口。新增 `evals/memory/deployment.ts`，本地和企业共同按部署文件内容计算版本。本地采集及 adjudicate 重新核对当前策略、检索实现；企业清单补入 baseline 实际使用的 `src/core/ai-client.ts`。缺文件、运行期间变更或导入时变更均拒绝，旧 Function.toString 包需要重新采集。指纹不是防伪认证，也不能验证人工声明的真实性。

红测 `2026-10-07-memory-version-completeness-red.log` 四个目标断言失败，修复后的专项通过。实际回环 HTTP 与独立 tsx CLI 证明跨进程采集/导入一致；自洽地重写 packet、配置及全部回执也不能绕过当前部署检查。真实 PostgreSQL 六文件 63 项通过，报告 `postgres-concurrency/b1677765-60a0-486a-aa0f-63a8babb3757/result.json` 已读取 passed=true、cleanedUp=true。版本、前台、设置和 worker 撤销五种取消场景覆盖新增 baseline 变化；未知费用仍保留上限，失败不输出完整 packet，也不写任务/激活/发送许可。

生产 ReliableAgent、ConversationCollector 和 DesktopAgentRuntime 增加可信主机计时监听点：实际 source.read 开始与提交、来源消息、生成开始/准备/完成/失败、候选可用、旧任务和自动发送结果。默认单调时钟来自同一主进程，runtimeInstanceId 隔离重启；观察消息的客户时间不作采集起点。监听点只提供诊断副本，不包含正文或改变发送权限。计时接线及 runtime 连接均有因缺少事件而失败的红测，修复后检查实际提交与任务关联。

独立 Node 进程红测 `2026-10-07-timing-async-sink-real-node-valid-red.log` 实际记录 4 次未处理 Promise 拒绝。修复后同步和异步监听器故障均被隔离且不等待；真实事件循环同时验证采集提交一次、候选一次、发送零、未处理异常零。三文件 45 项通过（`2026-10-07-timing-async-sink-green.log`），services 类型检查通过。最初顶层 await 的 CJS 夹具错误以及 fake-timer 下未复现的运行不是有效产品红测，保留日志但不作为修复依据。

以下为当时的历史状态：当时尚无私有计时采集器/导出，默认 IPC 也未开启记录。私有采集、默认启动和历史生命周期现已实现，详见本文末尾最新增量；真实 React 呈现后的主机确认及同一服务端冻结三组的前台对照仍缺。因此不能独立证明新增 p95 ≤500ms，现有两个采集命令仍分别为 knowledge_preview / enterprise_pipeline。500ms 终点的可选澄清仍未收到回复，不将工作台或发送终点说成已获确认。客户正文、模型输出或 renderer 自报时钟不能替代主机锚点，日志失败不能被算成完整测量。

此前源码稳定的完整回归 `2026-10-07-deployment-and-timing-full.log` 154 文件 1524 项通过（413.55s），构建、服务类型和 11 文件 lint 通过。场景三项、基础桌面及学习桌面组合通过；容量 `f6bb70d0-55e7-46a0-8aeb-fcce555b1a29`、基础桌面 `939a2a39-91a4-4ea5-b333-f0324b92416c`、学习管理 `31d3da68-f908-47da-8f41-0368c79c07f2`、恢复 `5a5285e7-177e-4de6-83c9-e0d7463511be`、企业发布 `ddbc07ee-59d2-4a49-bb01-8e961fa2f03d`、自动迭代 `2f7f6bbf-848d-4181-9af0-6527a4888a0b` 的结果均已读取。最新桌面图片本轮未重新查看；报告保持 synthetic，businessEffectVerified=false。这些完整检查发生在异步监听修复之前；修复后的完整回归和构建另行记录，不混为同一次。

真实回环 HTTP 500 故障探针 `memory-failed-call-b8eca13d-e8ac-4179-ab84-77628c77bda3/result.json` 已读取通过：请求一次、status=incomplete、费用未知、完整 packet 缺失。生产知识生成本来会向上传递模型异常，本轮没有修改已经正确的收费行为。全仓库 lint 最新完整快照仍为 162 errors / 11135 warnings（`2026-10-07-deployment-and-timing-global-lint.json`），不能称全仓库通过。真实业务标签、完整前台观察和最终独立审查仍缺，原八项目标 ACTIVE。

新增可执行性审查项：`EnterpriseMemoryReplay.collect` 当前须一次完成全体三组才返回 packet；CLI 逐组日志只保留用量引用，没有可恢复的冻结内容和回复 checkpoint。共享 `EnterpriseLearningValidationBudget.reserve` 触及每日额度即拒绝，运行结束为 failed/incomplete。因此若真实样本跨日才可完成，当前没有继续已完成组的入口；重新运行会重付之前组，不能据 200 条合成低 token 测试声称真实 200 条可在默认 50000 日额度下完成。真实费用和 token 分布尚未知，不猜测需要多少天。后续须增加服务端可信冻结绑定、逐组耐久 checkpoint、跨 UTC 日/重启续采和旧配置拒绝，保留失败及未知收费，避免重付已完成组；仍共用原预算与并发，不能提高额度或拼接不同冻结版本冒充同一批次。这项与完整前台证据一同属于原任务 8，尚未实现。

## 2026-10-07 当前八项范围核对（以下为此前快照）

以下是实施者对源码和证据的核对表，不代替计划要求的最终独立审查。全套工程通过也不代表真实业务效果达到四项门槛。

| 原任务 | 当前实现与可复核入口 | 验收依据及保留限制 |
| --- | --- | --- |
| 1 作用域、快照、保留期和迁移 | `learning-store.ts` 的范围继承、contextVersion、tombstone、保留期和旧卡归属；`learning-retention.ts` | foundation/store/retention 测试核对隔离、正文及索引删除、跨重启和旧来源拒绝。企业身份仍必须来自可信账号绑定。 |
| 2 案例和真实反馈 | 持久 episode assembler、feedback、生产任务引用和纠正提交 | feedback/submission 测试区分草稿、发送、采纳和处理结果；幂等纠正及故障恢复由实际 SQLite/HTTP/桌面验证。工程模拟员工不是业务真人标注。 |
| 3 复盘、费用和前台优先 | reviewer/jobs/scheduler/transport；本地和企业 shutdown/drain | runtime/transport/jobs 检查迟到响应、前台抢占、未知费用上限、UTC 跨日和恢复；取消不能解释为免费。 |
| 4 验证及 V1/V2/回滚 | 产品校准、风险检查、精确版本 grant、企业重新发布约束 | iteration/product-validation、真实 PostgreSQL 和实际 Electron 自动迭代；5 个校准案例中的 human 声明均为工程模拟，真实准入仍须独立标签。 |
| 5 整理和长期运行 | curator、maintenance、retention；模型合并默认关闭 | curator/maintenance 检查 7 天间隔、2 小时空闲、固定/人工项保护、事务失败回滚、版本冲突和跨重启。 |
| 6 企业实际生成 | worker authority、生产 generation context/publication、共享预算及 034 评估迁移 | 专用非 bypass 登录、真实 PostgreSQL 锁/并发、实际回环 HTTP、生成引用及发布失效；隔离工程数据库不构成正式业务发布。 |
| 7 工作记忆产品入口 | MemoryWindow、可信 IPC/preload、企业 adapter、持久提交 | 最新实际 Electron 的管理、双进程恢复、企业发布及自动迭代场景。当前补正删除回调的语言依赖，避免切换语言后沿用旧提示。 |
| 8 三组对照和验收 | memory:replay / memory:replay:enterprise / memory:adjudicate / memory:evaluate | 真实标签、盲评原始记录、USD 费用凭据、完整前台时延及最终独立审查仍待完成。局部采集不能判整体通过；全仓库 lint 也尚未通过。 |

本轮新增三个检查：私有 JSON 导出采用与导入相同的 64 MiB UTF-8 上限；来源加留出总量超过 100000 时在调用前拒绝；企业采集期间重新核对部署文件版本。版本变化红测 `2026-10-07-memory-deployment-freeze-red.log` 真实失败（旧运行仍继续），修复后与前台/设置/撤销四场景通过。私有文件红测 `2026-10-07-memory-private-artifacts-red.log` 三项失败，修复后三项通过。相关五文件 48 项通过（`2026-10-07-memory-review-related.log`），服务类型检查和九文件 ESLint 退出 0；MemoryWindow 保留 848 项格式警告，没有批量改格式或关闭规则。

本轮构建 `2026-10-07-memory-review-build.log` 退出 0，含 node/web 和 Electron 三端，Zod Rollup 注释警告保留。真实 PostgreSQL 六文件 63 项、64.49s 通过；报告 `.local/reports/postgres-concurrency/046a0176-0907-4bf0-b17d-7713b0b065fd/result.json` 已读取 passed=true、cleanedUp=true。学习桌面组合通过：13 场景 `f871bf90-260f-4245-a7a4-f29d5150f811`、双进程恢复 `a0c33dc2-1376-44b9-99f5-c6dfa41645a1`、企业发布 `f8fd2ad2-9395-4710-903f-be4b810f112c`、自动迭代 `77b73947-6aa5-4334-b82d-96654bf0ee8d`，四报告已读取，V2 截图已查看。

最新全仓库 lint `2026-10-07-memory-review-global-lint.json` 退出 1，162 errors / 11135 warnings，是当前共享工作区快照。最终完整回归 `2026-10-07-memory-review-full.log` 退出 0，153 文件 1497 项、412.15s；计数含其他开发的共享修改，不全部属于学习功能。场景 `2026-10-07-memory-review-scenarios.log` 退出 0，3 项、35.02s，容量报告 `9c0535f5-f7a4-4819-92f4-a3bc999c378e` 已读取 passed=true；基础桌面 `2026-10-07-memory-review-desktop.log` 退出 0，报告 `f5072d85-aea5-452b-9fd0-482b8df2b84d` 已读取 passed=true、networkAttempts=0。所有本轮工具进程均已终态。

前台时延起止点已向用户提出澄清，未取得回复前不把某个终点当作已确认。源码核查发现 `ReliableAgent.schedule` 内才创建 task.createdAt，不能用它代替采集起点；onCandidate 在界面显示及发送之前，也不能作未经确认的完整终点。后续应以可信采集开始、排队、生成、工作台实际呈现和可选发送确认的独立记录绑定同一来源/任务，保留取消和失败样本，不能修改局部 packet 的计时范围冒充完整观察。

继续审查项：企业部署指纹清单尚未包含 baseline 使用的 `src/core/ai-client.ts` 静态卡片渲染函数；本地 adjudicate 目前核对 packet 自声明的策略/检索字符串与配置哈希，没有重新核对当前部署实现。两处均需补齐并有跨进程及版本变化测试，不能把本轮已覆盖的检索文件变化扩大成全部传递依赖都已验证。最终独立审查、全仓库质量和真实业务证据仍未完成，目标 ACTIVE。以下旧运行保留为历史，不冒充本轮最终结果。

2026-10-07 最新企业采集增量：新增 `memory:replay:enterprise`，使用真实生效企业发布、相同生产方法/历史案例选择、实际 Jev 判断/文本生成/审核，随机三组顺序。留出采集没有学习案例、准备记录、任务、激活许可或发送许可写入；034 迁移将评估费用纳入共享后台槽和账号预算。来源只可属于 learn，完整会话不可跨 split；环境变化、前台抢占和账号撤销停止采集，未知费用保留上限估计。回执记录实际全部阶段的调用 UUID 和 token，USD 仍需独立计费凭据。企业与本地 packet 共用 `memory:adjudicate`，缺标签/用量/费用不能导出合格数据。跨进程验证发现运行函数文本受编译器影响，已改用部署文件内容指纹；源码缺失或版本不同拒绝导入。

新增前台计时范围保护：`knowledge_preview` 与 `enterprise_pipeline` 只能报告局部时延，不能让整体四门槛显示通过；未标计时范围也是 insufficient。完整前台时延必须为 `foreground_end_to_end`，并为三组每项提供私密 `latencyEvidenceRef`。原始观察必须由独立验收人员核对，不能将局部管线时延改名。企业采集覆盖鉴权、检索、Jev/生成/审核及用量核对，未覆盖客户端排队、截图、RPA 或发送。真实独立人工标签和完整前台观察仍未获得，不能宣称业务效果通过。输入、命令及证据准备见 `evals/memory/README.md`。

2026-10-07 本轮最终工程检查（共享仓库总数，不能全部归属于学习功能）：完整回归 `.local/reports/2026-10-07-enterprise-replay-full-final.log` 退出 0，150 文件 1469 项、396.21s。首次完整运行期间合同有变更，旧缓存拒绝新增 latencyScope/latencyEvidenceRef，9 项失败已保留在 `2026-10-07-enterprise-replay-full.log`；未用该失败运行冒充最终证据，源码稳定后重跑全套通过。来源/取消五项、确定性转人工及三组两项分别有专项记录；最后三文件 22 项 `2026-10-07-memory-latency-scope-final.log` 退出 0。14 文件 ESLint 与 services 类型检查退出 0，日志 `2026-10-07-enterprise-replay-lint.log`、`2026-10-07-enterprise-replay-services.log`。`2026-10-07-enterprise-replay-build.log` 退出 0，含 node/web/main/preload/renderer；保留 Zod Rollup 注释警告。

真实 PostgreSQL 最终专项：`.local/reports/postgres-concurrency/ae75a270-7460-4cff-911a-04fda2eb6046/result.json` 已读取 passed=true、cleanedUp=true，6 文件 63 项、66.07s，日志 `2026-10-07-enterprise-replay-postgres-final.log`。新增专用 worker 登录、实际回环 HTTP 三组九次调用、精确费用引用、跨进程 CLI 标签导入和确定性零调用 CLI 均通过；工程 origin=synthetic，最终评估 insufficient，没有真实人工准入或真实模型收费。迁移均重复执行验证，不放宽原有额度或发送权限。

场景 `2026-10-07-enterprise-replay-scenarios.log` 退出 0，3 文件 3 项、48.21s；容量报告 `.local/reports/capacity/d304baa3-608e-493a-bae1-6f8ef7f517ac/result.json` 已读取 passed=true。基础桌面 `2026-10-07-enterprise-replay-desktop.log` 退出 0，报告 `.local/reports/desktop-smoke/3c02c0c5-29a6-48b1-a66a-eab3ab575dd8/result.json` 已读取 passed=true。学习桌面组合 `2026-10-07-enterprise-replay-learning-desktop.log` 退出 0：13 场景 `8af5e085-77c8-4532-a912-01b01935bb21`、两进程恢复 `50d983c9-905d-4ae7-821e-027674bb0bf2`、企业发布 6 场景 `956dde1e-ac4e-46ac-8002-b8c8ff12c14a`、自动迭代 6 阶段 `0fa6fec3-677e-42aa-a6e5-d4ef11c9c8df`。四报告全部读取通过；最新 automatic-v2.png/outdated.png 已实际查看，分别显示生效 V2 和企业方法变化需要重新发布。全部是隔离工程证据。

最新全仓库 lint `2026-10-07-enterprise-replay-global-lint.log` 退出 1，165 errors / 11235 warnings；不关闭规则、不批量忽略或冒充全仓库通过。完整目标仍 ACTIVE：真实独立人工业务标签与完整前台观察、全仓库质量问题和原八任务的最终全范围独立审查仍未完成。未提交、推送、部署、调用真实收费模型或发送业务消息。

本轮原 Task 8 审查发现并修正两个实质缺口：原工具只有两组，且错误地用全部案例作为修改率分母。新 version=2 合同要求无记忆/静态记忆/学习记忆三组、各组实际人工评审状态、询价/投诉/转人工/多诉求类别、冻结策略与检索版本以及后台费用。修改率按各组已评审草稿计算，覆盖率仍保留全部案例；20% 边界改用不同分母的整数交叉比例，防止拒答或未评审减少分母后被误计改善。总体和类别均报告会话 bootstrap 区间；缺类别或证据不足不能通过。旧 v1 可读取，但只能为 insufficient。CLI 保留具名参数并增加原计划的位置参数，未通过/不足统一退出 2。

此前新增 `memory:replay` / `memory:adjudicate`：使用实际 KnowledgeReplyService、隔离 SQLite、实际 HTTP 模型传输和生产记忆渲染，串行随机组别顺序，保存冻结清单、实际加载引用、用量待核对记录与匿名盲评任务。留出资料不接入 LearningService、案例写入、复盘或发送；每组没有实际标签、token 或费用凭据时不得导出合格数据。三组回放的实际回环 HTTP 集成验证已通过；其使用合成模型/标签，最终仍判 insufficient。该命令仍只覆盖知识试答；企业新增命令及前台限制见上方最新说明。

上一轮检查：完整回归 `.local/reports/2026-10-07-memory-replay-full.log` 退出 0，144 文件 1428 项通过、356.20s；这是整个共享仓库的计数，不全部归属于本功能。随后对最后的缺证据处理及学习组计时范围调整再跑三文件 21 项，`.local/reports/2026-10-07-memory-v2-replay-timing-final.log` 退出 0、12.69s。十文件 ESLint 退出 0（`2026-10-07-memory-replay-final-lint.log`），最终 services 退出 0（`2026-10-07-memory-replay-evidence-final-services.log`），node/web 分别退出 0（`2026-10-07-memory-replay-node.log`、`2026-10-07-memory-replay-web.log`），均位于 `.local/reports/`。之前的全仓库 lint 164 项错误保持独立登记，本轮没有批量修改其他功能或关闭规则；构建/真实 PG/桌面的上一轮证据在下方按时间保留，没有冒充本轮重新运行。执行格式与资料要求见 `evals/memory/README.md`。此为上一轮的完整目标 ACTIVE 快照；企业三组新增采集及最新限制和检查见本文顶部，真实独立业务验收与全部范围最终审查仍待完成。

2026-10-07 新增本地实际自动迭代证据：真实 Electron 后台定时器与 HTTP、磁盘 SQLite、产品回复服务完整经过纠正、提炼 V1、缺校准不激活、校准后下一条回复引用 V1、修订 V2 待审时继续引用 V1、校准后引用 V2、回滚新增 V3 后恢复旧方法。未手动触发复盘或验证。报告 `.local/reports/learning-iteration/d9d4c7a1-2594-4787-b16d-a14065675549/result.json` 已读取通过，截图已检查。该证据使用明确标记的合成模型与模拟人工声明，不证明业务四门槛通过。

企业自动迭代也已由真实 PostgreSQL 独立登录与实际 HTTP 验证：六阶段完整经过 V1、V2、重新发布与回滚，引用为 1/1/2/3；旧发布明确拒绝 `CONFIGURATION_CHANGED`，64 次后台调用全部记录 reported，未产生发送许可。最终真实 PG 专项 `.local/reports/postgres-concurrency/939b156a-3e76-4a29-aa3e-529a0a23c810/result.json` 已读取 `passed=true`、`cleanedUp=true`，5 文件 56 项通过（整个共享专项计数）。业务准入只使用明确标记的隔离工程种子；没有真实独立业务批准。

桌面组合命令 `test:learning:desktop` 已通过原 13 场景、两次实际进程重启、企业发布 6 场景与自动迭代 6 阶段。最新自动迭代截图发现隐藏窗口偶尔返回旧画面，随后改为离屏渲染、检查实际 V2 DOM 并等待新的 compositor paint；独立重跑 `.local/reports/learning-iteration/266f89c6-ba1d-449c-bab7-4054cd5abae0/result.json` 通过，`automatic-v2.png` 已视觉检查为实际 V2。修正只涉及测试夹具。

本轮最终检查：新增八文件 lint、三文件 16 项本地集成测试、node/web/services 类型检查、构建、3 项场景和基础桌面均通过。最新完整套件为 141 文件 1410 项，退出 0、392.66s，日志 `.local/reports/2026-10-07-learning-automatic-iteration-full.log`；这是共享仓库计数，不全部属于学习功能。

最新构建的学习桌面组合也全部通过：本地 13 场景 `6bc74a42-0b75-4d78-82a5-943b8f932eba`、两进程恢复 `76a73aad-8b1d-4fd2-ab45-52f8be856ab4`、企业发布 6 场景 `a681221b-635b-494d-91f5-ae53e16f0203`、自动迭代 6 阶段 `56c1d838-119f-4bc0-9e14-4fbf07b492cb`；报告分别位于 `.local/reports/learning-smoke`、`learning-restart`、`learning-publication`、`learning-iteration` 下。四报告均读取 `passed=true`；最后两个截图已实际查看，分别显示需重新发布和当前生效 V2。

最新全仓库 lint 退出 1：164 项错误、11132 项警告，日志 `.local/reports/2026-10-07-learning-automatic-iteration-lint.log`。没有关闭规则或批量忽略报错，不能宣称全仓库质量检查全部通过。完整目标仍在执行；真实业务效果缺独立人工标注样本，模拟工程证据不能替代。

## 2026-10-05 验收范围历史快照

保留原 `docs/superpowers/plans/2026-10-03-hermes-learning-completion.md` 全部八项任务与设计默认值；补充执行顺序和当前接口见 `2026-10-04-hermes-learning-readonly-execution-plan.md`。历史文档的“尚未实现”描述不能替代当前源码检查。

| 要求 | 已有证据 | 尚需完成或验证 |
| --- | --- | --- |
| 范围、快照、版本与来源 | 本地/企业作用域合同、实际生成采集、任务绑定事件及版本核验；当前设备主机 resolver 与企业 adapter 已接入主进程 | 窗口合法范围选项、详情迟到保护及最终端到端 |
| 真实员工纠正与处理结果 | 实际 HTTP 客户端与 runtime/outbox；有效客户保留期持久化、遗忘 hook 已接入企业 IPC；窗口 episode 由服务器精确追溯实际任务，另一授权设备及真实 PG 幂等专项 | 窗口纠正的稳定重试与持久恢复、结果/质量按钮；提交成功后刷新失败的实际 UI 证明 |
| 问题结束 | 企业 024：独立片段 30 分钟关闭为 unknown；人工反馈优先检索；原始来源不改写 | 完整 UI 演示；没有可信问题绑定时保持独立片段，不启用模型猜测合并 |
| 复盘、自我修订与预算 | 既有持久队列、读取后修订、前台抢占与共用费用专项 | 模型进行中撤销调用设备、停机后迟到回包的最终桥接验证 |
| 验证、生效、回滚与正式发布 | 已有本地/企业真实回复管线成对回放、持久凭据和企业发布绑定 | 客户端管理/发布入口及实际操作闭环；不能把存储激活当正式发布 |
| 检索、整理、合并与遗忘 | 既有维护、替代来源、保留期和隔离专项；本地/企业验证、整理、校准读写、搜索和报告已公开为严格具名 IPC/preload 操作 | 完整界面控制与实际按钮操作；管理搜索与回复检索保持分别 20/3 条上限 |
| 工作记忆产品入口 | 企业权威 adapter、同一注册客户端与主机路由已接入；本地人工教导证据/候选原子保存、稳定来源冲突和回滚专项；遗忘取消待处理管理读取、阻止期间新请求 | 完整校准/报告/模型选择界面、界面跨范围迟到保护；人工教导与窗口纠正的跨 renderer 重启持久重试 |
| 真实桌面验收 | 其他功能已有 Electron smoke 基础 | 学习专用 `test:learning:desktop`、同次运行截图与机器报告，实际 UI 操作链路 |
| 独立效果评估 | 原始评估要求与合成工程样例 | `memory:evaluate` 合同/CLI/指标、独立人工标注集和盲评报告；缺真实标签应报 insufficient |
| 最终交付 | 持续记录实际命令、失败和修复 | 当前完整回归、构建/类型检查、桌面与情景检查、最终全范围独立审查 |

## 本轮实际检查

下面是各次运行对应时点的证据，不将先前绿色结果外推到后来发生变化的源码。

| 运行 | 命令范围 | 实际结果 |
| --- | --- | --- |
| 81007 | 反馈客户端/HTTP/工作台/outbox、注册、ledger/backup/inventory 八文件 | 168 项通过，退出 0，30.13s |
| ec854a | `typecheck:services`，新关闭功能之前 | 退出 0 |
| 5901 | `build`，含 node/web 检查与反馈 UI | 退出 0；依赖 Zod 的 Rollup 注释警告保留 |
| abbeea | 新企业空闲关闭八用例，实现前 | 八项失败，缺关闭行为及出处表 |
| 60318f | 企业空闲关闭首次实现 | 八项通过，退出 0 |
| ab768e | 迟到人工纠正与最后写入取消 | 一项失败、一项通过、八项未选；发现过时 unknown 案例重复检索 |
| 215e0a | 关闭/维护/实际生成/事件/生产验证五文件 | 117 项通过，退出 0，81.71s |
| 7db3ba | 22 个相关文件 lint | 退出 0 |
| 37c40a → 050a02 | 新关闭接口类型检查及修复 | 首次两个错误，修复后退出 0 |
| 34165 | 隔离真实 PostgreSQL 全专项 | 40 项通过，退出 0；独立池并发关闭、普通角色拒绝、异账号空结果 |
| a8139c | 关闭实现、用例及 PG 专项 lint | 退出 0 |
| 13036 | 完整共享工作区 `test` | 111 文件、1082 项；1022 通过、60 失败，退出 1，275.09s |
| 68660 | 修复后的 execution/generation/closure 三文件 | 71 项通过，退出 0，31.18s |
| ffcb38 | 两个修复后的测试文件格式/lint | 退出 0 |
| bb13f8 | 最新共享工作区 `typecheck:services` | 退出 1；同期恢复清单模块及新增用例尚有类型/接口缺口，不能报当前全绿 |

真实 PG 报告：`.local/reports/postgres-concurrency/beb92451-e17a-42cd-9d49-4c7a4183e5e0/result.json`，已读取 `passed=true`、`cleanedUp=true`、`testsPassed=40`。只使用合成数据与隔离非特权数据库登录，不证明真实业务改善。

完整回归 13036 的两个根因已核验：执行测试使用只到 015 的历史部分 schema，当前学习检索需要 023/024；生成测试清理未覆盖共享工作区新迁移 025 的外键。修复隔离测试 schema 和 CASCADE 清理，未移除生产外键、RLS 或原断言。随后 bb13f8 读取到其他恢复模块新测试仍缺接口；这些新变化不能由 68660 的证据证明完成。

## 完成判定

2026-10-05 后续实施新增证据：

| 运行 | 命令范围 | 实际结果 |
| --- | --- | --- |
| 8e14e6 | 管理基础、反馈客户端与注册三文件 | 38 项通过；修复新测试重用已消费 Response 的问题 |
| ba5f8e → 8b8f4c | 非空实际 HTTP 管理与真实遗忘确认 | 客户端原本要求 null，实际服务端返回 `{ forgotten: true }`；修正严格合同后二文件 27 项通过 |
| 5f98f4 → 421a92 | 十个新增具名管理方法及真实 HTTP | 首次 32 项缺方法失败；四文件 82 项通过，包含实际教导幂等、版本详情、搜索、校准和队列取消 |
| 8df986 → a08b4d | 企业有效保留期与持久同步 | 首次四项真实策略失败；接线及明确目标路由的响应丢失夹具修正后，四文件 110 项通过 |
| ca4f23 → b81e8f | 服务端先确认遗忘、本地匹配账号清理和取消 | 首次三项缺行为失败；七文件 186 项通过，包括实际 HTTP/runtime 遗忘与服务端拒绝旧任务复活 |
| de5cb5 → b85997 | 合法大方法返回及凭据响应限额 | 旧 64KiB 限额误拒绝合法方法；管理动作/教导采用既有 2MiB 上限，注册限额不变，二文件 60 项通过 |
| 48035c / 7ac0e0 / aa97c3 | 显示误删、离线清理、切换设备后旧同步重启 | 分别看到失败后修复：显示只读；离线按上次可信策略清理；取消遗忘不重启旧同步 |
| 191891 | 当前管理/事件/policy/outbox/runtime/注册/ledger/backup/inventory/恢复 IPC 十二文件 | 251 项通过，退出 0，42.48s；不是整个仓库全量检查 |
| d12fa6 | 管理与遗忘实现后的 `typecheck:services` | 退出 0；最后显示/离线/提示修改后的检查另行记录 |
| 1bd14c | 十个相关文件 lint | 退出 0；最后修订后的检查另行记录 |
| 7a9f67 | 最后显示/离线/取消/提示修订后的 `typecheck:services` | 退出 0 |
| 6e20e9 | 当前 `build`，含 node/web 类型检查和 Electron 三端构建 | 退出 0；Zod 的 Rollup 注释警告仍存在 |
| 01bc53 | 最终十一个相关文件 lint，含工作台提示修正 | 退出 0 |

策略存入已有 runtime_metadata 的整数行，键为账号设备和会话摘要；不新增数据库结构，不改变 schema 12 或旧版 11 恢复兼容。工作台显示不删除待同步正文；同步成功读取当前有效保留期后清理；网络失联时按上次可信策略清理，完全未知的范围只采用允许的最长 365 天上限并停止重放。保留期仍以实际原始任务时间计算，重试不能延期。

`DesktopAgentRuntime.forgetLearningScope` 已具备服务端确认、匹配本地旧设备正文清理和取消等待。原工作记忆 IPC 仍只绑定本地服务，因此这一 hook 尚未完成产品入口接线。管理客户端的 validate/curate 合同专项不证明模型进行中撤销或整个窗口验收。工作台提交后刷新失败提示已修正，真实 Electron 交互证明留待学习 smoke。

每项要求必须有当前源码、实际命令或同次运行报告证明。局部通过、历史总数、模型自评和经验条数均不作整个目标完成依据。真实效果评估与工程验收分开报告；当前缺独立真实人工标签，不能宣称修改率下降或业务目标达成。

超时关闭、管理客户端与同步策略均只是阶段性工程交付。上述未完成项仍属于完整目标，目标保持 active。

## 2026-10-05 桌面服务接线增量

本轮已将当前注册身份的企业 adapter 接到主进程、私有 IPC 和 preload；企业身份校验失败不回退本地。新增校准读取/导入、验证、整理、历史搜索与报告具名操作。管理搜索最大 20 条，生成检索仍最大 3 条；关闭记忆读取不妨碍授权用户检索历史资料。本地人工教导将不可变来源案例与候选放在同一事务，重试相同来源复用，改变完整方法内容则冲突，写失败回滚正文和索引。

窗口反馈新增三个 episode 管理操作，由服务器对保存的生产任务作精确来源 SHA256 绑定，复用原有实际草稿校验与反馈事务。支持同账号另一授权设备和纠正派生案例；跨账号、跨客户、伪造任务引用、保存草稿变更、撤销、遗忘后提交均拒绝。普通人工教导案例不能冒充生产任务。窗口反馈的跨重启持久重试仍需补齐。

| 运行 | 范围 | 实际结果 |
| --- | --- | --- |
| 8096e0 → a20c5c | IPC 原子教导、具名操作和主机 resolver | 初次三项缺行为失败；8 项通过 |
| aa85f3 → 88c7e3 → 92c6c1 | 服务端窗口反馈、桌面具名客户端 | 新路由最初 404；服务通过后客户端缺方法红测，随后完成 |
| 0fd7eb → 8aeabf | 当前设备企业 adapter、取消、迟到响应 | 初次三项缺方法；三个文件24项通过 |
| 30467e → 07566a | 遗忘取消管理读取、期间新请求拒绝 | 观察到真实缺口；四文件32项通过 |
| d49df5 → 3c406e | 服务类型检查 | 新夹具 unknown 行访问错误后修正，通过 |
| a65036 | 当前共享工作区完整 test | 115 文件1178项通过，300.78s；最后返回类型注解及等价会话选择修改前 |
| 656c4d → d69afa | 十六文件 lint | 18 个明确错误修正后退出0 |
| 68ce1e | build（node/web、main/preload/renderer） | 退出0；依赖 Zod 的 Rollup 注释警告保留 |
| a6920b | 最终修改后八文件相关回归 | 188项通过，23.49s |
| 953c9b | 真实 PostgreSQL 全专项 | 41项通过，20.17s；独立池并发窗口反馈幂等与隔离 |
| 0f7ca4 | 最终 services 检查 | 退出0 |

PG 报告 `.local/reports/postgres-concurrency/9a9a586a-f66c-4284-8255-9417743f4f24/result.json` 已核对 passed/cleanedUp 为 true、testsPassed 为41。pg 查询重叠提示仍存在。以上检查均已终止，没有留存待观察进程。完整界面、专用 Electron 演示、正式发布接线、模型进行中权限撤销验证、独立效果评估和最终审查仍在原验收范围内，尚未完成。

## 2026-10-05 窗口控制与真实 Electron 操作增量

企业范围选项现在只采用当前账号的完整授权范围，本地范围继续提供三个平台；使用规范化身份去重，并保留当前范围原始选中值。窗口移除了详情定时回调，快照/详情/变更按范围 epoch 与各自请求序号判断归属，切换范围、卸载和失败读取清除旧资料。详情还核验当前方法修订，不能把旧详情挂到新版本。校准初次读取完成前编辑区不可输入，避免返回资料覆盖输入；相同范围刷新保持对象引用，避免每次轮询重置编辑区。

新增校准读取/导入、候选验证、整理预览/执行、验证与整理报告、历史搜索、明确采纳/质量分类/处理结果以及有确认勾选的范围遗忘入口。人工教导案例不呈现生产反馈按钮。纠正和反馈在组件内复用同一意图来源，作用域卸载后不调用旧 onSaved；跨 renderer/主进程重启持久提交仍未实现。review 返回 null 时明确显示未排队，不再声称已入队。已确认教导遇到列表刷新失败保留保存提示。

新增并注册 `test:learning:desktop`，启动实际构建的 Electron、React、preload、可信 IPC、学习服务和存储；不替换 window.learningMemory、不直接写数据库。延迟详情及刷新失败通过在真实已执行的 IPC handler 外层施加传输延迟/故障，报告明确标记触发方式。知识库试答使用实际 AIClient 和回环合成模型，生成 unknown 案例后通过界面完成纠正、明确采纳和结果确认；没有执行真实发送。桌面 harness 使用隔离 userData 和软件渲染，生产 GPU 设置不变。

| 运行 | 范围 | 实际结果 |
| --- | --- | --- |
| 9a3768 | 新范围/请求归属六用例 | 六项失败：旧选项混入伪/外部范围、JSON 顺序不稳定、缺响应归属保护 |
| d7e53b → db2bd4 | 首次 Electron 尝试 | UnknownVizError 后超时退出1，没有功能通过证据；修复 harness 捕获失败报告及隔离软件渲染 |
| 5e4be8 | 原窗口真实 Electron | 退出1，明确缺校准/验证控制 |
| f2ca01 | scope/IPC 两文件 | 14项通过 |
| 717ca5 → 884440 | 窗口实现后 build | node/web 和三端构建通过；后续增量另记 |
| c0d81e、d82ef9 | 校准真实操作 | 暴露初次读取覆盖与未标注夹具拒绝；没有弱化服务端标签检查 |
| 12c9f7 → a8f843 | 完整校准操作 | 资料已保存；验证因 off 返回 learning_disabled，退出1；调整用例经 UI 开启 suggest |
| 2f45b5 → 2c4e0a | 六场景桌面 | 退出0；管理按钮实际操作 |
| 7dd576 → fd0748 | 九场景桌面 | 退出0；新增真实详情迟到拒绝、保存后刷新失败及遗忘旧提交拒绝 |
| cbc8ad → 3f8a60 | 已注册 test:learning:desktop | 退出0；十场景，新增实际知识库生成后的纠正/采纳/结果 UI；modelRequests=1 |
| b2336e → f27b3c | 九文件相关回归 | 71项通过，27.93s；最终 scope 去重修正前 |
| 99f66e → 8dd088 | build | node/web 和三端构建退出0；最终 scope 去重修正前 |
| 54d998 → 977977 | services 类型检查 | 退出0；最终 scope 去重修正前 |
| 64fa01 | 同范围字段顺序导致选中值失配 | 新用例失败，六项已通过；修复去重保留当前值 |
| 4870d5 → c61187 | 最终九文件相关回归 | 72项通过，24.93s |
| f5cee3 | 最终十文件 lint | 退出0，无该次 lint 警告 |
| 3f541c → 7f6deb | 最终窗口源码 build | node/web 和三端构建退出0；Zod 注释警告仍存在 |
| 2e9b3f → b4291d | 最新共享 services 检查 | 退出1；恢复模块新增测试需要尚未存在的 Ledger.applyRestoreDecision，未用空实现绕过 |
| 3560ae → 3a0d9f | 恢复模块源码实际更新后 services 复核 | 读取到09:39:36新增真实方法及更新测试，再运行退出0；保留其他作者修改 |
| 468962 → af6406 | 最终构建后的 test:learning:desktop | 十场景通过、退出0，实际生成模型请求1次 |

十场景报告 `.local/reports/learning-smoke/62a3e777-41b8-4a48-ab6e-834fd954da2e/result.json` 已读取 passed=true、十项 passed、modelRequests=1，并有同次 learning-window/compact/feedback PNG。该次运行在最终 scope 去重修正前；最终构建后的桌面复测另记。fixture 的 humanLabelled=true 只模拟导入协议，报告标记 synthetic-fixture-simulated-labels；一条案例验证不足、不生效，不属于真实人工标签或业务效果证据。

最终窗口源码报告 `.local/reports/learning-smoke/eddde037-7ceb-46ae-8ead-55bc911c658a/result.json` 已核对 passed=true、十场景全部 passed、modelRequests=1；已实际查看同次 learning-feedback.png，另有 learning-window.png 和 learning-compact.png。报告仍明确 management-window-only/no-real-business-labels/enterprise-publication-and-learning-loop-pending。负向校准、故意刷新失败及遗忘后重试在终端打印预期 IPC 拒绝，不将它们隐藏为无错误运行。所有本任务工具句柄均已终止；本轮未运行新的全仓库、情景或真实 PG 专项。

仍需：窗口跨重启持久提交、模型目录/配置控制、完整人工方法编辑与来源操作、企业正式发布接线及实际企业窗口演示、模型进行中撤销/停机证明、纠正→候选→验证生效→实际新回复→V2→回滚的完整桌面闭环、独立评估 CLI/真实标签、最终全量/情景/PG/桌面与独立审查。十场景通过不代表 Task6/7 或整个目标完成。

## 2026-10-06 设置、完整方法及持久提交基础

当前源码已有具名模型目录、实际配置保存、完整方法字段/修订及按案例 ID 打开授权来源。构建609459/47727/c46df2退出0；随后真实 Electron dc3adb/15054/f994b4退出0，共12场景。报告 `.local/reports/learning-smoke/ef2c9594-4c5c-49d1-92e3-82325990a4ad/result.json` 已读取 passed=true、modelRequests=1、人工修订/回滚 currentRevision=3、activeRevision=3；同次截图已查看。人工激活合成方法不能代替自动学习、独立验证或企业正式发布。

新增 learning-submissions 合同及 Ledger.learningSubmissions 私有传输日志：真实 SQLite 重启恢复同一来源/完整内容，重复响应不续期，修改正文同 ID 拒绝，保存确认清正文，账号/客户/设备 authority 分离，遗忘覆盖旧设备并阻止未入队的迟到意图，保留策略持久化，篡改请求拒绝。账本升13，真实11/12备份仍可恢复迁移；当前13备份包括待提交日志，恢复隔离围栏保留。

RED06165b：12个新行为因不存在日志而失败。2ea475/85729/6d8c49：新提交及库存测试通过，旧备份/outbox四项版本预期失效、一个现有 CLI 冷启动超时（5.337s）。仅更新合法版本/未来版本及增补12清单与13数据库不一致拒绝，不增加超时。5fa79e/97663/a0a552：四文件62项通过，17.67s。首次services发现Zod动态数组丢失判别联合元组类型；改显式四分支元组后76725e退出0，未使用any或忽略类型错误。相关13文件最终lint e8febb退出0、无该次lint警告。全仓库当前检查524eb9/97090正在进行；新持久化后的build和desktop复测仍待运行。

这批日志目前尚未接入窗口的提交/同步路径，不能宣称断网窗口已完成验收。剩余仍包括实际具名提交及状态入口、主机权限/来源时间恢复与取消、企业正式发布/企业桌面、模型进行中撤销与停机、完整自动V1/V2/回滚生成闭环、评估工具/真实业务标签及最终全范围检查和独立审查。完整目标保持ACTIVE。

2026-10-06 提交与同步接线：复用现有 schema13 日志，增加原始来源时间的可信主机缓存、准确单条收据、固定错误状态和无授权过期清理；四种窗口提交接通独立具名 preload/IPC、当前同一注册客户端及本地学习存储。遗忘取消在途提交并清日志/缓存，重启沿用原来源；恢复复核阻止重放，同时保持授权管理读取可用。七文件63项专项及services/18文件lint通过（99e187/fbf03b/f15df2）；同步修改恢复测试查询类型标注，不改断言或权限。
当前build92597/bd825f通过含node/web及三端；实际Electron13场景34690/e1c771通过，报告.local/reports/learning-smoke/c12f3287-7bd8-410b-ad5f-ccc1d4985a8e/result.json，新增窗口重载后收据保留及新具名提交遗忘拒绝。真实两个Electron进程77301/ff18ec通过，报告.local/reports/learning-restart/819ac187-d80b-4dda-9655-ac87f798f960：第一次UI教导在实际SQLite写锁下为pending，正常关闭；第二次启动自动变saved，同一sourceId/原始时间/一份案例和方法，进程PID14572与5596不同。该场景是合成本地存储故障恢复，不证明自动学习或业务改善。真实企业HTTP丢响应及磁盘host重启专项通过，使用实际应用/认证/权威存储和AgentRegistration，嵌入PG不能替代最终真实PG并发。
已注册test:learning:restart，test:learning:desktop串行包含管理场景和进程重启场景。格式及脚本lint通过；组合命令仍待最终运行。当前全量测试正在运行，log.local/reports/2026-10-06-learning-submission-integrated-full.log，必须等待终态再记录全套结论。完整原八项范围仍保留：模型在途撤销/停止证明、正式企业发布用户路径、自动候选/校准/新回复/V2/回滚完整桌面闭环、独立效果CLI与真实人工资料、最终当前检查和全范围独立审查。目标ACTIVE，未宣称整体完成。


2026-10-06 独立评估与后台关闭增量：用户确认的四项门槛已固定为修改率相对下降≥20%、学习组严重错误0、覆盖率下降≤5个百分点、新增p95≤500ms。新增 memory:evaluate、严格数据合同、成对指标/费用与会话bootstrap、JSON/中文Markdown报告和匿名数据指南；13项专项验证合成/模型标签、会话与来源重叠、冻结时序、缺失成对结果、基线零、准确p95及四种退出状态。实际合成CLI退出2，报告 .local/reports/memory-evaluation/synthetic-20261006-confirmed-gates，结论资料不足；不存在真实人工业务验收通过证据。
后台新增 shutdown 排空：本地提炼/验证/整理、企业提炼/校准/合并及管理请求取消后，等待原请求、迟到费用和权限查询回调，再关闭数据库。真实回环HTTP挂起/设备撤销证明无候选提交；非配合测试请求需释放后 shutdown 才完成。最新11文件117项、相关lint、services和build均通过。最新构建实际桌面8151/817696通过13场景与两进程恢复，报告 .local/reports/learning-smoke/778b9b46-4109-4cad-9972-43a471598b7a 和 .local/reports/learning-restart/077a238e-ea12-4a17-9a96-86b66f45bb21。
此前完整24378/cda9ae通过129文件1295项（这些新改动之前）。当前92196正在完整回归，日志 .local/reports/2026-10-06-learning-evaluation-shutdown-full.log，必须等待终态。原完整目标保持ACTIVE：正式企业发布准备及用户路径、自动候选/校准/实际新回复/V2/回滚桌面和企业场景、真实人工效果样本、最终scenarios/真实PG/全范围审查仍待完成。未提交/推送/部署或发送实际业务消息。


2026-10-07 验证终态补充：92196/c452af/821339已终态0，132文件1333项完整测试通过，283.25s；8151/817696桌面组合已终态0，13场景及两个实际进程重启通过。92484/a2c3ab/ee41fb场景3项通过；49435/9523ad/d0a117真实PostgreSQL16通过42项，报告.local/reports/postgres-concurrency/215ef978-9717-4a36-aeab-52bed4fb9129/result.json已读取passed=true、cleanedUp=true，保留既有pg查询重叠弃用提示。4e5975最新services通过。
完整lint23240/07bf06/f24a0e失败168errors、11203warnings，分布旧UI/RPA/脚本及学习基础，不能写成全仓库lint通过。随后修复学习范围4项：accountMemoryScope对Zod新解析对象删除conversationId而不声明无用解构变量；episodeExcerpt补完整返回类型；学习存储测试两处复用真实accountMemoryScope，不改断言。467f84/89121/93a02d三文件format/lint0并六文件71tests通过；18a5ad services0。第二次完整lint26395/b61b10/db1d59仍失败164errors、11181warnings，未放宽规则或忽略报错。这三文件修订晚于132/1333、build/desktop/realPG证据；最终全目标验收必须在后续产品修改后刷新相应检查。没有任何本任务活跃工具进程；不得把旧live记录再次启动。
原八任务完整目标保持ACTIVE。继续正式企业发布准备/独立管理员准入及窗口状态、实际自动提炼与新回复V1/V2/回滚闭环、校准资料显式synthetic/model/human来源保护、真实独立人工业务数据及最终全范围审查/检查。源码复核当前校准合同只有humanLabelled/humanConfirmed；不能把模拟声明当作真实业务标注。已询问业务数据本地路径，用户尚未回复；工程仍可继续，不以此提前标blocked或complete。不要仅重复本轮已通过的提交/关闭基础，不要缩减为单一评估任务。未commit/push/deploy/真实消息发送。


2026-10-07 企业发布与校准来源增量（持续原八任务目标）：
用户再次明确接受四项业务验收门槛：实质修改率相对下降至少20%、学习组严重错误0、覆盖率下降不超过5个百分点、学习组p95减基线组p95不超过500ms。门槛不代表已获得真实业务效果证据。
新增管理员 prepare-learning 操作：独立数据库登录、授权账号锁下读取当前实际可用方法目录；创建新configVersion，绑定memoryCorpusVersion及精确方法revision/contentHash；移除模板旧evaluationApprovalId。仅审计有界元数据，不写发布指针、恢复账号或授予发送权限。准备后目录变化会使旧草案发布遭TASK_CONFLICT；自动模板仍须现有独立freeze-evaluation/approve-evaluation/publish准入。
执行准备（在项目根目录，已配置独立ADMIN_DATABASE_URL及TEXT_MODEL_BASE_URL/TEXT_MODEL_ID/TEXT_MODEL_EXPECTED_ID）：
& '.\scripts\dev-tools.ps1' -NpmArgs @('run','admin','--','prepare-learning','--tenant','TENANT','--account','ACCOUNT','--file','.local/template.json','--out','.local/publications/FRESH-NAME.json')
终端只返回版本/数量/哈希摘要。输出必须为新私有文件，拒绝覆盖、公有路径、目录链接逃逸和大于1MiB的草案。普通设备及应用登录无法调用管理员准备。
企业窗口现在通过现有严格snapshot路由显示全账号目录与正式配置的未发布/当前/需重新发布/资料不完整状态、暂停状态和可提供给管理员的版本信息。设备客户端额外核对发布元数据的tenant/account；状态不构成发送许可。准备不会使窗口提前显示已发布。
校准案例新增labelOrigin，humanLabelled=true和humanConfirmed=true仍不足以把synthetic/model/未声明来源的案例升格。导入拒绝非human，验证在模型调用前返回insufficient；数据哈希、批准政策版本及本地主机校准实现版本绑定新的独立人工来源规则。旧批准不能自动激活；合格的新人工声明替换数据后可继续验证。测试中的human来源是明确注释的模拟人工声明，只用于工程回归；不能据此宣称业务效果或真实标注真实性。
新增 test:learning:publication，并纳入test:learning:desktop：实际Electron窗口/preload/可信IPC/同一设备注册/持久提交/真实HTTP/嵌入PostgreSQL及独立管理员准备发布，验证V2后旧草案拒绝与重新发布显示。报告明确synthetic-engineering-fixture、businessEffectVerified=false、automaticSendingEnabled=false。
原目标仍ACTIVE；尚需原计划实际自动复盘提炼→独立校准→下一条真实生成回复V1/V2/回滚的桌面与企业完整闭环、真实业务人工样本效果验收、全范围最终审查。已有全仓库lint164项历史错误尚未全部修复，不能宣称全仓库lint通过。没有提交、推送、部署或真实业务消息发送。

2026-10-07 本轮验证终态（本轮全部工具进程均已结束）：
Task4准备后端RED d44169四个missing-method；GREEN b6f76329tests。严格CLI/私有writer RED863bab（缺out及helper）；02004a发现Windows文件symlink需权限，改为实际硬链接拒绝覆盖及实际junction逃逸验证，不跳过；53a15c三个文件42tests通过。真实发布状态fixture先修正实际应用登录与完整合成来源payload；最终RED006ec3暴露status缺失；dcbc63/875e13暴露客户端接受外账号publication；scope身份校验后dd7c3f/64713/ad40f6四文件103tests通过。
来源保护RED a44656/b1dfdf三项；新增synthetic/model/未声明来源限制、版本绑定及旧grant拒绝。23630c/24378/620ddd三文件24tests通过；8f9bd7/79113/86463a十二文件131tests通过（在数据hash版本升级前后另做相关检查）；f18c8f/12255/6428e5三文件32tests含自动校准恢复通过。模拟human声明逐一注释，未转化为真实业务证据。
75546/53d61e services0；最终99006/270e31 services0。build29800/6360070；窗口样式和截图绘制等待后最终build16016/976a32 0（node/web/main/preload/renderer，保留已知Zod Rollup提示）。9e78d3/24153相关36文件eslint0；b3ec7f四个末次修改文件eslint0。
独立桌面首轮4712280六场景报告9654690b-a2dd-4485-97b5-df40224b8e5a；DOM验证通过，但outdated截图仍是前一帧，随后增加双requestAnimationFrame再截图并复核实际图片。最终桌面组合72ca99/51488/681dcc0：13场景.local/reports/learning-smoke/f1269788-34df-44e3-becf-ee4dfa3eda4a、两个真实Electron进程恢复.local/reports/learning-restart/0f302b40-a06d-4c99-a24d-ad70e2a944b3、六企业发布场景.local/reports/learning-publication/1846c4d9-635f-4d46-81c5-dc9064b9c6c2；三个result已读取passed=true，最后outdated.png已查看确实显示需要重新准备发布。组合已纳入test:learning:desktop；所有报告明确模拟工程证据，不是业务效果通过。
完整最新套件7aa24d/79309/02ff3d exit0：137files1383tests，436.74s；整个共享仓库计数，不全部属于学习功能。实际PostgreSQL16 03324d/55361/383abb0：3files45tests；.local/reports/postgres-concurrency/5da2342e-a490-4429-82ba-8df5c1cbc95f/result.json读取passed=true、cleanedUp=true、testsPassed45；保留pg查询重叠弃用提示。场景186/85632/4450650：3files3tests、34.46s，容量报告.local/reports/capacity/164ef5e3-d4e2-4a6b-bd2d-45e754b552a3/result.json。
最新完整lint001c56/53839/d98bdc exit1：164errors11137warnings，日志.local/reports/2026-10-07-learning-publication-lint.log。没有使用忽略/关闭规则/批量fix掩盖；不得宣称全仓库lint通过。
当前原八任务完整目标仍ACTIVE，未完成/未暂停/未blocked。下一段推进实际自动纠正→复盘提炼→独立校准→真实生成回复V1/V2与回滚的Electron/企业闭环，及全范围最终审查。真实业务人工数据路径仍未提供；业务四门槛验收保持资料不足。没有commit/push/deploy/真实业务消息发送。

## 2026-10-07：恢复与可信主机计时增量（原八项任务继续）

用户再次确认实质修改率相对下降至少20%、学习组严重错误0、覆盖率下降不超过5个百分点、新增p95不超过500ms。真实独立人工业务样本和最终独立审查仍缺，确认门槛不代表已达标。

恢复证据重新读取核对：五文件85项通过，114.45s，日志 `.local/reports/2026-10-07-evaluation-resume-final-related.log`；真实PostgreSQL选定六项通过35.10s，报告 `.local/reports/postgres-concurrency/3c1342e6-68d4-47b3-af71-da19b5dc9a00/result.json` 的passed、cleanedUp均为true。覆盖同一冻结run、两个不同OS进程继续未完成组、已付费阶段复用、竞争认领、真实HTTP费用引用、CLI预算等待和重新导出。跨UTC桶是受控测试主机时钟，不能写成经过24小时；这六项不是完整PostgreSQL套件重跑。

本轮新增RuntimeTimingEvidence和PrivateRuntimeTimingJournal，运行器提供仅可信主机可用的configureTimingCapture、bindTimingEvaluation、exportTimingEvidence。必须在第一次运行操作前配置新空目录；每个运行器最多安装一次。真实collector的readId、runtimeInstanceId、sourceMessageId和实际SQLite序号关联生成阶段；未知或未经核验的来源不能升格。计时使用主进程单调时钟，不用客户observedAt、排队后task.createdAt或candidate_ready代替整个前台区间。

默认每会话上限64个待写记录、10000条记录、64MiB日志加报告，单条256KiB；状态另受1024次读取、8192个来源键、1000个任务限制。入队不等待磁盘，队列/字节/记录超限、写入或权限失败均保留不足原因，不生成成功证据。事件和报告不含消息正文；私有目录先设实际Windows DACL或POSIX0700，文件用wx拒绝覆盖，每次落盘复核路径权限；封存footer和报告flush到磁盘。没有把普通append完成冒充耐久封存。

运行器关闭必须先得到观察器和发送器停止确认，再封存日志；未确认停止、尚未关闭或已遗忘时不能导出。配置与关闭并发会删除废弃会话；启动等待配置期间的员工暂停保持有效。当前会话范围遗忘会退役采集器，等排空后只删除该会话的已知普通单链接文件及空目录，不递归删除、不跟随链接；陌生文件或硬链接导致失败并允许修复后重试。同一个运行器再次start不能重建已遗忘的采集器。此处是**当前托管会话**，不能宣称已覆盖历史导出和其他进程的全部证据遗忘。

红测：来源关联缺失1项（runtime-timing-sources-red）；生命周期缺接口3项（runtime-timing-lifecycle-red）。最终六文件150项通过24.18s，日志 `.local/reports/2026-10-07-runtime-timing-learning-related.log`，包含真实Node事件循环、实际私有文件、SQLite来源核验、关闭/遗忘/并发取消以及原学习提交/反馈/IPC回归。最终services类型、七文件eslint及node/web/main/preload/renderer构建退出0，日志分别为runtime-timing-lifecycle-services-final、runtime-timing-lifecycle-eslint-final、runtime-timing-lifecycle-build-final；已知Zod Rollup注释警告保留。

**未完成：**普通registerAgentIpc启动尚未默认配置采集；托管历史会话的总量、90天过期及跨进程范围遗忘尚需实现；工作台实际显示后的可信IPC确认尚无；当前reviewable端点始终不足。confirmed_sent仅使用实际confirmed及发送开始阶段，不凭候选或人为回执认定。冻结绑定目前来自可信主机元数据，尚未接入服务端独立三组完整前台采集/原始凭据导入；本轮没有实际Electron呈现或真实业务效果验收。

最新完整套件仍是 `.local/reports/2026-10-07-permission-isolation-full.log`：153文件通过、7文件失败；1560项通过、6项失败、22项未执行，1033.72s。后续专项通过不能覆盖未解决的完整套件失败。全仓库lint历史162errors/11135warnings仍未全部解决；本轮七文件lint通过不代表全仓库通过。原八项完整目标保持ACTIVE，未提交、推送、部署、调用真实收费模型或发送业务消息。

## 2026-10-07 托管私有采集、跨进程遗忘与实际默认桌面验证

Task 8 补充第4项继续推进，原八项完整目标仍为 ACTIVE。新增 PrivateRuntimeTimingVault：主机私有SQLite索引、至多128会话/合计256MiB（32MiB元数据预留）、每活跃会话完整64MiB预留、关闭后实际文件字节核对、90天保留及60秒清理重试。已授权范围遗忘在事务中保存撤销屏障，删除匹配历史会话并阻止更早写进程的新写入；存活的外国写进程返回writer_busy，不能提前报告遗忘成功。删除只处理已知普通单链接文件与空目录；陌生、硬链接或超限文件失败关闭。不相干账号/会话保留，异常退出不重建完整报告。

默认生产registerAgentIpc等待托管采集初始化后才开放运行IPC和加载首个窗口；正常退出等待真实停止、私有日志排空与报告封存。缓存报告在读取时复核实际索引/文件，另一主机遗忘或过期后不可继续导出。没有新增renderer记录权限、平台能力或发送权限，仍须单独安装已核验native adapter。

实际红测记录：runtime-timing-vault-red是模块缺失造成套件不能加载，不是六项断言失败；host-red两项明确缺configureManagedTimingCapture；首次真实Electron桌面运行bab63ce9-2621-4ff4-a423-d981e0c1acd5退出1，揭示默认初始化被早到的合法暂停废弃，最终report为passed=false/timing_capture_unverified，runner退出0不等于验收通过。改为生产main等待安装后，该竞态得到修复，原关闭/暂停/遗忘取消保护没有放宽。

最终相关8文件179项通过25.87s，日志.local/reports/2026-10-07-runtime-timing-vault-related-final.log；含三项实际独立OS子进程：已封存范围清理、真实process.exit(17)无footer恢复为不完整、活跃外国写进程在遗忘后拒绝新写。10项vault测试还包含实际文件增长超过配置上限的准入/读取拒绝。90天测试为受控主机时钟，不是实际经过90天；这些全部为工程合成资料，businessVerified=false。

当前services类型检查、15个相关文件lint通过；默认启动修复后services和agent-ipc lint再次通过，日志runtime-timing-vault-startup-services、startup-ipc-lint。构建初次发现renderer通过CollectionStatusSchema引入主机恢复核验的node:crypto；将原字段不变的纯状态schema移到collection-status.ts并保留原导出，未弱化恢复签名核验。最终startup-build退出0，含node/web/main/preload/renderer；原Zod Rollup注释警告保留。src/main/index.ts只增加await，未批量格式化或宣称其全部历史lint问题解决。

最新实际Electron 44.5.1/Node 24.21.0桌面运行3f7dabc8-a681-42aa-83c4-09a8272d529e，result.json已读取passed=true、networkAttempts=0、configuredByProductionMain=true、sealedAfterRuntimeShutdown=true；runner-result退出0、timedOut=false、elapsedMs=28729。日志.local/reports/2026-10-07-runtime-timing-vault-desktop-final.log。该烟测确认默认生产启动和退出封存，foregroundPresentationVerified=false、status=insufficient，不能用隐藏窗口或单元事件宣称实际前台500ms达标。

剩余范围没有缩减：第4项还缺同一服务端完整冻结三组的真实性关联；第5项还缺工作台实际显示后的nonce、可信IPC、当前行/版本/账号/可见性与主机单调终点；第6项还缺三组前台原始凭据/真实独立盲评及费用核对；原八项最终全范围独立审查和全仓库质量问题仍未完成。两类终点继续保留，不推断用户已选终点。用户确认四项门槛不变，尚无实际人工业务样本，业务验收仍证据不足。

旧完整permission-isolation-full仍为153文件通过/7文件失败、1560项通过/6项失败/22项未执行；旧全局lint162errors/11135warnings未全部解决，本轮专项不替代这些结果。未提交、推送、部署、执行真实收费模型或发送业务消息。所有本轮exec/cell/PTY均已终态，不重启历史句柄；目标不complete、不paused、不blocked。

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

当前完成状态和最新终态证据统一见[当前验证报告](E:/wechat-autoreply/auto-reply/docs/learning-memory-final-verification.md)。本文保留原计划及按时间记录的历史结果；历史失败、待执行和执行中描述不能代替最新结论。真实业务四门槛仍需独立真人样本及原始证据。
