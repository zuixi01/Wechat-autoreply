# Jev 调用期限与响应校验

Jev 负责前置决策和最终草稿审核，文本模型负责生成草稿。两者只返回绑定任务的结果，发送目标和执行许可仍由程序控制。

## 当前调用行为

`TypeSafeClient` 每次尝试默认超时 3 秒，最多尝试 2 次，重试等待至少 150 毫秒；调用方提供的任务截止时间进一步缩短这些预算。一个计时器覆盖响应头和正文读取，JSON 解析另受正文大小限制。客户端同时发出取消信号并结束本地等待，不依赖传输层主动响应取消。

客户新消息、员工接管或暂停取消请求时，不再重试。超时或暂时服务错误可在总期限内有限重试；认证失败、重定向、非法响应不重试。上一尝试在取消后迟到的响应会丢弃，正文流会取消，不能覆盖新结果。获取模型列表也使用相同的期限和正文限制。

每份 Jev 响应最多 2,000,000 个 UTF-8 字节，边读边计数；没有 Content-Length 或声明过小也不能绕过限制。超过声明上限时不读取正文。超限、结束、取消和 HTTP 错误都会关闭正文读取，不把供应商错误正文带入日志或异常。严格 UTF-8 解码拒绝非法字节，避免静默替换字符后接受响应。

Jev 答案仍须与原问题逐项匹配：缺题、类型错配、未知选项、非法概率和评分量表变化都使整轮无效。大小或格式校验失败不能用其他题的高分补救，也不能产生自动发送权限。

调用记账层与客户端使用一致的严格 UTF-8 解码；非法正文不保存为已验证答案，不凭缺失用量记零。独立文本生成器也拒绝非法 UTF-8，保留既有 256 KiB 正文限制、模型版本和 JSON 草稿校验。

## 取消的边界

本地返回超时不证明远端供应商已经停止或不会计费。生产记账先持久化每次调用的额度预占，再调用模型；取消后迟到的供应商回执只能补记事实，不能恢复任务或授予发送权限。故障、未知用量及历史预占不会因客户端取消自动清零。

这些修复提高调用稳定性和异常输入处理，不构成 Jev 业务准确度提升的证据。真实业务效果仍需要 D20 的独立标注、校准/留出样本和 A/B/C 对照，以及最终多员工实机验收。

## 离线验证

```powershell
node node_modules/vitest/vitest.mjs run tests/integration/jev-bounded-transport.test.ts tests/integration/jev-contract.test.ts tests/integration/model-call-transport.test.ts tests/integration/text-generator.test.ts tests/integration/learning-enterprise-budget.test.ts tests/integration/generation-service.test.ts
```

新增测试覆盖不响应取消的传输、卡住的正文、迟到响应、总截止时间、有限重试、缺失/虚假的大小声明、准确字节边界、跨块中文解码、非法 UTF-8、错误正文释放，以及实际本地 HTTP 分块响应。所有输入和密钥为合成测试值；不连接真实 Jev，不读取或发送微信/企微消息。

2026-10-06 最终证据：

- 全量 `.local/reports/jev-transport-full-final.json`：131 文件、1327 项通过，0 失败/跳过，285.87 秒。
- 专项 `.local/reports/jev-transport-contracts-final.json`：6 文件、110 项通过，包含新 Jev 边界 17 项和文本 UTF-8 两项。
- 实际 PostgreSQL `.local/reports/postgres-concurrency/6c8b5868-9cdb-4381-a37d-a54116218815/result.json`：42 项通过，临时容器清理成功。
- 主进程、界面、全服务类型检查通过；`.local/reports/jev-transport-lint-final.json`：5 文件，0 错误/警告。
- 源码和证据摘要 `.local/reports/jev-transport-stage/1a2990c4-e4a8-45be-a31b-74790673fa32/result.json`：验证前后本次代码摘要一致，`incrementChecksPassed=true`、`fullGoalComplete=false`、`releaseReady=false`。共享工作区未冻结，没有新打包/安装/提交或独立复核。

初始失败证据保留：原客户端边界测试 10 失败/2 通过；记账一致性测试 1 失败/16 通过；文本 UTF-8 测试 2 失败；首轮服务类型检查的新增夹具 ArrayBuffer 类型错误已修正。没有删除失败断言或放宽测试期限。
