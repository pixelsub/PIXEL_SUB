// Public reseller API (v1).
//
// Other sellers add this API to their own store to show our catalog and
// live stock. Read-only: it never exposes stock contents, cost or delivery
// templates. Every request needs an API key created in the admin panel:
//
//   X-API-Key: psk_xxxxxxxx...      (or)   Authorization: Bearer psk_xxxx...
//
// Endpoints:
//   GET /api/v1/products        all active products + live stock
//   GET /api/v1/products/:id    one product
//   GET /api/v1/stock           compact { productId: stock } map for polling
//
// Ordering (only for keys linked to the reseller's Telegram account; paid from
// that account's wallet balance, delivered instantly in the response):
//   GET  /api/v1/balance
//   POST /api/v1/orders         { productId, quantity, reference? }
//   GET  /api/v1/orders         recent orders placed by this reseller
//   GET  /api/v1/orders/:id     one order (by ORD-xxxx id or your reference)
import express from 'express';
import rateLimit from 'express-rate-limit';
import prisma from '../../db.js';
import config from '../../config.js';
import logger from '../../logger.js';
import { emojiPlain } from '../../emoji.js';
import { num } from '../../utils.js';
import { hashApiKey } from '../../services/api_keys.js';
import { payWithBalance, availableStock, resellerUnitPrice } from '../../services/orders.js';
import { STOCK_COUNT, stockOf } from '../../services/stock.js';
import { render } from '../../services/settings.js';

const MAX_QUANTITY = 500;

const router = express.Router();

// CORS: resellers may call this from their own site's frontend.
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'X-API-Key, Authorization, Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Only refresh lastUsedAt at most once a minute per key, so a store polling
// every few seconds doesn't turn into a DB write per request.
const lastTouched = new Map();
const TOUCH_EVERY_MS = 60 * 1000;

async function requireApiKey(req, res, next) {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const raw = String(req.headers['x-api-key'] || bearer || '').trim();
  if (!raw) return res.status(401).json({ error: 'Missing API key. Send it in the X-API-Key header.' });

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
  if (!key || !key.isActive) return res.status(401).json({ error: 'Invalid or revoked API key' });

  req.apiKey = key;
  const now = Date.now();
  if (now - (lastTouched.get(key.id) || 0) > TOUCH_EVERY_MS) {
    lastTouched.set(key.id, now);
    prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  next();
}

router.use(requireApiKey);

// Per-key limit (keys are already validated above, so this is per reseller).
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `key:${req.apiKey.id}`,
    message: { error: 'Rate limit exceeded (120 requests/minute)' },
  })
);

const productInclude = { category: true, ...STOCK_COUNT };

function serialize(p) {
  const unlimited = !p.usesStock;
  const stock = unlimited ? null : stockOf(p);
  return {
    id: p.id,
    name: p.name,
    emoji: emojiPlain(p.emoji),
    description: p.description,
    // The price THIS reseller pays (after any per-product reseller discount).
    price: resellerUnitPrice(p),
    ...(num(p.resellerDiscountPct) > 0 ? { listPrice: num(p.price), discountPct: num(p.resellerDiscountPct) } : {}),
    currency: config.shop.currency,
    category: p.category && p.category.isActive
      ? { id: p.category.id, name: p.category.name, emoji: p.category.emoji }
      : null,
    unlimited,
    stock, // number of units available right now; null when unlimited
    inStock: unlimited || stock > 0,
    updatedAt: p.updatedAt,
  };
}

router.get('/products', async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: productInclude,
  });
  res.json({ products: products.map(serialize), generatedAt: new Date() });
});

router.get('/products/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product id' });
  const p = await prisma.product.findFirst({ where: { id, isActive: true }, include: productInclude });
  if (!p) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: serialize(p) });
});

router.get('/stock', async (req, res) => {
  const products = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, usesStock: true, supplierId: true, supplierStock: true, supplierMaxQty: true, ...STOCK_COUNT },
  });
  const stock = {};
  for (const p of products) stock[p.id] = p.usesStock ? stockOf(p) : null;
  res.json({ stock, generatedAt: new Date() });
});

// ------------------------------------------------------------------
// Ordering
// ------------------------------------------------------------------

// The reseller account behind this key, or a 403 explaining why ordering is off.
async function requireReseller(req, res, next) {
  if (!req.apiKey.userId) {
    return res.status(403).json({ error: 'Ordering is not enabled for this API key. Ask the shop owner to link it to your Telegram account.', code: 'ORDERING_DISABLED' });
  }
  const user = await prisma.user.findUnique({ where: { id: req.apiKey.userId } });
  if (!user || user.isBanned) return res.status(403).json({ error: 'Reseller account is not allowed to order', code: 'ACCOUNT_BLOCKED' });
  req.reseller = user;
  next();
}

const orderInclude = {
  items: { include: { stock: { select: { content: true }, orderBy: { id: 'asc' } }, product: { select: { usesStock: true, fixedContent: true } } } },
};

