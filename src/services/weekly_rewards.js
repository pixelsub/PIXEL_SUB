// Weekly rewards: every Friday the top 3 spenders who spent at least the
// threshold (default $100) over the past 7 days are credited wallet balance.
// Winners get a DM, every user gets an announcement and the channel gets a
// post — the last two only show masked names.
//
//  • The "week" is the 7 days before the Friday payout moment, so there is no
//    gap or overlap between weeks.
//  • Idempotent: WeeklyReward has UNIQUE(weekKey, rank), so a rank is never
//    paid twice, and `announced` lets a crash between paying and announcing
//    resume on the next tick.
//  • Spend = delivered shop purchases (wallet top-ups and reseller-API orders
//    excluded; admins and banned users never win).
import prisma from '../db.js';
import logger from '../logger.js';
import { bot } from '../bot/instance.js';
import { sendMessageSafe } from '../bot/delivery.js';
import { escapeHtml, money, num, sleep } from '../utils.js';
import { getAllSettings, setSetting } from './settings.js';
import { dhakaNow, postWeeklyWinners } from './channel.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

export function parseRewardConfig(s) {
  const threshold = Math.max(0, Number(s.weekly_reward_threshold) || 100);
  const amounts = String(s.weekly_reward_amounts || '5,3,2')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 10);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s.weekly_reward_time || '').trim());
  const time = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : '20:00';
  return { enabled: s.weekly_reward_enabled === 'true', threshold, amounts: amounts.length ? amounts : [5, 3, 2], time };
}

// Payout instant of the Friday on/before `now` (Dhaka is UTC+6, no DST).
function payoutInstant(dateStr, time) {
  return new Date(`${dateStr}T${time}:00+06:00`);
}

// Next Friday payout moment at or after `now`.
export function nextPayout(now, time) {
  for (let i = 0; i < 8; i++) {
    const { date } = dhakaNow(new Date(now.getTime() + i * 86400000));
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 5) continue;
    const at = payoutInstant(date, time);
    if (at.getTime() >= now.getTime()) return { date, at };
  }
  return null;
}

// Top spenders in (from, to]. Returns [{ user, spent }] sorted, qualified only.
export async function topSpenders(from, to, threshold, limit) {
  const inWindow = (f) => ({ gt: from, lte: to, ...(f || {}) });
  const rows = await prisma.order.groupBy({
    by: ['userId'],
    where: {
      kind: 'PURCHASE',
      status: 'DELIVERED',
      apiKeyId: null,
      OR: [{ deliveredAt: inWindow() }, { deliveredAt: null, createdAt: inWindow() }],
    },
    _sum: { amount: true },
  });
  const ranked = rows
    .map((r) => ({ userId: r.userId, spent: round2(num(r._sum.amount)) }))
    .filter((r) => r.spent >= threshold && r.spent > 0)
    .sort((a, b) => b.spent - a.spent || a.userId - b.userId);
  if (!ranked.length) return [];
  const users = await prisma.user.findMany({ where: { id: { in: ranked.map((r) => r.userId) } } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return ranked
    .map((r) => ({ user: byId.get(r.userId), spent: r.spent }))
    .filter((r) => r.user && !r.user.isBanned && !r.user.isAdmin)
    .slice(0, limit);
}

// "jo***" — never the full name.
export function maskName(u) {
  const base = (u?.username || u?.firstName || '').replace(/^@/, '').trim();
  if (!base) return `User ***${String(u?.telegramId ?? '').slice(-2)}`;
  const chars = [...base];
  return `${chars.slice(0, chars.length > 3 ? 2 : 1).join('')}***`;
}

// ---------------------------------------------------------------- messages

function announcementText(shopName, winners, cfg) {
  const lines = [`🏆 <b>${escapeHtml(shopName)} • WEEKLY REWARD WINNERS</b>`, '━━━━━━━━━━━━━━━━━━', ''];
  for (const w of winners) lines.push(`${MEDALS[w.rank - 1] || '🏅'} <b>${escapeHtml(maskName(w.user))}</b> — won <b>${money(w.reward)}</b>`);
  lines.push('', `💡 Spend <b>${money(cfg.threshold)}+</b> in a week and be among the top ${cfg.amounts.length} spenders to win next time!`);
  return lines.join('\n');
}

async function messageAllUsers(text) {
  const users = await prisma.user.findMany({ where: { isBanned: false }, select: { telegramId: true } });
  let sent = 0;
  for (const u of users) {
    const r = await sendMessageSafe(u.telegramId, text);
    if (r.ok) sent++;
    await sleep(40); // ~25 msgs/sec, under Telegram's limit
  }
  logger.info({ total: users.length, sent }, 'weekly reward message to all users done');
  return { total: users.length, sent };
}

// Admin switched the program on/off: tell every user (runs in the background).
export async function announceToggle(enabled) {
  const s = await getAllSettings(true);
  const cfg = parseRewardConfig(s);
  const text = enabled
    ? `🏆 <b>Weekly Rewards are ON!</b>\n\nSpend <b>${money(cfg.threshold)}+</b> in a week and be among the top ${cfg.amounts.length} spenders to win wallet credit:\n` +
      cfg.amounts.map((a, i) => `${MEDALS[i] || '🏅'} ${money(a)}`).join('\n') +
      `\n\nWinners are picked every Friday. Happy shopping! 🛒`
    : `⏸ <b>Weekly Rewards are paused.</b>\n\nThe weekly top-spender reward is switched off for now. We'll let you know when it's back!`;
  messageAllUsers(text).catch((e) => logger.warn({ err: e.message }, 'reward toggle announcement failed'));
}

// ---------------------------------------------------------------- payout

async function announceWeek(weekKey) {
  const rows = await prisma.weeklyReward.findMany({ where: { weekKey }, orderBy: { rank: 'asc' } });
  if (!rows.length || rows.every((r) => r.announced)) return;
  const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } } });
  const byId = new Map(users.map((u) => [u.id, u]));
  const winners = rows.map((r) => ({ rank: r.rank, user: byId.get(r.userId), spent: num(r.spent), reward: num(r.reward) }));
  const s = await getAllSettings(true);
  const cfg = parseRewardConfig(s);

  // 1) personal DM to each winner
  for (const w of winners) {
    if (!w.user) continue;
    await sendMessageSafe(
      w.user.telegramId,
      `🎉 <b>Congratulations!</b>\n\nYou're <b>#${w.rank}</b> top spender this week (${money(w.spent)} spent).\n💰 <b>+${money(w.reward)}</b> has been added to your balance. Thank you for shopping with us!`
    ).catch(() => {});
    await sleep(60);
  }
  // 2) channel post (names masked); never blocks the rest if the channel isn't set up
  const text = announcementText(s.shop_name, winners, cfg);
  try {
    await postWeeklyWinners(text, `weekly:${weekKey}`);
  } catch (e) {
    logger.warn({ err: e.message }, 'weekly winners channel post failed');
  }
  // Mark done before the slow all-users loop so a restart never re-sends DMs.
  await prisma.weeklyReward.updateMany({ where: { weekKey }, data: { announced: true } });
  // 3) every user hears who won this week
  await messageAllUsers(text);
}

