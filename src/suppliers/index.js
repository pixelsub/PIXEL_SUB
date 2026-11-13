// Supplier layer: catalog/stock sync and buying from upstream suppliers.
import prisma from '../db.js';
import logger from '../logger.js';
import { num } from '../utils.js';
import { decryptSecret } from '../services/secrets.js';
import { brandEmoji } from '../emoji.js';
import * as tokopremium from './tokopremium.js';
import * as ventebot from './ventebot.js';

export { SupplierError } from './tokopremium.js';

export const CONNECTORS = {
  ventebot: { label: 'VenteBot', defaultBaseUrl: 'https://web-production-1c7b1.up.railway.app/api/reseller', defaultCurrency: 'USD', client: ventebot },
  tokopremium: { label: 'TokoPremium', defaultBaseUrl: 'https://api.tokopremium.digital/api/v1', defaultCurrency: 'IDR', client: tokopremium },
};

function connectorFor(supplier) {
  const c = CONNECTORS[supplier.type];
  if (!c) throw new Error(`Unknown supplier type "${supplier.type}"`);
  return c.client;
}

// Supplier row → object the connector can call (decrypted key, plain numbers).
function runtime(supplier) {
  return { ...supplier, apiKey: decryptSecret(supplier.apiKeyEnc), rate: num(supplier.rate), markupPct: num(supplier.markupPct) };
}

// Round to cents; the tiny nudge stops float noise (0.675 → 0.67499…) rounding down.
const round2 = (n) => Math.round(n * 100 + 1e-9) / 100;

// Our unit cost and selling price (shop currency) for a supplier price.
// The price is computed from the unrounded cost so markup isn't lost to rounding.
// `productMarkup` (optional) overrides the supplier's default markup for one product.
export function pricing(supplier, supplierPrice, productMarkup = null) {
  const rate = num(supplier.rate) > 0 ? num(supplier.rate) : 1;
  const rawCost = num(supplierPrice) / rate;
  const pct = productMarkup == null ? num(supplier.markupPct) : num(productMarkup);
  return {
    cost: round2(rawCost),
    price: Math.max(0.01, round2(rawCost * (1 + pct / 100))),
  };
}

export async function testSupplier(supplier) {
  const s = runtime(supplier);
  const client = connectorFor(s);
  const pingRes = await client.ping(s).catch((e) => ({ error: e.message, code: e.code }));
  const { variants, raw } = await client.listProducts(s);
  const rawList = Array.isArray(raw) ? raw : raw?.products || raw?.data || raw?.items || [];
  return {
    ping: pingRes,
    variantCount: variants.length,
    sampleRaw: rawList.slice(0, 2),
    sampleParsed: variants.slice(0, 5).map((v) => {
      const { cost, price } = pricing(s, v.price);
      return { ...v, supplierPrice: v.price, cost, price };
    }),
  };
}

