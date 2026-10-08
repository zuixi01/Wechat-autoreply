# 旧设置迁移到待审核草稿

本步骤承接已批准的 D16。旧 settings.json 的规则和客户关系不等于新版已发布策略或稳定身份；先保留原文件，再导入独立草稿档案。当前不修改员工正在使用的设置，不调用模型、插件或聊天客户端。

Ruling: 迁移归属以主机确认的私有 workspace 为边界；旧姓名、modeId 和对象 ID 只保留为来源标识，不授予企业账号或客户身份 — 旧名称在多员工/多平台下不唯一 — 错误归属必须重新审核，不能自动绑定。

实施顺序：真实文件/SQLite 失败测试 → 严格解析与原文件备份 → 幂等草稿事务/失败恢复 → 运维命令和实际编译验证。常规实施沿用已授权开发分支，不重新请求开发许可。

- 原文件限 8 MiB，拒绝文件/目录别名；在私有档案旁按实际 SHA-256 保存完全相同的原始字节，完成并刷盘后才导入。原始备份可能包含密钥，不能作为公开报告或打包资源。
- 草稿只保留界面偏好提示、旧回复规则/统一开头，以及客户名称/称呼/关系和来源模式。结构化模型密钥、Provider 安装/URL、模型连接、捕获坐标、运行状态和批准记录不写入草稿。规则/关系自由文本仍属私有资料，不能假定其中没有敏感内容。
- 所有草稿处于 pending，automaticEnabled=false、identityVerified=false；旧自动回复要求只作审核提示。原名称不能变成 conversationId，同名对象不合并。
- 同一原文件重复运行不重复导入；仅密钥等被排除字段变化时，保存新的原始备份和来源关联，复用内容未变的草稿。规则改写追加不可变草稿，不覆盖旧版本。
- 档案固定归属 workspace，其他 workspace 不能打开；原文件、导入记录、草稿来源关联事务提交。事务失败不修改已有记录，原始备份保留，修复后可重新运行。

当前产物是待审核档案；已增加[私有审核与发布草稿命令](legacy-review.zh-CN.md)，可将人工确认的模式交给现有管理员发布流程。员工界面入口、稳定客户绑定、业务事实验收和设备/中央数据库联合恢复仍待接入。不能将迁移成功视为自动回复可启动，也不能靠编辑旧布尔值绕过 Sender 和中央许可。

开发命令使用明确的私有来源和目标，不自动查找员工配置。`workspace` 是主机确认的私有档案归属，不是旧账号名称：

```powershell
./scripts/dev-tools.ps1 -NpmArgs @('run', 'legacy:migrate', '--', '--source', 'C:/private/settings.json', '--archive', 'C:/private/migration/drafts.sqlite', '--workspace', 'employee-private-profile')
./scripts/dev-tools.ps1 -NpmArgs @('run', 'legacy:inspect', '--', '--archive', 'C:/private/migration/drafts.sqlite', '--workspace', 'employee-private-profile')
```

`inspect` 只读打开已有档案；缺失路径不会创建数据库，也不能进行导入。命令只输出计数、状态和备份位置，不输出规则、客户名或密钥；错误只输出固定代码。原文件未改写，字节完全一致的备份位于 `<archive>.backups/<SHA-256>/source.json`。导入失败时先保留备份，修正原文件或存储问题后重复迁移；原始凭据仍在私有备份中，需要按员工数据保管。生成草稿和来源关联在同一 SQLite 事务中提交；重复导入核对现有内容摘要，篡改档案拒绝复用。

Electron 打包包含私有 `out/main/legacy-migration.js` 维护入口，无 renderer IPC，也不会启动时自动导入。运维 CLI 不进入员工包，迁移档案及原始备份均不作为打包资源。
