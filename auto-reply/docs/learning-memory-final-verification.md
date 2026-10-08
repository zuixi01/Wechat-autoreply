# 工作记忆自学习：当前验证报告

日期：2026-10-07。本报告集中记录当前状态；既有失败及过程记录保留在原验收文档。

原八项目标的业务验收受阻：缺少真实样本、独立人工标签、费用及平台观察。工程修复和本轮必要检查已结束，真实业务四门槛尚不能判定达标。

## 工程能力与业务结论

| 范围 | 工程能力/证据 | 业务验收 |
| --- | --- | --- |
| 1 作用域、快照、保留期、迁移 | 已实现，隔离/清理/遗忘/重启及本轮完整工程回归通过 | 真实使用观察待提供 |
| 2 案例与真实反馈 | 持久聚合、幂等纠正、可信任务引用及工作台入口已实现 | 工程模拟员工不是真实人工数据 |
| 3 复盘、预算、前台优先 | 费用占额、抢占、迟到结算、恢复及配置变更审计已实现 | 不把取消或未知用量计为免费 |
| 4 校准、版本迭代、回滚 | 独立来源规则、验证凭据、V1/V2/回滚有工程证据 | 自动生效仍须真实独立标签 |
| 5 整理与维护 | 间隔/空闲/宽限、人工与固定项保护已实现 | 合成时钟不证明真实长期效果 |
| 6 企业生成与发布 | 服务端身份、发布目录、实际生成和持久三组任务已实现 | 测试库不是正式业务发布 |
| 7 工作记忆及员工教导 | 可信IPC、旧入口显式核对迁移及管理/恢复/发布/迭代桌面组合通过 | 工程模拟资料不是真实业务采纳 |
| 8 三组对照与完整验收 | 实际PG+Electron三组关联、独立CLI及本轮受影响检查通过；整仓历史失败与新版选测分别保留 | 真实效果仍资料不足；格式等警告保留 |

## 配置审计与旧入口补齐

本轮三路复核发现并修复两项原计划缺口：配置变更缺少审计，旧轨迹纠正及旧卡片入口仍走旧资料写入。另修复收据刷新失败后丢失已确认状态的问题。

- 本地学习设置升级至schema 16，实际配置变化与审计同事务提交；读取和同值更新不制造事件，遗忘清理对应范围审计。旧schema 15联合备份仍可验证、暂存和升级。
- 企业学习设置在原账号锁事务内写入既有audit_events，审计失败回滚配置与上下文版本。审计使用可信员工身份，仅存白名单变化及模型指纹。
- 模型目录、凭证、端点和文本/视觉默认模型使用稳定指纹审计；排除旧配置每次归一化生成的时间戳。跨settings文件与SQLite采用先持久化意图、再确认实际配置，重启可恢复未完成意图；实际值不匹配时拒绝成功返回。未声称两个存储具有原子回滚。
- 旧轨迹及旧卡片仅形成待核对教导，须明确选择主机提供的范围并确认，随后经持久提交保存候选；候选不自动生效，旧资料保留。
- 收据以严格普通对象跨IPC/preload/contextBridge传输。只有明确临时故障且主机已知授权未变时保留此前已保存记录；未知错误、非法响应或身份变化清空。此检查不表示每次查询都向服务端重新验证撤销状态。

统一services检查及Node/web/Electron构建已退出0。实际管理桌面16场景通过，包含上述旧入口、严格收据故障/恢复及真实配置审计落库；跨进程恢复PID2456→3796、pending→saved，企业发布6场景和定时学习6阶段均通过。组合日志：[当前桌面](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-desktop-checked.log)。管理[报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-smoke/7e8fbb41-0a5d-437d-85c4-eca764ebc682/result.json)及截图已亲读；本轮实际UI配置审计不等同于真实文件系统写失败的端到端验证，后者故障边界由专项测试模拟。

| 当前统一检查 | 终态及限制 | 精确证据 |
| --- | --- | --- |
| Node/web/Electron构建 | 退出0；依赖注释警告仍保留 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-build-final.log) |
| 最新services检查 | 退出0 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-services-terminal.log) |
| 最新全局lint | 646文件0错误/8188警告，退出0 | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-global-lint-terminal.json) |
| 完整unit/integration/regression | 192文件2058项，2056通过/2失败/0未执行；不能称整仓全绿 | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-full-tests.json) |
| 上述完整运行中的学习及相关文件 | 65文件608项均通过，包括模型审计、提交、备份与评估；这是2058中的子集，不能相加 | 同一完整JSON |
| 新增审计/旧UI/收据传输专项 | 5文件31项均通过，包含host审计8、本地7、企业7、旧UI3、传输6；同样属于完整运行子集 | 同一完整JSON |
| 新共享盲评封存文件单独复现 | 9项5通过/4个5000ms超时，退出1；原完整运行2个失败均再次复现 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-blind-seals-reproduction.log) |
| 当前完整真实PostgreSQL | 9文件87项通过，155.27s；passed=true/cleanedUp=true/scope=full | [报告](E:/wechat-autoreply/auto-reply/.local/reports/postgres-concurrency/6e6233ca-502c-41a1-a759-c17d007a9685/result.json)及[日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-postgres.log) |
| 最新共享文件选测 | 4文件46项通过/0失败/0未执行，65.04s；不是再次整仓回归 | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-shared-current.json)及[日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-shared-current.log) |

