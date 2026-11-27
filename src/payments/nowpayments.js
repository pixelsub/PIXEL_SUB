import crypto from 'crypto';
import config from '../config.js';
import logger from '../logger.js';
import { getSetting } from '../services/settings.js';

// NOWPayments (https://nowpayments.io) hosted crypto invoices.
//
// Flow: we create an invoice (POST /invoice) and send the customer to its
// invoice_url. Once they pick a coin NOWPayments creates a *payment* with its
// own payment_id and starts POSTing IPN callbacks to us. The IPN is signed
// (HMAC-SHA512 over the key-sorted JSON body); after checking it we always
// re-read the payment with GET /payment/:id — that server-to-server answer is
// the only thing delivery is based on, exactly like the Cryptomus flow.
//
// Note: looking a payment up by *invoice* id needs a JWT login (email +
// password), so we deliberately don't. The payment_id from the first IPN is
// stored on the order (paymentRef) and the poller re-checks it from then on.

const { apiKey, ipnSecret, apiBase } = config.nowpayments;

// confirmed = confirmed on-chain, sending = being forwarded to our wallet,
// finished = done. The customer's funds are final from `confirmed` on.
export const PAID_STATUSES = new Set(['confirmed', 'sending', 'finished']);
export const UNDERPAID_STATUSES = new Set(['partially_paid']);
export const FAILED_STATUSES = new Set(['failed', 'refunded', 'expired']);

async function request(method, path, body) {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`NOWPayments ${path} returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = new Error(`NOWPayments ${path} error (${res.status}): ${json.message || json.code || text.slice(0, 200)}`);
    err.nowpayments = json;
    throw err;
  }
  return json;
}

/**
 * Create a hosted invoice. The customer chooses the coin on the NOWPayments page.
 * @returns {{ id: string, invoice_url: string }}
 */
export async function createInvoice({ amount, currency, orderId, description }) {
  const callbackUrl = `${config.publicUrl}/api/webhook/nowpayments`;
  const body = {
    price_amount: Number(Number(amount).toFixed(2)),
    price_currency: String(currency || config.shop.currency).toLowerCase(),
    order_id: orderId,
    order_description: description || orderId,
    ipn_callback_url: callbackUrl,
    success_url: 'https://t.me',
    cancel_url: 'https://t.me',
    // NOWPayments fees go on top of the customer's amount. Only valid with a
    // fixed rate, so both flags travel together.
    ...(config.nowpayments.feePaidByUser ? { is_fixed_rate: true, is_fee_paid_by_user: true } : {}),
  };
  logger.info({ orderId, amount: body.price_amount, callbackUrl }, 'Creating NOWPayments invoice');
  const inv = await request('POST', '/invoice', body);
  if (!inv?.id || !inv?.invoice_url) throw new Error('NOWPayments invoice response missing id/invoice_url');
  return { id: String(inv.id), invoice_url: inv.invoice_url };
}

/** Authoritative payment status (server-to-server, API key auth). */
export async function getPayment(paymentId) {
  return request('GET', `/payment/${encodeURIComponent(String(paymentId))}`);
}

// Recursively sort object keys — NOWPayments signs the key-sorted JSON.
function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => { acc[k] = sortObject(value[k]); return acc; }, {});
  }
  return value;
}

/** Verify the x-nowpayments-sig header of an IPN callback. */
export function verifyIpnSignature(body, signature) {
  if (!ipnSecret || !signature || !body || typeof body !== 'object') return false;
  const expected = crypto.createHmac('sha512', ipnSecret).update(JSON.stringify(sortObject(body))).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature).trim().toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * How far short a partially_paid payment landed, in percent, comparing the
 * crypto actually received with the crypto that was asked for.
 */
export function shortfallPercent(info) {
  const want = Number(info?.pay_amount);
  const got = Number(info?.actually_paid);
  if (!Number.isFinite(want) || want <= 0 || !Number.isFinite(got) || got < 0) return null;
  if (got >= want) return 0;
  return ((want - got) / want) * 100;
}

export function isConfigured() {
  return Boolean(apiKey && ipnSecret);
}

/** May customers start NEW NOWPayments payments (keys set and admin switch on)? */
export async function isEnabled() {
  if (!isConfigured()) return false;
  return (await getSetting('nowpayments_enabled')) !== 'false';
}
