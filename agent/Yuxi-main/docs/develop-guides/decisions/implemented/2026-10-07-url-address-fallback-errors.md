# URL 导入按真实网络异常回退已校验地址

状态：implemented
类型：bug-fix
Owner：backend/package/yuxi/knowledge/utils/url_fetcher.py

## 问题

域名解析出多个公网地址时，首个地址不可达或连接超时会直接终止 URL 导入。httpcore 将底层操作系统异常映射为 `ConnectError` 或 `ConnectTimeout`，只捕获 `OSError` 无法执行既定的多地址回退。使用内建 `ConnectionError` 的测试不能发现这一协议差异。

## 决策

连接循环捕获 `httpcore.ConnectError`、`httpcore.ConnectTimeout` 和 `OSError`，继续尝试同次 DNS 解析中已完成安全校验的地址。所有地址失败时保留最后一次连接异常。DNS 解析次数、全部地址预校验、私网拒绝和各地址超时预算保持原有契约。

这是在现有循环中补全依赖协议异常的小型修复，没有需先裁决的新能力、配置或架构选择，因此直接记录 implemented 决定。

## 替代方案

- 只捕获 `OSError`：无法处理实际 httpcore backend 抛出的异常。
- 捕获所有异常：会吞掉程序错误或校验错误，将不应回退的问题误当成连接失败。

## 后果

首个公网地址失败时，后续已校验地址仍可建立连接。连接失败不会增加 DNS 解析或开放未校验地址；异常分类与现有网络库契约一致。

## 验证

`backend/test/unit/knowledge/test_url_fetcher.py` 使用真实 httpcore 异常类型覆盖连接失败、连接超时、下一地址成功、单地址失败及超时分配。保留原实现运行改正后的测试时，连接失败、连接超时及超时分配三个案例失败；修复后通过。

外部网站真实双栈网络探针未执行；单测证明异常分类、已校验地址回退及既有 SSRF 拒绝契约，不证明公网服务可用性。