原完整运行2个失败位于jev-blind-packet-seals的幂等封存与不可改写测试。单独复现没有改断言、样本量或时限；源码中多次完整核验300个合成artifact是耗时相关线索，尚未profile确定热点。共享作者在完整运行后更新了该模块和CLI，单独复现使用较新源码，不能替代或修改原192文件结论；复现期间5个相关文件指纹稳定，[前](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-blind-seals-reproduction-source-before.json)/[后](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-blind-seals-reproduction-source-after.json)记录保留。本轮学习修改已冻结，共享工作区未整体冻结；期间新增的三个Jev测试另行记录，不冒充已纳入原完整运行。

共享作者随后拆分复合测试：真实首创建、幂等重试及fresh-instance核验分别计时；既有seal场景通过beforeEach真实SQL流程准备，无mock或缩减300artifact，原安全断言保留，it仍5000ms。新版封存13项、CLI6项、私密资料10项及评审分页17项均通过。18份相关源码前后无漂移，[前](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-shared-current-source-before.json)/[后](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-learning-final-audit-shared-current-source-after.json)已核对。没有再次跑192文件全量，不能把旧2056加新46宣称总通过数。最新静态检查和diff --check退出0。

首轮桌面失败保留：[报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-smoke/b714f815-0cb4-493b-9041-61d8e7361cbd/result.json)。新增旧卡夹具引入待整理卡片，旧断言将其混入当前方法数量；断言改为仅数带版本header的实际方法，仍要求2项，不增加时限。新增旧入口夹具同时修正原表单输入类型及带数量按钮选择器。

## 上一轮多智能体lint收尾复核

三路独占运行链路10文件、主进程2文件、界面及通知模块4文件；主代理负责模型调用、Python辅助脚本及统一验证。修复150条源码错误；另12条是TS返回类型规则误用于JavaScript，按[官方混合语言说明](https://typescript-eslint.io/rules/explicit-function-return-type/#configuring-in-a-mixed-jsts-codebase)限定语言范围。TypeScript返回类型、no-explicit-any、React Hooks/global/refresh规则仍为error，[实际配置](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-rule-scope.log)已亲读。没有扩大超时、重试、预算或关闭运行时保护。

| 检查 | 终态 | 精确证据 |
| --- | --- | --- |
| 全局lint | 退出0，630文件0错误/8202警告 | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-global.json) |
| services类型检查 | 退出0 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-services.log) |
| Node/web及Electron三端构建 | 退出0；依赖的既有Rollup注释警告保留 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-build-checked.log) |
| 全部unit/regression及四个受影响integration | 100文件1031项通过，0失败/0未执行，120.97s | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-affected-tests.json) |
| 实际基础桌面 | 退出0，passed=true，networkAttempts=0 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/desktop-smoke/3857cf28-7f88-4e04-be31-3b6702a19399/result.json) |
| 实际学习管理桌面 | 13场景通过，1次回环模型调用 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-smoke/2cdebc44-cfba-4c33-9fd2-edf533b19253/result.json) |
| 提交跨进程恢复 | PID26432→1152，pending→saved，1案例 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-restart/531e0569-60a6-4121-a38e-1cdd745dc3f0/result.json) |
| 企业发布桌面 | 6场景通过，automaticSendingEnabled=false | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-publication/f63f5a55-e12c-46e1-88fc-d07daf34f77e/result.json) |
| 自动学习迭代桌面 | 脚本6阶段通过，定时器真实触发，实际回复V1→V2→回滚 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-iteration/bd0d9928-3550-494a-b0c4-8a3b85deefc2/result.json) |

学习桌面组合[日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-learning-desktop.log)退出0，四报告及恢复prepare/recover已分别亲读。发布/迭代仍为synthetic-engineering-fixture、businessEffectVerified=false；模拟标签不替代真实独立人工样本。基础桌面的计时由production main配置并退出封存，但foregroundPresentationVerified/businessVerified=false、status=insufficient，不能混作三组业务时延证明。

