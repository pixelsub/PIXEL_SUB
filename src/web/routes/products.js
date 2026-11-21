import express from 'express';
import { emojiPlain, parseEmoji, encodeEmoji } from '../../emoji.js';

// Combine the emoji character and optional premium-emoji id from a request body.
// A non-numeric id is ignored so a typo cannot corrupt the stored value.
function emojiFromBody(b, fallback) {
  const char = String(b.emoji ?? fallback).trim().slice(0, 8) || '🛍️';
  const id = String(b.emojiId ?? '').trim();
  return encodeEmoji(char, /^\d+$/.test(id) ? id : '');
}
// Reseller discount %: blank/0 = none; otherwise clamped to 0–100.
function discountFromBody(v) {
  const n = Number(v);
  return v === '' || v == null || !Number.isFinite(n) || n <= 0 ? null : Math.min(100, n);
}
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { stockOf } from '../../services/stock.js';
import { pricing } from '../../suppliers/index.js';
import { queueNewProductCheck } from '../../services/channel.js';

const router = express.Router();
router.use(requireAuth);

function serializeProduct(p) {
  return {
    id: p.id,
    name: p.name,
    emoji: emojiPlain(p.emoji),
    emojiId: parseEmoji(p.emoji).id,
    description: p.description,
    price: num(p.price),
    cost: num(p.cost),
    resellerDiscountPct: num(p.resellerDiscountPct),
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name, emoji: emojiPlain(p.category.emoji) } : null,
    isActive: p.isActive,
    sortOrder: p.sortOrder,
    usesStock: p.usesStock,
    fixedContent: p.fixedContent,
    stock: p._count ? stockOf(p) : undefined,
    // Supplier-backed products: price/stock are managed by the supplier sync.
    supplierId: p.supplierId ?? null,
    supplierName: p.supplier?.name ?? null,
    createdAt: p.createdAt,
  };
}

// List all products with available-stock counts
router.get('/', async (req, res) => {
  const products = await prisma.product.findMany({
    // Own products, plus only the supplier products picked on the Supplier page.
    where: { OR: [{ supplierId: null }, { supplierSelected: true }] },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      category: true,
      supplier: { select: { name: true } },
      _count: { select: { stock: { where: { isSold: false } } } },
    },
  });
  res.json({ products: products.map(serializeProduct) });
});

// -------- Categories --------
// Emoji is stored encoded (char + optional premium id); the admin UI gets
// the plain char and the premium id separately.
const serializeCategory = (c) => ({ ...c, emoji: emojiPlain(c.emoji), emojiId: parseEmoji(c.emoji).id });

router.get('/meta/categories', async (req, res) => {
  const categories = await prisma.category.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  res.json({ categories: categories.map(serializeCategory) });
});

router.post('/meta/categories', async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const category = await prisma.category.create({
    data: { name: String(b.name).trim().slice(0, 100), emoji: emojiFromBody(b, '📁'), sortOrder: Number(b.sortOrder) || 0 },
  });
  res.json({ category: serializeCategory(category) });
});

router.put('/meta/categories/:id', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = String(b.name).trim().slice(0, 100);
  if (b.emoji !== undefined || b.emojiId !== undefined) data.emoji = emojiFromBody(b, '📁');
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder) || 0;
  if (data.name === '') return res.status(400).json({ error: 'name required' });
  try {
    res.json({ category: serializeCategory(await prisma.category.update({ where: { id: Number(req.params.id) }, data })) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.delete('/meta/categories/:id', async (req, res) => {
  try {
    await prisma.category.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.get('/:id', async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: Number(req.params.id) },
    include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
  });
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ product: serializeProduct(product) });
});

// -------- Stock source: own stock <-> a supplier's variant --------
// One product can be fed by supplier A, supplier B, or the admin's own stock,
// and switched at any time. Order history and the product itself stay as they are.
const sourceInclude = { category: true, supplier: { select: { name: true } }, _count: { select: { stock: { where: { isSold: false } } } } };

router.get('/:id/source-options', async (req, res) => {
  const id = Number(req.params.id);
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return res.status(404).json({ error: 'Not found' });
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true }, orderBy: { id: 'asc' }, select: { id: true, name: true, currency: true } });
  const supplierId = Number(req.query.supplierId) || null;
  let variants = [];
  if (supplierId) {
    // This product's own variant, plus unused ones (not already a selected / sold product).
    const rows = await prisma.product.findMany({
      where: { supplierId, OR: [{ id }, { supplierSelected: false, orderItems: { none: {} } }] },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, supplierVariantId: true, supplierPrice: true, supplierStock: true },
    });
    variants = rows.map((r) => ({ variantId: r.supplierVariantId, name: r.name, supplierPrice: num(r.supplierPrice), stock: r.supplierStock ?? 0 }));
  }
  res.json({ current: { supplierId: product.supplierId, variantId: product.supplierVariantId }, suppliers, variants });
});

