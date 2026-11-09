// Telegram channel auto-posting: daily "Today's Stock", new product
// announcements, and manual posts from the admin panel.
//
// Reliability rules:
//  • Automatic posts claim a unique ChannelPost.dedupeKey BEFORE sending, so a
//    restart, a retry or a second running instance can never post twice.
//  • The scheduler is a 60s tick that works out "what should have been posted
//    by now" from the database, so a restart at 09:59 or 10:01 still posts the
//    daily stock (within a catch-up window) — no in-memory timers to lose.
//  • A post that may or may not have reached Telegram (crash mid-send) is
//    marked "unknown" and never retried automatically: a missing post is
//    better than a duplicate.
import { InlineKeyboard, GrammyError } from 'grammy';
import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { bot } from '../bot/instance.js';
import { emojiHtml, UI } from '../emoji.js';
import { escapeHtml, money, num, sleep } from '../utils.js';
import { getAllSettings, getSetting, setSetting } from './settings.js';
import { STOCK_COUNT, stockOf } from './stock.js';

export const TIMEZONE = 'Asia/Dhaka';
const DAILY_CATCHUP_MS = 4 * 60 * 60 * 1000; // still post up to 4h after the set time
const DAILY_MAX_FAILURES = 3; // per day, then stop and alert admins
const NEW_PRODUCT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // never announce older products
const COMBINE_NEW_ABOVE = 3; // more new products at once → one combined post
const STUCK_PENDING_MS = 10 * 60 * 1000;
const MAX_TEXT = 3900; // Telegram limit is 4096; leave room for entities

// ---------------------------------------------------------------- helpers

export class ChannelError extends Error {
  constructor(message, code = 'channel_error') { super(message); this.code = code; }
}

// Accept "@name", "name", "https://t.me/name", or a numeric "-100…" id.
export function normalizeChannelId(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, '').replace(/^tg:\/\/resolve\?domain=/i, '');
  s = s.split(/[/?#]/)[0];
  if (/^-?\d+$/.test(s)) return s;
  s = s.replace(/^@/, '');
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s) ? '@' + s : '';
}

// Date/time parts in Asia/Dhaka, independent of the server's timezone.
export function dhakaNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

function parseTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return 10 * 60;
  return Number(m[1]) * 60 + Number(m[2]);
}

function prettyDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

let botUsername = null;
export async function getBotUsername() {
  if (botUsername) return botUsername;
  if (!bot) return null;
  try { botUsername = bot.botInfo.username; } catch { /* not initialised yet */ }
  if (!botUsername) botUsername = (await bot.api.getMe()).username;
  return botUsername;
}

async function shopUrl(payload) {
  const u = await getBotUsername();
  return u ? `https://t.me/${u}${payload ? `?start=${payload}` : ''}` : null;
}

async function shopKeyboard(payload, label = '🛒 Shop Now') {
  const url = await shopUrl(payload);
  return url ? new InlineKeyboard().url(label, url) : undefined;
}

// Products the shop is actually selling (same rules as the bot's Shop).
async function listedProducts(where = {}) {
  return prisma.product.findMany({
    where: { isActive: true, OR: [{ supplierId: null }, { supplierSelected: true }], ...where },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: { category: true, ...STOCK_COUNT },
  });
}

const inStock = (p) => !p.usesStock || stockOf(p) > 0;

// Split long text on line boundaries into Telegram-sized chunks.
function chunkText(text) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && (cur + '\n' + line).length > MAX_TEXT) { out.push(cur); cur = line; }
    else cur = cur ? cur + '\n' + line : line;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------------------------------------------------------- formatting

// Visual building blocks shared by every post. The premium USDT coin marks
// prices; 📊 is upgraded to the premium chart icon by decorateHtml.
const DIVIDER = '━━━━━━━━━━━━━━━━━━';
const PRICE_ICON = `<tg-emoji emoji-id="${UI.usdt}">💲</tg-emoji>`;
export const DEFAULT_DAILY_HEADER = "🔔 <b>{shop_name} • TODAY'S STOCK UPDATE</b>";
const OLD_DAILY_HEADER = "📦 <b>Today's Stock</b>"; // first default — upgraded automatically

// "🟢 LIVE • 🕐 09 Nov 2026 • 10:00 AM (GMT+6)"
function liveStamp(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
  return `🟢 <b>LIVE</b> • 🕐 ${escapeHtml(day)} • ${escapeHtml(time)} (GMT+6)`;
}

