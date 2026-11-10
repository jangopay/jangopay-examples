# JangoPay Merchant Fulfillment: Digital Goods & VPN / Hosting (Node.js)

[简体中文](README.zh-CN.md) · [API Reference](https://doc.jangopay.org/api-reference) · [Webhook guide](https://github.com/jangopay/jangopay-docs/blob/main/docs/en/webhooks.md)

This is a **local, offline-only merchant fulfillment example**, not a production payment integration or a plugin for a named VPN panel. It shows how one merchant backend can connect a reconciled payment to either (1) digital-license issuance or (2) service renewal, **once per verified order**.

The payment-state and encryption utilities are imported from the sibling `../ai-credit-topup/` example. **Clone the whole `jangopay-examples` repository**, not only this folder. No npm dependencies or real funds are needed. Requires Node.js 22.16+ (`node:sqlite`, experimental under Node 22).

## Run

```bash
cd node/merchant-fulfillment
npm run setup
npm test
npm start
```

In a separate terminal, create a digital-goods purchase:

```bash
curl -sS -X POST http://127.0.0.1:3848/api/orders \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: digital-order-20261109' \
  -d '{"sku":"license-basic"}'
# Replace ORDER_ID with the response id:
curl -sS -X POST http://127.0.0.1:3848/api/orders/ORDER_ID/quote
npm run simulate -- ORDER_ID
curl -sS http://127.0.0.1:3848/api/entitlements
```

For a simulated VPN/hosting renewal, repeat with a **new** `Idempotency-Key` and `{"sku":"vpn-monthly"}`. The local demo's fixed catalog is:

| SKU | USD price | After verified payment |
| --- | --- | --- |
| `license-basic` | $9.00 | Create one illustrative `DEMO-LICENSE-*` (not a real redeemable license) |
| `vpn-monthly` | $5.00 | Advance the example account's expiry by 30 days from the later of current expiry and now |

The mock payment address is intentionally invalid: `MOCK-NOT-A-REAL-ADDRESS`. **Never transfer funds to it.** Example prices are placeholders, not JangoPay merchant pricing.

## Safety and technical scope

- **Localhost only (127.0.0.1)**, single test account, no authentication or production-grade authorization. Never expose this demo to the internet.
- The simulated JangoPay Webhook envelope uses RSA-OAEP-SHA256 + AES-256-GCM with an appended 16-byte tag. Merchant integrations use the current Webhook contract and account configuration.
- Successful decryption is not payment proof. The service separately checks merchant invoice + merchant transaction identity, USD gross/net/fees, asset/network and final settlement before any fulfillment.
- SQLite constraints and a single transaction guard invoice, fulfillment event and resulting entitlement against duplicates, process restarts and retries.
- Remote creation and quote failures go to `creation_unknown` or `quote_unknown` rather than automatically repeating side-effecting POST requests.
- This example includes **only a mock provider** on purpose. The opt-in live reference adapter is documented in [`../ai-credit-topup/`](../ai-credit-topup/). Do not copy live credentials or create payable invoices in this offline demo.
- A production integration needs an authenticated customer database, real license inventory or external VPN provisioning, authenticated billing settings, retryable outbox, reconciliation jobs, policy for late/partial/overpayments, and full payment-provider contract tests. A subscription renewal is **not** automatic recurring billing.

The server uses `.local/` for its database and locally generated RSA keys; both are gitignored. The `GET /api/entitlements` response includes example license keys **only because this service is loopback-only**. Real entitlements must be scoped to authenticated customers.

## HTTP endpoints

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/healthz` | Process health |
| POST | `/api/orders` | Create order with `sku` and `Idempotency-Key` |
| GET | `/api/orders/:id` | Check order state |
| POST | `/api/orders/:id/quote` | Request mock payment instructions |
| POST | `/webhooks/jangopay` | Decrypt, verify remotely, fulfill once |
| GET | `/api/entitlements` | Inspect local mock fulfillment |

## Local checks

`npm test` covers one-time digital delivery, successive 30-day renewals, duplicate notifications, idempotency keys, pending settlement, invalid transaction amounts, forged encryptable notifications, persistence and HTTP endpoints through the local mock provider.
