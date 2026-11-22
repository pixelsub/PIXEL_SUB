// Connector for the Hangout reseller API (REST · JSON · Bearer).
//   GET  /balance /products /orders?page=&page_size= /orders/{id}
//   POST /purchase  { product_id: "p:123", quantity }  + Idempotency-Key header
// Prices are USDT (treated as USD). Orders are fulfilled MANUALLY: an accepted
// purchase is "pending", and delivery details appear later on /orders/{id}.
// The supplier worker retries pending orders every minute; each retry re-POSTs
// with the same Idempotency-Key (never charges twice) and then reads the order.
//
// max_total is required by /purchase (invalid_purchase without it). Hangout also
// wants an identical body on retry, so it is a generous whole-number ceiling
// (2x price, rounded up) rather than the exact total.
//
// Same interface as tokopremium.js so the rest of the shop stays unaware.

import { SupplierError } from './tokopremium.js';

const TIMEOUT_MS = 25_000;

async function request(supplier, method, path, { body, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${supplier.apiKey}`, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  let res;
  try {
    res = await fetch(supplier.baseUrl.replace(/\/+$/, '') + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new SupplierError(`Network error: ${e.message}`, { code: 'network_error', definite: false });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }

  if (!res.ok) {
    const errObj = typeof data?.error === 'object' ? data.error : null;
    const message = errObj?.message || (typeof data?.error === 'string' ? data.error : null) || data?.message || data?.detail || `Supplier returned HTTP ${res.status}`;
    throw new SupplierError(String(message).slice(0, 300), {
      status: res.status,
      code: errObj?.code || data?.code || `http_${res.status}`,
      requestId: res.headers.get('x-request-id'),
      retryAfter: Number(res.headers.get('retry-after')) || null,
      // 5xx other than 503: the order may or may not exist. Re-POSTing with the
      // same Idempotency-Key is safe either way.
      definite: !(res.status >= 500 && res.status !== 503),
      data,
    });
  }
  return data;
}

const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(n) ? null : n;
};
const firstNum = (...vals) => {
  for (const v of vals) { const n = num(v); if (n != null) return n; }
  return null;
};

// ---------------- normalizers ----------------

export function normalizeProducts(data) {
  const list = Array.isArray(data) ? data : data?.products || data?.data?.products || data?.data || data?.items || [];
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p !== 'object') continue;
    const id = p.product_id ?? p.id;
    const price = firstNum(p.price, p.price_usdt, p.unit_price, p.price?.amount);
    if (id == null || price == null) continue;
    let stock = firstNum(p.stock, p.available_stock, p.stock_available, p.quantity_available, p.available);
    if (p.in_stock === false || p.available === false || p.is_available === false || p.active === false) stock = 0;
    out.push({
      variantId: String(id),
      name: String(p.name || p.title || `Product ${id}`).slice(0, 200),
      description: String(p.description || '').slice(0, 2000),
      price,
      stock: stock == null ? 0 : Math.max(0, Math.floor(stock)),
      minQty: firstNum(p.min_qty, p.min_quantity),
      maxQty: firstNum(p.max_qty, p.max_quantity),
    });
  }
  return out;
}

// Delivery details may be an array of strings/objects, items[].account_data, or
// one text blob with an account per line.
function extractAccounts(o, qty) {
  const asText = (a) => {
    if (typeof a === 'string') return a.trim();
    if (a && typeof a === 'object') {
      const v = a.account_data ?? a.account ?? a.data ?? a.content ?? a.value ?? a.credentials ?? a.text;
      return typeof v === 'string' ? v.trim() : '';
    }
    return '';
  };
  for (const key of ['accounts', 'items', 'delivery', 'deliveries', 'delivered_items']) {
    if (Array.isArray(o?.[key])) {
      const list = o[key].map(asText).filter(Boolean);
      if (list.length) return list;
    }
  }
  const blob = [o?.delivery_details, o?.delivery_text, o?.delivery, o?.details, o?.account_data, o?.result]
    .find((v) => typeof v === 'string' && v.trim());
  if (!blob) return [];
  const lines = blob.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // One account per line when that matches the quantity; otherwise keep it whole.
  return qty > 1 && lines.length === qty ? lines : [blob.trim()];
}

const DELIVERED = new Set(['delivered', 'completed', 'complete', 'fulfilled', 'done', 'success']);

function normalizeOrder(raw, extra = {}) {
  const o = raw?.order || raw?.data?.order || raw?.data || raw || {};
  const status = String(o.status || '').toLowerCase();
  const delivered = DELIVERED.has(status);
  const qty = firstNum(o.quantity, o.qty) || 1;
  return {
    supplierOrderId: o.id ?? o.order_id ?? null,
    status: delivered ? 'delivered' : status, // delivered | pending | cancelled | refunded | …
    delivered,
    accounts: delivered ? extractAccounts(o, qty) : [],
    total: firstNum(o.total, o.total_price, o.amount),
    test: false,
    ...extra,
  };
}

// ---------------- public API ----------------

const balanceOf = (d) => firstNum(d?.balance, d?.data?.balance, d?.wallet_balance, d?.available);

export async function ping(supplier) {
  const d = await request(supplier, 'GET', '/balance');
  return { ok: true, balance: balanceOf(d) };
}

export async function listProducts(supplier) {
  const raw = await request(supplier, 'GET', '/products');
  return { variants: normalizeProducts(raw), raw };
}

export async function getBalance(supplier) {
  return balanceOf(await request(supplier, 'GET', '/balance'));
}

export async function getOrder(supplier, id) {
  try {
    return normalizeOrder(await request(supplier, 'GET', `/orders/${encodeURIComponent(id)}`));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Buy. Re-POSTing with the same Idempotency-Key and identical body returns the
// same order, so an unknown outcome is simply retried. Since fulfilment is
// manual the POST is normally "pending"; we then read the order once so a
// replayed purchase that has since been delivered is picked up straight away.
export async function createOrder(supplier, { variantId, qty, idempotencyKey, unitPrice }) {
  const body = { product_id: String(variantId), quantity: qty };
  // Hangout requires max_total (our ceiling in USDT). Use a generous whole-number
  // cap so a small price drift between retries keeps the body identical.
  if (unitPrice > 0) body.max_total = Math.ceil(unitPrice * qty * 2) + 1;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await request(supplier, 'POST', '/purchase', { body, idempotencyKey });
      let order = normalizeOrder(d, { balance: firstNum(d?.balance, d?.balance_after, d?.data?.balance) });
      if (!order.delivered && order.supplierOrderId != null) {
        const fresh = await getOrder(supplier, order.supplierOrderId).catch(() => null);
        if (fresh) order = { ...fresh, balance: order.balance };
      }
      return order;
    } catch (e) {
      if (e.definite) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new SupplierError('Supplier order could not be confirmed', { code: 'unconfirmed', definite: false });
}
