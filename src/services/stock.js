// One place that answers "how many can be sold right now?" for any product.
//
// Own products count their unsold StockItem rows (callers include
// `_count: { select: { stock: { where: { isSold: false } } } }`).
// Supplier products use the live stock synced from the supplier, capped by
// the supplier's per-order maximum.

export const STOCK_COUNT = { _count: { select: { stock: { where: { isSold: false } } } } };

export function isSupplierProduct(p) {
  return p?.supplierId != null;
}

export function stockOf(p) {
  if (!p) return 0;
  if (isSupplierProduct(p)) {
    const s = Math.max(0, p.supplierStock ?? 0);
    return p.supplierMaxQty ? Math.min(s, p.supplierMaxQty) : s;
  }
  return p._count?.stock ?? 0;
}
