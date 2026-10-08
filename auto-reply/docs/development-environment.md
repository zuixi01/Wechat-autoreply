# 开发环境和验证命令

所有命令从 `E:\wechat-autoreply\auto-reply` 执行。外层 `E:\wechat-autoreply` 属于另一项目，不能将其构建结果计入本项目。

本机使用官方校验过的便携 Node 24.21.0/npm 11.19 和 .NET SDK 10.0.401，位于被 Git 忽略的 `.local/toolchain`；没有改动系统 Node 版本。`.node-version` 固定 Node 版本。

```powershell
& '.\scripts\dev-tools.ps1' run test
& '.\scripts\dev-tools.ps1' run test:scenarios
& '.\scripts\dev-tools.ps1' run typecheck:services
& '.\scripts\dev-tools.ps1' run build
& '.\scripts\dev-tools.ps1' run test:desktop
& '.\scripts\build-native.ps1'
```

本轮改动的专项 ESLint 检查通过，尚未宣称上游全部代码 lint 通过。当前固定 Electron 44.5.1，自带 Node 24.21.0 / SQLite 3.53.4，实际目录包中的 SQLite 建表、写读及辅助进程 info 已通过。软件渲染模式的隐藏桌面检查通过；默认硬件渲染检查仍出现截图错误及退出未确认，不能将软件渲染结果视为默认模式验收。

日常 `test` 使用单个 worker，避免 PGlite WASM 与构建或办公进程争用内存；应用本身的每 Agent 生成并发仍为 2，发送仍串行，测试超时门槛没有放宽。低可用内存时请依次运行构建、日常回归和容量回放；真实 PostgreSQL 多连接专项使用独立的 test:postgres 命令，不混入日常 PGlite 回归。

PowerShell 的参数转发可能消耗 `--`，调用独立工具时直接使用 Node 和该工具入口。例如：

```powershell
& '.\.local\toolchain\node-v24.21.0-win-x64\node.exe' node_modules/prettier/bin/prettier.cjs --check src/shared server/src tests
```

当前依赖通过禁用安装脚本的方式安装，Electron 官方二进制另行安装。原完整 `npm ci` 在 `node-window-manager` 的 node-gyp 阶段失败，本机未具备 MSVC 原生编译环境；旧 RPA 原生模块尚未编译。旧驱动改为按需加载，隔离配置下的实际 Electron 隐藏启动已通过，但旧驱动和 Windows 安装包仍未验收。

`test:desktop` 必须在构建后运行，启动实际 Electron 构建并加载 renderer/preload。它使用全新 `.local/reports/desktop-smoke/<UUID>` 配置目录，隐藏主窗口，检查未登记模式的具名 IPC、通用 IPC 私有通道隔离、SQLite v10、实际设置页的暂停按钮和正常退出。真实检查之后，测试脚本临时替换本进程内的状态 IPC，以合成响应验证启动时可暂停、迟到启动结果不覆盖暂停、停止待确认、错误恢复、编辑重审、评估说明、引用原文分页、人工确认未知结果、核对提交/结案和从未签发请求封存后的人工接管。这些替身只存在于测试脚本，不是设备登记或真实驱动验证。不会使用员工设置、读取聊天窗口或调用模型。命令同时检查进程退出码和本轮报告文件，单独的退出码 0 不算通过。

`test:scenarios` 是独立容量回放，单 worker，和日常 `test` 分开运行。固定合成数据集 `synthetic-capacity-v1` 使用 20 个 Agent、每个 20 个同名客户、5 轮共 10000 条唯一消息及同量重复观察；走真实本地 Agent、Scheduler、Sender 和内存 SQLite，模型与物理设备都是替身。输出 `.local/reports/capacity/<UUID>/result.json`，含每轮墙钟耗时、RSS/heap/external 内存和残留定时器。另一场景在默认队列上限 200 下提交 300 个会话，检查超额 100 个明确交人工、不执行。60 秒上限用于防止测试挂起，不是业务 SLA。容量回放目前使用开发 Node 24，不能代替 Electron 的持续办公、磁盘 WAL、多设备中央租约或真实模型吞吐验收。

2026-10-03 已修复此前依赖审计问题。`test:dependencies` 分别向官方 npm registry 审计生产依赖和全部依赖，两者已知漏洞均为 0，并保存原始 JSON 和 package-lock SHA-256；审计失败、网络不可用或锁文件变化均不放行。没有执行 `npm audit fix --force`。此检查不覆盖 .NET、原生二进制的全部漏洞或未来新增公告，也不代替功能验收。

## 后端数据库

