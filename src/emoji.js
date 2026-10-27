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
