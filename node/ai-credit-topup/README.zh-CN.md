# JangoPay × AI API 中转站余额充值示例（Node.js）

[English](README.md) · [JangoPay API 文档](https://doc.jangopay.org/api-reference) · [Webhook 说明](https://github.com/jangopay/jangopay-docs/blob/main/docs/zh-CN/webhooks.md)

这是一个面向 AI API 中转站、API 聚合平台、SaaS 开发者的**本地可运行充值示例**：用户购买预付额度，通过 USDT 付款后，由服务端核验 JangoPay 商户账单和交易，再写入余额。默认使用**离线模拟支付**，无需 API Key 或真实资金。示例聚焦单用户充值流程，商户部署与身份认证属于独立的系统集成工作。

## 已实现

- 以 USD 计价创建充值订单；使用请求幂等键避免重复创建。
- 独立获取 USDT（Tron）支付报价。真实模式需要从支付接口返回的 `payAmount` 获取币额，不能把 USD 金额直接当 USDT 数量。
- RSA-OAEP-SHA256 解密 AES 密钥、AES-256-GCM 解密通知，再通过商户 API **分别查询账单与交易**，只有符合最终状态才加余额。
- SQLite 事务、唯一流水约束、重启后保存余额，防止重复通知重复加钱。
- 遇到创建账单或报价超时，不盲目重试可能产生副作用的请求。

示例自行规定 **1 USD = 100 个演示 Credits**，不是 JangoPay 官方的充值汇率或商业规则。暂时只提供一个本地测试账号，没有登录、权限系统、真实用户中心等功能。

## 五分钟离线体验

需要 **Node.js 22.16+**（使用内置 `node:sqlite`，Node 22 下该 API 为实验性功能），不需要安装其他 NPM 依赖。

```bash
cd node/ai-credit-topup
npm run setup
npm start
```

另开一个终端：

```bash
curl -sS -X POST http://127.0.0.1:3847/api/topups \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-order-20261109' \
  -d '{"amountUsd":"10.00"}'
# 将下方 REPLACE_TOPUP_ID 替换为上一条返回的 id
curl -sS -X POST http://127.0.0.1:3847/api/topups/REPLACE_TOPUP_ID/quote
npm run simulate -- REPLACE_TOPUP_ID
curl -sS http://127.0.0.1:3847/api/balance
```

本地模拟地址是刻意设定的无效地址 `MOCK-NOT-A-REAL-ADDRESS`，**绝对不要向它转账**。模拟支付成功后将增加 1,000 Credits；再次触发模拟通知只会返回 `duplicate`，不会重复加余额。演示密钥和数据库保存在不会提交到 Git 的 `.local/` 目录下。

## 运行接口

| 路径 | 作用 |
| --- | --- |
| `GET /healthz` | 健康检查 |
| `GET /api/balance` | 演示账号余额和流水 |
| `POST /api/topups` | 创建充值订单，请求体 `{"amountUsd":"10.00"}`、请求头 `Idempotency-Key` |
| `POST /api/topups/:id/quote` | 获取一次付款报价 |
| `GET /api/topups/:id` | 获取订单状态 |
| `POST /webhooks/jangopay` | 解密通知、查询商户账单和交易、核验后入账 |

HTTP 服务**固定监听 127.0.0.1**，即使 live 模式也不会直接监听公网。本示例没有完整用户认证，不得直接暴露到互联网。真实上线须接入已有的登录鉴权、TLS、限流、商户凭据管理、操作审计和多用户账户体系。

## 资金安全设计

订单主流程为 `creating → awaiting_payment → quoting → quoted → credited`。如果账单创建请求结果不明，会进入 `creation_unknown`；报价请求结果不明会进入 `quote_unknown`。这两种状态都不会自动再次创建，必须先执行只读查询及人工核对。JangoPay 的 `orderId` 不是远端幂等键。

加密通知本身**不是付款真实性的证明**：知道公钥的第三方也能自行加密消息。所以只有通过服务端商户认证 API 核对发票身份、USD 价格、最终状态、已结算交易、USDT 网络等信息后才能入账。数据库事务同时更新订单状态、唯一充值流水和余额，即使回调重复或重启也不会二次发放。

## 真实支付模式：仅供受控联调

`live` 是依据公开 API 和已发布插件整理的显式启用参考适配器。接入时以当前商户账户的收款单响应、Webhook 尾部 16 字节认证标签、最终结算状态和支付报价字段为准。

```bash
export JANGOPAY_MODE=live
export ALLOW_REAL_PAYMENTS=1
export JANGOPAY_API_KEY='JangoPay_...'
export JANGOPAY_WEBHOOK_TAG_FORMAT=appended16
export JANGOPAY_FINAL_INVOICE_STATUSES=paid
export JANGOPAY_RSA_PRIVATE_KEY_PATH='/secure/location/merchant-private.pem'
npm start
```

还需要在 JangoPay 控制台设置对应的 RSA 公钥与 HTTPS 回调地址，并将本地服务代码集成到正式认证的商户服务端，**不能直接发布当前 HTTP 服务**。本项目不会臆造托管收银台 URL，采用 `pay-state` + `confirm-coin` 获取付款指引；不实现周期扣费、退款、出款或兑换。

## 测试

```bash
npm test
```

覆盖本地 HTTP 创建订单、报价、加密回调、错误密文、重复回调、商户账单不一致、幂等及持久化流程。
