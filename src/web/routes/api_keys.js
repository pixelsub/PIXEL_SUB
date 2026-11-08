// Admin management of reseller API keys.
import express from 'express';
import prisma from '../../db.js';
import config from '../../config.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { emojiPlain } from '../../emoji.js';
import { generateApiKey } from '../../services/api_keys.js';

const router = express.Router();
router.use(requireAuth);

function serialize(k) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    isActive: k.isActive,
    lastUsedAt: k.lastUsedAt,
    createdAt: k.createdAt,
    // Linked reseller account (enables ordering from its wallet balance).
    user: k.user
      ? {
          id: k.user.id,
          telegramId: String(k.user.telegramId),
          username: k.user.username,
          firstName: k.user.firstName,
          balance: num(k.user.balance),
        }
      : null,
  };
}

// Resolve a Telegram ID from the form into a User id.
// undefined = field not sent, null = unlink, number = link.
async function resolveUserId(telegramId) {
  if (telegramId === undefined) return undefined;
  const raw = String(telegramId ?? '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) {
    const err = new Error('Telegram ID must be numeric');
    err.status = 400;
    throw err;
  }
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(raw) } });
  if (!user) {
    const err = new Error('No customer with that Telegram ID. The reseller must /start the bot first.');
    err.status = 400;
    throw err;
  }
  return user.id;
}

router.get('/', async (req, res) => {
  const [keys, totals] = await Promise.all([
    prisma.apiKey.findMany({ orderBy: { id: 'desc' }, include: { user: true } }),
    prisma.order.groupBy({
      by: ['apiKeyId'],
      where: { apiKeyId: { not: null }, status: 'DELIVERED' },
      _count: { _all: true },
      _sum: { amount: true },
    }),
  ]);
  const byKey = new Map(totals.map((t) => [t.apiKeyId, { orders: t._count._all, revenue: num(t._sum.amount) }]));
  res.json({
    keys: keys.map((k) => ({ ...serialize(k), stats: byKey.get(k.id) || { orders: 0, revenue: 0 } })),
    baseUrl: `${config.publicUrl}/api/v1`,
  });
});

// Everything about one reseller: account, API sales stats, top products and
// a paginated order list (API orders only, or everything the account did).
router.get('/:id/details', async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: Number(req.params.id) }, include: { user: true } });
  if (!key) return res.status(404).json({ error: 'Not found' });

  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = 20;
  const source = ['api', 'all', 'topup'].includes(req.query.source) ? req.query.source : 'api';

  const apiDelivered = { apiKeyId: key.id, status: 'DELIVERED' };
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Order list filter. "all" and "topup" need a linked account.
  let orderWhere = { apiKeyId: key.id };
  if (source === 'all') orderWhere = key.userId ? { userId: key.userId } : { id: -1 };
  if (source === 'topup') orderWhere = key.userId ? { userId: key.userId, kind: 'TOPUP' } : { id: -1 };

  const [all, today, last30, items, topProducts, topups, failed, orderTotal, orders] = await Promise.all([
    prisma.order.aggregate({ where: apiDelivered, _count: { _all: true }, _sum: { amount: true } }),
    prisma.order.aggregate({ where: { ...apiDelivered, createdAt: { gte: dayStart } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.order.aggregate({ where: { ...apiDelivered, createdAt: { gte: monthAgo } }, _count: { _all: true }, _sum: { amount: true } }),
    // Per-line cost snapshot → profit (unitCost × quantity can't be summed in SQL via Prisma).
    prisma.orderItem.findMany({ where: { order: apiDelivered }, select: { quantity: true, unitCost: true, lineTotal: true } }),
    prisma.orderItem.groupBy({
      by: ['productName'],
      where: { order: apiDelivered },
      _sum: { quantity: true, lineTotal: true },
      orderBy: { _sum: { lineTotal: 'desc' } },
      take: 5,
    }),
    key.userId
      ? prisma.order.aggregate({ where: { userId: key.userId, kind: 'TOPUP', status: 'DELIVERED' }, _count: { _all: true }, _sum: { amount: true } })
      : null,
    prisma.order.count({ where: { apiKeyId: key.id, status: { not: 'DELIVERED' } } }),
    prisma.order.count({ where: orderWhere }),
    prisma.order.findMany({
      where: orderWhere,
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { items: true },
    }),
  ]);

  const units = items.reduce((s, i) => s + i.quantity, 0);
  const cost = items.reduce((s, i) => s + num(i.unitCost) * i.quantity, 0);
  const revenue = num(all._sum.amount);

  res.json({
    key: serialize(key),
    account: key.user
      ? {
          id: key.user.id,
          telegramId: String(key.user.telegramId),
          username: key.user.username,
          firstName: key.user.firstName,
          lastName: key.user.lastName,
          balance: num(key.user.balance),
          totalSpent: num(key.user.totalSpent),
          isBanned: key.user.isBanned,
          lastSeenAt: key.user.lastSeenAt,
          createdAt: key.user.createdAt,
        }
      : null,
    stats: {
      orders: all._count._all,
      revenue,
      units,
      profit: +(revenue - cost).toFixed(2),
      todayOrders: today._count._all,
      todayRevenue: num(today._sum.amount),
      last30Orders: last30._count._all,
      last30Revenue: num(last30._sum.amount),
      notDelivered: failed,
      topups: topups ? { count: topups._count._all, total: num(topups._sum.amount) } : null,
    },
    topProducts: topProducts.map((t) => ({ name: t.productName, units: t._sum.quantity || 0, revenue: num(t._sum.lineTotal) })),
    source,
    page,
    pages: Math.max(1, Math.ceil(orderTotal / pageSize)),
    total: orderTotal,
    orders: orders.map((o) => ({
      id: o.id,
      publicId: o.publicId,
      source: o.apiKeyId ? 'API' : o.kind === 'TOPUP' ? 'Top-up' : 'Bot',
      reference: o.resellerRef,
      status: o.status,
      amount: num(o.amount),
      currency: o.currency,
      method: o.method,
      createdAt: o.createdAt,
      summary: o.kind === 'TOPUP'
        ? 'Wallet top-up'
        : o.items.map((i) => `${emojiPlain(i.emoji)} ${i.productName} ×${i.quantity}`).join(', '),
    })),
  });
});

// Returns the full key exactly once — only its hash is stored.
router.post('/', async (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 100);
  if (!name) return res.status(400).json({ error: 'name required' });
  let userId;
  try { userId = await resolveUserId(req.body?.telegramId); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const { raw, hash, prefix } = generateApiKey();
  const key = await prisma.apiKey.create({
    data: { name, keyPrefix: prefix, keyHash: hash, userId: userId ?? null },
    include: { user: true },
  });
  res.json({ key: serialize(key), apiKey: raw });
});

router.put('/:id', async (req, res) => {
  const data = {};
  if (req.body?.name !== undefined) data.name = String(req.body.name).trim().slice(0, 100);
  if (req.body?.isActive !== undefined) data.isActive = Boolean(req.body.isActive);
  try {
    const userId = await resolveUserId(req.body?.telegramId);
    if (userId !== undefined) data.userId = userId;
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }
  try {
    const key = await prisma.apiKey.update({ where: { id: Number(req.params.id) }, data, include: { user: true } });
    res.json({ key: serialize(key) });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await prisma.apiKey.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
