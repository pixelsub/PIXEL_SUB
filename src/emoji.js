// Telegram custom (premium) emoji.
//
// Fill CUSTOM_EMOJI with  name -> custom_emoji_id.  Get an id by sending a
// premium emoji to the bot and reading message.entities[].custom_emoji_id
// (the bot logs them via the /emojiid handler), or from a sticker pack's
// custom_emoji_id field.
//
// Until an id is filled in, every helper falls back to the plain emoji, so
// nothing breaks.
export const CUSTOM_EMOJI = {
  // shop: '5368324170671202286',
};

// Inline in HTML message text: ce('shop', '🛍️')
export function ce(name, fallback) {
  const id = CUSTOM_EMOJI[name];
  return id ? `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>` : fallback;
}

// On an InlineKeyboard button (shown before the label):
//   withIcon(kb.text('Shop', 'shop'), 'shop')
// Remove the plain emoji from the label when an icon is set.
export function withIcon(kb, name) {
  const id = CUSTOM_EMOJI[name];
  return id ? kb.icon(id) : kb;
}
