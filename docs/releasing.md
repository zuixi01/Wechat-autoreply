# 发布前检查

当前项目为开发预览。本文是维护者的检查清单，不表示已完成列出的检查，也不授权上传、创建正式 Release、部署或真实聊天测试。历史报告只证明记录时对应的源码和范围。

## 固定待发布内容

- 记录实际提交号、版本和当前工作树状态，明确包含哪些改动；保留 Apache-2.0、NOTICE 与必要第三方声明。
- 检查暂存内容和 Git 历史，排除用户资料、供应商密钥、聊天原文、截图、数据库及私有报告。只增加忽略规则不能移除已有历史。
- 更新中英文首页和 [CHANGELOG](../CHANGELOG.md)，明确当前平台、已知限制、实验功能和仍未验收的能力。不要把旧源码报告当作新提交结果。

## 从干净环境检查

使用 Windows x64、[.node-version](../.node-version) 指定的 Node 和 .NET 10 SDK，在新克隆或隔离的源码副本中运行：

```powershell
npm ci
npm run check:source
npm run verify
npm run build
npm run test:dependencies
```

`npm ci` 需要执行 Electron 原生依赖安装脚本；Node 24 下窗口相关模块需要 Python 3 和包含 Windows SDK 的 Visual Studio C++ Build Tools 执行 `node-gyp` 编译。记录实际输出、失败和未运行项，不因已有依赖缓存而省略新克隆验证。`npm ci --ignore-scripts` 只用于源码贡献检查，不能代替发布的完整依赖安装和桌面验证。环境准备见 [开发说明](development-environment.md)。

### 当前依赖发布阻碍（2026-11-03）

兼容补丁已更新 Electron 44.10.1、Vite 7.3.7、Vitest 4.1.12、fast-uri 3.1.9、undici 6.29.1/7.30.1 和根目录/独立服务的 Zod 4.6.7。独立服务本轮安装审计为零告警。

根项目的官方 npm registry 审计仍失败：**65 个受影响包条目（29 high、36 moderate）**，由以下两类原始 advisory 及其传递依赖产生；这不是 65 个已验证的独立产品漏洞。

- Jimp 1.6.1 的插件仍依赖 Zod 3；[Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) 的修复范围为 4.6.6 及以上。全局强制 Zod 4 越过插件声明的兼容范围；降级 Jimp 则会破坏当前使用的 v1 图像 API。
- 构建和开发工具仍依赖 minimatch 3/5/9/10；[minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) 的修复范围为 11.0.1 及以上。部分消费者仍将模块当作函数调用，不能直接覆盖为仅提供命名导出的新 major。

现有 `test:dependencies` 要求 production/all 两种范围零告警，本轮未放宽此门槛。**依赖检查未通过前不要将 Windows 构建标为通过正式发布门槛。** 应通过上游兼容修复、经过独立验证的依赖迁移或替换解决，再重新运行完整安装、测试和打包；告警数量会随公开数据库更新，发布时必须重查。

本轮对当前文档中的测试联系人标签做了匿名化，未重写旧提交；Git 历史仍保留原标签。当前文档清理不代表历史资料完成脱敏，维护者仍需确认这些记录可公开。若要求彻底移除，应另行审阅历史重写及协作者同步方案。

### 当前源码 CI 环境阻碍（2026-11-03）

托管 Windows 运行器的完整 `npm ci` 和源码检查通过，但默认令牌 Owner 与当前用户不同，私有目录及运行时资料库测试被现有严格检查拒绝。临时目录的短路径别名问题已修正，不能将这些结果记作完整 `verify` 通过。仅调整独立测试进程默认 Owner 的方案也被运行器以访问拒绝阻止，未保留该适配代码，未修改账户、权限或 ACL。完整日常测试仍需在满足当前用户所有权前提的环境中验证。

## Windows 产物

```powershell
npm run build:win:dev
npm run test:packaged-native
npm run test:desktop:release
# 需要安装程序时
npm run build:win:installer:dev
```

从本轮 `.local/reports/windows-dev-build/<UUID>/result.json` 取得真实产物路径与构建编号，核对源码快照、辅助程序、归档和安装包摘要。安装包若另行构建，应验证那个实际安装包，不能用此前目录包检查代替。细节见 [Windows 安装包构建与验收](windows-installer.zh-CN.md) 和 [固定源码构建](release-source-snapshot.zh-CN.md)。

正式分发前分别记录干净普通用户的安装、启动、升级、卸载和回退结果，并说明用户数据保留行为、签名状态及 SHA-256。未签名或未完成某项检查时应明确标注，不把“已生成 exe”写成安装验收通过。公开下载链接应指向实际上传的 Release 资产，不链接维护者本机 `dist/` 路径。

## 功能与实机结论

隔离桌面、HTTP 和 SQLite 测试不能证明真实微信长期稳定。真实收发只在得到明确授权的账号和测试联系人中验证，记录微信版本、模型、模式、轮数与结果；不得将一次单联系人结果推广到批量、所有联系人或未来微信版本。发布时以 [个人能力报告](capability-report.wechat.md) 和 [企业能力报告](capability-report.wework.md) 区分已验证与待验证范围。

企业服务的产物与配置检查独立进行，参考 [服务说明](../server/README.md)。本清单不要求执行服务器变更，生产部署和数据迁移须另行确定授权与操作流程。

## English summary

Record the commit, version and exact scope. From a clean Windows checkout run `npm ci` with lifecycle scripts, `npm run check:source`, `npm run verify` and `npm run build`. Validate the actual Windows artifact, not an earlier build; report install/upgrade/uninstall/rollback and signing status separately. Publish only verified artifacts with checksums, retain licenses and attribution, and state limits honestly. Real-message tests and deployment require their own authorization.
