# 2026-10-07 D02 原始控件树视图

前一轮管理员暂停重启恢复已完成，属于实际进展。本轮继续解决后台适配的前置证据缺口：原探针只读 ControlView，不能由少量控件节点推断整个原始 UIA 树的内容。根据微软 [UIA 视图说明](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-treeoverview)，增加 RawView 的明确采样入口。

## 实现

- 原生辅助 0.3.0，协议仍 1；探针报告格式 2 增加 treeView 与 isControlElement/isContentElement，继续不读 Name/Value/Text，不操作焦点、草稿或剪贴板。
- info 明确声明 control/raw 两种元数据视图。桥接固定当前清单版本，返回版本/视图/窗口绑定失配均拒绝并关闭；旧 0.2.0 格式 1 可继续验证，仅限 control，raw 在启动/枚举之前拒绝。
- `probe:read --tree-view control|raw` 默认 control；私有报告保存请求视图，不接受降级回退。包校验模式不能组合窗口或视图参数，仍不启动辅助。
- 应用的构建版本与固定摘要从同一份实际清单派生，避免将当前 0.3.0 或历史 0.2.0 包标为另一版本；构建和执行校验共同保留。
- 节点 300、深度 8、原生遍历预算 3 秒、请求 5 秒和外层截止 20 秒及关闭确认均保持。一次报告的树完整，不证明消息历史完整或两次采样之间稳定。

## 验证

自建 WPF UIA 测试窗口（离屏、不激活）提供实际 IsControlElement=false 装饰节点；ControlView 4 节点，RawView 8 节点，证明真实视图过滤差异。节点数只属于该自建窗口，不能代指微信/企微。原生报告 `9e55de36-1c98-4b69-86c0-d189d6524da9` 22 项通过；错误进程/启动 ticks/句柄、允许列表、非枚举视图、两种视图节点/深度界限、元数据截断及不序列化私有文本均覆盖。

首轮四文件 66 项通过，加入包钩子后 `.local/reports/raw-probe-final.json` 五文件 74 项通过，0 失败/跳过。服务、主进程与界面类型，以及十三文件 lint 和构建退出 0；Zod 的 Rollup 注释位置警告保留。没有放宽原测试期限或检查规则；当前源码专项不代替全量工作区回归。

实际 self-contained 发布 `f144fc6a-848f-4739-a0dc-49162ce646a7` 通过，399 文件 / 146358162 字节，清单 SHA-256 `c159af1896b95548ade63c586c7c9968e874ecb9b6505c8c850f66dcd653dadb`。只调用 info 并确认退出；旧生成目录按原发布流程改名保留，无递归删除。当前编译的主进程工厂与本地资源的固定摘要/版本/info 已核对，报告 `raw-probe-compiled-factory.json`；这不是已安装 ASAR 或完整包内 GUI 验证。实际 CLI `--check-package` 通过、辅助未启动、窗口未枚举，报告 `raw-probe-package-check.json`。

本轮没有真实微信/企微枚举、采样、文本读取、发送或模型请求，没有安装、新 NSIS、提交、外部部署或独立审查。微信 4.1.15.13 的历史控件缺失证据保留；该版本 raw 未测，企微仍未测。三项平台能力均 false，真实后台驱动、Jev 业务准确度、多电脑办公和正式交付仍未完成。后续按用户准备安排核对两平台的实际 control/raw 报告，才能确定并验证生产读取路径；不能用模拟成功代替该结论。

复现命令（项目固定 Node 工具链）：

```powershell
npm run test:native-probe
node node_modules/vitest/vitest.mjs run tests/unit/windows-bridge.test.ts tests/unit/native-package.test.ts tests/unit/platform-probe.test.ts tests/integration/platform-probe-files.test.ts tests/unit/native-pack-hook.test.ts
npm run typecheck:services
npm run typecheck:node
npm run typecheck:web
node node_modules/electron-vite/bin/electron-vite.js build
node node_modules/tsx/dist/cli.mjs scripts/platform-probe.ts --platform wechat --native-release f144fc6a-848f-4739-a0dc-49162ce646a7 --check-package
```

完整 D00–D20 目标保持 active。原始视图是后台驱动开发的诊断基础，本次不登记未验证的消息读取/发送能力。

阶段汇总 `.local/reports/raw-probe-stage/cdbe4f0b-7dd1-465a-b095-34e50dd6cd8f/result.json` 绑定十六个验证后源码摘要、报告摘要、当前编译工厂与发布清单摘要，`incrementalChecksPassed=true`；完整工作区、完整目标、发布、生产后台驱动及安装包验证均保持 false。摘要不宣称共享工作区已冻结。
