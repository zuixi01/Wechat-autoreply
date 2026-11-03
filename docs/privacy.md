# 数据与隐私说明

本文说明当前个人微信路径的实际数据流，不替代你所配置供应商的数据政策。企业服务和外接 Provider 的范围分别见 [企业服务](../server/README.md) 与 [Provider 接入](provider.md)。

## 哪些数据会离开本机

| 功能 | 发送到哪里 | 请求可能包含的内容 |
| --- | --- | --- |
| 微信视觉读取 | 你配置的视觉模型接口 | 微信窗口、聊天列表、联系人标题、聊天气泡和草稿区域的截图或裁剪图 |
| 回复生成与重写 | 你配置的回复模型接口 | 本轮新消息、近期历史、回复规则、联系人资料、检索到的知识片段、适用的本人用词样本 |
| 模型连接测试、知识试答 | 所选择的模型接口 | 测试输入或试答问题，以及相应提示词和检索片段 |

模型请求使用配置中的 API 密钥认证，可能产生费用。HTTPS 保护传输，不保证供应商不保存、分析或训练这些数据；是否保留、保留多久以及如何删除，应查阅所选供应商政策。截图可能包含聊天中其他人的信息，即使本轮只准备回复一条消息，也应先确认处理权限。

个人模式无需启动企业服务。使用企业连接后，中央服务会按该功能协议处理设备身份、知识、审核、调用和恢复记录，不能套用“数据只在本机”的假设。可选 Provider bundle 是外部代码，其网络行为和数据处理还取决于 bundle 本身；只安装来源可信且已审阅的内容。

## 本机保存位置

桌面客户端使用 Electron 的 `app.getPath('userData')` 作为资料根目录；Windows 上通常位于当前用户的 `%APPDATA%` 内，实际名称可能随应用标识、开发或打包方式而变化。不要假定源码仓库目录就是用户数据目录。

| 相对用户数据目录的路径 | 内容 |
| --- | --- |
| `settings.json` | 模型接口及密钥、规则、联系人和客户端设置 |
| `agent/foreground-wechat.sqlite` | 已识别文字、会话基线、回复、发送记录及待人工核对状态 |
| `agent/personal-style.sqlite` | 本人用词样本与相关记录 |
| `agent/stickers/` | 导入的静态表情图片及配置 |
| `knowledge/knowledge.sqlite` | 导入资料提取的文本、元数据、版本和全文索引 |
| `worktrace/` | 启用相关工作记忆功能后保存的记录 |

这些文件可能包含敏感信息。个人模型配置不应被视为凭据保险箱，也不能把企业设备令牌的专用加密机制等同于全部设置和数据库已加密。保护当前 Windows 账户和备份访问权限，不要同步到公开网盘、提交到 Git 或打包进 Issue。

开发和实机检查还可能在仓库的 `.local/reports/`、`dist/` 或隔离测试目录生成报告、截图和产物。这些是本地产物，不随源码提供；提交前仍需核对实际暂存内容，忽略规则不会清除已经跟踪的文件。

## 分享、清理和撤销

- 分享问题时优先提供错误阶段、版本和使用合成消息的复现；逐项遮盖截图与日志中的姓名、正文、地址和凭据。
- 不需要的知识资料、用词样本和表情素材可从相应界面管理。不要为了绕过故障随意删除发送账本；丢失基线或未知结果证据可能导致无法安全续接，先按 [使用说明](personal-wechat.md) 核对。
- 卸载、删除源码或清理构建产物不代表清除了用户数据、供应商记录或其他备份。需要彻底移除资料时，先停止自动回复并退出应用，确认准确的用户数据目录及备份范围后再自行处理。
- 不再使用或已经暴露的模型密钥应在供应商侧撤销或轮换；删除本机配置不等于撤销远端凭据。

## English summary

Vision providers receive WeChat screenshots. Reply providers receive new messages, recent history, rules, retrieved knowledge and relevant wording samples. Requests use your configured provider and may incur costs; local execution does not keep all data local. Settings and databases under Electron's `userData` directory can contain credentials and private text. Do not upload profiles or raw diagnostics. Removing the app or a local file does not delete provider records, backups or Git history; revoke compromised keys at the provider.
