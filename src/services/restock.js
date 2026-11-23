// Restock announcements: DM every (non-banned) user when a supplier product
// comes back in stock. Triggered by supplier syncs (see suppliers/index.js),
// which run on the Hangout restock webhook and on the periodic worker, so it
// covers every supplier and product.
import prisma from '../db.js';
import logger from '../logger.js';
import { money, num, escapeHtml, sleep } from '../utils.js';
import { emojiHtml, productButton } from '../emoji.js';
import { getSetting } from './settings.js';
import { bot } from '../bot/instance.js';

// A product flapping 0 <-> 1 must not spam everyone: one message per product
// per cooldown window.
const COOLDOWN_MS = 30 * 60 * 1000;
const lastAnnounced = new Map(); // productId -> ts

let sending = Promise.resolve();

export function announceRestocks(productIds) {
  const now = Date.now();
  const ids = [...new Set(productIds)].filter((id) => now - (lastAnnounced.get(id) || 0) > COOLDOWN_MS);
  if (!ids.length) return;
  ids.forEach((id) => lastAnnounced.set(id, now));
  // Serialise so two quick syncs never interleave their broadcasts.
  sending = sending.then(() => send(ids)).catch((e) => logger.error({ err: e.message }, 'restock broadcast failed'));
}

async function send(ids) {
  if (!bot) return;
  if ((await getSetting('user_restock_enabled')) !== 'true') return;
  const products = await prisma.product.findMany({ where: { id: { in: ids }, isActive: true } });
  // Re-check: only products still buyable right now.
  const live = products.filter((p) => num(p.supplierStock) > 0);
  if (!live.length) return;
  const users = await prisma.user.findMany({ where: { isBanned: false }, select: { telegramId: true } });

  for (const p of live) {
    const msg =
      `🔔 <b>Restock Alert!</b>\n\n` +
      `${emojiHtml(p.emoji)} <b>${escapeHtml(p.name)}</b> is back in stock!\n` +
      `💵 Price: <b>${money(num(p.price))}</b> each\n` +
      `📦 Available now: <b>${p.supplierStock}</b>\n\n` +
      `Tap below to grab yours before it's gone.`;
    const kb = { inline_keyboard: [[productButton(p, 'Buy Now', `p:${p.id}`, { style: 'success' })]] };
    let sent = 0;
    for (const u of users) {
      try {
        await bot.api.sendMessage(u.telegramId.toString(), msg, { parse_mode: 'HTML', reply_markup: kb });
        sent++;
      } catch (_) {}
      await sleep(40);
    }
    logger.info({ product: p.name, sent, users: users.length }, 'restock announced');
  }
}
