import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { money, num, startOfDay, escapeHtml } from '../utils.js';
import { sendMessageSafe } from '../bot/delivery.js';

// "Invite & Earn" rules. Overridable from the environment without a code change.
const envNum = (key, fallback) => {
  const n = Number(process.env[key]);
  return process.env[key] !== undefined && process.env[key] !== '' && Number.isFinite(n) ? n : fallback;
};
export const RULES = {
  joinBonus: envNum('REFERRAL_JOIN_BONUS', 0.1), // credited to the referrer when a friend joins
  commissionPct: envNum('REFERRAL_COMMISSION_PCT', 5), // % of each commissioned purchase
  maxCommissionOrders: envNum('REFERRAL_MAX_COMMISSION_ORDERS', 3), // per invited friend
  dailyLimit: envNum('REFERRAL_DAILY_LIMIT', 20), // new referrals one user can earn from per day
  // Friends who become resellers (a user linked to a reseller API key):
  resellerBonus: envNum('REFERRAL_RESELLER_BONUS', 1), // one-time, when the friend becomes a reseller
  resellerCommissionPct: envNum('REFERRAL_RESELLER_COMMISSION_PCT', 5), // % of the PROFIT on their purchases
  resellerSpendCap: envNum('REFERRAL_RESELLER_SPEND_CAP', 100), // commission only on their first $100 of purchases
};

// A friend only counts if their account was created moments ago. Telegram sends
// the start payload every time the link is opened, so without this an existing
// customer could be "referred" retroactively.
const NEW_USER_WINDOW_MS = 10 * 60 * 1000;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export const referralCode = (userId) => `ref_${userId}`;

export function parseReferralPayload(payload) {
  const m = /^ref_(\d+)$/.exec(String(payload || '').trim());
  return m ? Number(m[1]) : null;
}

export function referralLink(botUsername, userId) {
  return `https://t.me/${botUsername}?start=${referralCode(userId)}`;
}

const displayName = (u) => (u?.username ? '@' + u.username : u?.firstName || 'a friend');

/**
 * A brand-new user opened the bot through someone's invite link. Records the
 * referral and pays the referrer the join bonus.
 *
 * Returns { ok: true, bonus } or { ok: false, reason }. Never throws: referral
 * trouble must not stop the new customer from reaching the shop.
 */
export async function registerReferral({ referrerId, referred }) {
  try {
    if (!referrerId || referrerId === referred.id) return { ok: false, reason: 'self' };
    if (Date.now() - new Date(referred.createdAt).getTime() > NEW_USER_WINDOW_MS) {
      return { ok: false, reason: 'not_new' };
    }

    const referrer = await prisma.user.findUnique({ where: { id: referrerId } });
    if (!referrer || referrer.isBanned) return { ok: false, reason: 'bad_referrer' };

    // A person can only be referred once, and an account that already bought
    // something is not new, whatever its age.
    const [already, orders] = await Promise.all([
      prisma.referral.findUnique({ where: { referredId: referred.id } }),
      prisma.order.count({ where: { userId: referred.id } }),
    ]);
    if (already) return { ok: false, reason: 'already_referred' };
    if (orders > 0) return { ok: false, reason: 'not_new' };

    const today = await prisma.referral.count({
      where: { referrerId, createdAt: { gte: startOfDay() } },
    });
    if (today >= RULES.dailyLimit) return { ok: false, reason: 'daily_limit' };

    const bonus = round2(RULES.joinBonus);
    // referredId is UNIQUE, so if two requests race, one create throws and the
    // whole transaction (including the balance credit) rolls back.
    await prisma.$transaction(async (tx) => {
      await tx.referral.create({ data: { referrerId, referredId: referred.id, bonusPaid: bonus } });
      if (bonus > 0) await tx.user.update({ where: { id: referrerId }, data: { balance: { increment: bonus } } });
    });

    logger.info({ referrerId, referredId: referred.id, bonus }, 'referral registered');
    await sendMessageSafe(
      referrer.telegramId,
      `🎉 <b>${escapeHtml(displayName(referred))}</b> joined using your invite link!\n\n` +
        `💰 <b>+${money(bonus)}</b> added to your balance.\n` +
        `You'll also earn <b>${RULES.commissionPct}%</b> on their first ${RULES.maxCommissionOrders} purchases.`
    ).catch(() => {});
    return { ok: true, bonus };
  } catch (e) {
    // Unique violation = lost a race to another request: not an error worth logging loudly.
    logger.warn({ err: e.message, referrerId }, 'referral registration failed');
    return { ok: false, reason: 'error' };
  }
}

