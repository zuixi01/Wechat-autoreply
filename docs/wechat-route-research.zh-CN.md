# 微信真实收发路线核查

核查日期：2026-10-07。目标仍为员工原有微信客户私聊、多员工账号、员工边办公边自动回复。本次只读取上游公开文档和源码，没有安装依赖、运行第三方程序、读取微信数据、修改进程或发消息。

**结论：存在支持本机 4.1.15.13 的公开研究候选，但尚未找到同时满足原有私聊、可靠消息身份和不干扰办公发送的已验证完整方案。** 上次 UIA 只见通用窗格，不能推导微信 4.x 永远没有 UIA；新源码提供了门禁未激活这一可能解释，但没有证明本机原探测失败就是该原因，仍需实机验证。也不能把官方机器人通道当作接管员工全部好友聊天。

| 路线                                              | 当前版本依据                                     | 收消息和身份                                                     | 发送及办公影响                                   | 结论                                                   |
| ------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| 本地数据库读取 + UIA 混合发送：wechatauto-replica | 作者声明测试 4.1.15.13；公开源码有对应门禁版本项 | 数据库字段含联系人 username、server_id、sort_seq；轮询           | 现成发送实现抢前台、点击、按键及修改剪贴板       | 最贴近本机版本的研究起点；须重做发送与可靠读取边界     |
| 客户端内部调用：aixed/WeChat-Hook                 | 当前源码目标 4.1.10.27，不是 4.1.15.13           | wxid、自身资料、数据库查询；当前回调参数不足以证明消息推送已实现 | 内部 SendText 调用；接口成功码不等于正确会话回显 | 可研究后台发送原理，不能直接集成本机版本               |
| 腾讯官方 iLink Bot：Tencent/openclaw-weixin       | 官方仓库 HTTP 后端，不依赖桌面 UIA               | bot 身份、用户 ID、消息 ID、长轮询游标                           | HTTP 发送不需要桌面键鼠；机器人消息              | 技术接入最直接，但公开合同不支持原员工全部好友私聊代理 |

## 1. 本机版本候选：wechatauto-replica

