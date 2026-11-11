import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num, startOfDay } from '../../utils.js';
import { RULES } from '../../services/referrals.js';

const router = express.Router();
router.use(requireAuth);

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const userBrief = (u) =>
  u && {
    id: u.id,
    telegramId: u.telegramId.toString(),
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    isBanned: u.isBanned,
  };

// Overview: totals + one row per referrer (who invited how many, who earned what).
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const today = startOfDay();

  const [perReferrer, buyers, todayRows, totals] = await Promise.all([
    prisma.referral.groupBy({
      by: ['referrerId'],
      _count: { _all: true },
      _sum: { bonusPaid: true, commissionTotal: true },
    }),
    prisma.referral.groupBy({ by: ['referrerId'], where: { commissionOrders: { gt: 0 } }, _count: { _all: true } }),
    prisma.referral.groupBy({ by: ['referrerId'], where: { createdAt: { gte: today } }, _count: { _all: true } }),
    prisma.referral.aggregate({ _count: { _all: true }, _sum: { bonusPaid: true, commissionTotal: true } }),
  ]);

  const buyerMap = new Map(buyers.map((b) => [b.referrerId, b._count._all]));
  const todayMap = new Map(todayRows.map((b) => [b.referrerId, b._count._all]));

  let rows = perReferrer.map((g) => {
    const bonus = num(g._sum.bonusPaid);
    const commission = num(g._sum.commissionTotal);
    return {
      referrerId: g.referrerId,
      invited: g._count._all,
      buyers: buyerMap.get(g.referrerId) || 0,
      today: todayMap.get(g.referrerId) || 0,
      bonus: r2(bonus),
      commission: r2(commission),
      total: r2(bonus + commission),
    };
  });
  rows.sort((a, b) => b.total - a.total || b.invited - a.invited);

  const total = rows.length;
  rows = rows.slice((page - 1) * pageSize, page * pageSize);
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.referrerId) } } });
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const r of rows) r.user = userBrief(byId.get(r.referrerId));

  const bonusAll = num(totals._sum.bonusPaid);
  const commissionAll = num(totals._sum.commissionTotal);
  res.json({
    rules: RULES,
    summary: {
      referrals: totals._count._all,
      referrers: total,
      referralsToday: todayRows.reduce((s, r) => s + r._count._all, 0),
      buyers: buyers.reduce((s, r) => s + r._count._all, 0),
      bonusPaid: r2(bonusAll),
      commissionPaid: r2(commissionAll),
      totalPaid: r2(bonusAll + commissionAll),
    },
    total,
    page,
    pageSize,
    pages: Math.ceil(total / pageSize),
    referrers: rows,
  });
});

// One referrer: every friend they invited and what each friend has earned them.
router.get('/:userId', async (req, res) => {
  const userId = Number(req.params.userId);
  const referrer = await prisma.user.findUnique({ where: { id: userId } });
  if (!referrer) return res.status(404).json({ error: 'Not found' });

  const refs = await prisma.referral.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' } });
  const friends = await prisma.user.findMany({ where: { id: { in: refs.map((r) => r.referredId) } } });
  const byId = new Map(friends.map((u) => [u.id, u]));

  const list = refs.map((r) => ({
    friend: userBrief(byId.get(r.referredId)),
    joinedAt: r.createdAt,
    bonus: num(r.bonusPaid),
    commissionOrders: r.commissionOrders,
    commission: num(r.commissionTotal),
    earned: r2(num(r.bonusPaid) + num(r.commissionTotal)),
    spent: num(byId.get(r.referredId)?.totalSpent),
  }));

  res.json({
    referrer: userBrief(referrer),
    maxCommissionOrders: RULES.maxCommissionOrders,
    totals: {
      invited: list.length,
      bonus: r2(list.reduce((s, x) => s + x.bonus, 0)),
      commission: r2(list.reduce((s, x) => s + x.commission, 0)),
      earned: r2(list.reduce((s, x) => s + x.earned, 0)),
    },
    friends: list,
  });
});

export default router;
