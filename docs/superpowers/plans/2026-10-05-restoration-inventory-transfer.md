# 恢复清单认证上传 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 为 D16 接通目标员工端的恢复元数据认证上传、完整接收及管理员逐项核对，继续推进原 D00–D20 目标。

**Architecture:** 沿用账号行锁、目标设备认证和已保存的主进程暂停声明。服务端保存不可修改的上传会话、分页和条目；完成时重新计算源清单哈希和统计，管理员只能把完整接收的清单用于核对。桌面主进程自行读取恢复上下文和注册身份，不接受渲染进程提供路径或身份。

**Tech Stack:** TypeScript、Zod、SQLite、PostgreSQL、Electron、Vitest。

**Spec:** `docs/development-plan.zh-CN.md` D16；`docs/ledger-recovery.zh-CN.md`。

## Global Constraints

- 保留 D00–D20 整体目标，不能以本轮完成替代全部完成。
- 本轮真实聊天读取、真实消息发送及模型调用均为 0；不询问实机就绪。
- `canRelease: false`、`externalEvidenceRequired: true`；完整接收只证明恢复元数据一致。
- 不修改 unknown 执行结果，不解除账号暂停，不改变现有测试超时和断言。
- 清单不含消息正文、回复正文、凭据或模型密钥；严格拒绝额外字段。
- 保留其他作者的学习模块和当前 schema 11/12 兼容性。

## Review Focus

- 响应丢失后的相同重试应返回原收据；同一请求或分页被修改应冲突。
- 另一设备、租户、账号、来源或已撤销身份不能上传或查询他人的清单。
- 缺页、重复条目、乱序、错误统计及内容哈希必须使完成失败。
- 上传期间状态改变、会话过期或设备改变不得变成可发送状态。
- 管理员查询分页必须覆盖全部条目，并区分本地声明和中央执行记录差异。

### Task 1: 严格清单协议和认证分页接收

**Files:** `src/shared/contracts/restore-inventory.ts`；`server/src/execution/restore-inventory-authority.ts`；`server/migrations/025-restore-inventory.sql`；`server/src/http/application.ts`；`tests/integration/restore-inventory-transfer.test.ts`。复用既有 index 装配，未修改其行为；迁移 024 留给同期学习实现。

- [x] 写实际 HTTP + PostgreSQL 测试，先验证缺少接口导致失败。
- [x] 每次操作从员工凭据派生 scope、持账号行锁、验证账号暂停/无活动租约/无有效发送许可。
- [x] start 绑定已保存暂停报告、restore/context/basis/summary 和请求 UUID；会话有效期 15 分钟。
- [x] page 限制 100 条/512 KiB；连续页号、严格键顺序、条目 scope；相同页幂等，变更页拒绝。
- [x] complete 遍历全部保存条目，重算原清单 basis 和统计；原子写入不可变收据。当前在服务器内读入完整元数据集，百万条吞吐尚未验收，不以协议数量上限作为性能证明。
- [x] 验证角色权限、RLS、完整性和响应丢失重试；不写入放行权限。

### Task 2: 管理员逐项读取和执行差异

**Files:** `server/src/admin/restore-inventory.ts`；`server/src/admin/administration.ts`；`server/src/admin/command.ts`；上述集成测试。

- [x] 先写非管理员拒绝、完整/未完整状态、全部分页及错误 case/upload 测试。
- [x] 复用管理数据库登录和账号锁，新增清单列表及条目查询命令。
- [x] 执行条目关联中央 permit，比较 task/draft/身份/会话/status/settlement；保留缺失和 unknown 原状。
- [x] 验证 late settlement 时查询更新、恢复来源不变、账号仍暂停。

### Task 3: 私有主进程上传与现有恢复面板

**Files:** `src/main/services/agent-registration.ts`；`src/main/services/desktop-agent-runtime.ts`；`src/main/ipc/restoration-ipc.ts`；`src/preload/index.ts`；`src/shared/contracts/restoration.ts`；`src/renderer/src/features/agent/RestorationControls.tsx`；相关 runtime/IPC/UI 测试。

- [x] 先写身份切换、暂停/上传失败及重试测试；主进程派生 context/scope。
- [x] 读取固定来源清单、提交全部页面和完成收据；失败仍保持暂停。
- [x] 私有 IPC 只接受空参数；现有面板显示进度和完整接收回执，不增加放行按钮。

### Task 4: 验证和交付记录

- [x] 运行专项、类型、lint；SQL 变更跑真实 PostgreSQL 检查。
- [x] 在源代码稳定后串行执行完整回归，不与打包竞争资源。
- [x] 复用独立审查员检查权限、完整性和重试；修复实际问题。
- [x] 更新 D16/进度及证据，继续保留实机、安装、准确度、多员工试点及正式恢复放行待验收。

## Execution Record

本增量证据：`.local/reports/restore-transfer-stage/baeba446-65f5-4654-8379-a1675bece952/result.json`。完整回归 112 文件/1141 项通过，其后学习集成修复五文件/126 项通过；真实 PostgreSQL 41 项、固定 Windows 开发包和恢复界面通过。全库 lint 仍失败，完整目标与发布状态仍为未完成。构建、审查修复、已知边界及下一阶段见 `docs/implementation-status.zh-CN.md` 2026-10-05 认证上传章节。