/**
 * Pay the referrer their commission for a delivered purchase by a referred
 * friend. Safe to call for any order and safe to call twice: it does nothing
 * unless the buyer was referred, the order is a real purchase, the friend has
 * commissions left, and this order has not already paid out.
 */
export async function awardCommission(orderId) {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    // Wallet top-ups are not purchases.
    if (!order || order.kind !== 'PURCHASE') return null;

    const ref = await prisma.referral.findUnique({ where: { referredId: order.userId } });
    if (!ref) return null;

    // A reseller friend (their account is linked to an API key) follows the
    // reseller rule — profit-based, API orders included — instead of the normal one.
    if (await prisma.apiKey.findFirst({ where: { userId: order.userId }, select: { id: true } })) {
      return awardResellerCommission(order, ref);
    }
    // Normal customers: reseller-API orders are wholesale, no commission.
    if (order.apiKeyId != null) return null;
    if (ref.commissionOrders >= RULES.maxCommissionOrders) return null;

    // Cheap early exit for the common repeat call; the UNIQUE orderId below is
    // the real guard against a concurrent double payout.
    if (await prisma.referralEarning.findUnique({ where: { orderId } })) return null;

    const amount = round2((num(order.amount) * RULES.commissionPct) / 100);
    if (!(amount > 0)) return null;

    const paid = await prisma.$transaction(async (tx) => {
      // Guarded claim of one of the friend's limited commission slots.
      const slot = await tx.referral.updateMany({
        where: { id: ref.id, commissionOrders: { lt: RULES.maxCommissionOrders } },
        data: { commissionOrders: { increment: 1 }, commissionTotal: { increment: amount } },
      });
      if (slot.count !== 1) return false;
      // orderId is UNIQUE: a second delivery of the same order throws here and
      // rolls the slot claim back.
      await tx.referralEarning.create({ data: { referralId: ref.id, orderId, amount } });
      await tx.user.update({ where: { id: ref.referrerId }, data: { balance: { increment: amount } } });
      return true;
    }).catch(() => false);
    if (!paid) return null;

    const [referrer, buyer] = await Promise.all([
      prisma.user.findUnique({ where: { id: ref.referrerId } }),
      prisma.user.findUnique({ where: { id: order.userId } }),
    ]);
    logger.info({ order: order.publicId, referrerId: ref.referrerId, amount }, 'referral commission paid');
    if (referrer) {
      await sendMessageSafe(
        referrer.telegramId,
        `💸 <b>Commission earned!</b>\n\n` +
          `${escapeHtml(displayName(buyer))} bought from the shop.\n` +
          `💰 <b>+${money(amount)}</b> (${RULES.commissionPct}%) added to your balance.`
      ).catch(() => {});
    }
    return amount;
  } catch (e) {
    logger.warn({ err: e.message, orderId }, 'referral commission failed');
    return null;
  }
}

/**
 * A referred friend just became a reseller (their account was linked to an API
 * key): pay the referrer the one-time reseller bonus. Safe to call repeatedly —
 * the guarded claim pays at most once per friend.
 */
