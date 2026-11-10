import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, makeService, createHttpApp } from '../src/app.mjs';
import { setupKeys, encryptDemoEvent } from '../../ai-credit-topup/src/app.mjs';

const HEADERS = { 'x-jangopay-event': 'payment.completed', 'x-jangopay-encryption-alg': 'AES-256-GCM', 'x-jangopay-key-encryption': 'RSA-OAEP-SHA256' };
function environment(nowSeconds = () => 1800000000) {
  const dir = mkdtempSync(join(tmpdir(), 'jpay-goods-'));
  const db = openDb(join(dir, 'db.sqlite'));
  const keys = setupKeys(dir);
  const svc = makeService(db, { privateKeyPem: readFileSync(keys.privateFile, 'utf8'), nowSeconds });
  const publicKey = readFileSync(keys.publicFile, 'utf8');
  return { db, dir, svc, publicKey, close: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function orderAndQuote(e, sku, key) {
  const order = await e.svc.create(sku, key);
  assert.equal(order.state, 'awaiting_payment');
  const quote = await e.svc.quote(order.id);
  assert.equal(quote.state, 'quoted');
  assert.equal(quote.payment.address, 'MOCK-NOT-A-REAL-ADDRESS');
  return quote;
}
function paid(e, order) {
  const txHash = 'testhash-' + order.id;
  e.db.prepare("UPDATE mock_payments SET state='paid',txn_state='settled',tx_hash=? WHERE invoice_id=?")
    .run(txHash, order.invoiceId);
  const txnId = e.db.prepare('SELECT txn_id FROM mock_payments WHERE invoice_id=?').get(order.invoiceId).txn_id;
  return encryptDemoEvent({ event_type: 'payment.completed', invoice_id: order.invoiceId, txn_id: txnId, order_id: order.id, tx_hash: txHash }, e.publicKey);
}
test('digital purchase delivers only after reconciled payment, once', async () => {
  const e = environment(); try {
    const order = await orderAndQuote(e, 'license-basic', 'digital-order-000001');
    assert.equal(e.svc.status().digitalLicenses.length, 0);
    const env = paid(e, order);
    assert.deepEqual(await e.svc.webhook(env, HEADERS), { result: 'fulfilled', type: 'digital' });
    const license = e.svc.status().digitalLicenses;
    assert.equal(license.length, 1); assert.match(license[0].licenseKey, /^DEMO-LICENSE-/);
    assert.deepEqual(await e.svc.webhook(env, HEADERS), { result: 'duplicate' });
    assert.deepEqual(e.svc.status().digitalLicenses, license);
  } finally { e.close(); }
});
test('renewal advances expiry by 30 days from max(current expiry, now), once', async () => {
  const e = environment(); try {
    const first = await orderAndQuote(e, 'vpn-monthly', 'vpn-first-order-01');
    await e.svc.webhook(paid(e, first), HEADERS);
    assert.equal(Date.parse(e.svc.status().vpnExpiresAt) / 1000, 1800000000 + 30 * 86400);
    const second = await orderAndQuote(e, 'vpn-monthly', 'vpn-second-order-2');
    await e.svc.webhook(paid(e, second), HEADERS);
    assert.equal(Date.parse(e.svc.status().vpnExpiresAt) / 1000, 1800000000 + 60 * 86400);
    await e.svc.webhook(paid(e, second), HEADERS);
    assert.equal(Date.parse(e.svc.status().vpnExpiresAt) / 1000, 1800000000 + 60 * 86400);
  } finally { e.close(); }
});
test('idempotency key never creates a second remote order', async () => {
  const e = environment(); try {
    const first = await e.svc.create('license-basic', 'idempotent-order-01');
    const again = await e.svc.create('license-basic', 'idempotent-order-01');
    assert.equal(first.id, again.id);
    assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM mock_payments').get().n, 1);
    await assert.rejects(e.svc.create('vpn-monthly', 'idempotent-order-01'), { status: 409 });
  } finally { e.close(); }
});
test('pending merchant settlement and mismatched invoice do not fulfill', async () => {
  const e = environment(); try {
    const order = await orderAndQuote(e, 'license-basic', 'pending-order-00001');
    const env = paid(e, order);
    e.db.prepare("UPDATE mock_payments SET txn_state='pending' WHERE invoice_id=?").run(order.invoiceId);
    await assert.rejects(e.svc.webhook(env, HEADERS), { status: 503 });
    assert.equal(e.svc.status().digitalLicenses.length, 0);
    e.db.prepare("UPDATE mock_payments SET txn_state='settled',amount_cents=100 WHERE invoice_id=?").run(order.invoiceId);
    await assert.rejects(e.svc.webhook(env, HEADERS), { status: 409 });
    assert.equal(e.svc.status().digitalLicenses.length, 0);
  } finally { e.close(); }
});
test('forged but encryptable notice is insufficient to grant entitlement', async () => {
  const e = environment(); try {
    const order = await orderAndQuote(e, 'license-basic', 'forged-order-000001');
    const row = e.db.prepare('SELECT txn_id FROM mock_payments WHERE invoice_id=?').get(order.invoiceId);
    const forged = encryptDemoEvent({ invoice_id: order.invoiceId, txn_id: row.txn_id, order_id: order.id }, e.publicKey);
    await assert.rejects(e.svc.webhook(forged, HEADERS), { status: 503 });
    assert.equal(e.svc.status().digitalLicenses.length, 0);
  } finally { e.close(); }
});
test('durable entitlement survives DB reopen', async () => {
  const e = environment(); try {
    const order = await orderAndQuote(e, 'license-basic', 'restart-order-00001');
    await e.svc.webhook(paid(e, order), HEADERS);
    const old = e.svc.status().digitalLicenses;
    const again = openDb(join(e.dir, 'db.sqlite'));
    try { assert.equal(again.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 1); }
    finally { again.close(); }
    assert.equal(old.length, 1);
  } finally { e.close(); }
});
test('HTTP endpoints permit loopback mock purchase and reveal no private key', async () => {
  const e = environment(); const server = createHttpApp(e.svc);
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(url + '/api/orders', { method: 'POST', headers: { 'content-type':'application/json', 'idempotency-key':'http-order-00001' }, body: JSON.stringify({ sku: 'vpn-monthly' }) });
    assert.equal(res.status, 201);
    const order = await res.json(); assert.equal(order.sku, 'vpn-monthly');
    const quote = await fetch(url + `/api/orders/${order.id}/quote`, { method: 'POST' });
    assert.equal((await quote.json()).state, 'quoted');
    const status = await (await fetch(url + '/api/entitlements')).json();
    assert.equal(status.vpnExpiresAt, null); assert.equal(JSON.stringify(status).includes('PRIVATE KEY'), false);
  } finally { await new Promise(resolve => server.close(resolve)); e.close(); }
});
