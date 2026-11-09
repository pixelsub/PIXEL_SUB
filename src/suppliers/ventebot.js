// Connector for the VenteBot Reseller API (REST · JSON · X-Reseller-Key).
//   GET  /me /products /orders/{id} /orders/lookup
//   POST /orders  { product_id, quantity, idempotency_key }
// Prices are USD. Delivered accounts come back as order.items[].account_data.
//
// Only products that hand over accounts immediately (delivery_type stock /
// supplier_api) are imported: activation products need a customer identifier
// and the synthetic api_test product is never for sale.
//
// Same interface as tokopremium.js so the rest of the shop stays unaware.

import { SupplierError } from './tokopremium.js';

const TIMEOUT_MS = 25_000;
const SELLABLE_DELIVERY = new Set(['stock', 'supplier_api']);

async function request(supplier, method, path, { body } = {}) {
  const headers = { 'X-Reseller-Key': supplier.apiKey, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

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
    throw new SupplierError(data?.message || `Supplier returned HTTP ${res.status}`, {
      status: res.status,
      code: data?.code || `http_${res.status}`,
      requestId: res.headers.get('x-request-id'),
      retryAfter: Number(res.headers.get('retry-after')) || null,
      // 5xx other than 503: the order may or may not exist. Safe to retry with
      // the same idempotency_key either way.
      definite: !(res.status >= 500 && res.status !== 503),
      data,
    });
  }
  return data;
}

const num = (v) => {
  const n = Number(v);
  return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
};

export function normalizeProducts(data) {
  const list = Array.isArray(data) ? data : data?.products || [];
  const out = [];
  for (const p of list) {
    if (!p || p.id == null || p.api_test) continue;
    if (!SELLABLE_DELIVERY.has(String(p.delivery_type || '').toLowerCase())) continue;
    const price = num(p.price_usd);
    if (price == null) continue;
    const stock = num(p.stock);
    out.push({
      variantId: String(p.id),
      name: String(p.name || `Product ${p.id}`).slice(0, 200),
      description: String(p.description || '').slice(0, 2000),
      price,
      stock: stock == null ? 0 : Math.max(0, Math.floor(stock)),
      minQty: null,
      maxQty: null,
    });
  }
  return out;
}

function normalizeOrder(o, extra = {}) {
  const status = String(o?.status || '').toLowerCase();
  const accounts = Array.isArray(o?.items) ? o.items.map((i) => i?.account_data).filter((a) => typeof a === 'string' && a) : [];
  return {
    supplierOrderId: o?.id ?? null,
    status: status === 'completed' ? 'delivered' : status, // delivered | cancelled | paid_pending_delivery | …
    delivered: status === 'completed',
    accounts,
    total: num(o?.amount_usd),
    test: false,
    ...extra,
  };
}

// ---------------- public API ----------------

export async function ping(supplier) {
  const d = await request(supplier, 'GET', '/me');
  return { ok: true, account: d?.key_name || d?.username || null, balance: num(d?.wallet_balance) };
}

export async function listProducts(supplier) {
  const raw = await request(supplier, 'GET', '/products');
  return { variants: normalizeProducts(raw), raw };
}

export async function getBalance(supplier) {
  const d = await request(supplier, 'GET', '/me');
  return num(d?.wallet_balance);
}

// Look up an order by our idempotency key. null = no record (NOT proof that
// nothing was charged — callers must re-POST with the same key, which is safe).
export async function getOrder(supplier, idempotencyKey) {
  try {
    const d = await request(supplier, 'GET', `/orders/lookup?idempotency_key=${encodeURIComponent(idempotencyKey)}`);
    const hit = Array.isArray(d?.results) ? d.results[0] : null;
    if (!hit?.order) return null;
    return normalizeOrder(hit.order);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Buy. The idempotency_key makes re-POSTing safe: VenteBot returns the same
// order instead of debiting the wallet twice, so an unknown outcome is simply
// retried with the same key.
export async function createOrder(supplier, { variantId, qty, idempotencyKey }) {
  const body = { product_id: Number(variantId), quantity: qty, idempotency_key: idempotencyKey, customer_reference: idempotencyKey };
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await request(supplier, 'POST', '/orders', { body });
      let order = normalizeOrder(d?.order, { balance: num(d?.balance_after), replayed: Boolean(d?.idempotent) });
      // A replay may echo the order as first created; read its current state.
      if (order.replayed && !order.delivered && order.supplierOrderId != null) {
        const fresh = await request(supplier, 'GET', `/orders/${encodeURIComponent(order.supplierOrderId)}`).catch(() => null);
        if (fresh?.order) order = normalizeOrder(fresh.order, { balance: order.balance, replayed: true });
      }
      return order;
    } catch (e) {
      if (e.definite) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new SupplierError('Supplier order could not be confirmed', { code: 'unconfirmed', definite: false });
}
