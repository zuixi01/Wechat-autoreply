# 旧配置审核与发布草稿

按已授权 D16 继续实现。原始迁移草稿永久保留；人工接受、拒绝、重新审核作为独立追加记录，绑定 workspace、原内容摘要、审核人和递增版本。并发提交须给出预期版本；重复请求只复用原记录，不能覆盖后来的审核。客户关系确认不会生成稳定身份或自动回复权限。

Ruling: 接受回复模式时要求人工明确填写 1–12000 字回复规则。旧 prompt 可达 32000 字，旧统一前缀没有对应的中央发送后处理；不得静默截断或冒称完全继承旧行为。

Ruling: 审核人名称仅为私有操作记录，不等于中央管理员认证。准备发布只接受当前已接受的模式审核，以及 automaticEnabled=false、mode=shadow、evaluationApproved=false、无 evaluationApprovalId 的明确版本模板。中央管理员仍经既有发布事务、租户权限和业务验收门禁处理。

验证：真实 SQLite 审核历史、幂等重试、过期版本、回滚、只读 v1 兼容/写入升级、客户身份隔离与篡改拒绝；发布模板往返中央管理员事务。命令输出只含计数和摘要，私有客户/规则内容只写操作者指定的新文件。

本阶段不代表完整 D16、实际微信/企微收发、Jev 业务准确度或全目标验收完成。

## 操作步骤

命令只操作指定的既有私有档案。`catalogue` 默认导出 50 项，可使用 `--offset` 和 `--limit`（最多 100 项）分页。目录项包含原草稿与当前审核记录；规则、客户关系和审核理由不输出到终端。每次导出须指定新的文件名。

```powershell
./scripts/dev-tools.ps1 -NpmArgs @('run', 'legacy:review', '--', 'catalogue', '--archive', 'C:/private/migration/drafts.sqlite', '--workspace', 'employee-private-profile', '--output', 'C:/private/catalogue-1.json')
```

人工从目录取 `draft.id`、`draft.contentHash` 和当前审核 `revision`（未审核为 0），填写新私有 JSON：

```json
{
  "sourceId": "review-request-unique-1",
  "draftId": "填写草稿的64位摘要",
  "expectedContentHash": "填写原内容的64位摘要",
  "expectedReviewRevision": 0,
  "decision": "accept",
  "reason": "已按现行业务资料重新核对",
  "replyRules": "先确认型号；价格以已批准资料为准，缺资料交给员工。"
}
```

接受回复模式必须明确写规则；接受偏好/客户关系，或 `reject`/`reopen`，不得提供 `replyRules`。每次新操作使用新 `sourceId`；相同操作重试保持整个请求及审核人不变。旧重试返回原记录并注明是否仍为当前审核，不能把重新审核的状态恢复为接受。

```powershell
./scripts/dev-tools.ps1 -NpmArgs @('run', 'legacy:review', '--', 'review', '--archive', 'C:/private/migration/drafts.sqlite', '--workspace', 'employee-private-profile', '--file', 'C:/private/review-1.json', '--reviewer', '审核人记录名')
./scripts/dev-tools.ps1 -NpmArgs @('run', 'legacy:review', '--', 'prepare', '--archive', 'C:/private/migration/drafts.sqlite', '--workspace', 'employee-private-profile', '--draft', '当前模式草稿摘要', '--revision', '1', '--template', 'C:/private/shadow-publication.json', '--output', 'C:/private/prepared-publication-1')
```

发布模板沿用 `server/admin/publication.example.json` 的结构，由管理员填写准确的模型、知识和配置版本。准备命令仅以审核规则替换 `replyRules`，不猜测模型版本或知识事实。新目录含 `publication.json`、私有 `provenance.json` 和最后写入的 `manifest.json`（两文件的字节长度/SHA-256）。已有目录或文件拒绝覆盖；失败留下的无清单目录不能作为完整产物，应另指定新目录重新准备。

`publication.json` 可交给现有管理员 `publish --file`，详见 `server/admin/README.md`。本命令不连接中央服务或调用模型。来源文件保留工作区、原内容、审核版本/摘要和发布内容摘要；审核姓名是私有记录，中央权限仍由管理员数据库登录决定。准备时要求审核仍为当前接受状态；文件是该时刻的草稿，后来重新审核不会自动撤回已导出的文件或中央版本，管理员应重新准备、核对并发布新版本。中央发布仍保持账号暂停，业务评测批准和自动启用另走原门禁。

档案写入打开时事务升级到 v2；只读 v1 档案可检查且不会升级。审核记录拒绝常规 UPDATE/DELETE，并验证来源和摘要链；数据库所有者有能力绕过本地保护，因此摘要链不是签名或独立管理员身份凭证。员工界面入口与稳定客户绑定仍待接入。