// Two-line product entry:
//   <emoji> Name
//      └ 💲 $1.30  •  📊 36 in stock
function productLines(p) {
  const qty = !p.usesStock ? '♾️ Always available' : stockOf(p) > 0 ? `📊 ${stockOf(p)} in stock` : '❌ Sold out';
  return [
    `${emojiHtml(p.emoji)} <b>${escapeHtml(p.name)}</b>`,
    `   └ ${PRICE_ICON} <b>${money(num(p.price))}</b>  •  ${qty}`,
  ];
}

async function headerLine(template) {
  const shop = escapeHtml(String(await getSetting('shop_name')).toUpperCase());
  const t = !template || template.trim() === OLD_DAILY_HEADER ? DEFAULT_DAILY_HEADER : template;
  return t.replace(/\{shop_name\}/g, shop);
}

export async function buildDailyStock() {
  const s = await getAllSettings();
  const showSoldOut = s.channel_daily_show_soldout === 'true';
  const all = await listedProducts();
  const available = all.filter(inStock);
  const soldOut = showSoldOut ? all.filter((p) => !inStock(p)) : [];
  const lines = [await headerLine(s.channel_daily_header), liveStamp(), DIVIDER, ''];
  if (available.length) {
    lines.push('✅ <b>AVAILABLE NOW</b>', '');
    for (const p of available) lines.push(...productLines(p), '');
  }
  if (soldOut.length) {
    lines.push('❌ <b>SOLD OUT</b>', '');
    for (const p of soldOut) lines.push(`${emojiHtml(p.emoji)} <s>${escapeHtml(p.name)}</s>`);
    lines.push('');
  }
  if (s.channel_footer) lines.push(DIVIDER, s.channel_footer);
  return { text: lines.join('\n').trim(), count: available.length + soldOut.length };
}

function productBlock(p, title) {
  const desc = p.description ? `\n${escapeHtml(p.description.length > 350 ? p.description.slice(0, 347) + '…' : p.description)}\n` : '';
  return [title, DIVIDER, '', ...productLines(p), desc].join('\n').trimEnd();
}

// ---------------------------------------------------------------- sending

async function channelId() {
  const id = await getSetting('channel_id');
  if (!id) throw new ChannelError('No channel configured. Set the channel in Admin → Channel.', 'no_channel');
  if (!bot) throw new ChannelError('BOT_TOKEN is not set.', 'no_bot');
  return id;
}

async function sendOne(chatId, text, keyboard) {
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(keyboard ? { reply_markup: keyboard } : {}) };
  for (let attempt = 0; ; attempt++) {
    try {
      return await bot.api.sendMessage(chatId, text, opts);
    } catch (e) {
      const retryAfter = e instanceof GrammyError ? e.parameters?.retry_after : null;
      if (retryAfter && attempt < 2) { await sleep((retryAfter + 1) * 1000); continue; }
      throw e;
    }
  }
}

// Claim (when a dedupeKey is given), send, record. Returns the ChannelPost row.
// { skipped: true } when the key was already claimed.
async function publish({ kind, dedupeKey = null, productIds = [], text, keyboard, createdBy = 'auto' }) {
  const chatId = await channelId();
  const pid = productIds.length === 1 ? productIds[0] : null;
  let rows;
  try {
    rows = dedupeKey
      ? await prisma.$transaction(
          (Array.isArray(dedupeKey) ? dedupeKey : [dedupeKey]).map((k, i) =>
            prisma.channelPost.create({ data: { kind, dedupeKey: k, productId: Array.isArray(dedupeKey) ? productIds[i] ?? null : pid, chatId, preview: text.slice(0, 300), createdBy } })
          )
        )
      : [await prisma.channelPost.create({ data: { kind, productId: pid, chatId, preview: text.slice(0, 300), createdBy } })];
  } catch (e) {
    if (e.code === 'P2002') return { skipped: true };
    throw e;
  }
  const ids = rows.map((r) => r.id);
  const messageIds = [];
  try {
    const parts = chunkText(text);
    for (let i = 0; i < parts.length; i++) {
      const msg = await sendOne(chatId, parts[i], i === parts.length - 1 ? keyboard : undefined);
      messageIds.push(msg.message_id);
      if (i < parts.length - 1) await sleep(1100);
    }
    await prisma.channelPost.updateMany({ where: { id: { in: ids } }, data: { status: 'sent', sentAt: new Date(), messageIds: messageIds.join(',') } });
    logger.info({ kind, dedupeKey, messages: messageIds.length }, 'channel post sent');
    return { ...rows[0], status: 'sent', messageIds: messageIds.join(',') };
  } catch (e) {
    const error = String(e.description || e.message).slice(0, 500);
    // Free the dedupe key so a later attempt may retry. If part of a long post
    // already went out, keep the key: never risk a duplicate.
    for (const r of rows) {
      await prisma.channelPost.update({
        where: { id: r.id },
        data: {
          status: 'failed',
          error,
          messageIds: messageIds.join(','),
          ...(r.dedupeKey && !messageIds.length ? { dedupeKey: `${r.dedupeKey}#failed#${r.id}` } : {}),
        },
      }).catch(() => {});
    }
    logger.warn({ kind, dedupeKey, err: error }, 'channel post failed');
    throw new ChannelError(error, 'telegram_error');
  }
}

