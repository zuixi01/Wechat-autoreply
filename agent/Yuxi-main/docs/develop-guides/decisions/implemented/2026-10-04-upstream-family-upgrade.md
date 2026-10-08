# 上游升级与家庭扩展的组合兼容

状态：implemented
类型：architecture
Owner：backend/package/yuxi/storage_migration.py

## 问题

用户要求保留全部 Yuxi 能力并升级到上游当前 main。原家庭档案测试后端只装配认证与家庭接口，无法验证完整平台。上游业务 schema 为 9，本地家庭域使用的版本 8 并不等同于上游版本 8。

## 决策

固定上游提交 031e2c72681edb8f95f71b60ceb66881f7915b8d，三方合并家庭扩展；采用组合业务版本 10。家庭能力的用例边界由 [家庭档案决策](./2026-10-04-family-archives.md) 拥有。

### 实现方案

`storage_migration.main` 在 PostgreSQL advisory lock 内接受未版本化数据库与 2/7/8/9，补建家庭域表；2/7/8 执行业务结构收敛，覆盖本地家庭版本 8 的历史结构。上游 `upgrade_agent_resource_selection` 原子转换旧 Agent 资源选择并记录中间版本 9；仅从旧资源协议调用，当前 9/10 的空数组保留原意。迁移的数据库与文件步骤全部完成后记录组合版本 10；失败时不发布组合版本，API 和 Worker 只接受精确当前 schema。

`server.main` 注册全部上游路由和家庭路由，由既有 Compose 装配 API、独立 Worker 与基础服务。前端复用上游布局和路由，只增加家庭菜单及页面。运行数据库和文件状态属于本项目独立目录；预览 fixture 不承担正式平台的验收。

## 替代方案

只补复制上游新增文件会保留旧调用方并造成版本不一致。重置整个子项目会覆盖已实现的家庭功能。固定上游版本并三方合并保留功能与可复核的来源。

## 后果

组合 schema 高于上游版本；后续合并须同时核对上游协议与家庭表，不能只覆盖版本常量。源码回滚须恢复匹配的数据库备份。部署保持家庭邀请使用的派生密钥稳定。上游移除的旧模块按上游替代实现收敛，升级前源码和数据备份供恢复。

## 验证

`test_family_migration.py` 的 4 项真实 PostgreSQL 测试覆盖 7/8/9→10、旧家庭档案及授权保留、旧资源转换与新空选择重跑，以及后续步骤失败不发布组合版本。`test_schema_migration_version.py` 的 12 项覆盖上游 schema 及资源迁移原子性；`test_family_archives.py` 的 9 项使用真实 HTTP 和 PostgreSQL 验证权限、版本及幂等。migrator unit 的 16 项验证当前版本不执行 DDL、支持版本与失败时的版本记录边界。

正式 Compose 的核心服务启动成功；HTTP readiness 验证 PostgreSQL、Redis 和兼容 Worker，所有启动组件正常。OpenAPI 同时包含知识库、图谱、评估、智能体、Skills 和家庭接口。后端完整 unit 2513 项、前端 397 项测试、lint/build、工程契约检查及 63 项测试、文档构建通过。

模型、RAG、图谱完整业务 E2E 和生产升级未验证；真实调用需要部署者的模型供应商配置。
