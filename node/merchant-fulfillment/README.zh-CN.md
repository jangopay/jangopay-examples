# JangoPay 数字商品自动交付与 VPN / Hosting 续期示例

[English](README.md) · [官方 API 文档](https://doc.jangopay.org/api-reference)

本项目是 **Node.js + SQLite 的本地离线模拟示例**，不是可直接上生产的付款插件，也不是 XBoard、V2Board 等特定系统的现成插件。它展示如何在核实付款后，**仅执行一次**数字商品授权发放或 VPN/服务器套餐续期。

项目复用同仓库 `../ai-credit-topup/` 的加密与状态处理函数，因此需要克隆完整 `jangopay-examples` 仓库。要求 Node.js 22.16+，不需要第三方 NPM 依赖，也不需要 JangoPay API Key。

## 本地运行

```bash
cd node/merchant-fulfillment
npm run setup
npm test
npm start
```

另开终端，模拟数字商品购买：

```bash
curl -sS -X POST http://127.0.0.1:3848/api/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: digital-order-20261109' \
  -d '{"sku":"license-basic"}'
# 将 ORDER_ID 替换为上一条响应中的 id
curl -sS -X POST http://127.0.0.1:3848/api/orders/ORDER_ID/quote
npm run simulate -- ORDER_ID
curl -sS http://127.0.0.1:3848/api/entitlements
```

续费场景使用新的幂等键并把商品改为 `{"sku":"vpn-monthly"}`。`license-basic` 是 9 USD 的演示授权商品；`vpn-monthly` 是 5 USD 的演示 30 天续期商品。价格和授权码均为**本地模拟规则**，不代表 JangoPay 官方费率或真实可兑换产品。

模拟收款地址 `MOCK-NOT-A-REAL-ADDRESS` 是故意构造的无效地址，**禁止真实转账**。

## 技术实现与安全边界

- 固定监听 `127.0.0.1`，只使用一个演示账户，没有用户登录、权限隔离，不得直接暴露公网。
- 使用 RSA-OAEP-SHA256 和 AES-256-GCM 解密模拟通知；商户集成时以当前 Webhook 契约和账户配置为准。
- **仅凭解密成功不能发货**：还要从商户侧重新读取发票与交易，核实订单、金额、付款币种和网络、结算状态，再完成交付。
- 用 SQLite 唯一约束和事务防止重复通知导致多次发放授权或重复续期。
- 账单创建、支付报价遇到结果不确定时，进入 `creation_unknown`、`quote_unknown`，不会盲目重复创建。
- 本项目只有模拟支付 Provider，不会创建真实账单。真实支付接入可参考 `../ai-credit-topup/` 的显式启用适配器与正式 API 契约。
- 商业应用需要用户鉴权、实际卡密库存或 VPN 系统接口、可靠履约队列、状态补偿和异常付款人工处理。这里的“续期”是客户再次支付的手动续费，**不是自动周期扣款**。

数据库和本地演示密钥放在 `.local/` 并通过 `.gitignore` 排除。查询权益接口会返回本地演示授权码，这仅限单机开发环境；生产必须按登录用户权限隔离。

运行 `npm test` 可检查本地模拟流程中的数字交付、连续续期、重复回调、幂等下单、付款未完成不得交付、金额异常、防伪造和数据库重启持久化等行为。