迁移顺序为 `server/migrations/001-core.sql`、`002-reviewed-execution.sql`、`003-generation.sql`、`004-administration.sql`、`005-evaluation-admission.sql`、`006-human-confirmation.sql`、`007-reconciliation-cases.sql`、`008-device-reconciliation.sql`、`009-reconciliation-decisions.sql`、`010-execution-request-seals.sql`、`011-model-call-ledger.sql`、`012-generation-capacity.sql`，由独立迁移凭据执行。普通 API 角色不得拥有 superuser/BYPASSRLS 或 `autoreply_admin` 权限；租户数据查询在同一事务、同一连接中设置可信租户作用域。

后端启动示例配置见 `server/.env.example`。生产使用 HTTPS；显式开发开关仅允许 127.0.0.1/::1 本地 HTTP，不能用于其他网卡地址。

中央生成需要同时设置服务端 `TYPESAFE_API_KEY`、`TEXT_MODEL_API_KEY`、`TEXT_MODEL_BASE_URL`、`TEXT_MODEL_ID` 和 `TEXT_MODEL_EXPECTED_ID`；员工端不配置模型密钥。未配置时生成接口返回不可用，执行许可拒绝放行。文本客户端的配置指纹用于发布校验；修改 endpoint、模型或生成提示后应发布新配置。

管理员操作现在可由 `server/scripts/admin.ts` 执行，使用独立 `ADMIN_DATABASE_URL` 和迁移运维配置的企业管理员登录映射。支持账号创建、登记码、不可变发布、中央暂停/恢复、设备撤销及未结执行查询；命令和初始化说明见 [管理操作](../server/admin/README.md)。管理员角色不能修改未知执行，真实核对流程和管理界面仍待开发。服务 API 和数据协议详见 [服务端说明](../server/README.md)。租约需在生成期间持续续期；续租和中央许可持久化执行器已接入新主进程运行核心，但实际后台收发适配尚未安装，自动回复保持关闭。

2026-10-03 已重新确认本机 Docker Linux Engine 可用；隔离的 PostgreSQL 16.15 多连接专项当前通过 20 项。PGlite 仍只提供单连接验证。专项证明限定的行锁、额度、租约与请求封存场景，不能替代生产部署、多个服务器进程或真实设备验收。

## Jev 连接验证

日常测试只使用合成夹具，不发真实网络请求。`npm run jev:check` 是显式联网检查命令，需要主进程外的服务端环境变量 `TYPESAFE_API_KEY`；可用 `JEV_MODEL` 固定请求版本。真实密钥不得写进源码、前端、命令行参数或日志。

本次连接报告在 `.local/reports/jev-live.json`，所有 `.local` 内容均被忽略并从打包资源排除。报告仅记录模型、合成回答、用量和耗时。没有上传实际客户资料。

业务评测工具和输入要求见 [Jev 评测说明](../evals/jev/README.md)。它读取业务人员独立标注的 A/B/C 配对文件，不调用模型自评，不发送网络请求。当前只验证了合成夹具上的计算逻辑，实际业务效果仍未评估。

## 界面预览

资源构建后可将 `out/renderer` 作为 localhost 静态目录预览设置界面。URL `/?window=settings&section=enterprise` 打开企业连接页。浏览器预览没有 Electron IPC，登记及运行按钮停用并显示提示；设备登记的端到端验证须在桌面客户端进行。运行控件使用具名私有接口，轮询仅读取状态；请求超时只表示未确认，不视为已暂停或已取消主进程操作。

界面截图保存在 `.local/reports/design`。当前检查了实际设置窗 900×720 和最小窗 860×640 下的布局、字段、滚动、状态文案以及控制台。该记录不代表真实聊天收发通过。

## 可选旧本地控制接口

默认不开启。只有同时设置 `AUTOREPLY_ENABLE_LEGACY_SKILL_SERVER=1` 和 `AUTOREPLY_LEGACY_SKILL_TOKEN` 才监听 loopback 12680（占用时仅尝试一次 12681）。令牌应使用密码学随机数生成，每设备独立的 64 位十六进制值；不得写入命令行参数、源码、截图、前端或安装包。调用方用 `Authorization: Bearer <私有令牌>`，仅接受准确的 127.0.0.1/localhost Host，拒绝浏览器 Origin/Referer/Fetch Metadata；不支持网页 CORS 调用。POST 正文仅允许为空或 `{}`，大小最多 1 KiB。

Windows 旧启动路径统一拒绝；此接口不替代新员工工作台的登记、同步、平台验证、租约和执行许可。暂停会同时请求新运行器停止，必须收到实际停止确认才成功；状态是只读。令牌正确也不能使未验证平台具备后台读写能力。

