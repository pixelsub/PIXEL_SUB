import express from 'express';
import { emojiPlain } from '../../emoji.js';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num, startOfDay } from '../../utils.js';
import { stockOf } from '../../services/stock.js';

const router = express.Router();
router.use(requireAuth);

// "Today" is a Bangladesh day (Asia/Dhaka, UTC+6, no daylight saving): it
// starts at 12:00 AM Dhaka time, whatever timezone the server runs in.
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// YYYY-MM-DD of the Dhaka day containing d.
const dhakaDate = (d) => new Date(new Date(d).getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 10);

const emptyMethods = () => Object.fromEntries(['BINANCE', 'BYBIT', 'CRYPTOMUS', 'BALANCE'].map((k) => [k, { orders: 0, amount: 0, topups: 0 }]));

// GET /api/dashboard — headline stats + 14-day revenue series + recent orders
router.get('/', async (req, res) => {
  const now = new Date();
  const today = startOfDay(now);
  const since = new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);

  const paidStatuses = ['PAID', 'DELIVERED', 'REFUNDED'];

  const [
    totalUsers,
    newUsersToday,
    totalOrders,
    pendingOrders,
    deliveredOrders,
    revenueAgg,
    revenueTodayAgg,
    productCount,
    lowStockProducts,
    recentOrders,
    paidForSeries,
    topProductsRaw,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.order.count(),
    prisma.order.count({ where: { status: 'PENDING' } }),
    prisma.order.count({ where: { status: 'DELIVERED' } }),
    // Revenue = product sales only; wallet top-ups are not revenue.
    prisma.order.aggregate({ _sum: { amount: true }, where: { status: { in: ['PAID', 'DELIVERED'] }, kind: 'PURCHASE' } }),
    prisma.order.aggregate({
      _sum: { amount: true },
      where: { status: { in: ['PAID', 'DELIVERED'] }, kind: 'PURCHASE', paidAt: { gte: today } },
    }),
    prisma.product.count({ where: { isActive: true } }),
    prisma.product.findMany({
      where: { isActive: true, usesStock: true },
      select: { id: true, name: true, emoji: true, supplierId: true, supplierStock: true, supplierMaxQty: true, _count: { select: { stock: { where: { isSold: false } } } } },
    }),
    prisma.order.findMany({
      orderBy: { createdAt: 'desc' },
      take: 8,
      include: { user: true, items: true },
    }),
    prisma.order.findMany({
      where: { status: { in: ['PAID', 'DELIVERED'] }, paidAt: { gte: since } },
      select: { paidAt: true, amount: true, method: true, kind: true },
    }),
    prisma.orderItem.groupBy({
      by: ['productName', 'emoji'],
      _sum: { quantity: true, lineTotal: true },
      where: { order: { status: { in: ['PAID', 'DELIVERED'] } } },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: 6,
    }),
  ]);

  // Build 14-day revenue + order-count series
  const days = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(since.getTime() + i * DAY_MS);
    days.push({ date: dhakaDate(d), revenue: 0, orders: 0, methods: emptyMethods() });
  }
  const idx = new Map(days.map((d, i) => [d.date, i]));
  for (const o of paidForSeries) {
    if (!o.paidAt) continue;
    const key = dhakaDate(o.paidAt);
    const i = idx.get(key);
    if (i !== undefined) {
      days[i].revenue += num(o.amount);
      days[i].orders += 1;
      // Payment-method split. BINANCE/BYBIT include wallet top-ups (money
      // actually received); BALANCE is an order paid from the wallet.
      const m = days[i].methods[o.method] || (days[i].methods[o.method] = { orders: 0, amount: 0, topups: 0 });
      m.orders += 1;
      m.amount += num(o.amount);
      if (o.kind === 'TOPUP') m.topups += 1;
    }
  }
  for (const d of days) for (const m of Object.values(d.methods)) m.amount = +m.amount.toFixed(2);

  const lowStock = lowStockProducts
    .map((p) => ({ id: p.id, name: p.name, emoji: emojiPlain(p.emoji), stock: stockOf(p) }))
    .filter((p) => p.stock <= 3)
    .sort((a, b) => a.stock - b.stock);

  // Profit, per product and overall. Top-ups are excluded: they move money into
  // a wallet rather than selling an item. unitCost is the snapshot taken at
  // purchase time, so editing a product's cost never rewrites past profit.
  const soldLines = await prisma.orderItem.findMany({
    where: { order: { status: { in: paidStatuses.filter((s) => s !== 'REFUNDED') }, kind: 'PURCHASE' } },
    select: { productId: true, productName: true, emoji: true, quantity: true, lineTotal: true, unitCost: true, order: { select: { id: true, paidAt: true } } },
  });

  const profitByProduct = new Map();
  let profitRevenue = 0;
  let profitCost = 0;
  let linesMissingCost = 0;
  // Today = since 12:00 AM Bangladesh time, by payment time.
  const todayAgg = { revenue: 0, cost: 0, items: 0, orders: new Set() };
  for (const li of soldLines) {
    const rev = num(li.lineTotal);
    const cost = num(li.unitCost) * li.quantity;
    profitRevenue += rev;
    profitCost += cost;
    if (li.order?.paidAt && li.order.paidAt >= today) {
      todayAgg.revenue += rev;
      todayAgg.cost += cost;
      todayAgg.items += li.quantity;
      todayAgg.orders.add(li.order.id);
    }
    if (num(li.unitCost) === 0) linesMissingCost++;
    const key = li.productId ?? `deleted:${li.productName}`;
    const row = profitByProduct.get(key) || { name: li.productName, emoji: li.emoji, qty: 0, revenue: 0, cost: 0 };
    row.qty += li.quantity;
    row.revenue += rev;
    row.cost += cost;
    profitByProduct.set(key, row);
  }
  const productProfit = [...profitByProduct.values()]
    .map((r) => ({ ...r, profit: +(r.revenue - r.cost).toFixed(2) }))
    .sort((a, b) => b.profit - a.profit);

  res.json({
    stats: {
      totalUsers,
      newUsersToday,
      totalOrders,
      pendingOrders,
      deliveredOrders,
      revenue: num(revenueAgg._sum.amount),
      revenueToday: num(revenueTodayAgg._sum.amount),
      productCount,
      // Product-sale figures only — excludes wallet top-ups.
      salesRevenue: +profitRevenue.toFixed(2),
      totalCost: +profitCost.toFixed(2),
      profit: +(profitRevenue - profitCost).toFixed(2),
      margin: profitRevenue > 0 ? +(((profitRevenue - profitCost) / profitRevenue) * 100).toFixed(1) : 0,
      linesMissingCost,
      today: {
        date: dhakaDate(now),
        since: today,
        salesRevenue: +todayAgg.revenue.toFixed(2),
        cost: +todayAgg.cost.toFixed(2),
        profit: +(todayAgg.revenue - todayAgg.cost).toFixed(2),
        margin: todayAgg.revenue > 0 ? +(((todayAgg.revenue - todayAgg.cost) / todayAgg.revenue) * 100).toFixed(1) : 0,
        orders: todayAgg.orders.size,
        items: todayAgg.items,
      },
    },
    series: days,
    todayMethods: days[days.length - 1].methods,
    productProfit,
    lowStock,
    topProducts: topProductsRaw.map((t) => ({
      name: t.productName,
      emoji: emojiPlain(t.emoji),
      qty: t._sum.quantity || 0,
      revenue: num(t._sum.lineTotal),
    })),
    recentOrders: recentOrders.map((o) => ({
      id: o.id,
      publicId: o.publicId,
      status: o.status,
      amount: num(o.amount),
      currency: o.currency,
      createdAt: o.createdAt,
      user: {
        telegramId: o.user.telegramId.toString(),
        username: o.user.username,
        firstName: o.user.firstName,
      },
      summary: o.items.map((i) => `${emojiPlain(i.emoji)} ${i.productName} ×${i.quantity}`).join(', '),
    })),
  });
});

export default router;
