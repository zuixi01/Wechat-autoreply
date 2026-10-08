# 2026-10-07 管理员入口执行记录

本轮承接全员暂停命令，完成现有桌面页面中的可操作管理员入口。使用 Product Design 的现有项目组件原则，沿用企业连接页面的卡片、表单、按钮和颜色；已运行上下文预检，本机没有保存的额外设计参考。不另建网站、模板或发布站点。

## 已实现

- 独立 `admin:serve` 进程，专用管理员数据库登录、固定企业、独立管理凭据；启动时拒绝超级用户、绕过 RLS、可切换特权角色及非管理员登录。
- 每次操作通过 `Administration` 再次核对真实数据库管理员映射。员工正常 HTTP 服务不开放管理入口。
- 严格五种操作：身份、设备分页、全员暂停、批次摘要和批次账号分页。请求不能指定企业、恢复发送或执行任意命令。
- 现有 Electron 主进程私有管理连接与七条具体 IPC，沿用精确渲染器来源校验。管理凭据只驻留当前主进程内存，不写盘或回传状态。
- 请求最长等待 8 秒，禁止重定向，响应限 2 MiB；断开取消请求、阻断迟到登录。网关入站 JSON 限 16 KiB、拒绝浏览器 Origin，最多同时处理八个已认证操作。
- 「企业连接 → 企业管理员」实际组件支持登录、设备分页、全员暂停、原编号重试及账号分页；同步工作锁防止连续点击创建不同批次。
- 最近批次编号和确认状态随当前管理会话在页面切换后保留。退出程序、断开或更换连接前须记录编号；本轮没有跨重启管理操作记录。
- 真实停止声明与物理停止验证清楚区分。权限撤销后清除管理列表；不开放自动发送或恢复围栏。

## 验证及保留的失败

初次格式检查发现 JSX 事件括号错误，已修复。初次 lint 发现五处缺少返回类型，已补齐；没有关闭规则。

定向回归报告：`.local/reports/admin-console-targeted-final.json`。覆盖实际嵌入式 PostgreSQL HTTP 请求、管理员映射撤销、跨企业、批次事务与幂等、入站界限、主进程取消/迟到/超限以及 IPC 来源校验。

该报告为 7 文件 / 44 项，零失败/跳过。最后通过 `.local/reports/admin-console-wire.json` 的 6 项 HTTP 集成验证，已包含真正的主进程 `AdminConnection` → 本地 HTTP → 嵌入式 PostgreSQL 管理员认证、运行状态解析、暂停、账号分页及当前会话批次记录，不只依赖各层独立模拟。

构建报告：`.local/reports/admin-console-build.log`，真实 main/preload/renderer 编译成功。本次构建到开发 `out/`，不是新安装包或已安装客户端。

桌面第一次通过：`.local/reports/desktop-smoke/e2db9ad5-1507-49a5-88aa-94536f733ccb/result.json`。使用真实 Electron、生产渲染器/预加载及合成管理 IPC；网络尝试、真实聊天操作和真实模型调用均为 0。验证失败后原 UUID 重试、组件重新挂载后保持编号、设备/账号分页和权限撤销；两张实际截图已打开检查。之后只将夹具的 1970 时间改为当前合成时间，后续截图复验单独记录。

主进程和界面类型通过，服务端一次遇到共享评测测试尚未接通 `evaluation` 参数的类型失败：`.local/reports/admin-console-type-services-final.log`，保留原报告。本轮没有修改该学习预算实现或测试；当前实现随后完成，`.local/reports/admin-console-type-services-recheck.log` 复验通过。

19 文件 scoped lint 最终通过，报告 `.local/reports/admin-console-lint-verified.log`。未声称全库 lint 通过或有新的独立复核。

全量回归 `.local/reports/admin-console-full.json`：148 文件、1445 项，1444 通过、1 失败、0 跳过，364.62 秒。失败为共享 `learning-enterprise-product-validation` 新三路评测在已经加载的旧预算实现上申请 1800 调用，超过旧 1201 上限。运行期间该实现已新增按 `evaluation` 用途的上限，保留原失败报告，并对当前受影响文件及本增量重新验证；没有修改其测试期限、删除断言或将本轮全量记为全绿。

桌面最终复验 `.local/reports/desktop-smoke/be75f6b7-832f-4c38-b067-8a9ba8a2e05f/result.json` 通过。更新时间夹具后的实际截图仍为合成数据；两次通过均为零网络/聊天/模型操作，不代表真实企业网络或收发通过。

当前受影响文件及管理员增量复验 `.local/reports/admin-console-current-recheck.json`：8 文件 / 61 项，60 通过、1 失败、0 跳过。原来的评测额度测试已通过；同一共享文件随后新增三路采集测试，但采集函数尚未导出，故该新测试失败。管理员 44 项全部通过。本轮未修改该评测业务实现、放宽断言或继续反复跑全库。共享评测开发仍在进行，完整工作区验收保持未通过。

## 未完成的完整目标

真实管理证书/网络部署、真实后台聊天观察与不干扰办公的发送、多电脑联调、实际业务 Jev 准确度、正式签名安装、恢复/回滚和员工工作日试点仍未完成。当前工作区存在另一条学习评测开发线，未冻结整个仓库；未提交、安装、外部部署或操作真实聊天/模型。

操作说明见 [管理员界面](../../admin-console.zh-CN.md)。继续推进后台收发适配器和真实业务验收所需的准备工作。

最后阶段记录：`.local/reports/admin-console-stage/3c883374-0b42-4366-a447-227e2efd06ed/result.json`。保存验证后的 22 个相关源码摘要与测试计数；`adminFeatureChecksPassed=true`，`fullWorkspaceChecksPassed=false`、`fullGoalComplete=false`、`releaseReady=false`。摘要取自最后功能验证后，不能用于声称全量运行前后整个工作区被冻结。未新造安装包、安装、提交、外部部署或独立复核。
