import crypto from 'crypto';
import config from '../config.js';
import logger from '../logger.js';

const BASE = 'https://api.bybit.com';
const RECV_WINDOW = '5000';

export function isConfigured() {
  return Boolean(config.bybit.apiKey && config.bybit.apiSecret && config.bybit.uid);
}

/**
 * Build a HMAC-SHA256 signed GET request for the Bybit V5 private API.
 * Bybit V5 signature payload: timestamp + apiKey + recvWindow + queryString
 */
async function signedGet(path, params = {}) {
  const timestamp = Date.now().toString();
  const queryString = new URLSearchParams(params).toString();
  const payload = timestamp + config.bybit.apiKey + RECV_WINDOW + queryString;
  const signature = crypto
    .createHmac('sha256', config.bybit.apiSecret)
    .update(payload)
    .digest('hex');

  const url = `${BASE}${path}${queryString ? '?' + queryString : ''}`;
  const res = await fetch(url, {
    headers: {
      'X-BAPI-API-KEY': config.bybit.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': RECV_WINDOW,
      'X-BAPI-SIGN': signature,
      'X-BAPI-SIGN-TYPE': '2',
    },
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bybit ${path} returned non-JSON (${res.status}): ${text.slice(0, 160)}`);
  }
  // Bybit uses retCode: 0 for success, anything else is an error.
  if (!res.ok || (json.retCode !== undefined && json.retCode !== 0)) {
    throw new Error(`Bybit ${path} error ${json.retCode ?? res.status}: ${json.retMsg || 'unknown'}`);
  }
  return json;
}

/**
 * Fetch recent internal deposit records received by this account.
 *
 * Bybit Internal Deposits (/v5/asset/deposit/query-internal-record) are
 * off-chain user-to-user transfers — exactly what happens when a customer
 * sends USDT to our Bybit UID from inside their own Bybit account.
 *
 * Response row fields:
 *   txID         — transaction identifier (what the customer copies)
 *   coin         — always "USDT" in our case
 *   amount       — string e.g. "10.00"
 *   status       — 1=Processing, 2=Success, 3=Failed
 *   fromMemberId — sender's Bybit UID
 *   createdTime  — millisecond timestamp string
 */
export async function getInternalDeposits({ limit = 50, startTime } = {}) {
  const params = { coin: 'USDT', limit: String(limit) };
  if (startTime) params.startTime = String(Math.floor(startTime));
  const res = await signedGet('/v5/asset/deposit/query-internal-record', params);
  return Array.isArray(res.result?.rows) ? res.result.rows : [];
}

/**
 * Normalise whatever the customer pasted as a transaction ID.
 */
function normalizeRef(v) {
  return String(v || '').trim().replace(/\s+/g, '').replace(/^[#:]+|[.,;]+$/g, '');
}

/**
 * Bybit returns createdTime in some endpoints as seconds (~10 digits) and
 * others as milliseconds (~13 digits). Always normalise to milliseconds.
 */
function toMs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // A 10-digit number is a Unix timestamp in seconds; 13-digit is already ms.
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Find the incoming Bybit internal transfer the customer says they sent,
 * identified by the transaction ID they pasted.
 *
 * A transaction ID alone does not release goods — the transfer must also be:
 *  - coin USDT
 *  - status Success (2)
 *  - dated at/after the order (with grace)
 *  - value within tolerancePct of what is owed
 *  - not already claimed by another order
 *
 * Returns { tx } on success or { error } with a specific reason so the
 * customer gets a useful message rather than a generic failure.
 */
export async function findPaymentByReference({
  reference,
  amount,
  createdAt,
  tolerancePct = 2,
  usedTxIds = new Set(),
  // 2-hour grace: covers clock drift, user transferring before placing the order,
  // and Bybit processing/confirmation delays.
  graceMs = 2 * 60 * 60 * 1000,
}) {
  const ref = normalizeRef(reference);
  if (ref.length < 4) return { error: 'ref_too_short' };

  const owed = Number(amount);
  if (!Number.isFinite(owed) || owed <= 0) return { error: 'api_error' };

  const since = new Date(createdAt).getTime() - graceMs;

  let rows;
  try {
    // Query without startTime — Bybit caps at 50 rows which is enough for any
    // normal transaction volume. Passing startTime risks excluding a valid
    // payment if the API interprets the unit (seconds vs ms) differently.
    rows = await getInternalDeposits({ limit: 50 });
  } catch (e) {
    logger.warn({ err: e.message }, 'bybit: internal deposit lookup failed');
    return { error: 'api_error' };
  }

  // Match by txID — exact match first, then substring (handles different formats).
  const matches = (r) => {
    const txId = normalizeRef(r.txID);
    if (!txId) return false;
    return txId === ref || txId.includes(ref) || ref.includes(txId);
  };

  const found = rows.filter(matches);
  if (!found.length) return { error: 'not_found' };

  // Must be USDT.
  const usdt = found.filter((r) => String(r.coin || '').toUpperCase() === 'USDT');
  if (!usdt.length) return { error: 'not_incoming' };

  // Must be a completed transfer (status 2 = Success).
  const successful = usdt.filter((r) => Number(r.status) === 2);
  if (!successful.length) return { error: 'not_incoming' };

  // Transaction id must not already be attached to another order.
  const unclaimed = successful.filter((r) => !usedTxIds.has(String(r.txID)));
  if (!unclaimed.length) return { error: 'already_used' };

  // Must be dated at or after the order was created (with grace window).
  // toMs() normalises Bybit timestamps — API may return seconds or milliseconds.
  const inWindow = unclaimed.filter((r) => toMs(r.createdTime) >= since);
  if (!inWindow.length) return { error: 'too_old' };

  // Amount must be within tolerance of what is owed.
  const enough = inWindow.filter((r) => {
    const got = Number(r.amount);
    if (!Number.isFinite(got)) return false;
    if (got >= owed) return true;
    return ((owed - got) / owed) * 100 <= tolerancePct;
  });
  if (!enough.length) {
    return { error: 'wrong_amount', tx: inWindow[0], owed };
  }

  // Oldest first — settle the payment that has been waiting longest.
  enough.sort((a, b) => toMs(a.createdTime) - toMs(b.createdTime));
  return { tx: enough[0] };
}