首次构建[失败日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-build.log)退出2：provider config从any改为unknown后，trace model可能为对象；补真实字符串守卫，合法配置保留原优先级，非法值回退视觉模型。后续Node检查与完整构建退出0。旧settings入口的运行时schema校验并非本轮类型清理所解决，不宣称类型注解能校验不可信IPC数据。

统一验证前[676份源码指纹](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-source-before.json)与完成后的[核对结果](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-legacy-lint-source-after.json)亲读为0变化；diff --check退出0。1031是本轮受影响检查的独立结果，不与以下1935项完整旧快照或协同选测相加。数据库源码本轮未改动，沿用下方已通过的完整PostgreSQL记录，没有重复执行整套PG。

## 上一轮完整工程验证（保留记录）

| 检查 | 终态 | 精确证据 |
| --- | --- | --- |
| 前台桥及原日志专项 | 4文件21项通过，12.56s | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-foreground-bridge-final-local.log) |
| services类型检查 | 退出0 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-foreground-bridge-final-services.log) |
| 15文件定向lint | 退出0 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-foreground-bridge-final-lint.log) |
| 最终构建 | 退出0，含node/web及Electron三端 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-build.log) |
| 实际三组联合及CLI | 选定1文件12项通过，69.54s | [PG报告](E:/wechat-autoreply/auto-reply/.local/reports/postgres-concurrency/0b931594-0c41-4b1b-89a8-4d01ec169ff9/result.json) |
| 场景检查 | 3文件3项通过，47.58s | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-scenarios.log) |
| 实际基础桌面 | 退出0，主进程托管计时配置/退出封存通过 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/desktop-smoke/cc854c5b-4f40-49d5-a26b-2bc21c531f00/result.json) |
| 恢复完成时间夹具修正后 | 选定1文件8项通过，17.60s | [PG报告](E:/wechat-autoreply/auto-reply/.local/reports/postgres-concurrency/c2aaca7f-0358-4027-991c-11760fa03d33/result.json) |
| 完整PostgreSQL复核 | 8文件83项通过，130.87s，scope=full且已清理 | [PG报告](E:/wechat-autoreply/auto-reply/.local/reports/postgres-concurrency/841d7f4f-4239-4ea2-be60-9b0d4f81b4c0/result.json) |
| 学习管理桌面 | 13场景通过，真实窗口/IPC/本地生成 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-smoke/e4bdae2f-a83e-4555-9f16-927031405ec0/result.json) |
| 学习提交重启恢复 | prepare/recover不同实际PID，pending→saved且1案例 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-restart/500719b9-a041-44b2-905b-dbea8eb91ad1/result.json) |
| 企业发布桌面 | 6场景通过，准备不发布、旧草案拒绝及新发布可见 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-publication/6304817e-3c27-49d8-9111-4ad20f1d8ad6/result.json) |
| 自动学习迭代桌面 | 6阶段通过，自动定时复盘/校准、真实生成V1→V2→回滚 | [报告](E:/wechat-autoreply/auto-reply/.local/reports/learning-iteration/e8a7a4a6-2527-4c42-abcb-14213a8e0725/result.json) |
| 完整本地回归 | 182文件1935项通过，618.44s，失败及未执行均0 | [JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-full-tests.json) |
| 共享新增评估专项 | 3文件55项通过，11.78s；后续盲评48项通过，9.34s | [三文件日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-shared-jev-tests.log)、[后续日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-blind-review-checked.log) |
| 最新services类型复核 | 退出0 | [日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-services-terminal.log) |

本轮完整unit/integration/regression已亲读success=true、1935通过/0失败/0未执行，testResults为182文件；JSON的350个嵌套suite不是文件数。运行期间其他作者新增的blind-review/providers两个测试文件未包含在182文件中，已另作上述专项；这些结果不相加为一个完整快照。共享代码与来源指纹按[初始清单](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-source-hashes.json)及[终态清单](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-source-hashes-terminal.json)记录。本任务核心学习源码未发生测试期间漂移；恢复测试时钟修正和共享Jev变更另行记录。
学习桌面组合[日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-learning-desktop.log)退出0；四报告及prepare/recover已独立亲读。发布/迭代均为synthetic-engineering-fixture且businessEffectVerified=false，发布automaticSendingEnabled=false；迭代模拟human标签不会升级为真实人工准入，缺独立案例时仍insufficient。两恢复PID为10428/14952，证明实际跨进程恢复，非模型训练或正式发布批准。

## 实际三组链路已验证的边界