// ---------------------------------------------------------------- post types

export async function postDailyStock({ createdBy = 'auto', dedupeKey = null } = {}) {
  const { text, count } = await buildDailyStock();
  if (!count) {
    if (dedupeKey) await prisma.channelPost.create({ data: { kind: 'daily_stock', dedupeKey, chatId: await channelId(), status: 'skipped', error: 'No products in stock', createdBy } }).catch(() => {});
    throw new ChannelError('No products to post — nothing is in stock.', 'empty');
  }
  return publish({ kind: 'daily_stock', dedupeKey, text, keyboard: await shopKeyboard('shop'), createdBy });
}

async function loadProduct(productId) {
  const p = await prisma.product.findUnique({ where: { id: Number(productId) }, include: STOCK_COUNT });
  if (!p) throw new ChannelError('Product not found', 'not_found');
  return p;
}

export async function postProduct(productId, { createdBy = 'admin', kind = 'product', dedupeKey = null } = {}) {
  const p = await loadProduct(productId);
  const title = kind === 'new_product' ? '🆕 <b>NEW PRODUCT ADDED</b>' : '🛍 <b>AVAILABLE NOW</b>';
  return publish({ kind, dedupeKey, productIds: [p.id], text: productBlock(p, title), keyboard: inStock(p) ? await shopKeyboard(`p_${p.id}`) : await shopKeyboard('shop', '🛍 Browse the shop'), createdBy });
}

export async function postPriceUpdate(productId, { oldPrice = null, createdBy = 'admin' } = {}) {
  const p = await loadProduct(productId);
  const now = num(p.price);
  const old = oldPrice != null && oldPrice !== '' && Number.isFinite(Number(oldPrice)) ? Number(oldPrice) : null;
  const tag = old != null && old > now ? '🔥 <b>PRICE DROP</b>' : '💲 <b>PRICE UPDATE</b>';
  const priceLine = old != null && old !== now ? `<s>${money(old)}</s> ➡ <b>${money(now)}</b>` : `<b>${money(now)}</b>`;
  const qty = !p.usesStock ? '♾️ Always available' : stockOf(p) > 0 ? `📊 ${stockOf(p)} in stock` : '❌ Sold out';
  const text = [
    tag, DIVIDER, '',
    `${emojiHtml(p.emoji)} <b>${escapeHtml(p.name)}</b>`,
    `   └ ${PRICE_ICON} ${priceLine}  •  ${qty}`,
  ].join('\n');
  return publish({ kind: 'price_update', productIds: [p.id], text, keyboard: inStock(p) ? await shopKeyboard(`p_${p.id}`) : undefined, createdBy });
}

export async function postSoldOut(productId, { createdBy = 'admin' } = {}) {
  const p = await loadProduct(productId);
  const text = [
    '❌ <b>SOLD OUT</b>', DIVIDER, '',
    `${emojiHtml(p.emoji)} <s>${escapeHtml(p.name)}</s>`,
    '',
    '🔔 Restock coming soon — check the shop for other products!',
  ].join('\n');
  return publish({ kind: 'sold_out', productIds: [p.id], text, keyboard: await shopKeyboard('shop', '🛍 Browse the shop'), createdBy });
}

