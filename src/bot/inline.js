// Inline mode: an admin types "@<bot>" in the channel's message box, picks
// "Today Stock", and the post goes out "via @<bot>". Telegram does not allow
// premium (custom) emoji in the inline result itself, but does allow them when
// the bot edits that message afterwards (bot owner with Telegram Premium) —
// so the result is sent with plain emoji and immediately edited.
//
// Needs, once, in @BotFather: /setinline (enable inline mode) and
// /setinlinefeedback → Enabled (so we receive chosen_inline_result).
import prisma from '../db.js';
import logger from '../logger.js';
import { sleep } from '../utils.js';
import { isAdminTelegramId } from './instance.js';
import { buildDailyStock, inlineShopKeyboard } from '../services/channel.js';

const MAX_TEXT = 3900;
const RESULT_STOCK = 'stock';

// Inline results can't carry custom emoji: keep the fallback character.
export function stripPremium(html) {
  return String(html).replace(/<tg-emoji\b[^>]*>(.*?)<\/tg-emoji>/gsu, '$1');
}

// An inline message is a single message: cut on a line boundary if needed.
export function fitOne(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.lastIndexOf('\n', MAX_TEXT - 2);
  return text.slice(0, cut > 0 ? cut : MAX_TEXT - 2) + '\n…';
}

async function stockMessage() {
  const { text, count } = await buildDailyStock();
  return { html: fitOne(text), count };
}

export function registerInlineHandlers(bot) {
  bot.on('inline_query', async (ctx) => {
    // Only shop admins may post through the bot; everyone else sees nothing.
    if (!isAdminTelegramId(ctx.from.id)) {
      return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }
    const { html, count } = await stockMessage();
    const keyboard = await inlineShopKeyboard('shop');
    if (!count || !keyboard) {
      return ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
    }
    await ctx.answerInlineQuery([{
      type: 'article',
      id: RESULT_STOCK,
      title: '📦 Today Stock',
      description: `${count} products · premium emoji are added a second after posting`,
      input_message_content: { message_text: stripPremium(html), parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      // A keyboard is required: without it Telegram gives us no inline_message_id to edit.
      reply_markup: keyboard,
    }], { cache_time: 0, is_personal: true });
  });

  bot.on('chosen_inline_result', async (ctx) => {
    const r = ctx.chosenInlineResult;
    if (r.result_id !== RESULT_STOCK || !r.inline_message_id || !isAdminTelegramId(r.from.id)) return;
    // Not awaited: the short waits inside must not hold up other customers' updates.
    applyPremium(bot, r.inline_message_id, r.from.username || String(r.from.id))
      .catch((e) => logger.warn({ err: e.message }, 'inline premium edit crashed'));
  });
}

// Edit the freshly sent inline message so its emoji become premium. Recorded
// in the channel history; the unique key stops a repeated update from editing twice.
export async function applyPremium(bot, inlineMessageId, by) {
  const { html } = await stockMessage();
  let post;
  try {
    post = await prisma.channelPost.create({
      data: { kind: 'inline_stock', dedupeKey: `inline:${inlineMessageId}`, chatId: `inline:${inlineMessageId}`.slice(0, 190), preview: html.slice(0, 300), createdBy: by },
    });
  } catch (e) {
    if (e.code === 'P2002') return { skipped: true };
    throw e;
  }
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: await inlineShopKeyboard('shop') };
  let error = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // The message may not exist yet the instant chosen_inline_result arrives.
    await sleep(attempt === 0 ? 700 : 2000);
    try {
      await bot.api.editMessageTextInline(inlineMessageId, html, opts);
      error = null;
      break;
    } catch (e) {
      error = String(e.description || e.message);
      if (/not modified/i.test(error)) { error = null; break; }
      if (!/not found|MESSAGE_ID_INVALID|retry/i.test(error)) break;
    }
  }
  await prisma.channelPost.update({
    where: { id: post.id },
    data: { status: 'sent', sentAt: new Date(), error: error ? `Posted, but premium emoji could not be added: ${error}`.slice(0, 500) : null },
  }).catch(() => {});
  if (error) logger.warn({ err: error }, 'inline premium edit failed');
  else logger.info('inline stock post upgraded to premium emoji');
  return { ok: !error, error };
}
