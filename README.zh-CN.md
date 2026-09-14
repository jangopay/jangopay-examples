<p align="center"><img src="https://raw.githubusercontent.com/jangopay/.github/main/assets/brand-banner-zh.png" alt="JangoPay — stablecoin payments for global online businesses" width="100%"></p>

<p align="center"><a href="README.md">English</a> · <a href="https://www.jangopay.org/">Website</a> · <a href="mailto:contact@jangopay.org">Contact</a></p>

# JangoPay 接入流程模板

**为在线业务规划可落地的支付流程。**

本仓库提供商户业务流程模板和可复用的上线检查清单。它**不是 SDK**，不包含未经核实的 JangoPay 接口或可执行支付请求。

## 场景模板

| 流程 | 适用业务 | 查看 |
| :--- | :--- | :--- |
| 收款链接 | 无需定制开发，快速开始收款 | [中文](recipes/workflows.zh-CN.md#收款链接) · [English](recipes/workflows.en.md#payment-link) |
| 数字交付 | 确认付款后开放内容、授权或下载 | [中文](recipes/workflows.zh-CN.md#数字交付) · [English](recipes/workflows.en.md#digital-delivery) |
| 服务续费 | SaaS、服务器等在线服务续费 | [中文](recipes/workflows.zh-CN.md#服务续费) · [English](recipes/workflows.en.md#service-renewal) |

## 上线前检查

- [ ] 确认支持的币种、网络组合及费用。
- [ ] 建立业务订单与收款记录的对应关系。
- [ ] 使用正式文档规定的方法验证通知。
- [ ] 安全处理重复、延迟和乱序通知。
- [ ] 仅在验证付款确认后交付商品或开通服务。
- [ ] 为超时、少付、多付或不支持的付款准备处理流程。
- [ ] 密钥仅存放在服务端，日志隐藏敏感信息。
- [ ] 上线前核对收款记录与业务订单。

## 使用边界

图示与步骤只描述业务流程，不代表正式事件字段或接口契约。实际请求、验签、状态值与技术接入，以正式 API 文档为准。

[产品文档](https://github.com/jangopay/jangopay-docs) · [官网](https://www.jangopay.org/) · [联系团队](mailto:contact@jangopay.org)