let running = false;
export async function runWeeklyRewardIfDue(now = new Date()) {
  if (running || !bot) return { due: false };
  running = true;
  try {
    const s = await getAllSettings();
    const cfg = parseRewardConfig(s);
    if (!cfg.enabled) return { due: false };

    const { date, minutes } = dhakaNow(now);
    if (new Date(`${date}T00:00:00Z`).getUTCDay() !== 5) return { due: false }; // Friday only
    const [hh, mm] = cfg.time.split(':').map(Number);
    if (minutes < hh * 60 + mm) return { due: false };

    const weekKey = date;
    const doneKey = `weekly_reward_done:${weekKey}`;
    if (s[doneKey]) return { due: false, done: true };

    // Winners already paid but not (fully) announced — e.g. a restart mid-way.
    const existing = await prisma.weeklyReward.count({ where: { weekKey } });
    if (existing) {
      await announceWeek(weekKey);
      await setSetting(doneKey, 'paid');
      return { due: true, resumed: true };
    }

    const to = payoutInstant(weekKey, cfg.time);
    const winners = await topSpenders(new Date(to.getTime() - WEEK_MS), to, cfg.threshold, cfg.amounts.length);
    if (!winners.length) {
      await setSetting(doneKey, 'none');
      logger.info({ weekKey }, 'weekly reward: nobody qualified');
      return { due: true, winners: 0 };
    }

    // Pay all ranks atomically. UNIQUE(weekKey, rank) makes a double run throw
    // and roll the whole credit back.
    try {
      await prisma.$transaction(async (tx) => {
        for (let i = 0; i < winners.length; i++) {
          const w = winners[i];
          await tx.weeklyReward.create({ data: { weekKey, rank: i + 1, userId: w.user.id, spent: w.spent, reward: cfg.amounts[i] } });
          await tx.user.update({ where: { id: w.user.id }, data: { balance: { increment: cfg.amounts[i] } } });
        }
      });
    } catch (e) {
      logger.warn({ err: e.message, weekKey }, 'weekly reward payout skipped (already paid?)');
      return { due: true, error: e.message };
    }
    logger.info({ weekKey, winners: winners.length }, 'weekly rewards paid');
    await announceWeek(weekKey);
    await setSetting(doneKey, 'paid');
    return { due: true, winners: winners.length };
  } catch (e) {
    logger.warn({ err: e.message }, 'weekly reward run failed');
    return { due: true, error: e.message };
  } finally {
    running = false;
  }
}

// Live standings for the admin page: current week so far + past winners.
export async function rewardOverview() {
  const s = await getAllSettings(true);
  const cfg = parseRewardConfig(s);
  const now = new Date();
  const next = nextPayout(now, cfg.time);
  const to = next ? next.at : now;
  const from = new Date(to.getTime() - WEEK_MS);
  const standings = (await topSpenders(from, now, 0.01, 10)).map((r, i) => ({
    rank: i + 1,
    name: r.user.username ? '@' + r.user.username : r.user.firstName || `User ${r.user.telegramId}`,
    telegramId: String(r.user.telegramId),
    spent: r.spent,
    qualified: r.spent >= cfg.threshold,
    reward: r.spent >= cfg.threshold && i < cfg.amounts.length ? cfg.amounts[i] : 0,
  }));
  const history = await prisma.weeklyReward.findMany({ orderBy: [{ weekKey: 'desc' }, { rank: 'asc' }], take: 60 });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(history.map((h) => h.userId))] } } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return {
    config: cfg,
    nextPayout: next ? next.at.toISOString() : null,
    windowFrom: from.toISOString(),
    standings,
    history: history.map((h) => {
      const u = byId.get(h.userId);
      return {
        weekKey: h.weekKey,
        rank: h.rank,
        name: u ? (u.username ? '@' + u.username : u.firstName || `User ${u.telegramId}`) : `#${h.userId}`,
        spent: num(h.spent),
        reward: num(h.reward),
      };
    }),
  };
}

let timer = null;
export function startWeeklyRewardScheduler() {
  if (!bot) return;
  timer = setInterval(() => runWeeklyRewardIfDue().catch(() => {}), 60 * 1000);
  setTimeout(() => runWeeklyRewardIfDue().catch(() => {}), 20 * 1000);
}
export function stopWeeklyRewardScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}
