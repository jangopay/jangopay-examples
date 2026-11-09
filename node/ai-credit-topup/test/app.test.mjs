import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, setupKeys, makeService, encryptDemoEvent, decryptWebhook, createHttpApp, AppError } from '../src/app.mjs';

const HEADERS = { 'x-jangopay-event': 'payment.completed', 'x-jangopay-encryption-alg': 'AES-256-GCM',
  'x-jangopay-key-encryption': 'RSA-OAEP-SHA256' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'jangopay-demo-'));
  const keyFiles = setupKeys(directory);
  const privateKey = readFileSync(keyFiles.privateFile, 'utf8');
  const publicKey = readFileSync(keyFiles.publicFile, 'utf8');
  const dbFile = join(directory, 'topups.sqlite');
  const db = openDb(dbFile);
  const service = makeService(db, { mode: 'mock', privateKeyPem: privateKey });
  return { directory, dbFile, db, service, publicKey, privateKey,
    dispose() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
function evt(f, t, overrides = {}) {
  const row = f.db.prepare('SELECT * FROM mock_invoices WHERE invoice_id=?').get(t.invoiceId);
  return encryptDemoEvent({ event_type: 'payment.completed', invoice_id: t.invoiceId,
    order_id: t.id, txn_id: row.txn_id, tx_hash: row.tx_hash, ...overrides }, f.publicKey);
}
async function quoted(f, amount = '10.00', key = randomUUID()) {
  const topup = await f.service.create(amount, key);
  assert.equal(topup.state, 'awaiting_payment');
  const quote = await f.service.quote(topup.id);
  assert.equal(quote.state, 'quoted');
  return quote;
}
function settle(f, topup) {
  f.db.prepare("UPDATE mock_invoices SET state='paid',txn_state='settled',tx_hash=? WHERE invoice_id=?")
    .run('f'.repeat(64), topup.invoiceId);
}

test('create, quote, encrypted event, durable exactly-once credit and restart', async () => {
  const f = fixture();
  try {
    const t = await quoted(f);
    assert.equal(f.service.balance().credits, 0);
    assert.equal(t.payment.warning.includes('MOCK'), true);
    settle(f, t);
    const envelope = evt(f, t);
    assert.deepEqual(await f.service.webhook(envelope, HEADERS), { result: 'credited', credits: 1000 });
    assert.deepEqual(await f.service.webhook(envelope, HEADERS), { result: 'duplicate' });
    assert.equal(f.service.balance().credits, 1000);
    assert.equal(f.service.balance().ledger.length, 1);
    const again = makeService(f.db, { mode: 'mock', privateKeyPem: f.privateKey });
    assert.equal(again.balance().credits, 1000);
    assert.deepEqual(await again.webhook(envelope, HEADERS), { result: 'duplicate' });
  } finally { f.dispose(); }
});

test('client idempotency and decimal validation', async () => {
  const f = fixture();
  try {
    const key = randomUUID();
    const t1 = await f.service.create('12.34', key);
    const t2 = await f.service.create('12.34', key);
    assert.equal(t1.invoiceId, t2.invoiceId);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM mock_invoices').get().n, 1);
    await assert.rejects(f.service.create('13.00', key), error => error.status === 409);
    for (const value of ['0.50', '1000.01', '1.1', '1e6', 'nan', 10, '00.10']) {
      await assert.rejects(f.service.create(value, randomUUID()), error => error.status === 400);
    }
  } finally { f.dispose(); }
});

test('duplicate quote cannot create a second merchant transaction', async () => {
  const f = fixture();
  try {
    const t = await quoted(f);
    const t2 = await f.service.quote(t.id);
    assert.deepEqual(t.payment, t2.payment);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM mock_invoices WHERE txn_id IS NOT NULL').get().n, 1);
  } finally { f.dispose(); }
});

test('cryptographic tamper and incorrect webhook fields are rejected', async () => {
  const f = fixture();
  try {
    const t = await quoted(f);
    settle(f, t);
    const envelope = evt(f, t);
    const ct = Buffer.from(envelope.ciphertext, 'base64');
    ct[0] ^= 1;
    await assert.rejects(f.service.webhook({ ...envelope, ciphertext: ct.toString('base64') }, HEADERS), e => e.status === 400);
    await assert.rejects(f.service.webhook(envelope, { ...HEADERS, 'x-jangopay-event': 'payout.completed' }), e => e.status === 400);
    await assert.rejects(f.service.webhook(evt(f, t, { txn_id: 'not-the-quote' }), HEADERS), e => e.status === 409);
    assert.equal(f.service.balance().credits, 0);
  } finally { f.dispose(); }
});

test('encryptable but fake notification is not payment proof', async () => {
  const f = fixture();
  try {
    const t = await quoted(f);
    await assert.rejects(f.service.webhook(evt(f, t), HEADERS), e => e.status === 503);
    assert.equal(f.service.balance().credits, 0);
    assert.equal(f.service.get(t.id).state, 'quoted');
  } finally { f.dispose(); }
});

test('merchant API mismatches never credit users', async () => {
  const f = fixture();
  try {
    const t = await quoted(f);
    settle(f, t);
    f.db.prepare('UPDATE mock_invoices SET amount_cents=amount_cents+100 WHERE invoice_id=?').run(t.invoiceId);
    await assert.rejects(f.service.webhook(evt(f, t), HEADERS), e => e.status === 409);
    assert.equal(f.service.balance().credits, 0);
  } finally { f.dispose(); }
});

test('one remote transaction cannot fulfill two local orders', async () => {
  const f = fixture();
  try {
    const first = await quoted(f); settle(f, first);
    const second = await quoted(f);
    f.db.prepare('UPDATE topups SET quote_txn_id=NULL WHERE id=?').run(second.id);
    await f.service.webhook(evt(f, first), HEADERS);
    assert.equal(f.service.balance().credits, 1000);
    assert.equal(f.service.get(second.id).state, 'quoted');
  } finally { f.dispose(); }
});

test('HTTP end-to-end JSON requests, quote and encrypted callback', async () => {
  const f = fixture();
  const server = createHttpApp(f.service);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = await fetch(url + '/api/topups', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ amountUsd: '2.50' }) });
    assert.equal(post.status, 201);
    const t = await post.json();
    const quotedResponse = await fetch(`${url}/api/topups/${t.id}/quote`, { method: 'POST' });
    assert.equal((await quotedResponse.json()).state, 'quoted');
    settle(f, t);
    const callback = await fetch(url + '/webhooks/jangopay', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-JangoPay-Event': 'payment.completed',
      'X-JangoPay-Encryption-Alg': 'AES-256-GCM', 'X-JangoPay-Key-Encryption': 'RSA-OAEP-SHA256'
    }, body: JSON.stringify(evt(f, t)) });
    assert.equal(callback.status, 200);
    assert.equal((await callback.json()).result, 'credited');
    assert.equal((await (await fetch(url + '/api/balance')).json()).credits, 250);
    assert.equal((await fetch(url + '/api/nope')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); f.dispose(); }
});
