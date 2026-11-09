import { escapeHtml } from './utils.js';

// A product/category "emoji" column holds either a plain emoji ("🎨") or a
// Telegram custom (premium) emoji stored as "<fallback>|<custom_emoji_id>".
// Admins set the latter by sending a premium emoji to the bot; no migration is
// needed because it is still just a string.
const SEP = '|';

// Premium emoji used for fixed UI buttons (see InlineKeyboard#icon). The plain
// emoji is dropped from those labels, so the id must stay valid.
export const UI = {
  check: '5366053107929197717',
  dollar: '5409048419211682843',
  wallet: '5215420556089776398',
  cross: '5210952531676504517',
  star: '5262485971655468699',
  support: '5456623351042694411',
  shop: '5377660214096974712',
  bolt: '5411590687663608498',
  shield: '5373173798633752502',
  card: '5472250091332993630',
  phone: '5334922072571258707',
  lock: '5870972873450984431',
  box: '5472335930549347896',
  usdt: '6213220344614882714',
  fire: '5463154755054349837',
  qty: '5226929552319594190',
  chart: '5231200819986047254',
  robot: '5854890673353789054',
  arrow: '5888758586426789596',
  warn: '5280957715462505291',
  mail: '4970246557065544891',
  tick: '5262832270573582269',
  grad: '5375163339154399459',
  // Manual payment methods, keyed like config.manualMethods[].key
  method: { BINANCE: '5454205576512818013', BYBIT: '5888695201299437962' },
};

export function parseEmoji(value = '') {
  const s = String(value ?? '');
  const i = s.indexOf(SEP);
  if (i === -1) return { char: s, id: '' };
  const id = s.slice(i + 1);
  return /^\d+$/.test(id) ? { char: s.slice(0, i), id } : { char: s, id: '' };
}

export function encodeEmoji(char, id) {
  return id ? `${char}${SEP}${id}` : char;
}

// Plain-text contexts (button labels, web panel, logs).
export function emojiPlain(value) {
  return parseEmoji(value).char;
}

// Inside an HTML-parse-mode message. Replaces escapeHtml(x.emoji).
export function emojiHtml(value) {
  const { char, id } = parseEmoji(value);
  return id ? `<tg-emoji emoji-id="${id}">${escapeHtml(char)}</tg-emoji>` : escapeHtml(char);
}

// Pull the first premium emoji out of a message, if any.
export function emojiFromMessage(message) {
  const text = message.text || message.caption || '';
  const ent = (message.entities || message.caption_entities || []).find((e) => e.type === 'custom_emoji');
  if (!ent) return null;
  return encodeEmoji(text.substr(ent.offset, ent.length) || '🛍️', ent.custom_emoji_id);
}