export async function postCustom({ text, shopButton = false, buttonText = '', buttonUrl = '', createdBy = 'admin' }) {
  const body = String(text || '').trim();
  if (!body) throw new ChannelError('Message text is required', 'bad_request');
  if (body.length > 4000) throw new ChannelError('Message is too long (max 4000 characters)', 'bad_request');
  const kb = new InlineKeyboard();
  let hasButton = false;
  if (buttonText && buttonUrl) {
    if (!/^https?:\/\/|^tg:\/\//i.test(buttonUrl)) throw new ChannelError('Button link must start with https://', 'bad_request');
    kb.url(String(buttonText).slice(0, 60), buttonUrl).row();
    hasButton = true;
  }
  if (shopButton) {
    const url = await shopUrl('shop');
    if (url) { kb.url('🛒 Shop Now', url); hasButton = true; }
  }
  return publish({ kind: 'custom', text: body, keyboard: hasButton ? kb : undefined, createdBy });
}

export async function postTestMessage(createdBy = 'admin') {
  const shop = await getSetting('shop_name');
  return publish({ kind: 'test', text: `✅ <b>${escapeHtml(shop)}</b> is connected to this channel.\nAutomatic stock updates will appear here.`, createdBy });
}

// Delete a post's messages from the channel.
export async function deletePost(postId) {
  const post = await prisma.channelPost.findUnique({ where: { id: Number(postId) } });
  if (!post) throw new ChannelError('Post not found', 'not_found');
  if (!bot) throw new ChannelError('BOT_TOKEN is not set.', 'no_bot');
  if (post.chatId.startsWith('inline:')) throw new ChannelError('Posts made with inline mode can only be deleted in Telegram.', 'bad_request');
  const ids = post.messageIds.split(',').filter(Boolean).map(Number);
  for (const mid of ids) {
    try { await bot.api.deleteMessage(post.chatId, mid); }
    catch (e) { if (!/message to delete not found/i.test(e.description || e.message)) throw new ChannelError(e.description || e.message, 'telegram_error'); }
  }
  await prisma.channelPost.updateMany({ where: { messageIds: post.messageIds, chatId: post.chatId, status: 'sent' }, data: { status: 'deleted' } });
  return { deleted: ids.length };
}

// Can the bot post in this channel? Returns details for the admin panel.
export async function testConnection(rawId) {
  if (!bot) throw new ChannelError('BOT_TOKEN is not set.', 'no_bot');
  const id = normalizeChannelId(rawId ?? (await getSetting('channel_id')));
  if (!id) throw new ChannelError('Enter a channel username (@mychannel) or numeric id (-100…).', 'bad_request');
  let chat;
  try { chat = await bot.api.getChat(id); }
  catch (e) { throw new ChannelError(`Channel not found or the bot isn't a member: ${e.description || e.message}`, 'not_found'); }
  const me = await bot.api.getMe();
  let member;
  try { member = await bot.api.getChatMember(chat.id, me.id); }
  catch (e) { throw new ChannelError(`Bot is not in this channel: ${e.description || e.message}`, 'not_member'); }
  const isAdmin = member.status === 'administrator' || member.status === 'creator';
  const canPost = chat.type === 'channel' ? isAdmin && (member.status === 'creator' || member.can_post_messages !== false) : ['administrator', 'creator', 'member'].includes(member.status);
  return {
    id,
    chatId: String(chat.id),
    title: chat.title,
    username: chat.username || null,
    type: chat.type,
    botStatus: member.status,
    canPost,
    canDelete: isAdmin && (member.status === 'creator' || member.can_delete_messages !== false),
    hint: canPost ? null : 'Add the bot as an administrator of the channel with “Post messages” permission.',
  };
}

// ---------------------------------------------------------------- automation

let announceTimer = null;
// Called right after anything that can make a product newly sellable; the
// minute sweep is the safety net if this is missed (e.g. a restart).
export function queueNewProductCheck(delayMs = 4000) {
  if (!bot) return;
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => announceNewProducts().catch((e) => logger.warn({ err: e.message }, 'new product announce failed')), delayMs);
}

async function installedAt() {
  let v = await getSetting('channel_installed_at');
  if (!v) { v = new Date().toISOString(); await setSetting('channel_installed_at', v); }
  return new Date(v);
}

