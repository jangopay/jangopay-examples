<p align="center"><img src="assets/brand-banner-zh.png" alt="JangoPay" width="100%"></p>

<p align="center"><a href="README.md">English</a> · <a href="https://doc.jangopay.org/">Developer docs</a> · <a href="https://github.com/jangopay/jangopay-docs">API guide</a></p>

# JangoPay 服务端接入示例

基于官方 API 契约的 Node.js、Python、PHP 请求示例。默认查询收款单列表；显式添加 --create 才创建收款单。

| 语言 | 环境 | 文件 |
| :--- | :--- | :--- |
| Node.js | 20+ | [payment.mjs](node/payment.mjs) |
| Python | 3.10+ | [payment.py](python/payment.py) |
| PHP | 8.1+ / cURL | [payment.php](php/payment.php) |

## 运行

在服务端环境配置 JANGOPAY_API_KEY。读取列表需要查询权限，创建收款单需要创建权限。示例使用系统标准库，不需要安装 SDK。

```bash
node node/payment.mjs
python3 python/payment.py
php php/payment.php
```

创建前另外设置以下环境变量。金额是 USD 计价字符串，资产必须是当前启用的币种与网络组合。订单号来自你的服务端订单。

```text
JANGOPAY_ORDER_ID=ORDER-1001
JANGOPAY_AMOUNT=10.00
JANGOPAY_ALLOWED_ASSET=USDT:tron
```

```bash
# 任选一种语言；每次执行会创建收款单。
node node/payment.mjs --create
python3 python/payment.py --create
php php/payment.php --create
```

示例仅输出 invoiceId 或记录数量，不输出令牌。创建请求不会自动重试；orderId 不是幂等键。创建超时后先查询并核对记录，持久化本地订单映射后再继续收银台流程。

## 付款通知

Webhook 使用 RSA-OAEP-SHA256 与 AES-256-GCM。按正式实现解密并核对服务端记录，以数据库约束与事务保证订单只交付一次。

[Webhook 指南](https://github.com/jangopay/jangopay-docs/blob/main/docs/zh-CN/webhooks.md) · [官方指南](https://doc.jangopay.org/integration-guide?section=production)

## 场景与插件

[收款、数字交付与服务续费](recipes/workflows.zh-CN.md) · [Dujiaoka 2.x](https://doc.jangopay.org/integration-guide?section=dujiaoka) · [SDK](https://doc.jangopay.org/integration-guide?section=sdk)

## 验证范围

示例提供令牌获取、列表查询和显式创建请求，不含完整商户数据库或收银台。代码未使用真实商户凭据进行线上付款联调；上线前请完成账户环境中的请求与通知测试。

契约核对日期: 2026-10-12 · [API Reference](https://doc.jangopay.org/api-reference) · [contact@jangopay.org](mailto:contact@jangopay.org)
