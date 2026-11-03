# 微信自动回复 · WeChat AutoReply

[English](README.en.md) · [使用说明](docs/personal-wechat.md) · [贡献指南](CONTRIBUTING.md)

Windows 个人微信前台自动回复客户端，基于 SightFlow 开发，使用 Electron、React、视觉模型和 Windows 窗口辅助程序。仓库同时包含独立的企业回复服务。

**当前为开发预览版。** 单联系人流程有有限真实收发记录；批量模式尚未完成两位联系人连续收发的最终实机验收，企业后台收发仍需要经过验证的平台适配器。开源不代表生产就绪，当前限制与历史验证范围见 [个人微信能力报告](docs/capability-report.wechat.md) 和 [企业能力报告](docs/capability-report.wework.md)。

## 能力与限制

- 单联系人：读取可见新文字，按回复规则和知识资料生成，核对联系人、窗口和草稿，保存 SQLite 记录后发送，再核对微信回显。
- 进度与人工处理：保留暂停和重启进度；发现人工草稿、身份冲突或未知发送结果时等待或阻止继续，供本人核对。未知结果不会自动重发。
- 个性化：联系人专属规则、本人用词样本、知识检索、分段回复和导入的静态表情图片。
- 多联系人：仅处理明确填写的名单，共享单联系人进度；属于实验功能，详见 [批量模式](docs/personal-wechat-batch.zh-CN.md)。
- 企业服务：包含设备登记、受控知识、工作记忆、人工审核与恢复流程；窗口探测本身不提供后台聊天读取或发送能力。

个人模式需要微信窗口完整位于主显示器并保持前台，会占用当前桌面。切换应用或通知遮挡时等待，恢复后重新校验。群聊、语音、图片和文件来信不作为可自动回复的文字处理。视觉识别可能出错或超时，现有实测不证明长期稳定、消息完整覆盖或微信升级后的兼容性。仅在你有权处理的账号和会话中使用，并遵守适用的平台规则。

## 从源码启动

完整开发环境：**Windows x64、Node.js 24.21.0（见 [.node-version](.node-version)）、.NET 10 SDK、Python 3，以及 Visual Studio C++ Build Tools（含 Windows SDK）**。Node 24 下窗口相关原生依赖需要通过 `node-gyp` 构建；Python 是构建工具，应用运行不需要 Python 服务。`.local/toolchain` 只是可选的本地工具目录，不随仓库提供。

```powershell
git clone https://github.com/zuixi01/Wechat-autoreply.git
cd Wechat-autoreply
npm ci
npm run dev
```

`npm ci` 会安装并重建 Electron 原生依赖，请保留安装脚本。开发启动与普通构建会编译个人微信窗口辅助程序，并绑定其哈希。安装失败及工具准备见 [开发环境](docs/development-environment.md)。

只做源码或文档贡献时，可使用 `npm ci --ignore-scripts` 后运行 `npm run check:source` 和 `npm run verify`；这条路径不准备 Electron 原生依赖，不能用于运行客户端、桌面测试或 Windows 打包验收。

1. 登录个人微信，只保留一个完整主窗口，放在主显示器内。
2. 在“模型配置”中添加兼容 Chat Completions 的 HTTPS 接口和密钥，测试连接；在主页选择支持图片输入的视觉模型和回复模型。
3. 保存统一回复规则；按需添加联系人专属要求和知识资料。
4. 输入准确备注名，启动单联系人模式。同名或搜索不完整时，先手动打开指定单聊并清空草稿，再使用“接入已打开的聊天”。

单联系人首次启动只建立基线，不回复历史消息；批量模式会处理授权名单内的现有未读消息。遇到无法确认的发送结果，应先在微信中人工核对。完整操作与恢复说明见 [个人微信使用说明](docs/personal-wechat.md)。

## 数据与模型调用

视觉模型会收到微信窗口、聊天列表或气泡截图；回复模型会收到本轮新消息、近期历史、回复规则，以及检索到的知识片段和适用的用词样本。请求发送到你配置的模型接口，可能产生供应商费用；本地运行客户端不等于聊天数据只在本机处理。使用前确认供应商的数据政策及你对相关数据的处理权限。

模型配置和密钥、联系人规则、知识文本、已识别消息、回复和处理进度保存在本机用户数据目录；不要分享整个配置目录、数据库或未经脱敏的日志和截图。数据文件位置与处理建议见 [数据说明](docs/privacy.md)。企业服务的数据处理边界另见 [企业服务文档](server/README.md)。

## 检查与构建

在仓库根目录运行：

```powershell
npm run check:source             # 源码仓库检查，不启动微信
npm run verify                   # 类型检查、静态检查、日常自动化测试
npm run build                    # 编译应用与个人微信辅助程序
```

Windows 可运行目录和安装包：

```powershell
npm run build:win:dev
npm run test:packaged-native
npm run test:desktop:release
npm run build:win:installer:dev
```

这些检查不能替代真实微信、安装升级、签名或长期运行验收；仓库里的历史测试数字也不能代表当前提交已经通过。构建及发布前核对见 [发布检查](docs/releasing.md) 和 [Windows 安装说明](docs/windows-installer.zh-CN.md)。`npm run test:wechat` 会使用真实账号、模型和聊天资料并可能发送消息，只能在取得明确授权后对测试联系人运行，详见 [使用说明](docs/personal-wechat.md)。

## 文档与参与

| 入口 | 内容 |
| --- | --- |
| [个人微信](docs/personal-wechat.md) / [批量模式](docs/personal-wechat-batch.zh-CN.md) | 操作、恢复和功能边界 |
| [开发环境](docs/development-environment.md) / [发布检查](docs/releasing.md) | 工具链、检查和 Windows 交付 |
| [数据说明](docs/privacy.md) / [安全报告](SECURITY.md) | 数据流、私有文件和漏洞报告 |
| [企业服务](server/README.md) / [知识管理](docs/knowledge-management.md) | 独立服务与知识流程 |
| [贡献指南](CONTRIBUTING.md) / [变更记录](CHANGELOG.md) | 提交问题、改动与验证 |

欢迎提交可复现的问题和范围清晰的 PR。报告时说明系统、微信和应用版本，提供脱敏步骤及错误信息；请勿上传真实聊天内容、数据库或密钥。开发过程和历史验收文档包含仅在维护者本机保存的报告引用，未随仓库发布的报告不能直接通过 GitHub 访问。

## 许可证与归属

本项目采用 [Apache License 2.0](LICENSE)，基于 SightFlow。上游归属保留在 [NOTICE](NOTICE)，分发时请保留许可证、NOTICE 与相关第三方声明。本项目与微信、WeChat、企业微信或其运营方无官方关联。