// ---- Automatic premium emoji in message text -------------------------------
// Plain emoji that appear in message text are swapped for their premium twin.
// Anything not listed stays as is.
const TEXT_MAP = {
  '🛍': UI.shop, '⚡': UI.bolt, '🛡': UI.shield, '💳': UI.card, '📱': UI.phone,
  '🔐': UI.lock, '📦': UI.box, '🔥': UI.fire, '💵': UI.dollar, '👛': UI.wallet,
  '✅': UI.check, '❌': UI.cross, '⭐': UI.star, '🌟': UI.star,
  '🧮': UI.qty, '📊': UI.chart, '🤖': UI.robot, '➡': UI.arrow,
  '⚠': UI.warn, '📧': UI.mail, '✔': UI.tick, '🎓': UI.grad,
  // Set chosen by the shop owner (2026-11-09). Several plain emoji share one
  // premium icon where one design fits them all (clocks, hourglasses).
  '🔔': '5258342814273513092', '🟢': '5222138207063258426', '🔴': '5411225014148014586',
  '🕐': '5440621591387980068', '🕒': '5440621591387980068', '🕓': '5440621591387980068',
  '♾': '5469745532693923461', '🆕': '5382357040008021292', '🛒': '5312361253610475399',
  '💬': '5443038326535759644', '💲': '5409048419211682843', '🧾': '5444856076954520455',
  '⬅': '5456187398977247949', '🏠': '5465226866321268133',
  '⏳': '5454415424319931791', '⌛': '5454415424319931791',
  '💰': '5224257782013769471', 'ℹ': '5215578413317758112', '📌': '5215578413317758112',
  '👋': '5440431182602842059', '👇': '5348122332432965936', '✏': '5395444784611480792',
  '🔢': '5226929552319594190', '💎': '5427168083074628963', '🔄': '5226702984204797593',
  '📋': '5408946052961170713', '⏰': '5413704112220949842', '⏱': '5413704112220949842',
  '🙏': '5285070644864628879', '😔': '5370781385885751708', '💙': '5294401079063107680',
  '🎁': '5203996991054432397', '🔗': '5271604874419647061',
  '🔑': '5420094143089111506', '🗝': '5420094143089111506',
  '♻': '5377584064326804458', '📘': '5366050848776396912', '💻': '5818813162815753343',
  '👆': '5341515693479186232', '❗': '5341515693479186232', '⛔': '5463358164705489689',
  '🗑': '5372825386591732174', '👤': '5249053508681883137', '👥': '5453957997418004470',
  '🏷': '5240228673738527951', '➕': '5397916757333654639', '📈': '5028746137645876535',
  '📉': '5246762912428603768', '📣': '5424818078833715060',
  '🗓': '5472279086657199080', '📅': '5472279086657199080',
  '🚫': '5240241223632954241', '🎉': '5208541126583136130',
};
const TEXT_RE = new RegExp(`(${Object.keys(TEXT_MAP).join('|')})\\uFE0F?`, 'gu');

// Rewrite plain emoji in an HTML-mode message. Existing <tg-emoji> tags, any
// other tag, and code/pre blocks (where custom emoji are not allowed) are left alone.
export function decorateHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  let skip = 0;
  return html
    .split(/(<tg-emoji\b[^>]*>.*?<\/tg-emoji>|<[^>]+>)/gsu)
    .map((part, i) => {
      if (i % 2 === 1) {
        if (/^<(code|pre)\b/i.test(part)) skip++;
        else if (/^<\/(code|pre)>/i.test(part)) skip = Math.max(0, skip - 1);
        return part;
      }
      if (skip) return part;
      return part.replace(TEXT_RE, (m, e) => `<tg-emoji emoji-id="${TEXT_MAP[e]}">${m}</tg-emoji>`);
    })
    .join('');
}

// Inline buttons can't hold <tg-emoji>, but they can show a premium icon
// (icon_custom_emoji_id). A label that starts with a mapped emoji, e.g.
// "⬅️ Back", becomes icon + "Back". Buttons that already have an icon are
// left alone.
const BTN_RE = new RegExp(`^(${Object.keys(TEXT_MAP).join('|')})\\uFE0F?\\s*`, 'u');
export function decorateKeyboard(markup) {
  const rows = markup?.inline_keyboard;
  if (!Array.isArray(rows)) return markup;
  let changed = false;
  const inline_keyboard = rows.map((row) => (Array.isArray(row) ? row.map((b) => {
    if (!b || typeof b.text !== 'string' || b.icon_custom_emoji_id) return b;
    const m = BTN_RE.exec(b.text);
    const text = m ? b.text.slice(m[0].length).trim() : '';
    if (!m || !text) return b; // emoji-only buttons keep their emoji
    changed = true;
    return { ...b, text, icon_custom_emoji_id: TEXT_MAP[m[1]] };
  }) : row));
  return changed ? { ...markup, inline_keyboard } : markup;
}

// grammY API transformer: decorate text/caption of every HTML message, and
// the leading emoji of every inline button.
export function premiumEmojiTransformer(prev, method, payload, signal) {
  if (payload && payload.parse_mode === 'HTML' && !payload.entities && !payload.caption_entities) {
    if (typeof payload.text === 'string') payload = { ...payload, text: decorateHtml(payload.text) };
    if (typeof payload.caption === 'string') payload = { ...payload, caption: decorateHtml(payload.caption) };
  }
  if (payload && payload.reply_markup?.inline_keyboard) {
    payload = { ...payload, reply_markup: decorateKeyboard(payload.reply_markup) };
  }
  return prev(method, payload, signal);
}