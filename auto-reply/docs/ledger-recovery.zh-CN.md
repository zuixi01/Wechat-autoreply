# 消息账本备份与恢复

本实现承接已批准的 D16：升级失败时保留消息、人工接管、原发送和中央许可历史，不能通过恢复旧文件取得再次发送权。它是账本恢复的开发步骤；完整配置/知识/学习数据库、中央 PostgreSQL 和设备凭据的联合恢复仍需后续验收。

实施顺序：先用真实磁盘 SQLite/WAL 编写失败测试，再实现一致性快照与严格校验，最后接入恢复阻断和主进程测试。当前账本版本为 12，增加持久学习反馈 outbox；备份和只读恢复接受真实 schema 11 或 12 的已完成快照，清单版本必须与数据库一致，不接受不认识的格式。恢复的旧 11 账本在应用打开时向前升级为 12，原恢复来源与阻断保持不变。

备份用 Node 的 SQLite backup 接口读取一个一致数据库，而非复制正在使用的单个 sqlite 文件。每次写入独立 UUID 子目录，先完成数据库并校验完整性/外键，最后写入清单作为完成标志。清单只有版本、文件摘要、长度和时间，不包含客户正文、密钥或发送权限。数据库本身包含客户历史，应保存于受控私有目录；SHA-256 校验用于完整性检查，不证明备份发布者身份。[Node SQLite backup 文档](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html#sqlitebackupsource-db-destination-options)。

恢复先检查目录和文件类型、严格清单、文件摘要、数据库完整性、外键及账本版本/必需表。只在不存在的新目录中生成数据库，不替换当前 profile，也不操作源数据库和旧备份。生成的恢复数据库带有持久化待核对标记；主进程启动/同步拒绝恢复自动执行，底层发送准备和进入 dispatching 同样拒绝。重启不清除标记，既有未知执行及人工接管仍保留。

完整解除恢复阻断需追加管理员/中央对账流程，确认备份后可能发生的执行和设备/登录版本；该环节尚未实现，不提供删除标记的操作。当前恢复产物用于核对，不是可直接启用自动发送的生产恢复。旧设置、旧 Provider、旧自动回复开关不会从账本快照导入执行权限。

每次恢复现在生成独立 restoreId，将备份 UUID、原数据库摘要、恢复时间和前一次恢复编号/内容摘要写入追加记录，事务内同时设置阻断及当前记录指针。记录自带规范化内容摘要；旁置 restore.json 是副本，不作为放行依据。普通旧账本不新增恢复记录；旧恢复仅有阻断而缺来源时报告 ledger_restore_context_missing，仍拒绝解除。只读查询不建表、不迁移，记录异常明确报错；恢复表或持久化指针存在时仍要求对账，不能通过清除旧标记取得执行权。来源摘要用于一致性，不证明管理员身份，也不代表备份之后的执行已对账。

追加表只在恢复事务中建立，正常 UPDATE/DELETE 被触发器拒绝。读取核对记录结构、完整顺序、恢复编号唯一性、内容摘要链和最新指针，最多接受 1000 条，每条最多 64 KiB；超限或损坏拒绝读取，也不能放行执行。数据库所有者仍可能删除全部阻断证据或重写一致的记录；该本地保护不能代替中央认证、访问控制和正式对账。旧兼容构建尚无新来源校验，不作为安全解除恢复阻断的回退路径。

测试必须覆盖：WAL 中已提交数据、备份后继续写入、恢复后的历史/接管/未知状态、内容和清单篡改、缺文件/额外文件、符号链接/路径别名、错误版本/格式、存在的恢复目录、恢复标记跨重启，以及主进程不观察、不请求租约/许可/模型。测试仅用合成消息，不读取微信/企微，不发送真实回复。

## 运维命令

在已配置开发 Node 的终端运行；将下面引号内的占位符替换为实际绝对路径。备份命令只读打开源账本，不创建或迁移缺失源文件。迁移/生产恢复前仍须中央暂停、逐台确认静止，并核对备份之后的执行；在线快照的数据库一致性不代表所有电脑已经物理停止。

```powershell
npm run ledger:backup -- --source "<源账本绝对路径>" --output "<私有备份根目录>"
npm run ledger:verify -- --backup "<已完成的 UUID 快照目录>"
npm run ledger:restore -- --backup "<已完成的 UUID 快照目录>" --output "<不存在的新恢复目录>"
npm run ledger:inspect-restoration -- --source "<待核对账本绝对路径>"
```

backup 返回实际 UUID 目录和清单；verify 返回校验结果；restore 返回新文件路径、restoreContext 及 requiresReconciliation=true。inspect-restoration 只读返回数据库中的 context，普通账本为 null；不返回客户消息，不从旁置文件取得授权，也不会创建缺失数据库。恢复记录缺失/损坏报错并继续阻断。参数不匹配、格式错误或目标存在时退出非零，只输出脱敏错误码，不自动找员工 profile、不覆盖现有目录、不调用模型或聊天客户端。失败恢复目录保留供检查，未完成目录不能作为成功快照。

使用本地开发工具时，用 `scripts/dev-tools.ps1 -NpmArgs @('run','ledger:inspect-restoration','--','--source','<绝对路径>')` 明确转发 npm 参数。

私有 `out/main/ledger-recovery.js` 导出相同实现和账本类，供运维恢复及包内检查，不通过 IPC 接收任意数据库路径。开发 CLI 本身不包含在员工归档中；员工应用内的备份/恢复入口和管理员解除恢复阻断仍待后续开发，不能把开发命令当作最终员工操作流程。

## 本地恢复消息与执行清单

该开发命令只读打开指定恢复账本，不创建 Ledger、不迁移或改变执行状态。先在私有 JSON 文件中填写核对范围，例如 `{"tenant_id":"COMPANY","employee_id":"EMPLOYEE","account_id":"ACCOUNT","agent_id":"AGENT","platform":"wework"}`。范围应与已登记目标设备一致；文件只指定读取范围，不是设备认证或管理员授权证据。

```powershell
npm run ledger:inspect-inventory -- --source "<恢复账本绝对路径>" --scope "<私有设备范围 JSON>" --limit 50
npm run ledger:inspect-inventory -- --source "<恢复账本绝对路径>" --scope "<私有设备范围 JSON>" --after "<上一页 nextAfter>" --basis "<上一页 basisHash>" --limit 50
```

报告绑定有效恢复来源和完整企业/员工/账号/Agent/平台，覆盖该设备的历史登录轮次。逐条消息只返回身份、原消息 ID、序号、内容指纹、实际处理标记、缺口和接管状态，不返回正文；处理标记不简化为“最大已处理序号”。执行返回原任务与草稿摘要、入站区间、本地状态、完整请求/许可摘要、许可及回执状态、中央更新时间和证据摘要。没有消息的执行会话也纳入核对。`sequenceComplete` 仅表示本地序列连续，`localRangePresent` 仅表示原任务区间的记录在本地，均不证明客户端历史完整或事实已核验。

每次读取使用一致事务，摘要覆盖所有范围内记录，明细每页最多 100 条；换页携带原摘要，消息处理、接管、请求或许可内容变化会拒绝旧摘要。缺来源、损坏指纹/绑定/唯一约束及重复分页键拒绝整个报告。CLI 拒绝重复参数和大于 8 KiB 的范围文件，不自动寻找员工 profile、读取聊天窗口或调用模型。完整遍历最多接受一百万条消息和累计一百一十万条消息/执行记录，超限拒绝，不截取后冒称完整。

该报告始终是 `local_restored_metadata`、`canRelease=false`、`externalEvidenceRequired=true`。中央原执行结果、备份后新增消息、其他设备历史、既有核对决定及应用确认仍需另行验证。本地恢复副本里的“已处理”或“confirmed”不是备份后未发生新执行的证明；零未知、零未结算或空页均不授予恢复权限。开发 CLI 不替代最终员工恢复向导。

## 中央恢复核对单

恢复来源开单后，员工在企业连接页点击“提交恢复清单”。主进程先停止采集、发送、租约和待执行活动，记录暂停声明，再根据自己的登记身份与 SQLite 恢复上下文生成固定元数据快照。仅扫描账本一次，每页上传 100 条；页面不能提供账本路径、账号身份或放行标记。消息正文、回复正文和凭据不会进入清单。

服务需要按顺序应用 `025-restore-inventory.sql`（沿用既有迁移身份；不能用管理员数据库凭据启动普通服务）。认证接口是 `/v1/restorations/inventory/start`、`/page`、`/complete`；会话有效期 15 分钟。清单绑定目标账号、设备、恢复来源、已保存暂停声明、basis 和统计。会话、页、条目及完整收据均仅追加，完整接收时重新校验全部页面/条目哈希、顺序、数量、消息身份唯一、会话共同状态和执行区间存在情况。缺页或损坏不能产生完整收据。

请求在首次上传前写入本地不可修改日志。断网、响应丢失或进程重启后，相同来源在重试期内使用原请求和分页；主进程仍重新确认暂停状态。临时快照删除失败不会锁死上传，下次先重试清理。完整收据表示保存的恢复元数据一致，自动回复继续暂停。

管理员使用独立数据库登录读取：

```powershell
npm run admin -- restore-inventories --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --limit 50
npm run admin -- restore-inventory-items --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<上传 UUID>" --limit 100
npm run admin -- restore-inventory-items --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<上传 UUID>" --after "<上一页 nextAfter>" --limit 100
```

列表区分接收中与完整接收；只有完整清单可逐项读取。每次查询先核验保存集完整性，执行条目同时显示当前中央许可，并列出身份、任务、状态、回执摘要、原消息范围等差异。中央晚到结算会反映到当前核对结果，不会改写已上传的本地记录。另用 `restore-permit-audit` 核对中央开单快照和当前全部许可，避免遗漏备份后新增但不在本地副本中的执行。

所有结果固定 `canRelease: false` 和 `externalEvidenceRequired: true`。本轮仍需后续完成备份后可信事实收集、管理员决定、本地原子应用、中央确认和联合备份；保存完整清单不能证明备份后未发送、其他旧设备已停机或恢复获批。

### 统一核对依据和外部证据引用（迁移 026）

管理员现在可一次核对完整清单、开单时全部许可和当前全部许可，并绑定当前账号、员工启用状态、所有登记设备和租约。显示一页时，`basisHash` 与统计仍覆盖所有记录；中央备份后新增但本地没有的执行也会列出。每项区分账号停止、消息历史、本地执行和中央执行，返回所需证据类型与缺口。即使本地标记已处理或中央记录已结算，仍须核验备份后事实。

```powershell
npm run admin -- restore-assessment --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<完整上传 UUID>" --limit 100
npm run admin -- restore-assessment --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<完整上传 UUID>" --after "<nextAfter>" --basis "<basisHash>" --limit 100
```

换页必须携带原依据；晚到结算、设备撤销、租约或末页记录变化后拒绝旧依据。合法 UUID 大小写在入站统一；等价数据库时区不会改变摘要，许可、设备和租约的微秒变化仍会改变依据。

管理员在外部核实后，可以保存一个具体对象的证据引用。文件只包含以下字段，不包含正文、截图、文件路径或放行声明。`subjectKey`、`subjectHash` 和 `kind` 必须来自本次 assessment 的同一项；`observedAt` 是核实时间，不能早于开单或晚于服务端时间。

```json
{
  "noteId": "<新 UUID>",
  "basisHash": "<完整依据摘要>",
  "subjectKey": "<核对对象 key>",
  "subjectHash": "<该对象摘要>",
  "kind": "device_stop",
  "referenceId": "external-case-001",
  "evidenceHash": "<外部证据 SHA-256>",
  "observedAt": 0
}
```

示例占位内容需要替换。kind 根据对象为 `device_stop`、`message_history` 或 `execution_outcome`，不能互换。

```powershell
npm run admin -- record-restore-evidence --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<完整上传 UUID>" --file "<证据引用 JSON>"
npm run admin -- restore-evidence --tenant "<企业>" --account "<账号>" --case "<核对单 UUID>" --upload "<完整上传 UUID>" --limit 100
```

迁移 `026-restore-evidence.sql` 要求沿用独立管理员登录和账号锁；普通服务角色不能读取或写入证据。记录与审计原子提交，不能修改或删除；相同 ID/内容重试返回原收据，改内容拒绝。依据变化后，旧收据仍能作为历史读取，`currentBasis=false`，同请求重试不会把它重新认证为当前有效。新记录必须使用新依据。

外部引用和文件摘要是管理员提交的元数据声明，尚不证明原证据真实、充分或管理员已作出最终恢复决定。当前仍无恢复启用命令，结果保持 `canRelease=false`，不改原 unknown、水位或暂停。后续正式决定必须逐项审核这些事实，并继续经过本地原子应用和中央确认。

D16 现在支持由独立数据库管理员为一次恢复开单。迁移 019 必须由受信任迁移角色执行；暂停约束函数要求其所有者保有 SUPERUSER 或 BYPASSRLS，否则拒绝解除暂停。管理员在既有账号锁内验证已登记、未撤销的目标 Agent 和完整恢复 context，暂停账号，保存全部中央许可的开单时快照、精确条数及原登录租约。每个 restoreId 在该账号内唯一；相同内容重试返回原单，换设备或来源摘要拒绝。记录只含身份/版本/摘要/状态等元数据，不含聊天正文、回复或密钥。

开单不修改原许可、未知回执和租约，不证明任何设备已经物理停止。只读元数据中的 devicePauseAcknowledged 始终为 null。当前尚无解除本地或中央恢复阻断的命令；所有恢复核对单都阻止 resume，数据库触发器也拒绝把账号 paused 改为 false。不能使用普通管理员 SQL 绕过，也不能通过删旧本地标记取得发送权。受信任数据库所有者仍能改 schema，这不是签名或不可绕过的外部安全保证。

先从本地 inspect-restoration 的 context 取得完整对象，以中央已登记 Agent ID 形成私有文件 `{"agentId":"目标 Agent ID","context":完整对象}`，原样保留 context 的编号、前次记录及摘要，不手工重算或替换。管理员只用 ADMIN_DATABASE_URL，不使用员工设备或普通服务数据库凭据。文件最大 8 KiB，CLI 拒绝不匹配参数、非法分页及重复选项，失败只输出脱敏代码。

```powershell
npm run admin -- open-restore-review --tenant COMPANY --account ACCOUNT --file C:\private\restore-input.json
npm run admin -- restore-reviews --tenant COMPANY --account ACCOUNT
npm run admin -- restore-review --tenant COMPANY --account ACCOUNT --case CASE_UUID
npm run admin -- restore-review-permits --tenant COMPANY --account ACCOUNT --case CASE_UUID --limit 50
npm run admin -- restore-review-permits --tenant COMPANY --account ACCOUNT --case CASE_UUID --after LAST_PERMIT_ID --limit 50
```

restore-reviews 当前最多列出 100 张单；开单返回的 caseId 始终可用 restore-review 单独读取。许可快照保存全部记录，读取每页 1–100 条，默认 50，使用上一页最后一个 permitId 作为 after 继续；空页结束。后来的许可结算不会改开单快照，快照条数变化拒绝读取且保持暂停。该准备步骤并非正式恢复放行：可信设备停止报告、备份后消息水位/许可核对、管理员决定及本地原子应用/中央确认仍待接入。

## 当前验证结果

### 目标设备暂停报告（D16，迁移 020）

中央服务新增私有 `POST /v1/restorations/challenge` 和 `POST /v1/restorations/report`。设备凭据确定企业、员工、账号、Agent 和平台，不能由正文替换身份。挑战绑定恢复核对单、完整本地恢复 context 以及全部许可快照的 frontierHash；每页内部读取 500 条，摘要覆盖最后一页。账号须暂停，旧租约及仍有效的 issued 许可须到期。挑战有效期严格为 30 秒，相同 requestId 返回原挑战，过期后须新 requestId；服务在首次报告提交时再次核对权限、账号、租约、许可、来源和完整快照。

可信主进程的 `reportRestorePause({caseId,requestId})` 先确认 Observer、Sender、中央结算、租约及平台 stop 已完成，才请求挑战。停止失败、设备改变、取消、来源不符或挑战过期均不上传。实例编号、运行代次和停止声明由主进程生成，先在恢复账本事务内持久化，再上传；同一实例/代次的丢响应重试复用完全相同的报告，重启或新的暂停代次须新 requestId。设备和中央时钟不匹配时会拒绝，不能跳过时效检查。

中央报告、审计原子追加，相同内容重试返回同一 `target_pause_report_recorded` 回执，换内容拒绝。本地追加表正常更新/删除被拒绝，重开账本核对格式、摘要和当前恢复 context。回执表示历史报告已记录；它不是当前仍停止的证明，不证明其他旧设备停止、未知发送已核对或备份后的消息已处理。五个停止字段是经认证主进程的声明，不是独立的物理停机证明，也不把原生探针的 false 能力改为 true。

本步骤不消费消息、改原许可、清除本地标记或恢复账号；`devicePauseAcknowledged` 保持 null。员工提交入口已按下文接入；备份后消息水位与许可逐项核对、正式恢复决定、本地原子应用和中央应用确认仍需后续开发。真实聊天及模型调用继续按用户安排暂缓。

### 员工提交恢复暂停状态

恢复账本进入员工应用后，现有“客户自动回复”区域显示恢复提示。员工确认企业连接后点击“提交暂停状态”；不填写数据库路径、恢复编号、核对单编号或停止声明。只读状态轮询读取本地元数据，不访问聊天客户端、企业服务或模型。

主进程根据当前账本中的来源和登记身份调用私有 `POST /v1/restorations/lookup`，查找管理员已创建且明确绑定当前设备的核对单。发现接口仅返回匹配元数据，不创建挑战、执行许可或恢复授权。随后主进程确认停止，再走原挑战、账本保存和上传流程；未匹配到核对单、来源损坏或连接改变时拒绝提交。IPC 只允许应用主文档及严格空对象，不能通过旧通用桥接调用。

同一运行代次、同一来源且挑战未到期的重试复用同一请求和完整报告；挑战到期后主进程创建新请求。重启后保留账本历史，并保守地重新要求提交，旧实例的收据不作为新实例已停止的依据。界面显示“已提交暂停状态，等待管理员核对”只说明中央收到了历史报告，不能据此启动自动回复。提交超时或非法回执显示结果未确认；连续点击、后台刷新和暂时读取失败不会替代成功确认。

员工界面目前完成暂停声明提交，不包含完整恢复向导、管理员放行、本地解除阻断或中央应用确认。中央及本地仍保持恢复阻断。

### 管理员查询暂停声明

独立数据库管理员现可读取摘要或完整原报告。列表每页 1–100 条，默认 50，以 challengeId 的 UUID 顺序读取；after 是上一页最后一条的 challengeId，空页结束。摘要不返回完整报告，详情只包含上述身份、来源、时效和主进程声明元数据，不含聊天、回复正文或凭据。查询重算全部许可快照摘要，核对原报告摘要、完整 nonce、恢复来源、作用域和数据库时间字段；损坏或错绑拒绝读取，不将损坏记录包装为有效证据。

```powershell
npm run admin -- restore-pause-reports --tenant COMPANY --account ACCOUNT --case CASE_UUID --limit 50
npm run admin -- restore-pause-reports --tenant COMPANY --account ACCOUNT --case CASE_UUID --after LAST_CHALLENGE_UUID --limit 50
npm run admin -- restore-pause-report --tenant COMPANY --account ACCOUNT --case CASE_UUID --challenge CHALLENGE_UUID
```

命令只使用 ADMIN_DATABASE_URL，设备/普通服务角色不能冒用管理员读取；跨企业、账号、核对单和禁用管理员拒绝。recordedAt 是中央记录时间，observedAt 是主进程报告观察时间；declarationKind=target_main_process 和 receiptStatus=target_pause_report_recorded 明确表示历史声明。设备后来被撤销时，管理员仍可读取原历史；这些字段不表示设备当前仍停止或原权限仍有效。每页为一次读取时点，分页期间可能追加新报告，持续新增时应重新查询核对，不将空页作为全部设备停机的证明。

查询不改写历史、追加恢复决定或解除暂停。正式恢复审核仍须覆盖其他旧设备、备份后的消息与原执行结果，本步骤不代替那些证据。

## 比较恢复前后的中央许可

```powershell
npm run admin -- restore-permit-audit --tenant COMPANY --account ACCOUNT --case CASE_UUID --limit 50
npm run admin -- restore-permit-audit --tenant COMPANY --account ACCOUNT --case CASE_UUID --after LAST_PERMIT_ID --limit 50 --basis PREVIOUS_BASIS_SHA256
```

使用独立 `ADMIN_DATABASE_URL`。每次读取在账号锁内完整比较开单快照与当前许可，统计全部记录，再返回最多 100 条明细。`nextAfter` 非空时继续下一页，并携带 `basisHash`；核对依据变化时拒绝旧分页，重新读取。新增未捕获、身份漂移、当前缺失、状态变化和不完整历史字段分别标记；过期的 issued 仍计入未结算，不能改判为未发送。Unicode 游标与 SQL 使用相同排序，时间按实际值比较并保留微秒，等价时区不会误报变化。

这是中央元数据视图。`settlementRecorded` 不是物理发送证明；原未知许可可能已有独立核对决定，应另查该核对单及应用确认，本视图不会改写或验证其决定。所有结果固定 `canRelease=false`、`localWatermarksRequired=true`，本地恢复阻断继续生效。缺少备份后的消息处理水位、执行日志或其他设备证据时，不能依据空页或中央零未结算统计恢复自动回复。

此前本地恢复专项 3 文件、89 项通过；完整安装候选管线的 96 文件、894 项及全部八阶段通过。固定构建 `4fe01516-f868-42c9-94ec-2f3bd70c7383` 的实际包内检查确认来源记录持久化、清除旧标记后继续阻断。前次完整回归的 PDF 超时、旧包检查失败和后续服务类型检查失败均保留，未放宽期限。详情见 [安装包记录](windows-installer.zh-CN.md) 和 [实施进度](implementation-status.zh-CN.md)。当前没有中央恢复放行或正式安装/联合回退验收。

中央准备阶段新增 8 项行为验证、2 项真实数据库并发验证，另有独立 CLI 凭据拒绝检查。生成服务/恢复专项 57 项、最终完整回归 99 文件/919 项全部通过；真实 PostgreSQL 16.15 的 31 项通过，独立临时容器清理已确认。开单与原发送许可争同一账号锁、并发重试只生成一张单，以及等待期间设备撤销后的拒绝均已实测。曾出现的新外键使旧测试夹具清理失败、CLI 分页二次解析错误、约束角色失权误放行和同期学习测试接口错误均保留；补齐夹具清理、分页解析及约束权限检查后重新验证，未删外键或业务断言。主进程/服务类型、相关源码 ESLint 和格式检查通过。此阶段未重建安装包、部署中央服务或读取真实客户端。

## 客户端隔离应用与中央确认（迁移 028–029）

管理员完成本次清单的逐项核对并封存后，员工可在“设置 → 企业连接 → 恢复记录核对”点击“应用管理员核对结果”。页面只提交空请求；恢复来源、设备身份、核对单及当前决定由主进程查询，不允许页面传入路径、账号、决定编号或放行字段。尚未封存、依据已变或连接不可用时提示重试，并保留暂停。

主进程先等待观察、发送、结算和租约停止，再读取本设备的当前决定。在一次 SQLite 事务中检查最新恢复来源及上传前的完整清单摘要，隔离该账号的旧入站消息，保留已处理和出站记录，将覆盖的会话交由人工。所有原发送状态、unknown 及回执不改写；其他账号不被消费。完整清单通过遍历核验，不以界面的一页为全部历史。

隔离应用有不可修改的持久化回执。随后中央在同一账号锁内重新检查目标凭据、暂停状态、原决定及完整当前依据，追加精确确认与审计。两条写入同事务；重复提交只返回原确认，换内容、跨账号或被撤销设备拒绝。迁移 028 允许普通服务显式缩小为只读角色查询本设备核对单，不继承管理员读权；迁移 029 的确认表没有普通服务修改或删除权限。

本地提交后断网、丢响应或重启，可重新点击；主进程复用原应用回执，不再消费后来观察到的新消息。中央确认必须严格绑定原应用摘要，保存到本地不可修改的确认记录后，界面才显示“旧消息隔离已完成并已记录”。这表示历史提交事实，不证明当前消息/执行数据库仍完整。后续最终恢复审核必须再核验当前源数据。

**本步骤不会启动自动回复或解除恢复围栏。** 确认固定 `quarantine_recorded / canRelease=false / automaticStart=false / externalEvidenceRequired=true`。全局恢复来源记录、账号暂停及独立未知执行核对继续生效；单账号确认不能清除同一文件中其他账号的阻断。备份后完整消息历史、其他设备事实及最终放行证书仍待实现。不能将证据引用或管理员元数据隔离结论当作完整历史证明。

当前入口源码已构建，并以独立空测试目录的实际 Electron renderer/preload 做合成界面检查；不是新安装包或真实微信/企微验收。测试及发布边界详见 [实施进度](implementation-status.zh-CN.md) 的本轮记录。

## 管理员逐项核对与封存决定（迁移 027）

管理员可以显式记录已审阅的证据及核对结果，再封存完整的隔离历史决定。使用独立 `ADMIN_DATABASE_URL`；员工设备和普通服务账号不能调用。结果仅为后续本地应用准备，不授予发送、自动启动或清除暂停的权限。

```powershell
npm run admin -- restore-rulings --tenant COMPANY --account ACCOUNT --case CASE_UUID --upload UPLOAD_UUID --limit 50
npm run admin -- record-restore-ruling --tenant COMPANY --account ACCOUNT --case CASE_UUID --upload UPLOAD_UUID --file RULING_JSON
npm run admin -- seal-restore-decision --tenant COMPANY --account ACCOUNT --case CASE_UUID --upload UPLOAD_UUID --file DECISION_JSON
npm run admin -- restore-decision --tenant COMPANY --account ACCOUNT --case CASE_UUID --upload UPLOAD_UUID --decision DECISION_UUID
```

`restore-rulings` 返回完整 `basisHash`、`rulingsHash` 和全部对象的 `subjects / accepted / held / missing`，明细最多 100 条。继续分页必须同时带 `--after LAST_SUBJECT --basis BASIS_SHA256 --rulings RULINGS_SHA256`；事实或核对结果变化时拒绝旧分页。缺少核对的中央执行记录，包括不在备份中的执行，也计入 missing，不能只审核第一页后封存。

RULING_JSON 的结构如下；编号、摘要均替换为实际读取到的值。`noteReceiptHash` 是匹配证据收据的规范 `hashContext` 摘要，不是证据文件的 `evidenceHash`。外部引用必须由管理员实际审阅，不能仅凭存在一个文件编号作出通过判断。

```json
{
  "rulingId": "11111111-1111-4111-8111-111111111111",
  "basisHash": "<当前完整依据 SHA256>",
  "subjectKey": "<核对对象键>",
  "subjectHash": "<核对对象摘要>",
  "noteId": "<已保存的证据 noteId>",
  "noteReceiptHash": "<完整证据收据的规范摘要>",
  "expectedPreviousRulingId": null,
  "outcome": "hold",
  "evidenceReviewed": true
}
```

未能充分核对时选 `hold`；确认可以进入历史隔离准备时选 `accept_for_quarantine`。第一次记录的 previous 为 null；改判使用新 rulingId 并指明最新 `expectedPreviousRulingId`。服务追加版本，保留旧结论；两个管理员基于同一旧版同时改判，只有一个成功。相同请求重试返回原历史收据，改写同一个编号的内容被拒绝。存在损坏的版本、证据或已封存决定时拒绝继续操作。

全部当前对象通过后，DECISION_JSON 使用新 decisionId 和当前两种摘要：

```json
{
  "decisionId": "22222222-2222-4222-8222-222222222222",
  "basisHash": "<当前完整依据 SHA256>",
  "rulingsHash": "<全部最新核对结果 SHA256>",
  "historyPolicy": "quarantine",
  "reviewedAllSubjects": true
}
```

任何 missing、hold 或摘要变化都会拒绝封存。封存后该依据的结论不可改判；新的事实变化需要重新核对新依据。决定绑定源恢复、目标设备、清单和全部核对版本；决定与审计同事务保存。查询 `currentBasis=false` 表示历史决定，不能作为当前应用依据。

所有收据保持 `canRelease=false`，封存结果为 `applicationRequired=true / automaticStart=false`。当前没有写入消息处理水位、改原 unknown 或解除中央/本地恢复阻断。下一步仍需备份后完整历史核验、本地原子隔离应用及精确中央确认，随后独立人工启用；联合备份、正式安装和实机业务验收保持原计划范围。