let announcing = false;
export async function announceNewProducts() {
  if (announcing) return { posted: 0 };
  announcing = true;
  try {
    const s = await getAllSettings();
    if (s.channel_new_enabled !== 'true' || !s.channel_id || !bot) return { posted: 0 };
    const since = new Date(Math.max((await installedAt()).getTime(), Date.now() - NEW_PRODUCT_WINDOW_MS));
    const candidates = (await listedProducts({ createdAt: { gte: since } })).filter(inStock);
    if (!candidates.length) return { posted: 0 };
    const done = new Set((await prisma.channelPost.findMany({
      where: { dedupeKey: { in: candidates.map((p) => `new:${p.id}`) } },
      select: { dedupeKey: true },
    })).map((r) => r.dedupeKey));
    const fresh = candidates.filter((p) => !done.has(`new:${p.id}`));
    if (!fresh.length) return { posted: 0 };

    if (fresh.length > COMBINE_NEW_ABOVE) {
      // Many at once (e.g. "Add all in stock" for a supplier): one combined post.
      const lines = ['🆕 <b>NEW PRODUCTS ADDED</b>', liveStamp(), DIVIDER, ''];
      for (const p of fresh) lines.push(...productLines(p), '');
      if (s.channel_footer) lines.push(DIVIDER, s.channel_footer);
      const r = await publish({ kind: 'new_product', dedupeKey: fresh.map((p) => `new:${p.id}`), productIds: fresh.map((p) => p.id), text: lines.join('\n'), keyboard: await shopKeyboard('shop') });
      return { posted: r.skipped ? 0 : fresh.length };
    }
    let posted = 0;
    for (const p of fresh) {
      const r = await postProduct(p.id, { kind: 'new_product', dedupeKey: `new:${p.id}`, createdBy: 'auto' });
      if (!r.skipped) posted++;
      await sleep(1100);
    }
    return { posted };
  } finally {
    announcing = false;
  }
}

let dailyAlerted = '';
export async function runDailyIfDue(now = new Date()) {
  const s = await getAllSettings();
  if (s.channel_daily_enabled !== 'true' || !s.channel_id || !bot) return { due: false };
  const { date, minutes } = dhakaNow(now);
  const at = parseTime(s.channel_daily_time);
  if (minutes < at || (minutes - at) * 60000 > DAILY_CATCHUP_MS) return { due: false };
  const key = `daily:${date}`;
  if (await prisma.channelPost.findUnique({ where: { dedupeKey: key } })) return { due: false, done: true };
  const failures = await prisma.channelPost.count({ where: { dedupeKey: { startsWith: `${key}#failed#` } } });
  if (failures >= DAILY_MAX_FAILURES) {
    if (dailyAlerted !== date) {
      dailyAlerted = date;
      const { notifyAdmins } = await import('../bot/delivery.js');
      const last = await prisma.channelPost.findFirst({ where: { dedupeKey: { startsWith: `${key}#failed#` } }, orderBy: { id: 'desc' } });
      await notifyAdmins(`⚠️ <b>Daily channel post failed</b> ${DAILY_MAX_FAILURES} times today.\n<code>${escapeHtml(last?.error || '')}</code>\nFix it in Admin → Channel, then use “Post Today Stock now”.`).catch(() => {});
    }
    return { due: true, gaveUp: true };
  }
  try {
    const r = await postDailyStock({ dedupeKey: key });
    return { due: true, posted: !r.skipped };
  } catch (e) {
    return { due: true, error: e.message };
  }
}

// Pending rows left by a crash mid-send: we can't know if Telegram got them,
// so close them as "unknown" (keeping the key) instead of retrying.
async function closeStuckPending() {
  await prisma.channelPost.updateMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - STUCK_PENDING_MS) } },
    data: { status: 'unknown', error: 'Interrupted while sending (server restart?) — not retried to avoid a duplicate.' },
  });
}

let timer = null;
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await closeStuckPending();
    await runDailyIfDue();
    await announceNewProducts();
  } catch (e) {
    logger.warn({ err: e.message }, 'channel scheduler tick failed');
  } finally {
    ticking = false;
  }
}

export function startChannelScheduler() {
  if (!bot) { logger.warn('Channel scheduler disabled (no BOT_TOKEN)'); return; }
  installedAt().catch(() => {});
  logger.info({ timezone: TIMEZONE }, 'Starting channel auto-post scheduler');
  timer = setInterval(tick, 60 * 1000);
  setTimeout(tick, 15 * 1000);
}

export function stopChannelScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  clearTimeout(announceTimer);
}

// Status for the admin panel.
export async function schedulerStatus() {
  const s = await getAllSettings();
  const { date, minutes } = dhakaNow();
  const today = await prisma.channelPost.findUnique({ where: { dedupeKey: `daily:${date}` } });
  return {
    timezone: TIMEZONE,
    now: dhakaNow(),
    dailyTime: s.channel_daily_time,
    todayStatus: today ? today.status : minutes < parseTime(s.channel_daily_time) ? 'scheduled' : 'not posted',
    todayError: today?.error || null,
    botUsername: await getBotUsername().catch(() => null),
  };
}
