# AI API Credit Top-Ups with JangoPay — Node.js Example

[简体中文](README.zh-CN.md) · [JangoPay API Reference](https://doc.jangopay.org/api-reference) · [Webhooks](https://github.com/jangopay/jangopay-docs/blob/main/docs/en/webhooks.md)

A runnable, **loopback-only learning example** for AI API gateways, proxy dashboards and SaaS apps that sell **prepaid API credits** for USDT payments. Demonstrates a real integration architecture with a default **offline mock provider**. Real JangoPay payments are **not** exercised by automated tests. This is **not a production-ready merchant application**.

## What it does

- Create a USD-priced top-up under a client `Idempotency-Key` and associate a JangoPay invoice with a local business order.
- Produce payment instructions for one selected asset/network (USDT on Tron) using a separate quote step; never substitute USD price for actual on-chain token amount in live mode.
- Receive an encrypted `payment.completed` webhook (RSA-OAEP-SHA256 / AES-256-GCM with a trailing 16-byte tag), then independently query merchant invoice **and** transaction endpoints.
- Credit a **single example user** once using an SQLite transaction and unique ledger constraints. Retain balances and ledger across process restarts.
- Handle non-final settlements, duplicate events, amount/order mismatch and unknown remote-creation results without issuing credits or automatic duplicate POST requests.

`1 USD = 100 demo credits` is an **example merchant pricing rule**, not a JangoPay product setting. This project has no account login, RBAC, billing tax logic, deployment hardening or real customer identity management.

## Run the offline demo

**Requires Node.js 22.16+** (built-in `node:sqlite`; this API is experimental in Node 22). No npm dependencies, database service, API key or real funds are required.

```bash
cd node/ai-credit-topup
npm run setup
npm start
```

In a **second terminal**:

```bash
# Supply an independently generated request key (12–100 safe characters)
curl -sS -X POST http://127.0.0.1:3847/api/topups \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: example-order-20261109' \
  -d '{"amountUsd":"10.00"}'
# Copy the returned id; then:
curl -sS -X POST http://127.0.0.1:3847/api/topups/REPLACE_TOPUP_ID/quote
# Complete the cryptographically encrypted mock callback and merchant reconciliation:
npm run simulate -- REPLACE_TOPUP_ID
curl -sS http://127.0.0.1:3847/api/balance
```

The **mock address is deliberately invalid** (`MOCK-NOT-A-REAL-ADDRESS`). Never send USDT to it. A successful mock payment produces a 1,000-credit ledger entry; calling the simulator a second time returns `duplicate` with no extra credits.

The demo writes only to `.local/`, which is excluded from git. Setup generates an ephemeral merchant RSA keypair for **local use only**. A fresh `.local` folder creates a fresh, unrelated demo identity.

## HTTP endpoints

| Method / path | Purpose |
| --- | --- |
| `GET /healthz` | Local health check |
| `GET /api/balance` | Demo user's current balance and recent credit ledger |
| `POST /api/topups` | Create a top-up; JSON `{ "amountUsd": "10.00" }`, plus `Idempotency-Key` |
| `POST /api/topups/:id/quote` | Obtain an invoice's current payment instructions once |
| `GET /api/topups/:id` | Retrieve local order state |
| `POST /webhooks/jangopay` | Accept JangoPay's encrypted completion event; reconcile before crediting |

The HTTP server **always binds to 127.0.0.1**, including when live mode is enabled. It deliberately does **not** provide authentication or production-ready multi-user authorization. Do not expose this server directly to the public internet. For a production site, adapt the service functions into your existing authenticated backend, use TLS, authorization, rate limiting, key rotation, real ledger isolation and operational monitoring.

## Architecture and state safety

`creating → awaiting_payment → quoting → quoted → credited`

- `creation_unknown`: Creating the invoice failed or timed out. The remote request may have succeeded; reconcile **read-only** before any manual re-attempt. JangoPay `orderId` is **not** an idempotency key.
- `quote_unknown`: Creating payment instructions failed or timed out. Do not automatically repeat `confirm-coin`; inspect merchant transactions first.
- The webhook's encryption protects its contents, but **does not prove the sender's identity**, because anyone who has the merchant public key can encrypt a message. Credits are issued **only after authenticated server-side invoice + settled transaction reconciliation**.
- The authoritative remote invoice must match local `invoiceId`, `orderId`, USD amount and final status; the merchant transaction must match `txnId`, `invoiceId`, asset/network and settled state. Any reported transaction hash is cross-checked.
- A **single DB write transaction** updates the order, inserts the unique credit ledger row, and increments balance. Retries and restarts cannot grant the same top-up twice.
- Credentials, private keys and sensitive API responses are not returned to the client.

## Optional real-merchant integration (not tested against production)

The `live` provider is an **opt-in reference adapter** based on the public API contract and the published JangoPay integrations. Do **not** enable it until you have verified an actual merchant/test-account response, the invoice field serializer and especially the Webhook authentication-tag framing against a redacted real event. The published WooCommerce/Azuriom adapters themselves require explicit validation of `appended16` framing. No ready-to-use hosted checkout URL is invented here: the example requests pay-state and confirm-coin, then returns quoted payment instructions.

Configure environment variables on the server, not in source control:

```bash
export JANGOPAY_MODE=live
export ALLOW_REAL_PAYMENTS=1
export JANGOPAY_API_KEY='JangoPay_...'
export JANGOPAY_WEBHOOK_TAG_FORMAT=appended16
export JANGOPAY_FINAL_INVOICE_STATUSES=paid
export JANGOPAY_RSA_PRIVATE_KEY_PATH='/secure/location/merchant-private.pem'
npm start
```

**Required before any actual money:** Set the corresponding public key and callback URL in JangoPay Console; validate actual invoice-create fields, `payment.completed` payload, GCM appended-tag format, `paid`/`settled` statuses, fee/net amount arithmetic and the pay-state/confirm-coin quote shape in a controlled merchant environment. Configure a reachable HTTPS webhook route by **adapting** this code into your real authenticated backend; this local example never listens on public interfaces. It does not silently retry ambiguous invoice creation or quote requests. Incorrect contract assumptions will fail closed rather than issue credits.

## Test

```bash
npm test
```

Tests cover full offline HTTP flow, invalid/duplicated callbacks, merchant mismatches, durable credit ledger, idempotent creation/quoting, malformed amounts and no-credit-before-settlement behavior. They **do not** certify compatibility with real merchant data or production readiness.

## Scope and caveats

- USDT on Tron and USD-priced orders only; a merchant must explicitly verify supported assets on their account.
- One local demo user; no real authentication, customer records, billing invoices or tax accounting.
- Simplified USD-to-credit rule; commercial pricing and legal suitability are outside this repo.
- Real JangoPay response fields and Webhook framing must be validated before launch.
- No automatic subscription charging, refunds, payouts or currency conversion.

Official API documentation: https://doc.jangopay.org/api-reference · [Integration guide](https://doc.jangopay.org/integration-guide)
