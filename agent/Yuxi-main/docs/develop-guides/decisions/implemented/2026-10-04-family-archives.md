# 现有 Yuxi 中的家庭档案模块

状态：implemented
类型：feature
Owner：backend/package/yuxi/services/family_service.py

## 问题

家庭档案管理需要连接既有认证、页面和业务事实。家庭管理关系与健康信息访问权限分开，统计也需要遵循当前授权范围。

## 决策

### 实现方案

`FamilyArchivesView.vue` 复用现有布局、认证、主题和 PageHeader，在 `/family` 下组织成员档案、健康指标、统计概览和授权管理四个视图。普通读写通过 `/api/family` 业务接口完成。

`family_service.py` 拥有家庭事务与权限边界，`family_repository.py` 拥有持久化查询。PostgreSQL 保存家庭、成员、测量记录、档案版本与无健康值的审计记录。家庭行锁使授权变更与受控读写按事务串行执行。测量 UUID 与不可变创建输入处理重试，档案和更正采用乐观版本校验。

本人管理自身健康信息；家庭管理员访问其他成员时，服务端校验认领账号、字段、家庭营养管理用途、有效期与成年条件。出生日期采用本人档案声明，不提供身份核验。邀请认领不自动授予健康访问权限；授权撤回后历史、导出、指标和聚合同样按当前范围过滤。前端刷新重新请求指标和统计，并清理失效的敏感展示。

家庭域表由 `yuxi.storage_migration` 拥有；上游与家庭的组合 schema 为 11。上游兼容背景见 [上游升级决策](./2026-10-04-upstream-family-upgrade.md)，成员生命周期、独立代维护授权和指标作废迁移见 [日常维护闭环](./2026-10-08-family-archives-completion.md)。API 和 Worker 继续要求精确的运行 schema，运行时不新增建表路径。

## 替代方案

独立原型便于交互评审，但用户已选择后端保存与授权，需要真实服务边界。浏览器存储健康信息增加撤回和共享控制成本。业务模块直接复用 Yuxi 的装配结构和 PostgreSQL，避免增加独立应用与数据库。

## 后果

成员需要平台账号完成本人认领。成人授权依据本人填写的出生日期；未成年人监护授权、专业复核与 Agent 消费档案另行实现。统计表示授权可见的档案状态和记录行为，不包含疾病判断、医学阈值或健康评分。部署需要沿用停机迁移流程并保持既有 `API_KEY_DERIVATION_SECRET` 稳定。

## 验证

`backend/test/integration/test_family_archives.py` 通过实际 TCP HTTP、正式路由、JWT 认证和独立 PostgreSQL schema 验证无授权、跨家庭、字段投影、过期、撤回、重放、版本冲突、成年限制及并发幂等；`test_family_migration.py` 实际调用迁移入口两次，验证版本 7/8/9 数据保留与版本 10 收敛。两个文件共 13 项通过，并接入 `system-tests.yml`。

前端 unit 397 项通过；Ruff、前端 lint/build、工程契约检查及其 63 项测试通过。浏览器验证创建、确认、更正、两账号字段授权、外部新增记录后的刷新、撤回后的展示与聚合更新。完整 Compose 的核心服务与正式 HTTP 装配通过验证；其他业务集成、Agent Worker E2E 和生产部署未验证。