// Pull the supplier catalog and upsert it into Product. New items are created
// hidden so the admin chooses what to sell; known items get fresh stock, price
// and cost. Items that disappeared upstream are set to 0 stock.
export async function syncSupplier(supplierId) {
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier) throw new Error('Supplier not found');
  const s = runtime(supplier);
  const client = connectorFor(s);
  try {
    const { variants } = await client.listProducts(s);
    const balance = await client.getBalance(s).catch(() => null);
    // Products put on sale before "selected" existed count as selected.
    await prisma.product.updateMany({ where: { supplierId: supplier.id, isActive: true, supplierSelected: false }, data: { supplierSelected: true } });
    const existing = await prisma.product.findMany({ where: { supplierId: supplier.id } });
    const byVariant = new Map(existing.map((p) => [p.supplierVariantId, p]));
    const seen = new Set();
    let created = 0, updated = 0;

    for (const v of variants) {
      seen.add(v.variantId);
      const p = byVariant.get(v.variantId);
      const { cost, price } = pricing(s, v.price, p?.markupPct);
      const fields = {
        supplierPrice: v.price,
        supplierStock: v.stock,
        supplierMinQty: v.minQty,
        supplierMaxQty: v.maxQty,
        price,
        cost,
      };
      if (!p) {
        await prisma.product.create({
          data: { ...fields, name: v.name, ...(brandEmoji(v.name) ? { emoji: brandEmoji(v.name) } : {}), description: v.description, usesStock: true, isActive: false, supplierId: supplier.id, supplierVariantId: v.variantId },
        });
        created++;
      } else {
        // Products still carrying the placeholder name (imported before the
        // supplier's name field was recognised) pick up the real name.
        // Names the admin changed are left alone.
        const placeholder = p.name === `Variant ${v.variantId}`;
        const rename = placeholder && v.name !== p.name ? { name: v.name, ...(p.description ? {} : { description: v.description }) } : {};
        if (
          Object.keys(rename).length ||
          num(p.supplierPrice) !== v.price || p.supplierStock !== v.stock || num(p.price) !== price ||
          num(p.cost) !== cost || p.supplierMinQty !== v.minQty || p.supplierMaxQty !== v.maxQty
        ) {
          await prisma.product.update({ where: { id: p.id }, data: { ...fields, ...rename } });
          updated++;
        }
      }
    }
    const gone = existing.filter((p) => !seen.has(p.supplierVariantId) && p.supplierStock !== 0).map((p) => p.id);
    if (gone.length) await prisma.product.updateMany({ where: { id: { in: gone } }, data: { supplierStock: 0 } });

    await prisma.supplier.update({
      where: { id: supplier.id },
      data: { lastSyncAt: new Date(), lastSyncError: null, ...(balance != null ? { balance } : {}) },
    });
    return { variants: variants.length, created, updated, removed: gone.length, balance };
  } catch (e) {
    await prisma.supplier.update({ where: { id: supplier.id }, data: { lastSyncAt: new Date(), lastSyncError: `${e.code ? e.code + ': ' : ''}${e.message}`.slice(0, 500) } }).catch(() => {});
    throw e;
  }
}

/**
 * Buy `qty` of a supplier product for one order line.
 * Returns { ok: true, accounts, unitCost } | { pending: true, message } | { ok: false, code, message }.
 * The idempotency key ties the purchase to this order line, so repeating the
 * call (retries, the pending sweeper) can never pay the supplier twice.
 */
export async function buyFromSupplier(product, qty, idempotencyKey) {
  const supplier = await prisma.supplier.findUnique({ where: { id: product.supplierId } });
  if (!supplier || !supplier.isActive) return { ok: false, code: 'supplier_unavailable', message: 'Supplier is disabled or deleted' };
  const s = runtime(supplier);
  try {
    const order = await connectorFor(s).createOrder(s, { variantId: product.supplierVariantId, qty, idempotencyKey });
    if (order.balance != null) {
      await prisma.supplier.update({ where: { id: supplier.id }, data: { balance: order.balance } }).catch(() => {});
    }
    if (order.delivered && order.accounts.length >= qty) {
      const unitCost = order.total != null ? round2(order.total / qty / (s.rate || 1)) : null;
      return { ok: true, accounts: order.accounts.slice(0, qty), unitCost, supplierOrderId: order.supplierOrderId, test: order.test };
    }
    if (['refunded', 'cancelled', 'canceled', 'failed'].includes(order.status)) {
      return { ok: false, code: `supplier_${order.status}`, message: `Supplier order ${order.supplierOrderId} is ${order.status}` };
    }
    return { pending: true, message: `Supplier order ${order.supplierOrderId || ''} is ${order.status || 'processing'}` };
  } catch (e) {
    if (!e.definite || e.code === 'rate_limited') {
      return { pending: true, message: `${e.code}: ${e.message}` };
    }
    logger.warn({ err: e.message, code: e.code, requestId: e.requestId, supplier: supplier.id }, 'supplier order failed');
    return { ok: false, code: e.code, message: `${e.message}${e.requestId ? ` (request ${e.requestId})` : ''}` };
  }
}
