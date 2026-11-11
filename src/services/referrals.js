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
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    // Wallet top-ups are not purchases, and reseller-API orders are wholesale.
    if (!order || order.kind !== 'PURCHASE' || order.apiKeyId != null) return null;

    const ref = await prisma.referral.findUnique({ where: { referredId: order.userId } });
    if (!ref || ref.commissionOrders >= RULES.maxCommissionOrders) return null;

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
