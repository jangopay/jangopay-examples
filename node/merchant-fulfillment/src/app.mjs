// Local JangoPay merchant fulfillment demonstration (Node 22.16+; no dependencies).
// All endpoints are LOOPBACK ONLY and use a single test account. Not production software.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { AppError, setupKeys, encryptDemoEvent, decryptWebhook } from '../../ai-credit-topup/src/app.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local');
const ASSET = 'USDT:tron';
const fail = (status, message) => { throw new AppError(status, message); };
const field = (o, snake, camel) => o?.[snake] ?? o?.[camel];
const usd = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
const CATALOG = Object.freeze({
  'license-basic': { type: 'digital', amountCents: 900, description: 'Example license' },
  'vpn-monthly': { type: 'renewal', amountCents: 500, days: 30, description: 'Example VPN renewal' },
});
function parseUsd(x) {
  if (typeof x !== 'string' || !/^(?:0|[1-9]\d{0,6})\.\d{2}$/.test(x)) fail(409, 'Invalid USD settlement amount');
  const [a, b] = x.split('.');
  return Number(a) * 100 + Number(b);
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
export function openDb(path = join(LOCAL, 'fulfillment.sqlite')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, sku TEXT NOT NULL,
    kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, asset TEXT NOT NULL,
    invoice_id TEXT UNIQUE, quote_txn_id TEXT UNIQUE, pay_amount TEXT, address TEXT,
    state TEXT NOT NULL DEFAULT 'creating', created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS deliveries (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), license_key TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS fulfillments (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), txn_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS mock_payments (
    invoice_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE,
    amount_cents INTEGER NOT NULL, asset TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    txn_id TEXT UNIQUE, txn_state TEXT DEFAULT 'pending', tx_hash TEXT
  );`);
  db.prepare('INSERT OR IGNORE INTO subscriptions(id) VALUES (?)').run('demo-vpn-account');
  return db;
}
function mockProvider(db) {
  return {
    async create(order) {
      const invoiceId = 'mock-inv-' + randomUUID();
      db.prepare('INSERT INTO mock_payments(invoice_id,order_id,amount_cents,asset) VALUES (?,?,?,?)')
        .run(invoiceId, order.id, order.amount_cents, ASSET);
      return { invoiceId };
    },
    async quote(invoiceId) {
      const row = db.prepare('SELECT * FROM mock_payments WHERE invoice_id=?').get(invoiceId);
      if (!row) fail(404, 'Unknown mock invoice');
      const txnId = 'mock-txn-' + randomUUID();
      db.prepare('UPDATE mock_payments SET txn_id=? WHERE invoice_id=? AND txn_id IS NULL').run(txnId, invoiceId);
      const saved = db.prepare('SELECT * FROM mock_payments WHERE invoice_id=?').get(invoiceId);
      return { txnId: saved.txn_id, payAmount: usd(row.amount_cents), receiveAddress: 'MOCK-NOT-A-REAL-ADDRESS', asset: ASSET };
    },
    async invoice(invoiceId) {
      const row = db.prepare('SELECT * FROM mock_payments WHERE invoice_id=?').get(invoiceId);
      if (!row) fail(404, 'Missing mock invoice');
      return { invoiceId, orderId: row.order_id, currencyCode: 'USD', amount: usd(row.amount_cents),
        payedAmount: usd(row.amount_cents), feePayByUser: false, status: row.state };
    },
    async transaction(txnId) {
      const row = db.prepare('SELECT * FROM mock_payments WHERE txn_id=?').get(txnId);
      if (!row) fail(404, 'Missing mock transaction');
      return { txnId, invoiceId: row.invoice_id, status: row.txn_state, payCurrency: 'USDT', chain: 'tron',
        currencyCode: 'USD', amount: usd(row.amount_cents), feeAmount: '0.00',
        netAmount: usd(row.amount_cents), feePayByUser: false, txHash: row.tx_hash };
    },
  };
}
// Deliberate scope: this service uses only the local mock provider.
// No simulated application is allowed to silently create a payable production invoice.
export function makeService(db, { privateKeyPem, provider = mockProvider(db), nowSeconds = () => Math.floor(Date.now() / 1000) } = {}) {
  const getRow = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const publicOrder = id => {
    const row = getRow(id);
    if (!row) return null;
    return { id: row.id, sku: row.sku, type: row.kind, amountUsd: usd(row.amount_cents),
      state: row.state, invoiceId: row.invoice_id,
      payment: row.state === 'quoted' ? { asset: row.asset, payAmount: row.pay_amount,
        address: row.address, warning: 'MOCK PAYMENT ONLY. DO NOT SEND REAL FUNDS.' } : null };
  };
  return {
    get: publicOrder,
    status() {
      const delivered = db.prepare('SELECT order_id AS orderId, license_key AS licenseKey FROM deliveries').all();
      const expiresAt = db.prepare('SELECT expires_at FROM subscriptions WHERE id=?').get('demo-vpn-account').expires_at;
      return { digitalLicenses: delivered, vpnExpiresAt: expiresAt ? new Date(expiresAt * 1000).toISOString() : null };
    },
    async create(sku, requestKey) {
      if (!Object.hasOwn(CATALOG, sku)) fail(400, 'Unknown product');
      if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(requestKey)) fail(400, 'Valid Idempotency-Key required');
      const product = CATALOG[sku];
      const { row, fresh } = transaction(db, () => {
        const existing = db.prepare('SELECT * FROM orders WHERE request_key=?').get(requestKey);
        if (existing) {
          if (existing.sku !== sku) fail(409, 'Idempotency key was used for a different SKU');
          return { row: existing, fresh: false };
        }
        const id = randomUUID();
        db.prepare('INSERT INTO orders(id,request_key,sku,kind,amount_cents,asset,state) VALUES (?,?,?,?,?,?,?)')
          .run(id, requestKey, sku, product.type, product.amountCents, ASSET, 'creating');
        return { row: getRow(id), fresh: true };
      });
      if (fresh) {
        try {
          const result = await provider.create(row);
          if (typeof result?.invoiceId !== 'string' || !result.invoiceId) throw new Error('Invoice ID missing');
          db.prepare("UPDATE orders SET invoice_id=?, state='awaiting_payment' WHERE id=? AND state='creating'")
            .run(result.invoiceId, row.id);
        } catch {
          // Unknown remote result. Never blindly issue another POST.
          db.prepare("UPDATE orders SET state='creation_unknown' WHERE id=? AND state='creating'").run(row.id);
        }
      }
      return publicOrder(row.id);
    },
    async quote(id) {
      const row = getRow(id);
      if (!row) fail(404, 'Order missing');
      if (row.state === 'quoted' || row.state === 'fulfilled') return publicOrder(id);
      if (row.state !== 'awaiting_payment') fail(409, 'Quote not allowed in current order state');
      if (!db.prepare("UPDATE orders SET state='quoting' WHERE id=? AND state='awaiting_payment'").run(id).changes) fail(409, 'Quote already being processed');
      try {
        const q = await provider.quote(row.invoice_id);
        if (q?.asset !== ASSET || typeof q.txnId !== 'string' || !q.txnId
            || typeof q.payAmount !== 'string' || !/^[0-9]+(?:\.[0-9]{1,18})?$/.test(q.payAmount)
            || /^0+(?:\.0+)?$/.test(q.payAmount)
            || typeof q.receiveAddress !== 'string' || !q.receiveAddress) throw new Error('Bad quote');
        db.prepare("UPDATE orders SET quote_txn_id=?,pay_amount=?,address=?,state='quoted' WHERE id=? AND state='quoting'")
          .run(q.txnId, q.payAmount, q.receiveAddress, id);
      } catch {
        db.prepare("UPDATE orders SET state='quote_unknown' WHERE id=? AND state='quoting'").run(id);
      }
      return publicOrder(id);
    },
    async webhook(envelope, headers) {
      if (!privateKeyPem) fail(503, 'Local merchant key unavailable');
      const notice = decryptWebhook(envelope, headers, privateKeyPem);
      const invoiceId = field(notice, 'invoice_id', 'invoiceId');
      const txnId = field(notice, 'txn_id', 'txnId');
      const orderId = field(notice, 'order_id', 'orderId');
      if (typeof invoiceId !== 'string' || !invoiceId || typeof txnId !== 'string' || !txnId) fail(400, 'Missing payment identifiers');
      const row = db.prepare('SELECT * FROM orders WHERE invoice_id=?').get(invoiceId);
      if (!row) fail(404, 'Unknown invoice');
      if (row.state === 'fulfilled') return { result: 'duplicate' };
      if (row.state !== 'quoted' || row.quote_txn_id !== txnId || (orderId !== undefined && orderId !== row.id))
        fail(409, 'Order is not payable or payment identity mismatch');
      // A forged but decryptable event cannot cause fulfillment: query the merchant-side invoice and txn.
      const inv = await provider.invoice(invoiceId);
      const t = await provider.transaction(txnId);
      const valid = field(inv, 'invoice_id', 'invoiceId') === row.invoice_id
        && field(inv, 'order_id', 'orderId') === row.id
        && field(inv, 'currency_code', 'currencyCode') === 'USD'
        && parseUsd(field(inv, 'amount', 'amount')) === row.amount_cents
        && field(t, 'txn_id', 'txnId') === txnId
        && field(t, 'invoice_id', 'invoiceId') === row.invoice_id
        && String(field(t, 'pay_currency', 'payCurrency') ?? '').toUpperCase() === 'USDT'
        && String(field(t, 'chain', 'chain') ?? '').toLowerCase() === 'tron';
      if (!valid) fail(409, 'Merchant records do not match local order');
      if (String(field(inv, 'status', 'status') ?? '').toLowerCase() !== 'paid'
        || String(field(t, 'status', 'status') ?? '').toLowerCase() !== 'settled')
        fail(503, 'Final payment settlement not verified');
      const paid = parseUsd(field(inv, 'payed_amount', 'payedAmount'));
      const gross = parseUsd(field(t, 'amount', 'amount'));
      if (gross !== row.amount_cents) fail(409, 'Gross amount mismatch');
      if (paid !== gross) {
        const net = parseUsd(field(t, 'net_amount', 'netAmount'));
        const fee = parseUsd(field(t, 'fee_amount', 'feeAmount'));
        if (field(inv, 'fee_pay_by_user', 'feePayByUser') !== false
          || field(t, 'fee_pay_by_user', 'feePayByUser') !== false
          || field(t, 'currency_code', 'currencyCode') !== 'USD'
          || net !== paid || net + fee !== gross || net <= 0) fail(409, 'Cannot reconcile settlement net/fee');
      }
      const eventHash = field(notice, 'tx_hash', 'txHash');
      const merchantHash = field(t, 'tx_hash', 'txHash');
      if (eventHash !== undefined && (typeof eventHash !== 'string' || !merchantHash || eventHash !== merchantHash))
        fail(409, 'Transaction hash mismatch');
      return transaction(db, () => {
        if (!db.prepare("UPDATE orders SET state='fulfilled' WHERE id=? AND state='quoted'").run(row.id).changes)
          return { result: 'duplicate' };
        db.prepare('INSERT INTO fulfillments(order_id,txn_id,kind) VALUES (?,?,?)').run(row.id, txnId, row.kind);
        if (row.kind === 'digital') {
          const license = 'DEMO-LICENSE-' + randomBytes(12).toString('hex').toUpperCase();
          db.prepare('INSERT INTO deliveries(order_id,license_key) VALUES (?,?)').run(row.id, license);
          return { result: 'fulfilled', type: 'digital' };
        }
        if (row.kind === 'renewal') {
          const previous = db.prepare('SELECT expires_at FROM subscriptions WHERE id=?').get('demo-vpn-account').expires_at;
          const next = Math.max(nowSeconds(), previous) + CATALOG[row.sku].days * 86400;
          db.prepare('UPDATE subscriptions SET expires_at=? WHERE id=?').run(next, 'demo-vpn-account');
          return { result: 'fulfilled', type: 'renewal' };
        }
        fail(500, 'Unknown fulfillment type');
      });
    },
  };
}
async function json(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'Expected application/json');
  const chunks = []; let count = 0;
  for await (const part of req) { count += part.length; if (count > 32768) fail(413, 'Body too large'); chunks.push(part); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Expected object'); return body; }
  catch (err) { if (err instanceof AppError) throw err; fail(400, 'Invalid JSON'); }
}
function output(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
export function createHttpApp(service) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return output(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/entitlements') return output(res, 200, service.status());
      if (req.method === 'POST' && url.pathname === '/api/orders') {
        const data = await json(req);
        return output(res, 201, await service.create(data.sku, req.headers['idempotency-key']));
      }
      const match = url.pathname.match(/^\/api\/orders\/([0-9a-f-]{36})(\/quote)?$/);
      if (match && req.method === 'GET' && !match[2]) {
        const row = service.get(match[1]); if (!row) fail(404, 'Order not found');
        return output(res, 200, row);
      }
      if (match && req.method === 'POST' && match[2]) return output(res, 200, await service.quote(match[1]));
      if (req.method === 'POST' && url.pathname === '/webhooks/jangopay') {
        const body = await json(req); return output(res, 200, await service.webhook(body, req.headers));
      }
      fail(404, 'Not found');
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      output(res, status, { error: status >= 500 ? 'Request failed; consult local server logs' : err.message });
    }
  });
}
async function main() {
  const cmd = process.argv[2];
  const db = openDb(process.env.FULFILLMENT_DB_PATH ? resolve(process.env.FULFILLMENT_DB_PATH) : undefined);
  if (cmd === 'setup') { const p = setupKeys(LOCAL); console.log(p.created ? 'Local RSA keys generated' : 'Local RSA keys exist'); db.close(); return; }
  const keys = setupKeys(LOCAL);
  const svc = makeService(db, { privateKeyPem: readFileSync(keys.privateFile, 'utf8') });
  if (cmd === 'simulate') {
    const row = db.prepare("SELECT * FROM orders WHERE id=? AND state IN ('quoted','fulfilled')").get(process.argv[3]);
    if (!row) fail(404, 'Provide a quoted order ID');
    db.prepare("UPDATE mock_payments SET state='paid',txn_state='settled',tx_hash=COALESCE(tx_hash,?) WHERE invoice_id=?")
      .run(randomBytes(32).toString('hex'), row.invoice_id);
    const pay = db.prepare('SELECT * FROM mock_payments WHERE invoice_id=?').get(row.invoice_id);
    const envelope = encryptDemoEvent({ event_type: 'payment.completed', order_id: row.id,
      invoice_id: row.invoice_id, txn_id: row.quote_txn_id, tx_hash: pay.tx_hash }, readFileSync(keys.publicFile, 'utf8'));
    const port = Number(process.env.PORT || 3848);
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/jangopay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JangoPay-Event': 'payment.completed',
        'X-JangoPay-Encryption-Alg': 'AES-256-GCM', 'X-JangoPay-Key-Encryption': 'RSA-OAEP-SHA256' },
      body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000) });
    console.log(response.status, await response.text()); if (!response.ok) process.exitCode = 1;
    db.close(); return;
  }
  if (cmd !== 'serve') fail(400, 'Usage: setup | serve | simulate <order-id>');
  const port = Number(process.env.PORT || 3848);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'Bad port');
  const server = createHttpApp(svc);
  server.listen(port, '127.0.0.1', () => console.log(`Mock fulfillment demo: http://127.0.0.1:${port}`));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e instanceof AppError ? e.message : 'Unexpected local error'); process.exitCode = 1; });
}
