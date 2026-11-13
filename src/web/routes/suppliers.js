// Admin management of upstream suppliers.
import express from 'express';
import prisma from '../../db.js';
import config from '../../config.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { emojiPlain } from '../../emoji.js';
import { encryptSecret } from '../../services/secrets.js';
import { stockOf } from '../../services/stock.js';
import { CONNECTORS, syncSupplier, testSupplier, pricing } from '../../suppliers/index.js';
import { queueNewProductCheck } from '../../services/channel.js';

const router = express.Router();
router.use(requireAuth);

function serialize(s, counts = {}) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    typeLabel: CONNECTORS[s.type]?.label || s.type,
    baseUrl: s.baseUrl,
    keyHint: s.keyHint,
    currency: s.currency,
    rate: num(s.rate),
    markupPct: num(s.markupPct),
    isActive: s.isActive,
    balance: s.balance == null ? null : num(s.balance),
    lastSyncAt: s.lastSyncAt,
    lastSyncError: s.lastSyncError,
    createdAt: s.createdAt,
    products: counts.total ?? 0,
    selling: counts.active ?? 0,
  };
}

function readBody(b, { requireKey }) {
  const out = {};
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (b.name !== undefined || requireKey) {
    out.name = String(b.name || '').trim().slice(0, 100);
    if (!out.name) err('Name is required');
  }
  if (b.type !== undefined || requireKey) {
    out.type = String(b.type || 'tokopremium');
    if (!CONNECTORS[out.type]) err('Unknown supplier type');
  }
  if (b.baseUrl !== undefined || requireKey) {
    out.baseUrl = String(b.baseUrl || CONNECTORS[out.type || 'tokopremium'].defaultBaseUrl).trim().replace(/\/+$/, '');
    if (!/^https:\/\//.test(out.baseUrl) && config.isProd) err('Base URL must start with https://');
  }
  const apiKey = String(b.apiKey ?? '').trim();
  if (apiKey) {
    out.apiKeyEnc = encryptSecret(apiKey);
    out.keyHint = apiKey.slice(-4);
  } else if (requireKey) err('API key is required');
  if (b.currency !== undefined) out.currency = String(b.currency || 'IDR').trim().toUpperCase().slice(0, 8);
  if (b.rate !== undefined) {
    out.rate = Number(b.rate);
    if (!(out.rate > 0)) err('Exchange rate must be greater than 0');
  }
  if (b.markupPct !== undefined) {
    out.markupPct = Number(b.markupPct);
    if (!Number.isFinite(out.markupPct) || out.markupPct < 0 || out.markupPct > 1000) err('Markup must be between 0 and 1000%');
  }
  if (b.isActive !== undefined) out.isActive = Boolean(b.isActive);
  return out;
}

// Re-price every product of a supplier after its rate/markup changed.
async function repriceProducts(supplier) {
  const products = await prisma.product.findMany({ where: { supplierId: supplier.id, supplierPrice: { not: null } } });
  for (const p of products) {
    const { cost, price } = pricing(supplier, p.supplierPrice, p.markupPct);
    if (num(p.price) !== price || num(p.cost) !== cost) {
      await prisma.product.update({ where: { id: p.id }, data: { price, cost } });
    }
  }
}

router.get('/', async (req, res) => {
  const [suppliers, totals, active] = await Promise.all([
    prisma.supplier.findMany({ orderBy: { id: 'asc' } }),
    prisma.product.groupBy({ by: ['supplierId'], where: { supplierId: { not: null } }, _count: { _all: true } }),
    prisma.product.groupBy({ by: ['supplierId'], where: { supplierId: { not: null }, supplierSelected: true }, _count: { _all: true } }),
  ]);
  const t = new Map(totals.map((x) => [x.supplierId, x._count._all]));
  const a = new Map(active.map((x) => [x.supplierId, x._count._all]));
  res.json({
    suppliers: suppliers.map((s) => serialize(s, { total: t.get(s.id), active: a.get(s.id) })),
    types: Object.entries(CONNECTORS).map(([k, c]) => ({ type: k, label: c.label, defaultBaseUrl: c.defaultBaseUrl, defaultCurrency: c.defaultCurrency })),
    shopCurrency: config.shop.currency,
  });
});

router.post('/', async (req, res) => {
  let data;
  try { data = readBody(req.body || {}, { requireKey: true }); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const supplier = await prisma.supplier.create({ data });
  // First sync right away so the catalog shows up immediately.
  let sync = null, syncError = null;
  try { sync = await syncSupplier(supplier.id); } catch (e) { syncError = `${e.code ? e.code + ': ' : ''}${e.message}`; }
  const fresh = await prisma.supplier.findUnique({ where: { id: supplier.id } });
  res.json({ supplier: serialize(fresh), sync, syncError });
});

router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  let data;
  try { data = readBody(req.body || {}, { requireKey: false }); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  try {
    const supplier = await prisma.supplier.update({ where: { id }, data });
    if (data.rate !== undefined || data.markupPct !== undefined) await repriceProducts(supplier);
    if (data.isActive === false) {
      // A disabled supplier can't fulfil — hide its products from the shop.
      await prisma.product.updateMany({ where: { supplierId: id }, data: { isActive: false } });
    } else if (data.isActive === true) {
      // Re-enabled: put the selected products back on sale.
      await prisma.product.updateMany({ where: { supplierId: id, supplierSelected: true }, data: { isActive: true } });
    }
    res.json({ supplier: serialize(supplier) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  // Products never sold are removed; sold ones are kept (order history) but
  // hidden, and stay on the Products page only if they were selected.
  await prisma.product.deleteMany({ where: { supplierId: id, orderItems: { none: {} } } });
  await prisma.product.updateMany({ where: { supplierId: id }, data: { isActive: false, supplierStock: 0 } });
  try {
    await prisma.supplier.delete({ where: { id } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.post('/:id/test', async (req, res) => {
  const supplier = await prisma.supplier.findUnique({ where: { id: Number(req.params.id) } });
  if (!supplier) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ ok: true, ...(await testSupplier(supplier)) });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code, requestId: e.requestId, status: e.status });
  }
});

router.post('/:id/sync', async (req, res) => {
  try {
    res.json({ ok: true, result: await syncSupplier(Number(req.params.id)) });
  } catch (e) {
    res.status(e.message === 'Supplier not found' ? 404 : 502).json({ ok: false, error: `${e.code ? e.code + ': ' : ''}${e.message}` });
  }
});

router.get('/:id/products', async (req, res) => {
  const supplier = await prisma.supplier.findUnique({ where: { id: Number(req.params.id) } });
  if (!supplier) return res.status(404).json({ error: 'Not found' });
  const products = await prisma.product.findMany({
    where: { supplierId: supplier.id },
    orderBy: [{ supplierSelected: 'desc' }, { name: 'asc' }],
    include: { _count: { select: { stock: { where: { isSold: false } }, orderItems: true } } },
  });
  res.json({
    supplier: serialize(supplier),
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      emoji: emojiPlain(p.emoji),
      variantId: p.supplierVariantId,
      supplierPrice: num(p.supplierPrice),
      cost: num(p.cost),
      price: num(p.price),
      markupPct: p.markupPct == null ? null : num(p.markupPct),
      stock: stockOf(p),
      supplierStock: p.supplierStock ?? 0,
      selected: p.supplierSelected,
      isActive: p.isActive,
      sold: p._count.orderItems,
    })),
  });
});

// Select / unselect supplier products. Selecting adds them to the shop
// (Products page + on sale); unselecting removes them from both.
router.post('/:id/products/select', async (req, res) => {
  const id = Number(req.params.id);
  const selected = Boolean(req.body?.selected);
  const where = { supplierId: id };
  if (Array.isArray(req.body?.productIds)) where.id = { in: req.body.productIds.map(Number) };
  else if (req.body?.inStockOnly) where.supplierStock = { gt: 0 };
  if (selected) where.supplierSelected = false; // count only newly added
  else where.supplierSelected = true;
  const r = await prisma.product.updateMany({ where, data: { supplierSelected: selected, isActive: selected } });
  if (selected && r.count) queueNewProductCheck();
  res.json({ ok: true, count: r.count });
});

// Set (or clear, with markupPct: null) a per-product markup and re-price those products.
router.post('/:id/products/markup', async (req, res) => {
  const id = Number(req.params.id);
  const supplier = await prisma.supplier.findUnique({ where: { id } });
  if (!supplier) return res.status(404).json({ error: 'Not found' });
  const raw = req.body?.markupPct;
  const markupPct = raw === null || raw === '' || raw === undefined ? null : Number(raw);
  if (markupPct !== null && (!Number.isFinite(markupPct) || markupPct < 0 || markupPct > 1000)) {
    return res.status(400).json({ error: 'Markup must be between 0 and 1000%' });
  }
  if (!Array.isArray(req.body?.productIds) || !req.body.productIds.length) return res.status(400).json({ error: 'No products given' });
  const products = await prisma.product.findMany({ where: { supplierId: id, id: { in: req.body.productIds.map(Number) } } });
  for (const p of products) {
    const { cost, price } = pricing(supplier, p.supplierPrice ?? 0, markupPct);
    await prisma.product.update({ where: { id: p.id }, data: { markupPct, ...(p.supplierPrice != null ? { price, cost } : {}) } });
  }
  res.json({ ok: true, count: products.length });
});

export default router;
