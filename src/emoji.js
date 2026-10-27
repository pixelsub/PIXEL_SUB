import { escapeHtml } from './utils.js';

// A product/category "emoji" column holds either a plain emoji ("🎨") or a
// Telegram custom (premium) emoji stored as "<fallback>|<custom_emoji_id>".
// Admins set the latter by sending a premium emoji to the bot; no migration is
// needed because it is still just a string.
const SEP = '|';

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