[实际Electron报告](E:/wechat-autoreply/auto-reply/.local/reports/foreground-evaluation/79db8d48-a0ce-4bb5-9bb2-3a9e56493e60/result.json)为passed=true：9次回环HTTP、0发送、3次真实呈现，runner退出0/未超时/14409ms。

原DB批次为88b2fb6b-0da4-42de-9b5e-a604472c5abc，原封存session为2f9cd770-8648-4dad-bfee-4b7a0ddb96b6。
none/baseline/learned各自绑定实际task/context、runtime、read与呈现回执，并在线核对原冻结依据及费用；原始日志只读重放。
独立CLI verify-foreground/adjudicate-foreground通过，原packet字节、回复、用量、费用保持；派生数据只替换已核前台时延字段。
synthetic标签仍为insufficient；verification不鉴定真人标签或费用来源。nativePlatformVerified=false，businessEffectVerified=false。
此单个合成会话不证明真实业务新增p95≤500ms；reviewable不表示用户已选唯一验收终点，confirmed_sent仍需真实发送确认。
基础桌面报告的foregroundPresentationVerified=false/businessVerified=false，不能混作本次三组呈现证明。
[容量报告](E:/wechat-autoreply/auto-reply/.local/reports/capacity/caaf5f73-1a4a-4edc-930e-6abcdc4f2e3a/result.json)为20agents/400conversations/10000messages，使用virtualClock及内存SQLite，不证明native、多设备或长期业务容量。

## 遗留问题及已保留的失败

- 完整PG首轮[报告](E:/wechat-autoreply/auto-reply/.local/reports/postgres-concurrency/e078989c-3c46-4be3-ab42-5c2b04815fda/result.json)为passed=false/cleanedUp=true：8文件81项通过/2失败，137.78s。
- 最强静态解释是恢复completion夹具混用主机与PG时间；未逐字段实测排除其他原因，不能声称唯一根因。仅测试构造改为实际PG时钟，并保留parse预检、原断言及时限，选测8项通过。
- 完整PG重跑已结束：8文件83项通过，130.87s，精确报告841d7f4f-4239-4ea2-be60-9b0d4f81b4c0已亲读passed=true/cleanedUp=true/scope=full；[日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-full-postgres-checked.log)。首轮失败保留。
- 本轮完整学习桌面组合及完整unit/integration/regression均终态退出0：[完整回归日志](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-full-tests.log)。旧完整失败和后续77项选测保留为历史，本轮182文件的新全套结果独立成立。
- 上一轮全局lint为624文件162错误/10793警告、19错误文件：[JSON](E:/wechat-autoreply/auto-reply/.local/reports/2026-10-07-multiagent-final-global-lint.json)。这是保留的历史失败；本轮收尾已独立执行全仓库lint，630文件0错误/8202警告、退出0。没有将全部警告宣称为已修复。
- 共享作者持续新增Jev评估文件，期间两次services复核分别报告旧快照的5处mock/UUID类型问题及2处测试回执可空问题；作者完成修正后，最新services-terminal退出0。root未抢改其源码；一次两行类型修正尝试因作者已先完成相同修正而未应用。两次失败日志保留，不以此前通过替代。

## 真实业务四门槛与缺失资料

| 用户确认的门槛 | 当前业务结论 |
| --- | --- |
| 实质修改率相对下降至少20% | insufficient |
| 学习组严重错误0 | insufficient |
| 覆盖率下降最多5个百分点 | insufficient |
| 学习组p95减基线组p95最多500ms | insufficient |

仍需真实100学习/100校准/200评估样本、至少30独立会话、独立人工盲评及原始费用凭据；模型自评或合成human声明不能代替。
保留学习/校准/评估隔离、原冻结三组、失败/取消样本、完整前台来源及成对成本，资料充分后才能作业务判定。
下一步收敛：取得真实业务样本/独立人工标签/费用及真实平台观察，按已确认四门槛完成业务验收。全局lint错误已清零，既有格式等警告仍保留。
不提高预算/重试/超时或放宽身份、发布、发送保护来制造通过；未提交、推送、部署、调用真实收费模型或发送业务消息。

本轮根代理及协同代理启动的全部检查已终态，三路学习修改已冻结，构建、学习相关回归、真实PG、桌面组合及新版共享文件选测通过；整仓首轮2失败及4个超时复现保留为历史，没有再次全量运行。连续至少三轮目标推进均缺少同一真实业务资料：上一轮完整工程回归、lint收尾及本轮审计/旧入口修复。当前没有可替代独立人工标注、真实费用和平台观察的工程操作，业务验收需等待外部资料，不能标complete。没有新的发布、预算、发送授权，也未用合成结果声称已满足真实业务四门槛。