function serializeOrder(o) {
  return {
    id: o.publicId,
    reference: o.resellerRef,
    status: o.status,
    amount: num(o.amount),
    currency: o.currency,
    createdAt: o.createdAt,
    deliveredAt: o.deliveredAt,
    items: o.items.map((i) => {
      // Codes/accounts claimed from stock; fixed-content products deliver their template.
      let delivered = i.stock.map((s) => s.content);
      if (!delivered.length && i.product && !i.product.usesStock && o.status === 'DELIVERED') {
        delivered = [render(i.product.fixedContent || '', { order_id: o.publicId })];
      }
      return {
        productId: i.productId,
        name: i.productName,
        quantity: i.quantity,
        unitPrice: num(i.unitPrice),
        total: num(i.lineTotal),
        delivered,
      };
    }),
  };
}

function findOrder(userId, id) {
  return prisma.order.findFirst({
    where: { userId, kind: 'PURCHASE', OR: [{ publicId: id }, { resellerRef: id }] },
    orderBy: { id: 'desc' }, // a reference reused after a failed attempt → latest order
    include: orderInclude,
  });
}

router.get('/balance', requireReseller, (req, res) => {
  res.json({ balance: num(req.reseller.balance), currency: config.shop.currency });
});

router.post('/orders', requireReseller, async (req, res) => {
  const b = req.body || {};
  const productId = Number(b.productId);
  const quantity = Number(b.quantity ?? 1);
  const reference = b.reference == null || b.reference === '' ? null : String(b.reference).trim().slice(0, 100);

  if (!Number.isInteger(productId)) return res.status(400).json({ error: 'productId is required', code: 'BAD_REQUEST' });
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    return res.status(400).json({ error: `quantity must be a whole number from 1 to ${MAX_QUANTITY}`, code: 'BAD_REQUEST' });
  }

  const product = await prisma.product.findFirst({ where: { id: productId, isActive: true } });
  if (!product) return res.status(404).json({ error: 'Product not found', code: 'PRODUCT_NOT_FOUND' });

  // Same reference again (e.g. a network retry) → return the original order,
  // never buy twice. The claim row's primary key is the lock, so even two
  // simultaneous requests can't both get through.
  const refKey = reference ? { userId_reference: { userId: req.reseller.id, reference } } : null;
  if (reference) {
    // Plain lookup first so ordinary retries don't hit (and log) a constraint
    // error; the create below is still the real lock for simultaneous requests.
    let claim = await prisma.resellerOrderRef.findUnique({ where: refKey });
    if (!claim) {
      try {
        await prisma.resellerOrderRef.create({ data: { userId: req.reseller.id, reference } });
      } catch (e) {
        if (e.code !== 'P2002') throw e;
        claim = await prisma.resellerOrderRef.findUnique({ where: refKey });
      }
    }
    if (claim) {
      if (claim.orderId) {
        const existing = await prisma.order.findUnique({ where: { id: claim.orderId }, include: orderInclude });
        if (existing) return res.json({ order: serializeOrder(existing), duplicate: true });
      }
      return res.status(409).json({ error: 'An order with this reference is already being processed', code: 'REFERENCE_IN_PROGRESS' });
    }
  }
  // A failed attempt frees the reference so the reseller can retry with it.
  const releaseRef = () => (refKey ? prisma.resellerOrderRef.delete({ where: refKey }).catch(() => {}) : null);

  let result;
  try {
    result = await payWithBalance({ user: req.reseller, product, quantity, resellerRef: reference, apiKeyId: req.apiKey.id });
  } catch (e) {
    await releaseRef();
    const balance = num((await prisma.user.findUnique({ where: { id: req.reseller.id } }))?.balance);
    if (e.code === 'INSUFFICIENT_BALANCE') {
      return res.status(402).json({ error: 'Insufficient balance', code: e.code, balance, required: +(resellerUnitPrice(product) * quantity).toFixed(2) });
    }
    if (e.code === 'OUT_OF_STOCK') {
      const available = product.usesStock ? await availableStock(product.id) : null;
      return res.status(409).json({ error: 'Not enough stock', code: e.code, available, balance });
    }
    logger.error({ err: e.message, key: req.apiKey.id }, 'reseller API order failed');
    return res.status(500).json({ error: 'Order failed — your balance was not charged', code: e.code || 'ORDER_FAILED', balance });
  }

  if (refKey) await prisma.resellerOrderRef.update({ where: refKey, data: { orderId: result.order.id } });
  const order = await prisma.order.findUnique({ where: { id: result.order.id }, include: orderInclude });
  const balance = num((await prisma.user.findUnique({ where: { id: req.reseller.id } })).balance);
  res.status(201).json({ order: serializeOrder(order), balance });
});

router.get('/orders', requireReseller, async (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
  const orders = await prisma.order.findMany({
    where: { userId: req.reseller.id, kind: 'PURCHASE' },
    orderBy: { id: 'desc' },
    take: limit,
    include: orderInclude,
  });
  res.json({ orders: orders.map(serializeOrder) });
});

router.get('/orders/:id', requireReseller, async (req, res) => {
  const order = await findOrder(req.reseller.id, String(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found', code: 'ORDER_NOT_FOUND' });
  res.json({ order: serializeOrder(order) });
});

router.use((req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

export default router;