export async function awardResellerBonus(userId) {
  try {
    const bonus = round2(RULES.resellerBonus);
    if (!(bonus > 0)) return null;
    const ref = await prisma.referral.findUnique({ where: { referredId: userId } });
    if (!ref || num(ref.resellerBonusPaid) > 0) return null;

    const paid = await prisma.$transaction(async (tx) => {
      const claim = await tx.referral.updateMany({
        where: { id: ref.id, resellerBonusPaid: 0 },
        data: { resellerBonusPaid: bonus, bonusPaid: { increment: bonus } },
      });
      if (claim.count !== 1) return false;
      await tx.user.update({ where: { id: ref.referrerId }, data: { balance: { increment: bonus } } });
      return true;
    }).catch(() => false);
    if (!paid) return null;

    const [referrer, friend] = await Promise.all([
      prisma.user.findUnique({ where: { id: ref.referrerId } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ]);
    logger.info({ referrerId: ref.referrerId, referredId: userId, bonus }, 'reseller referral bonus paid');
    if (referrer) {
      await sendMessageSafe(
        referrer.telegramId,
        `🎉 <b>${escapeHtml(displayName(friend))}</b> is now a reseller!\n\n` +
          `💰 <b>+${money(bonus)}</b> added to your balance.\n` +
          `You'll also earn <b>${RULES.resellerCommissionPct}%</b> of the profit on their purchases (up to ${money(RULES.resellerSpendCap)} total).`
      ).catch(() => {});
    }
    return bonus;
  } catch (e) {
    logger.warn({ err: e.message, userId }, 'reseller referral bonus failed');
    return null;
  }
}

// Commission for a reseller friend's purchase: % of the order's PROFIT, only on
// the part of their spending that falls inside the spend cap.
async function awardResellerCommission(order, ref) {
  const cap = RULES.resellerSpendCap;
  const total = num(order.amount);
  const remaining = cap - num(ref.resellerSpend);
  if (!(total > 0) || !(remaining > 0)) return null;
  if (await prisma.referralEarning.findUnique({ where: { orderId: order.id } })) return null;

  const profit = order.items.reduce((s, i) => s + (num(i.unitPrice) - num(i.unitCost)) * i.quantity, 0);
  if (!(profit > 0)) return null;
  const share = Math.min(1, remaining / total); // part of this order still inside the cap
  const amount = round2((profit * share * RULES.resellerCommissionPct) / 100);
  if (!(amount > 0)) return null;

  const paid = await prisma.$transaction(async (tx) => {
    const slot = await tx.referral.updateMany({
      where: { id: ref.id, resellerSpend: { lt: cap } },
      data: { resellerSpend: { increment: round2(total * share) }, commissionOrders: { increment: 1 }, commissionTotal: { increment: amount } },
    });
    if (slot.count !== 1) return false;
    await tx.referralEarning.create({ data: { referralId: ref.id, orderId: order.id, amount } });
    await tx.user.update({ where: { id: ref.referrerId }, data: { balance: { increment: amount } } });
    return true;
  }).catch(() => false);
  if (!paid) return null;

  const [referrer, buyer] = await Promise.all([
    prisma.user.findUnique({ where: { id: ref.referrerId } }),
    prisma.user.findUnique({ where: { id: order.userId } }),
  ]);
  logger.info({ order: order.publicId, referrerId: ref.referrerId, amount }, 'reseller referral commission paid');
  if (referrer) {
    await sendMessageSafe(
      referrer.telegramId,
      `💸 <b>Commission earned!</b>\n\n` +
        `Your reseller friend ${escapeHtml(displayName(buyer))} made a purchase.\n` +
        `💰 <b>+${money(amount)}</b> (${RULES.resellerCommissionPct}% of profit) added to your balance.`
    ).catch(() => {});
  }
  return amount;
}

export async function referralStats(userId) {
  const [refs, today] = await Promise.all([
    prisma.referral.findMany({ where: { referrerId: userId } }),
    prisma.referral.count({ where: { referrerId: userId, createdAt: { gte: startOfDay() } } }),
  ]);
  const bonus = refs.reduce((s, r) => s + num(r.bonusPaid), 0);
  const commission = refs.reduce((s, r) => s + num(r.commissionTotal), 0);
  const buyers = refs.filter((r) => r.commissionOrders > 0).length;
  return {
    invited: refs.length,
    buyers,
    today,
    todayLeft: Math.max(0, RULES.dailyLimit - today),
    bonus: round2(bonus),
    commission: round2(commission),
    total: round2(bonus + commission),
  };
}
