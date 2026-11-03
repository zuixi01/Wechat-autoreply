# 安全报告 · Security

本项目处于开发预览阶段，尚未承诺稳定版本的安全维护周期或响应时限。公开源码和自动化检查不代表已完成全面安全审计。

## 私密报告

若仓库的 **Security → Report a vulnerability** 入口可用，请通过该入口提交私密报告。此文档不表示该功能已经启用。若入口不可用，请先通过维护者公开的联系途径，或不包含漏洞细节的 Issue，请求建立私密沟通渠道；在渠道建立前不要公开漏洞利用步骤、有效凭据或真实用户数据。

报告中提供受影响的版本或提交号、组件、影响、前置条件和最小复现。优先使用合成消息、隔离账号和脱敏日志。不要提交他人的聊天、完整数据库、密钥、访问令牌、Cookie 或私钥。请勿为了验证问题读取他人账号、发送未获授权的消息或影响在线服务。

若发现自己的凭据已经公开，应在对应服务撤销或轮换，并通知维护者处理仓库或附件中的暴露；仅删除当前文件不能清除 Git 历史中的内容。

## 使用与数据边界

客户端可向所配置模型发送聊天截图和文字，并在本机保存配置、消息与处理记录。第三方 Provider bundle 是外部代码，安装前应审阅来源与内容。详见 [数据说明](docs/privacy.md)；企业服务另有 [配置与权限说明](server/README.md)。

## Private reporting

This is a development preview with no promised security support window or response time. If **Security → Report a vulnerability** is available on this repository, use it for a private report. Its availability has not been asserted here. Otherwise ask the maintainer to establish a private channel through a published contact method or an issue containing no vulnerability details.

Include the affected commit, component, impact, prerequisites and a minimal reproduction using synthetic data. Do not publish exploit details, private chats, databases or credentials. Test only with authorization. Revoke exposed credentials at the provider; removing a current file does not remove Git history. See [data handling](docs/privacy.md) before sharing diagnostics.
