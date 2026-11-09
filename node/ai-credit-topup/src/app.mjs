import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomBytes, generateKeyPairSync, publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv, constants } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, '.local');
export const DEMO_USER = 'demo-user';
const ASSET = 'USDT:tron';
const MAX_BODY = 32768;
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new AppError(status, message); };
const field = (value, snake, camel) => value?.[snake] ?? value?.[camel];
const usd = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
function cents(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(value)) fail(400, 'Use a USD amount like "10.00"');
  const [whole, fraction] = value.split('.');
  return Number(whole) * 100 + Number(fraction);
}
function exactAmount(value, expectedCents) {
  try { return cents(value) === expectedCents; } catch { return false; }
}
function txn(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const out = fn(); db.exec('COMMIT'); return out; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function openDb(path = join(LOCAL, 'topups.sqlite')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, credits INTEGER NOT NULL DEFAULT 0 CHECK(credits >= 0));
    CREATE TABLE IF NOT EXISTS topups (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id),
      amount_cents INTEGER NOT NULL, credits INTEGER NOT NULL, asset TEXT NOT NULL,
      invoice_id TEXT UNIQUE, quote_txn_id TEXT UNIQUE, pay_amount TEXT, receive_address TEXT,
      state TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS credit_ledger (
      topup_id TEXT PRIMARY KEY REFERENCES topups(id), user_id TEXT NOT NULL REFERENCES users(id),
      delta INTEGER NOT NULL, txn_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS mock_invoices (
      invoice_id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE, amount_cents INTEGER NOT NULL,
      asset TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', txn_id TEXT UNIQUE,
      txn_state TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT
    );`);
  db.prepare('INSERT OR IGNORE INTO users(id) VALUES (?)').run(DEMO_USER);
  return db;
}
export function setupKeys(directory = LOCAL) {
  mkdirSync(directory, { recursive: true });
  const privateFile = join(directory, 'merchant-private.pem');
  const publicFile = join(directory, 'merchant-public.pem');
  if (existsSync(privateFile) || existsSync(publicFile)) {
    if (!existsSync(privateFile) || !existsSync(publicFile)) fail(409, 'Incomplete keypair; fix it manually');
    return { privateFile, publicFile, created: false };
  }
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  writeFileSync(privateFile, pair.privateKey, { mode: 0o600, flag: 'wx' });
  writeFileSync(publicFile, pair.publicKey, { mode: 0o644, flag: 'wx' });
  return { privateFile, publicFile, created: true };
}
function b64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > maxBytes * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail(400, 'Invalid encrypted envelope');
  const data = Buffer.from(value, 'base64');
  if (!data.length || data.length > maxBytes) fail(400, 'Invalid encrypted envelope');
  return data;
}
export function encryptDemoEvent(payload, publicKeyPem) {
  const key = randomBytes(32), nonce = randomBytes(12);
  const encryptor = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([encryptor.update(JSON.stringify(payload), 'utf8'), encryptor.final(), encryptor.getAuthTag()]);
  const encrypted = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { event_type: 'payment.completed', algorithm: 'AES-256-GCM', key_algorithm: 'RSA-OAEP-SHA256',
    encrypted_key: encrypted.toString('base64'), nonce: nonce.toString('base64'), ciphertext: body.toString('base64') };
}
export function decryptWebhook(envelope, headers, privateKeyPem) {
  if (headers['x-jangopay-event'] !== 'payment.completed' || headers['x-jangopay-encryption-alg'] !== 'AES-256-GCM'
    || headers['x-jangopay-key-encryption'] !== 'RSA-OAEP-SHA256') fail(400, 'Invalid webhook headers');
  if (!envelope || envelope.event_type !== 'payment.completed' || envelope.algorithm !== 'AES-256-GCM'
    || envelope.key_algorithm !== 'RSA-OAEP-SHA256') fail(400, 'Invalid webhook envelope');
  const sealedKey = b64(envelope.encrypted_key, 1024);
  const nonce = b64(envelope.nonce, 32), encrypted = b64(envelope.ciphertext, MAX_BODY);
  if (nonce.length !== 12 || encrypted.length <= 16) fail(400, 'Invalid encrypted envelope size');
  try {
    const key = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, sealedKey);
    if (key.length !== 32) fail(400, 'Invalid AES key');
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(encrypted.subarray(-16));
    const raw = Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]);
    const data = JSON.parse(raw.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400, 'Invalid payload');
    if (field(data, 'event_type', 'eventType') && field(data, 'event_type', 'eventType') !== 'payment.completed') fail(400, 'Invalid event');
    return data;
  } catch { fail(400, 'Unable to authenticate webhook envelope'); }
}
function provider(db, config) {
  if (config.mode === 'mock') return {
    async create(order) {
      const invoiceId = `mock-inv-${randomUUID()}`;
      db.prepare('INSERT INTO mock_invoices (invoice_id, order_id, amount_cents, asset) VALUES (?, ?, ?, ?)')
        .run(invoiceId, order.id, order.amount_cents, order.asset);
      return { invoiceId };
    },
    async quote(invoiceId) {
      const row = db.prepare('SELECT * FROM mock_invoices WHERE invoice_id=?').get(invoiceId);
      if (!row) fail(404, 'Unknown mock invoice');
      const txnId = `mock-txn-${randomUUID()}`;
      db.prepare('UPDATE mock_invoices SET txn_id=? WHERE invoice_id=? AND txn_id IS NULL').run(txnId, invoiceId);
      return { txnId, payAmount: usd(row.amount_cents), receiveAddress: 'MOCK-NOT-A-REAL-ADDRESS', asset: row.asset };
    },
    async invoice(invoiceId) {
      const row = db.prepare('SELECT * FROM mock_invoices WHERE invoice_id=?').get(invoiceId);
      if (!row) fail(404, 'Mock invoice not found');
      return { invoiceId, orderId: row.order_id, currencyCode: 'USD', amount: usd(row.amount_cents),
        payedAmount: usd(row.amount_cents), feePayByUser: false, status: row.state };
    },
    async transaction(txnId) {
      const row = db.prepare('SELECT * FROM mock_invoices WHERE txn_id=?').get(txnId);
      if (!row) fail(404, 'Mock transaction not found');
      const [payCurrency, chain] = row.asset.split(':');
      return { txnId, invoiceId: row.invoice_id, status: row.txn_state, payCurrency, chain,
        amount: usd(row.amount_cents), currencyCode: 'USD', feeAmount: '0.00', netAmount: usd(row.amount_cents),
        feePayByUser: false, txHash: row.tx_hash };
    }
  };
  if (config.mode !== 'live' || process.env.ALLOW_REAL_PAYMENTS !== '1'
    || process.env.JANGOPAY_WEBHOOK_TAG_FORMAT !== 'appended16'
    || process.env.JANGOPAY_FINAL_INVOICE_STATUSES !== 'paid'
    || !/^JangoPay_/.test(process.env.JANGOPAY_API_KEY ?? '')) fail(500, 'Live mode is disabled until manually validated and opted in');
  // Read-only invoice/transaction reconciliation is required even after a decryptable notification.
  let token;
  const call = async (path, method, auth, body) => {
    const response = await fetch('https://api.jangopay.org' + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json', ...(auth ? { Authorization: auth } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok || !data || data.success === false || (data.code !== undefined && data.code !== '0000')) {
      fail(502, `JangoPay request failed (HTTP ${response.status})`);
    }
    return data;
  };
  const bearer = async () => {
    if (!token) {
      const response = await call('/api/v1/auth/apikey/token', 'POST', `Basic ${process.env.JANGOPAY_API_KEY}`, {});
      token = response.data?.accessToken;
      if (typeof token !== 'string' || !token) fail(502, 'JangoPay token unavailable');
    }
    return `Bearer ${token}`;
  };
  const get = async path => call(path, 'GET', await bearer());
  return {
    async create(order) {
      const result = await call('/api/v1/invoice/create', 'POST', await bearer(), {
        currency_code: 'USD', amount: usd(order.amount_cents), order_id: order.id,
        description: 'AI API credits example', allowed_currency: [order.asset], cover_pct: 100,
        mix_pay: false, auto_to_u: false, auto_withdraw: false, fee_pay_by_user: false });
      const invoiceId = field(result.invoice, 'invoice_id', 'invoiceId');
      if (typeof invoiceId !== 'string' || !invoiceId) fail(502, 'JangoPay invoice ID unavailable');
      return { invoiceId };
    },
    async quote(invoiceId) {
      const state = await call(`/api/v1/invoice/${encodeURIComponent(invoiceId)}/pay-state`, 'GET');
      const paymentSession = field(state, 'payment_session', 'paymentSession');
      if (typeof paymentSession !== 'string' || !paymentSession) fail(502, 'Payment session unavailable');
      const quote = await call(`/api/v1/invoice/${encodeURIComponent(invoiceId)}/confirm-coin`, 'POST', undefined,
        { invoice_id: invoiceId, pay_currency: 'USDT', chain: 'tron', payment_session: paymentSession });
      const t = quote.transaction;
      const txnId = field(t, 'txn_id', 'txnId');
      const payAmount = field(t, 'pay_amount', 'payAmount');
      const receiveAddress = field(t, 'receive_address', 'receiveAddress');
      if (typeof txnId !== 'string' || !txnId || typeof payAmount !== 'string' || !/^[0-9]+(?:\.[0-9]{1,18})?$/.test(payAmount)
        || /^0+(?:\.0+)?$/.test(payAmount) || typeof receiveAddress !== 'string' || !receiveAddress || receiveAddress.length > 512
        || (field(t, 'invoice_id', 'invoiceId') !== undefined && field(t, 'invoice_id', 'invoiceId') !== invoiceId)
        || (field(t, 'pay_currency', 'payCurrency') !== undefined && String(field(t, 'pay_currency', 'payCurrency')).toUpperCase() !== 'USDT')
        || (field(t, 'chain', 'chain') !== undefined && String(field(t, 'chain', 'chain')).toLowerCase() !== 'tron')) fail(502, 'Incomplete or mismatched payment quote');
      return { txnId, payAmount, receiveAddress, asset: ASSET };
    },
    async invoice(id) {
      const data = await get(`/api/v1/invoice/${encodeURIComponent(id)}`);
      return data.invoice ?? data;
    },
    async transaction(id) {
      const data = await get(`/api/v1/invoice/transaction/${encodeURIComponent(id)}`);
      return data.transaction ?? data;
    }
  };
}
function publicTopup(row, mode) {
  if (!row) return null;
  return { id: row.id, amountUsd: usd(row.amount_cents), credits: row.credits, state: row.state,
    invoiceId: row.invoice_id, payment: row.state === 'quoted' ? {
      asset: row.asset, amount: row.pay_amount, address: row.receive_address,
      warning: mode === 'mock' ? 'MOCK PAYMENT ONLY; DO NOT TRANSFER FUNDS' : 'Confirm asset/network and quote with merchant before paying'
    } : null };
}
export function makeService(db, config = {}) {
  const mode = config.mode ?? 'mock';
  const pay = config.provider ?? provider(db, { mode });
  const privateKeyPem = config.privateKeyPem;
  return {
    balance() {
      const user = db.prepare('SELECT credits FROM users WHERE id=?').get(DEMO_USER);
      const ledger = db.prepare('SELECT topup_id AS topupId, delta, txn_id AS txnId FROM credit_ledger WHERE user_id=? ORDER BY created_at DESC, topup_id DESC LIMIT 20').all(DEMO_USER);
      return { userId: DEMO_USER, credits: user.credits, ledger };
    },
    get(id) { return publicTopup(db.prepare('SELECT * FROM topups WHERE id=?').get(id), mode); },
    async create(amountUsd, requestKey) {
      if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{12,100}$/.test(requestKey)) fail(400, 'Provide an Idempotency-Key (12-100 safe characters)');
      const amountCents = cents(amountUsd);
      if (amountCents < 100 || amountCents > 100000) fail(400, 'Top-up must be between USD 1.00 and USD 1000.00');
      const { row, fresh } = txn(db, () => {
        const existing = db.prepare('SELECT * FROM topups WHERE request_key=?').get(requestKey);
        if (existing) {
          if (existing.amount_cents !== amountCents) fail(409, 'Idempotency key used with a different amount');
          return { row: existing, fresh: false };
        }
        const id = randomUUID();
        db.prepare('INSERT INTO topups(id,request_key,user_id,amount_cents,credits,asset,state) VALUES (?,?,?,?,?,?,?)')
          .run(id, requestKey, DEMO_USER, amountCents, amountCents, ASSET, 'creating');
        return { row: db.prepare('SELECT * FROM topups WHERE id=?').get(id), fresh: true };
      });
      if (fresh) {
        try {
          const invoice = await pay.create(row);
          if (!invoice?.invoiceId || typeof invoice.invoiceId !== 'string') throw new Error('Missing invoice ID');
          db.prepare("UPDATE topups SET invoice_id=?,state='awaiting_payment' WHERE id=? AND state='creating'").run(invoice.invoiceId, row.id);
        } catch {
          // A network timeout may mean the remote invoice WAS created. Never POST twice automatically.
          db.prepare("UPDATE topups SET state='creation_unknown' WHERE id=? AND state='creating'").run(row.id);
        }
      }
      return this.get(row.id);
    },
    async quote(id) {
      const topup = this.get(id);
      if (!topup) fail(404, 'Top-up not found');
      if (topup.state === 'quoted' || topup.state === 'credited') return topup;
      if (topup.state !== 'awaiting_payment') fail(409, 'Quote unavailable; manual reconciliation may be required');
      const claimed = db.prepare("UPDATE topups SET state='quoting' WHERE id=? AND state='awaiting_payment'").run(id).changes;
      if (!claimed) fail(409, 'Quote request already in progress');
      try {
        const quote = await pay.quote(topup.invoiceId);
        if (!quote || quote.asset !== ASSET || typeof quote.txnId !== 'string' || !quote.txnId
          || typeof quote.payAmount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(quote.payAmount)
          || typeof quote.receiveAddress !== 'string' || !quote.receiveAddress) throw new Error('Invalid quote');
        db.prepare("UPDATE topups SET quote_txn_id=?,pay_amount=?,receive_address=?,state='quoted' WHERE id=? AND state='quoting'")
          .run(quote.txnId, quote.payAmount, quote.receiveAddress, id);
      } catch {
        // confirm-coin is potentially side-effecting; do not automatically repeat after timeout.
        db.prepare("UPDATE topups SET state='quote_unknown' WHERE id=? AND state='quoting'").run(id);
      }
      return this.get(id);
    },
    async webhook(envelope, headers) {
      if (!privateKeyPem) fail(503, 'Webhook private key not configured');
      const event = decryptWebhook(envelope, headers, privateKeyPem);
      const invoiceId = field(event, 'invoice_id', 'invoiceId');
      const txnId = field(event, 'txn_id', 'txnId');
      const orderId = field(event, 'order_id', 'orderId');
      if (typeof invoiceId !== 'string' || !invoiceId || typeof txnId !== 'string' || !txnId) fail(400, 'Webhook identifiers missing');
      const topup = db.prepare('SELECT * FROM topups WHERE invoice_id=?').get(invoiceId);
      if (!topup) fail(404, 'Unknown invoice');
      if (topup.state === 'credited') return { result: 'duplicate' };
      if (topup.state !== 'quoted') fail(409, 'Top-up is not ready to receive funds');
      if (txnId !== topup.quote_txn_id || (orderId !== undefined && orderId !== topup.id)) fail(409, 'Payment identity mismatch');
      // The envelope is not a sender signature; anyone with the public key can encrypt.
      // Trust only these independent, authenticated merchant API reads for settlement.
      const invoice = await pay.invoice(invoiceId);
      const t = await pay.transaction(txnId);
      const invoiceStatus = String(field(invoice, 'status', 'status') ?? '').toLowerCase();
      const validIdentity = field(invoice, 'invoice_id', 'invoiceId') === topup.invoice_id
        && field(invoice, 'order_id', 'orderId') === topup.id
        && field(invoice, 'currency_code', 'currencyCode') === 'USD'
        && exactAmount(field(invoice, 'amount', 'amount'), topup.amount_cents)
        && field(t, 'txn_id', 'txnId') === txnId && field(t, 'invoice_id', 'invoiceId') === invoiceId
        && String(field(t, 'pay_currency', 'payCurrency') ?? '').toUpperCase() === 'USDT'
        && String(field(t, 'chain', 'chain') ?? '').toLowerCase() === 'tron';
      if (!validIdentity) fail(409, 'Merchant API identity mismatch; no credits issued');
      if (invoiceStatus !== 'paid' || String(field(t, 'status', 'status') ?? '').toLowerCase() !== 'settled') {
        fail(503, 'Settlement not final; retry after merchant confirmation');
      }
      const gross = topup.amount_cents;
      const paid = field(invoice, 'payed_amount', 'payedAmount');
      const txAmount = field(t, 'amount', 'amount');
      if (!exactAmount(txAmount, gross) || typeof paid !== 'string') fail(409, 'Settlement amount mismatch');
      if (!exactAmount(paid, gross)) {
        const net = field(t, 'net_amount', 'netAmount'), fee = field(t, 'fee_amount', 'feeAmount');
        let netCents, feeCents;
        try { netCents = cents(net); feeCents = cents(fee); }
        catch { fail(409, 'Unverified net/fee reconciliation'); }
        if (field(invoice, 'fee_pay_by_user', 'feePayByUser') !== false || field(t, 'fee_pay_by_user', 'feePayByUser') !== false
          || field(t, 'currency_code', 'currencyCode') !== 'USD' || !exactAmount(paid, netCents)
          || netCents + feeCents !== gross || netCents <= 0) fail(409, 'Unverified net/fee reconciliation');
      }
      const eventHash = field(event, 'tx_hash', 'txHash');
      const remoteHash = field(t, 'tx_hash', 'txHash');
      if (eventHash !== undefined && (typeof eventHash !== 'string' || !remoteHash || eventHash !== remoteHash)) fail(409, 'Transaction hash mismatch');
      // Unique topup_id and txn_id + one SQLite write transaction make fulfillment exactly once locally.
      return txn(db, () => {
        const updated = db.prepare("UPDATE topups SET state='credited' WHERE id=? AND state='quoted'").run(topup.id);
        if (!updated.changes) return { result: 'duplicate' };
        db.prepare('INSERT INTO credit_ledger (topup_id,user_id,delta,txn_id) VALUES (?,?,?,?)')
          .run(topup.id, topup.user_id, topup.credits, txnId);
        db.prepare('UPDATE users SET credits=credits+? WHERE id=?').run(topup.credits, topup.user_id);
        return { result: 'credited', credits: topup.credits };
      });
    }
  };
}
async function readJson(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) fail(415, 'Use application/json');
  let size = 0, chunks = [];
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BODY) fail(413, 'Request too large');
    chunks.push(part);
  }
  try { const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) fail(400, 'Expected JSON object');
    return obj;
  } catch (e) { if (e instanceof AppError) throw e; fail(400, 'Invalid JSON'); }
}
function response(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}
export function createHttpApp(service) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/healthz') return response(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/balance') return response(res, 200, service.balance());
      if (req.method === 'POST' && url.pathname === '/api/topups') {
        const data = await readJson(req);
        return response(res, 201, await service.create(data.amountUsd, req.headers['idempotency-key']));
      }
      const match = url.pathname.match(/^\/api\/topups\/([0-9a-f-]{36})(\/quote)?$/);
      if (match && req.method === 'GET' && !match[2]) {
        const topup = service.get(match[1]);
        if (!topup) fail(404, 'Top-up not found');
        return response(res, 200, topup);
      }
      if (match && req.method === 'POST' && match[2]) return response(res, 200, await service.quote(match[1]));
      if (req.method === 'POST' && url.pathname === '/webhooks/jangopay') {
        const data = await readJson(req);
        return response(res, 200, await service.webhook(data, req.headers));
      }
      fail(404, 'Not found');
    } catch (error) {
      // Never echo upstream response bodies, tokens, keys, decrypted payloads or stack traces.
      const status = error instanceof AppError ? error.status : 500;
      response(res, status, { error: status >= 500 ? 'Request could not be completed; consult local logs' : error.message });
    }
  });
}
async function main() {
  const command = process.argv[2];
  if (command === 'setup') {
    const result = setupKeys();
    console.log(result.created ? 'Generated demo merchant keypair under .local/' : 'Demo keys already exist');
    return;
  }
  const mode = process.env.JANGOPAY_MODE || 'mock';
  if (!['mock', 'live'].includes(mode)) fail(500, 'Unknown mode');
  const dbPath = process.env.TOPUP_DB_PATH ? resolve(process.env.TOPUP_DB_PATH) : join(LOCAL, 'topups.sqlite');
  const keyFile = mode === 'mock' ? join(LOCAL, 'merchant-private.pem') : process.env.JANGOPAY_RSA_PRIVATE_KEY_PATH;
  if (!keyFile || !existsSync(keyFile)) fail(500, 'Merchant private key missing; run npm run setup for demo');
  const db = openDb(dbPath);
  if (command === 'simulate') {
    if (mode !== 'mock') fail(403, 'Simulation is only available in mock mode');
    const id = process.argv[3];
    const row = db.prepare("SELECT * FROM topups WHERE id=? AND state IN ('quoted','credited')").get(id);
    if (!row) fail(404, 'Provide an existing quoted top-up id');
    const txHash = randomBytes(32).toString('hex');
    db.prepare("UPDATE mock_invoices SET state='paid',txn_state='settled',tx_hash=COALESCE(tx_hash,?) WHERE invoice_id=?")
      .run(txHash, row.invoice_id);
    const actual = db.prepare('SELECT * FROM mock_invoices WHERE invoice_id=?').get(row.invoice_id);
    const publicKeyPem = readFileSync(join(LOCAL, 'merchant-public.pem'), 'utf8');
    const envelope = encryptDemoEvent({ event_type: 'payment.completed', invoice_id: row.invoice_id,
      order_id: row.id, txn_id: row.quote_txn_id, tx_hash: actual.tx_hash }, publicKeyPem);
    const port = Number(process.env.PORT || '3847');
    const result = await fetch(`http://127.0.0.1:${port}/webhooks/jangopay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json',
        'X-JangoPay-Event': 'payment.completed', 'X-JangoPay-Encryption-Alg': 'AES-256-GCM',
        'X-JangoPay-Key-Encryption': 'RSA-OAEP-SHA256' }, body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5000) });
    console.log(result.status, await result.text());
    if (!result.ok) process.exitCode = 1;
    db.close(); return;
  }
  if (command !== 'serve') fail(400, 'Use setup, serve or simulate <topup-id>');
  const svc = makeService(db, { mode, privateKeyPem: readFileSync(keyFile, 'utf8') });
  const port = Number(process.env.PORT || '3847');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail(400, 'Invalid port');
  const server = createHttpApp(svc);
  server.listen(port, '127.0.0.1', () => console.log(`JangoPay ${mode} top-up demo listening on http://127.0.0.1:${port}`));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error:', e instanceof AppError ? e.message : 'Unexpected failure'); process.exitCode = 1; });
}