生产生成服务现在要求先迁移 011 并由管理员设置账号的每日模型请求次数额度。未配置不会默认无限额；零或已耗尽时交员工处理。JeV 重试与文本请求均逐次预占，账本和额度配置由数据库角色隔离，令牌仍只在服务端。配置命令和 UTC 日统计说明见 [模型调用记录和额度](../server/admin/README.md#模型调用记录和每日请求额度)。这尚不是实际货币预算，已知 token 用量不包含未知计费。

## 真实 PostgreSQL 多连接专项

运行 `npm run test:postgres`（本机可用 `.\scripts\dev-tools.ps1 run test:postgres`）。要求 Docker Linux Engine 可用，并已缓存 [PostgreSQL 官方镜像](https://hub.docker.com/_/postgres) `postgres:16`；未缓存时可先运行 `docker pull postgres:16`。测试 runner 不自动拉取，不使用现有容器、部署连接串或员工设置。

每轮创建带 UUID/归属标签的临时容器，动态端口只绑定 127.0.0.1，限制 512 MiB 和 1 CPU，数据库在 tmpfs。随机密码只通过子进程环境传递；报告不保存连接串/密码。迁移 001–012 各执行两次；建立分别继承 autoreply_app / autoreply_admin 的普通登录，检查非 superuser / 非 BYPASSRLS。生产 Postgres 类创建三个独立连接池，记录不同 backend PID，验证实际 READ COMMITTED。受控事务持有账号行锁，pg_stat_activity 证明其他连接真实等待；没有用 JavaScript 队列假装数据库争锁。

20 项覆盖：18 个并行请求竞争 5 个模型尝试额度及连续尝试编号；直接 SQL 竞争最后一额；管理员未提交的暂停/额度变更在等待者获锁后生效；另一个员工账号不被繁忙账号阻塞；实际管理员登录/RLS 和不可变记录权限；两个设备竞争过期租约仅一个胜出；封存先提交/许可先提交两种顺序都互斥；实际终止测试 backend 后未提交预占回滚且连接池恢复；已提交无结果预占保持且未知用量独立计数；真实 lock_timeout 后不调用模型，回滚后新请求可用。新增共享逻辑生成准入：三个独立 GenerationService 实例的第三个账号任务经实际 HTTP 返回 429；20 个跨租户任务最多准入 10 个；完成缓存不占名额；过期行释放逻辑容量但不可延长/重启/完成或调用新模型；等待共享锁后再次检查任务截止时间；生产事务覆盖连接默认 repeatable read，直接不支持的隔离级别拒绝；计数器失去 BYPASSRLS 时拒绝而非少计。

报告在 `.local/reports/postgres-concurrency/<UUID>/`：result.json 含镜像 digest、测试数及 cleanup 结果，database.json 含版本、迁移和角色/PID，tests.json 为逐项结果。通过必须要求测试退出成功、没有跳过/失败且本轮容器已清理；清理前核对 UUID 标签和实际容器 ID，不停止其他项目容器。最新专项报告以 result.json 的测试数和清理状态为准；2026-10-03 的迁移 012 阶段验证 20 项，具体报告见实施进度。

模型 HTTP 在这组测试中仍为合成传输，不上传客户数据、不开微信/企微。三个独立连接池在一个 Node 测试进程中，不等于三个实际后端进程的容量或集群部署验收。封存/许可测试验证 SQL 互斥触发器，不把合成许可当作真实平台发送。本轮日常 555 项和此前 PostgreSQL 专项 20 项分别运行/报告。

## Windows 辅助程序及独立开发包

实际辅助项目为 `native/WindowsAdapter`，当前仅有元数据命令，没有发送功能。运行 `.\scripts\dev-tools.ps1 run build:win:dev` 重新发布自带 .NET 的 win-x64 辅助程序、类型检查并在 UUID 隔离目录构建/打包；不覆盖共享 `out`。产物在 `dist/windows-dev-<UUID>/win-unpacked`，包前/包后校验固定到实际编译入口的清单 SHA-256。包内测试用 `.\scripts\dev-tools.ps1 run test:packaged-native`，辅助只执行 `info`，另验证 SQLite、Provider 文件和合成账本恢复/旧设置迁移，不探测聊天客户端。详细命令、路径、停止确认和完整性边界见 [辅助程序说明](../native/README.zh-CN.md)。

本阶段新独立开发包 `19e5c960-ac45-4cdc-9093-147c5a5b880e` 已通过实际包内 0.2.0 info、辅助关闭确认、SQLite 写读、Provider、合成账本恢复/旧配置迁移及审核和严格 ASAR 清单。归档 166441081 字节、17604 条路径，SHA-256 `d5347a74729a274f04b89e4d80dbb508e82ed452e8d53fe63edae930dae33c43`。完整 `verify:release` 本阶段退出 0，包括 813 项测试、实际自建 WPF 元数据检查、构建、包内、完整默认桌面及反馈专项。新鲜生产/全部依赖审计均为 0；本阶段未执行完整软件渲染检查或正式安装。失败和具体边界见 [原生探针证据](native-probe.zh-CN.md) 与实施状态。

Windows 安装候选命令为 `build:win:installer:dev`，准备工具后再编译。当前候选从构建 `e20bec52-5f45-4a80-a6a9-4ae532d2a251` 的应用目录恢复封装生成；原完整构建曾因下载失败退出 1，恢复 NSIS 退出 0。包内、同一编译目录的默认桌面及反馈专项通过；安装文件内嵌应用和全部原生内容已核验。尚未实装、升级、卸载或签名；具体文件、摘要、命令和失败边界见 [安装包说明](windows-installer.zh-CN.md)。

`test:desktop:release` 检查同一隔离编译目录；`test:desktop:software` 显式使用测试专用软件渲染，不更改员工应用的渲染设置。两个模式保留 40 秒退出期限，要求退出码 0 及本轮报告通过。`test:workbench:feedback` 只检查实际轮询中的反馈保留、主动清除和读取恢复，不可冒充完整桌面检查；软件专项可用 `-NpmArgs @('run','test:workbench:feedback','--','--software-rendering')`。当前 `verify:release` 已实际完整通过，包含原生 WPF 和反馈门禁。包内/桌面检查新增 `--build-id <UUID>`，桌面显式编号优先于 npm 的 latest 默认；错误/重复编号启动前拒绝，报告绑定实际编号和归档摘要，防止共享 latest 变化后误验另一份产物。详细重复命令见原生探针文档。

```powershell
& '.\scripts\dev-tools.ps1' run test:dependencies
& '.\scripts\dev-tools.ps1' run build:win:dev
& '.\scripts\dev-tools.ps1' run test:packaged-native
& '.\scripts\dev-tools.ps1' run test:desktop:release
& '.\scripts\dev-tools.ps1' run test:desktop:software
```

上述产物是未签名目录包，不能当作 Windows 安装、升级、卸载或干净电脑验收。旧 `node-window-manager` 仍缺少本机原生编译产物；旧 Windows 引擎保持关闭。报告路径、失败记录及后续验收见实施状态。

v11 消息账本的开发备份、验证、隔离恢复命令见 [账本恢复说明](ledger-recovery.zh-CN.md)。它保留历史并阻止旧快照直接取得执行权；尚不包含所有配置/知识/学习/中央数据库的联合恢复和管理员解除阻断流程。

旧设置的开发迁移和只读汇总命令见 [旧设置迁移](legacy-migration.zh-CN.md)。显式提供原文件、私有 SQLite 档案和主机确认的 workspace，原始备份完成后才导入待审核草稿；不自动发现或改写员工当前设置。结构化模型凭据不进入草稿，但完全相同的原始备份仍含旧凭据，应保管在私有数据目录。运维 CLI 和备份不进入员工安装资源；私有编译入口仅供维护，无 renderer IPC 或启动自动导入。

人工审核及发布草稿使用 `legacy:review`，步骤见 [旧配置审核](legacy-review.zh-CN.md)。命令只写私有审核历史和新的发布文件，中央发布仍使用既有管理员登录。模式须人工确认明确的规则和当前审核版本，不能沿用旧开关自动启用。普通员工界面及稳定客户绑定仍待接入。

## Provider 代码边界

主进程仅加载随应用发布的 `resources/providers/volcengine-ark`。构建将清单和入口文件的 SHA-256 固定到编译代码；加载时核对固定 ID/版本/路径、完整目录与两份文件，然后执行刚刚验证的字节，避免重开文件加载不同内容。当前代码包必须为自包含 ES module；外部 URL、本地文件 URL、旧用户目录安装和冒用内置 ID 均不能取得执行权。模型 API 配置仍通过既有客户端处理，代码校验不授予发送权限。

Windows 包前/实际 ASAR 包后都核对编译时的 Provider 校验值与交付的资源文件；实际包内测试再次加载编译后的校验器。桌面检查还实例化实际已发布代码，测试专用 fetch 拦截器要求初始化请求为零，不执行模型生成。测试引导使用 Electron 官方启动器同样的 `setAppPath` 设置工作区根目录，以验证真实资源位置；不会使用员工配置。

打包采用明确文件白名单，包后和独立包测试共用同一实际清单守卫；历史 dist、源码、脚本、备份、Python 训练文件、tsbuildinfo、环境文件不能混入归档。训练功能仍不属于员工启动前提。失败构建保留隔离目录并记录阶段，不更新 latest 指针；不会删除历史产物或覆盖员工数据。