router.post('/:id/source', async (req, res) => {
  const id = Number(req.params.id);
  const b = req.body || {};
  const fail = (status, error) => res.status(status).json({ error });
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) return fail(404, 'Not found');

  // An order already paid and waiting on the OLD supplier must finish there:
  // re-buying it from a different source could charge twice.
  const waiting = await prisma.order.count({
    where: { status: 'PAID', items: { some: { productId: id } }, events: { some: { type: 'supplier_pending' } } },
  });
  if (waiting) return fail(409, `${waiting} paid order(s) for this product are still waiting on the supplier. Switch after they are delivered.`);

  let data;
  if (b.source === 'own') {
    data = {
      supplierId: null, supplierVariantId: null, supplierPrice: null, supplierStock: null,
      supplierMinQty: null, supplierMaxQty: null, supplierSelected: false, markupPct: null, usesStock: true,
    };
  } else if (b.source === 'supplier') {
    const supplier = await prisma.supplier.findUnique({ where: { id: Number(b.supplierId) } });
    if (!supplier || !supplier.isActive) return fail(400, 'Supplier not found or disabled');
    const target = await prisma.product.findFirst({ where: { supplierId: supplier.id, supplierVariantId: String(b.variantId || '') } });
    if (!target) return fail(400, 'That supplier product was not found. Press Sync on the Suppliers page first.');
    if (target.id !== id) {
      if (target.supplierSelected) return fail(409, `“${target.name}” is already sold as its own product.`);
      if (await prisma.orderItem.count({ where: { productId: target.id } })) return fail(409, `“${target.name}” has order history as a separate product.`);
    }
    const { cost, price } = pricing(supplier, target.supplierPrice ?? 0, null);
    data = {
      supplierId: supplier.id, supplierVariantId: target.supplierVariantId, supplierPrice: target.supplierPrice,
      supplierStock: target.supplierStock, supplierMinQty: target.supplierMinQty, supplierMaxQty: target.supplierMaxQty,
      supplierSelected: true, markupPct: null, usesStock: true, price, cost,
    };
    if (target.id !== id) {
      // The unused catalog placeholder is replaced by this product.
      await prisma.$transaction([
        prisma.stockItem.deleteMany({ where: { productId: target.id } }),
        prisma.product.delete({ where: { id: target.id } }),
      ]);
    }
  } else {
    return fail(400, 'source must be "own" or "supplier"');
  }

  const updated = await prisma.product.update({ where: { id }, data, include: sourceInclude });
  res.json({ product: serializeProduct(updated) });
});

router.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.name || b.price == null) return res.status(400).json({ error: 'name and price are required' });
  const product = await prisma.product.create({
    data: {
      name: String(b.name).slice(0, 200),
      emoji: emojiFromBody(b, '🛍️'),
      description: b.description || '',
      price: Number(b.price),
      cost: Number(b.cost) || 0,
      resellerDiscountPct: discountFromBody(b.resellerDiscountPct),
      categoryId: b.categoryId ? Number(b.categoryId) : null,
      isActive: b.isActive !== false,
      sortOrder: Number(b.sortOrder) || 0,
      usesStock: b.usesStock !== false,
      fixedContent: b.fixedContent || '',
    },
    include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
  });
  queueNewProductCheck(); // channel announcement (if enabled and in stock)
  res.json({ product: serializeProduct(product) });
});

router.put('/:id', async (req, res) => {
  const b = req.body || {};
  const data = {};
  if (b.name !== undefined) data.name = String(b.name).slice(0, 200);
  if (b.emoji !== undefined || b.emojiId !== undefined) data.emoji = emojiFromBody(b, '🛍️');
  if (b.description !== undefined) data.description = b.description;
  if (b.price !== undefined) data.price = Number(b.price);
  if (b.cost !== undefined) data.cost = Number(b.cost) || 0;
  if (b.resellerDiscountPct !== undefined) data.resellerDiscountPct = discountFromBody(b.resellerDiscountPct);
  if (b.categoryId !== undefined) data.categoryId = b.categoryId ? Number(b.categoryId) : null;
  if (b.isActive !== undefined) {
    data.isActive = Boolean(b.isActive);
    // Putting a supplier product on sale also selects it (no-op for own products).
    if (data.isActive) data.supplierSelected = true;
  }
  if (b.sortOrder !== undefined) data.sortOrder = Number(b.sortOrder) || 0;
  if (b.usesStock !== undefined) data.usesStock = Boolean(b.usesStock);
  if (b.fixedContent !== undefined) data.fixedContent = b.fixedContent;

  try {
    const product = await prisma.product.update({
      where: { id: Number(req.params.id) },
      data,
      include: { category: true, _count: { select: { stock: { where: { isSold: false } } } } },
    });
    if (data.isActive) queueNewProductCheck();
    res.json({ product: serializeProduct(product) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  try {
    // A paid order still waiting on the supplier needs the product to finish.
    const waiting = await prisma.order.count({
      where: { status: 'PAID', items: { some: { productId: id } }, events: { some: { type: 'supplier_pending' } } },
    });
    if (waiting) return res.status(409).json({ error: `${waiting} paid order(s) for this product are still waiting on the supplier. Delete it after they are delivered.` });

    // Real delete. Past orders keep their own copy of name, price and cost
    // (order lines and delivered codes just lose the link), so revenue and
    // profit history stay intact. Unsold stock goes with the product.
    await prisma.$transaction([
      prisma.stockItem.deleteMany({ where: { productId: id, isSold: false } }),
      prisma.product.delete({ where: { id } }),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
