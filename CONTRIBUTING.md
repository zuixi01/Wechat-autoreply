# 贡献指南 · Contributing

欢迎提交可复现的问题、文档修正和范围明确的代码改动。项目仍处于开发预览阶段；新增能力应说明实际验证范围，不把模拟测试写成真实微信或生产验收。

## 提交问题

先检查已有 Issue，并记录应用版本或提交号、Windows 版本、微信版本、相关模型接口类型、复现步骤、预期与实际结果。尽量使用合成消息复现；上传前删除联系人、聊天内容、密钥、Cookie、数据库地址及其他私人信息。不要上传整个用户数据目录、SQLite 数据库、`.env` 或未经处理的截图。

安全问题请按 [SECURITY.md](SECURITY.md) 使用私密报告渠道，不在公开 Issue 中发布漏洞利用细节。

## 本地开发

完整开发入口是 Windows x64，Node 版本见 [.node-version](.node-version)，另需 .NET 10 SDK、Python 3 和包含 Windows SDK 的 Visual Studio C++ Build Tools。首次安装执行：

```powershell
npm ci
npm run dev
```

`npm ci` 包含 Electron 原生依赖安装和重建；Node 24 下窗口相关模块需要 `node-gyp` 编译，不能用跳过安装脚本代替完整开发安装。可选的 `.local/toolchain` 不随仓库提供，详细环境见 [开发说明](docs/development-environment.md)。

请使用普通用户终端。私有资料目录须归当前用户所有；默认目录所有者为管理员组的提升权限会话会被严格权限检查拒绝，见 [环境限制](docs/development-environment.md#验证)。

只做源码或文档贡献且不具备原生构建环境时，可执行 `npm ci --ignore-scripts`，再运行 `npm run check:source` 和 `npm run verify`。此方式不能用于运行客户端、桌面测试或 Windows 打包验收；PR 中应明确安装脚本未执行及未验证的范围。

## 提交改动

1. 从当前开发分支创建工作分支。保持一次 PR 聚焦一个问题，避免顺带重构。
2. 修改行为时补充有意义的边界或回归测试；文档小改无需新增重复实现的测试。
3. 更新受影响的中英文入口、使用说明及 [Unreleased 记录](CHANGELOG.md)。保留 Apache-2.0、NOTICE 与上游声明，不加入无权分发的素材或数据。
4. 在 PR 中说明问题、最终行为、实际运行的检查、未完成的验证，以及涉及真实数据或平台兼容性的限制。

提交前的基本检查：

```powershell
npm run check:source
npm run verify
npm run build
```

`check:source` 检查仓库公开源码与文档约定；`verify` 执行类型、静态及日常自动化测试；`build` 编译应用。任何命令失败均应保留实际原因，不能通过删除测试、放宽断言或忽略失败来宣称通过。只改文档时，可说明实际执行了源码/文档检查，完整构建未运行。

Windows CI 使用规范化的临时路径，并先验证私有存储测试的环境前提。运行器默认 Owner 与当前用户不同时，固定测试入口会在同一用户的独立进程令牌副本中设置默认 Owner；不更改调用者令牌、目录 ACL 或权限。若运行器不具备启动该进程的现有权限，CI 会失败并保留原因，不跳过测试或放宽产品的权限检查。本地开发仍应使用普通用户终端。

## 涉及真实微信与发布

普通贡献不需要读取真实聊天或发送消息。`npm run test:wechat` 使用实际账号、应用资料及模型接口，必须先获得账号持有人和测试范围的明确授权；只能使用指定测试联系人。不要在共享测试或 CI 中添加真实账号、供应商密钥、客户数据或自动发送步骤。

打包不等于发布。维护者发布前按 [发布检查](docs/releasing.md) 核对同一提交与产物，明确签名、安装、升级、回退和实机验收状态。

## English summary

Full development requires Windows x64, the Node version in `.node-version`, .NET 10 SDK, Python 3 and Visual Studio C++ Build Tools with a Windows SDK. Run `npm ci` with lifecycle scripts enabled, then `npm run check:source`, `npm run verify` and `npm run build`. Source-only contributors can use `npm ci --ignore-scripts` with the source checks and `verify`, but cannot use it to validate startup, desktop tests or Windows packages. Keep pull requests focused and report checks actually performed and their limits. Use synthetic data, retain Apache-2.0 and upstream notices, and never commit private profiles or credentials. Real WeChat tests require explicit authorization. Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