核查固定源码版本为 `91dc0e1a601013b759b261061d8f7642f736af90`。README 标为 1.2.4.4，作者声明在 4.1.15.13 验证，并说明维护时间有限。这些是上游陈述，不是本项目实机验收。[项目 README](https://github.com/fanyuantaier/wechatauto-replica/blob/91dc0e1a601013b759b261061d8f7642f736af90/README.md)

`uia_driver.py` 的版本表包含 4.1.15.13。`_hot_activate_accessibility()` 以进程写权限打开微信，调用 `_write_process_byte()` / `WriteProcessMemory` 修改 Qt 门禁，再验证 `mmui` 控件出现；失败尝试恢复原值。它不是已证实的微信客户端设置开关。`ensure_window()` 调用 `_activate()` 抢前台；`send_text()` 经 `_paste_into()` 点击输入框、清除原输入、写全局剪贴板、粘贴并按 Enter。因此原实现明确不能满足员工无干扰办公。[UIA 源码](https://github.com/fanyuantaier/wechatauto-replica/blob/91dc0e1a601013b759b261061d8f7642f736af90/wechatauto/uia_driver.py)

`WeChatDB` 从本地数据库读取，`Listener` 轮询增量；字段提供 username、server_id、sort_seq。源码提醒 local_id 跨分片重复，默认账号按文件最近时间挑选，解密失败可能尝试切换账号；增量接口以 sort_seq 水位筛选。生产适配不能直接照搬这些假设：须绑定账号与进程、保存分片及可靠复合游标、验证同序列分页不会漏消息，失败不得自动跨员工账号。[数据库源码](https://github.com/fanyuantaier/wechatauto-replica/blob/91dc0e1a601013b759b261061d8f7642f736af90/wechatauto/db.py)

`guia.py` 的 `send_msg()` 提供混合发送，`_verify_sent()` 做数据库回读。回读正文等信息的候选匹配，必须进一步核对能否区分员工同时发送的同文消息；不能直接替代本项目 executionId 与具体新外发消息的关联。其坐标/OCR 路径同样使用桌面输入。[混合发送源码](https://github.com/fanyuantaier/wechatauto-replica/blob/91dc0e1a601013b759b261061d8f7642f736af90/wechatauto/guia.py)

**可借鉴数据库读取和客户端控件定位；不可直接复用其发送来宣称后台办公兼容。** Gate 内存修改是否稳定、客户端升级后的结构、账号登录生命周期、锁屏和睡眠，以及消息服务端 ID 的完整性均未在本项目验证。

## 2. UIA 商业库与客户端内部发送

wxauto 官方安装文档将免费 wxauto4 支持范围写到 4.1.8.107；wxautox4 为需激活的 Plus 版本，没有在该页给出 4.1.15.13 的精确支持承诺。官方技术边界声明不提供注入或内存修改；本次未找到其官方文档证明只需打开微信某个辅助功能选项即可解决当前空树。[安装及版本文档](https://docs.wxauto.org/docs/install.html)

补充精确版本声明：SiverKing/SiverWXbot_plus 固定版本 `98efc46339a52b84351805cf72c5871fce331175` 的 README 声称支持 Windows 微信 4.1.9～4.1.15.13；`wxbot_core.py` 导入 wxautox4，私聊回复仍调用 `chat.SendMsg()`。这是基于 Plus 库的应用层兼容声明，不能因官方安装页未列本机版本就判定 Plus 一定不支持；但公开应用源码没有提供独立原生后台 SendText 实现，也没有证明原生稳定消息 ID 或发送不改焦点、输入和剪贴板。底层库与本机办公共存仍须单独验证。[版本声明](https://github.com/SiverKing/SiverWXbot_plus/blob/98efc46339a52b84351805cf72c5871fce331175/README.md)、[私聊发送调用](https://github.com/SiverKing/SiverWXbot_plus/blob/98efc46339a52b84351805cf72c5871fce331175/wxbot_core.py#L3911-L3945)

wxautox4 的 AddListenChat 基于聊天子窗口监听；Message 文档明确 `id` 切换 UI 后会变、`hash` 可能重复。因此即使监听和回复 API 可调用，也不能映射成原生稳定消息 ID；付费本身不补齐这些条件。[监听 API](https://docs.wxauto.org/docs/class/WeChat.html)、[消息身份文档](https://docs.wxauto.org/docs/class/Message.html)

aixed/WeChat-Hook 核查版本 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6`，README 固定目标 4.1.10.27，依赖内部偏移，升级需重新适配；默认服务监听 `0.0.0.0:30001`。当前 RecvType/CallBackURL 仅描述为解析或保存配置，不代表已实现可用推送。[版本与接口](https://github.com/aixed/WeChat-Hook/blob/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6/README.md)

`Route_SendTextMsg()` 调用 `WeixinSend::SendText()` 后直接返回 ret=0，没有该路由提供的消息 ID 或发送回显。生产接入还需当前版本适配、局部可信传输、原生消息关联和未知结果处理，不能收到 success 就标为 confirmed。[发送路由源码](https://github.com/aixed/WeChat-Hook/blob/e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6/src/SendTextMsg.cpp)

WeChatFerry 原仓库仍列 3.9.12.51 / 3.9.12.17 等版本，未找到本机 4.1.15.13 适配证据，暂不作为当前候选。[原仓库版本记录](https://github.com/lich0821/WeChatFerry#版本更新)

## 3. 腾讯官方通道的真实范围

核查 Tencent/openclaw-weixin 固定版本 `24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`。QR 登录源码分别返回 `bot_token`、`ilink_bot_id` 和扫码人的 `ilink_user_id`；本地 accountId 使用 bot ID，不能把它直接写成员工原微信账号。[登录源码](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/auth/login-qr.ts)

发送构造将 message_type 固定为 BOT，并带目标用户和会话 context_token。API 类型含入站 message_id、get_updates_buf，发送响应可含服务端 message_id；源码把该服务端值列为可选，客户端自生成 ID 不能替代服务端回显。[发送源码](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/messaging/send.ts)、[API 类型](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/api/types.ts)

据公开 bot 合同推断，它处理机器人通道内的对话；未发现枚举员工原好友、读取员工与全部客户私聊或以该员工身份回复的接口。context_token 应按 bot 与对方会话保存，官方协议也未保证缺少 token 的发送会被服务端接受。[官方协议](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol.md)

qingchencloud/wxchat-sdk 是相同 iLink 通道的第三方多语言封装，不是腾讯 SDK，不增加员工原私聊权限。其 README 对 token 交付的说法不能替代官方服务端保证。[封装项目说明](https://github.com/qingchencloud/wxchat-sdk)

## 下一步决策

保持原员工私聊目标时，优先以 wechatauto-replica 的数据库层和控件发现作为**实验候选**，不直接启用其输入与发送。最小实机验证依次为：固定 4.1.15.13 与明确测试账号；只读核对账号、两个同名联系人和消息原生 ID；验证跨分片分页、同文连发及人工外发；单独验证是否存在不改焦点/聊天/草稿/剪贴板的定向发送原语及唯一回显。不存在该发送原语就停止这条路线的办公兼容承诺，转评精确版本客户端内部 SDK，不能靠事后恢复焦点冒充无干扰。

若用户接受改为客户与独立机器人对话，官方 iLink 是代码入口最清晰的候选，可接现有 Jev 和任务队列；这是明确改变聊天身份和业务入口，不能擅自替代员工私聊目标。独立电脑或独立交互桌面的 RPA 也属于运行条件改变。

当前没有一条路线通过本项目真实办公验收，微信研究结果亦不能证明企业微信可用。
