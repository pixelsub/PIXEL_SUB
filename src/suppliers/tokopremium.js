// Connector for the TokoPremium reseller API (REST · JSON · Bearer).
//   GET  /ping /products /balance /orders /orders/{id|idempotency-key}
//   POST /orders  { variant_id, qty }  + Idempotency-Key header
// Prices are integers in IDR. Accounts come back in the order response.
//
// Every function returns plain normalized objects so the rest of the shop
// never touches this supplier's field names.

const TIMEOUT_MS = 25_000;

export class SupplierError extends Error {
  constructor(message, { status = 0, code = 'supplier_error', requestId = null, retryAfter = null, definite = true, data = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    // definite = the supplier certainly did NOT create/charge an order.
    // false = outcome unknown (timeout, 5xx) — must be checked, never assumed.
    this.definite = definite;
    this.data = data;
  }
}

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
    const code = data?.code || `http_${res.status}`;
    throw new SupplierError(data?.error || `Supplier returned HTTP ${res.status}`, {
      status: res.status,
      code,
      requestId: data?.request_id || res.headers.get('x-request-id'),
      retryAfter: Number(res.headers.get('retry-after')) || null,
      // 5xx other than maintenance: the order may or may not exist.
      definite: !(res.status >= 500 && res.status !== 503),
      data,
    });
  }
  return data;
}

// ---------------- normalizers ----------------

const firstNum = (...vals) => {
  for (const v of vals) {
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

// The catalog may be flat variants or products with a `variants` array; field
// names are matched loosely so small format differences don't break the sync.
export function normalizeProducts(data) {
  const list = Array.isArray(data) ? data : data?.products || data?.data || data?.items || data?.variants || [];
  const out = [];
  const add = (parent, v) => {
    const id = v.variant_id ?? v.variantId ?? v.id;
    const price = firstNum(
      v.reseller_price, v.your_price, v.price?.reseller, v.prices?.reseller, v.price?.yours,
      typeof v.price === 'object' ? null : v.price, v.unit_price, v.price?.normal, v.normal_price,
    );
    if (id == null || price == null) return;
    let stock = firstNum(v.stock, v.available_stock, v.stock_available, v.qty_available, v.stock?.available,
      typeof v.available === 'number' ? v.available : null);
    if (v.available === false || v.in_stock === false || v.is_available === false) stock = 0;
    const vName = String(v.name ?? v.title ?? v.variant_name ?? '').trim();
    const pName = String(parent?.name ?? parent?.title ?? '').trim();
    const name = pName && vName && !vName.toLowerCase().includes(pName.toLowerCase()) ? `${pName} — ${vName}` : (vName || pName || `Variant ${id}`);
    out.push({
      variantId: String(id),
      name: name.slice(0, 200),
      description: String(v.description ?? parent?.description ?? '').slice(0, 2000),
      price,
      stock: stock == null ? 0 : Math.max(0, Math.floor(stock)),
      minQty: firstNum(v.min_qty, v.minQty, parent?.min_qty),
      maxQty: firstNum(v.max_qty, v.maxQty, parent?.max_qty),
    });
  };
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    if (Array.isArray(p.variants) && p.variants.length) p.variants.forEach((v) => add(p, v));
    else add(null, p);
  }
  return out;
}

function normalizeOrder(o, extra = {}) {
  const status = String(o?.status || '').toLowerCase();
  return {
    supplierOrderId: o?.id ?? null,
    status, // delivered | pending | processing | refunded | cancelled …
    delivered: status === 'delivered',
    accounts: Array.isArray(o?.accounts) ? o.accounts.map(String) : [],
    accountsHidden: Boolean(o?.accounts_hidden),
    total: firstNum(o?.total),
    test: Boolean(o?.test),
    ...extra,
  };
}

// ---------------- public API ----------------

export async function ping(supplier) {
  return request(supplier, 'GET', '/ping');
}

export async function listProducts(supplier) {
  const raw = await request(supplier, 'GET', '/products');
  return { variants: normalizeProducts(raw), raw };
}

export async function getBalance(supplier) {
  const d = await request(supplier, 'GET', '/balance');
  return firstNum(d?.balance, d?.data?.balance);
}

// Look up an order by its TP- code or our Idempotency-Key. null = never created.
export async function getOrder(supplier, idOrKey) {
  try {
    const d = await request(supplier, 'GET', `/orders/${encodeURIComponent(idOrKey)}`);
    return normalizeOrder(d?.order || d);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// Buy. Safe to call again with the same key: the supplier returns the same
// order instead of charging twice. On an unknown outcome we look the order up
// by key, and only re-POST when the supplier confirms it was never created.
export async function createOrder(supplier, { variantId, qty, idempotencyKey }) {
  const body = { variant_id: variantId, qty };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const d = await request(supplier, 'POST', '/orders', { body, idempotencyKey });
      const order = normalizeOrder(d?.order, { balance: firstNum(d?.balance), replayed: Boolean(d?.replayed) });
      // A replay may echo the order as it was first created; when it wasn't
      // delivered yet, read its current state.
      if (order.replayed && !order.delivered) {
        const fresh = await getOrder(supplier, idempotencyKey).catch(() => null);
        if (fresh) return { ...fresh, balance: order.balance, replayed: true };
      }
      return order;
    } catch (e) {
      if (e.definite) throw e;
      const found = await getOrder(supplier, idempotencyKey).catch(() => undefined);
      if (found) return found; // it went through after all
      if (found === undefined) throw e; // lookup failed too — still unknown
      // found === null → never created; loop and POST again with the same key.
    }
  }
  throw new SupplierError('Supplier order could not be confirmed', { code: 'unconfirmed', definite: false });
}
