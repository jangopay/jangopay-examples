<p align="center"><img src="assets/brand-banner-en.png" alt="JangoPay" width="100%"></p>

<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="https://doc.jangopay.org/">Developer docs</a> · <a href="https://github.com/jangopay/jangopay-docs">API guide</a></p>

# JangoPay Server Integration Examples

Node.js, Python and PHP request examples based on the official API contract. The default command reads invoice records; --create explicitly creates an invoice.

| Language | Runtime | File |
| :--- | :--- | :--- |
| Node.js | 20+ | [payment.mjs](node/payment.mjs) |
| Python | 3.10+ | [payment.py](python/payment.py) |
| PHP | 8.1+ / cURL | [payment.php](php/payment.php) |

## Run

Configure JANGOPAY_API_KEY in your server environment. Listing requires read permission; creation requires invoice-create permission. Examples use standard runtime libraries rather than an SDK.

```bash
node node/payment.mjs
python3 python/payment.py
php php/payment.php
```

Before creation, also configure these environment variables. Amount is a USD pricing string; the asset must be an enabled currency/network pair. Use an order ID from your server-side order system.

```text
JANGOPAY_ORDER_ID=ORDER-1001
JANGOPAY_AMOUNT=10.00
JANGOPAY_ALLOWED_ASSET=USDT:tron
```

```bash
# Choose one language; each execution creates an invoice.
node node/payment.mjs --create
python3 python/payment.py --create
php php/payment.php --create
```

Examples print only invoiceId or a record count, never tokens. Creation is not automatically retried; orderId is not an idempotency key. Reconcile ambiguous timeouts and persist order mappings before continuing checkout.

## Payment notifications

Webhooks use RSA-OAEP-SHA256 and AES-256-GCM. Decrypt using the official implementation, reconcile server-side records, and use database constraints and transactions to fulfill each order once.

[Webhook guide](https://github.com/jangopay/jangopay-docs/blob/main/docs/en/webhooks.md) · [Official guide](https://doc.jangopay.org/integration-guide?section=production)

## Workflows and integrations

[Collection, digital delivery and renewal](recipes/workflows.en.md) · [Dujiaoka 2.x](https://doc.jangopay.org/integration-guide?section=dujiaoka) · [SDK](https://doc.jangopay.org/integration-guide?section=sdk)

## AI credit top-up example

[Explore the Node.js credit top-up workflow](node/ai-credit-topup/README.md): a local SQLite ledger, encrypted mock callback and exactly-once crediting for a prepaid AI API balance. It runs offline by default and is not a production plugin.

## Validation scope

The small request examples cover token issuance, list queries and explicit creation. The AI top-up example adds a local database and mock payment flow. Neither has been verified with a real JangoPay merchant transaction; validate actual API responses and Webhook framing before adapting either for production.

Contract checked: 2026-10-12 · [API Reference](https://doc.jangopay.org/api-reference) · [contact@jangopay.org](mailto:contact@jangopay.org)
