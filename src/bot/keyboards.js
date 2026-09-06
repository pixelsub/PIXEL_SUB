import { InlineKeyboard } from 'grammy';
import { money, num } from '../utils.js';
import config from '../config.js';

const cryptomusConfigured = () => Boolean(config.cryptomus.merchantId && config.cryptomus.paymentKey);

export function mainMenuKeyboard(isAdmin = false) {
  const kb = new InlineKeyboard()
    .text('🛍️ Shop', 'shop')
    .row()
    .text('📦 My Orders', 'orders')
    .text('💰 Wallet', 'balance')
    .row()
    .text('💬 Support', 'support')
    .text('ℹ️ FAQ', 'faq');
  if (isAdmin) kb.row().text('🛠️ Admin Panel', 'a:menu');
  return kb;
}

// Product list: one per row. Telegram cannot colour a button, so stock state
// is carried by a marker and by position — sold-out items sort to the bottom
// in getActiveProducts, so the first thing a customer meets is buyable.
export function shopKeyboard(products) {
  const kb = new InlineKeyboard();
  for (const p of products) {
    const available = !p.usesStock || p.available > 0;
    const tail = !p.usesStock
      ? '♾️'
      : available
        ? `📦 ${p.available}`
        : 'Out of stock';
    const mark = available ? '' : '❌ ';
    kb.text(`${mark}${p.emoji} ${p.name} | ${money(num(p.price))} | ${tail}`, `p:${p.id}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

// Quantities offered as one-tap buttons. Anything else is typed in via Custom.
const QTY_PRESETS = [1, 2, 3, 5];

// Step 1 of checkout: pick how many. Tapping a quantity moves on to the
// payment step rather than re-rendering this page, so the two decisions stay
// separate and the keyboard never gets long enough to scroll.
export function qtyKeyboard(product, maxQty) {
  const kb = new InlineKeyboard();
  // A preset above maxQty would only earn an "only N left" error at
  // checkout, so it is never offered.
  const presets = QTY_PRESETS.filter((n) => n <= maxQty);
  for (const n of presets) kb.text(String(n), `q:${product.id}:${n}`);
  kb.row();
  // Skip Custom when the presets already cover every buyable quantity
  // (maxQty 3 or less), since there would be nothing left to type.
  if (presets.length !== maxQty) kb.text('✏️ Custom', `qc:${product.id}`).row();
  kb.text('⬅️ Back to Shop', 'shop').text('🏠 Menu', 'menu');
  return kb;
}

// Step 2 of checkout: one row per payment method, priced for the chosen qty.
export function paymentKeyboard(product, qty, maxQty, opts = {}) {
  const kb = new InlineKeyboard();
  const total = num(product.price) * qty;
  // Only show Crypto when Cryptomus is fully configured. "(Auto)" is not
  // decoration — it appears only where payment truly confirms itself.
  if (cryptomusConfigured()) {
    kb.text(`💎 Pay ${money(total)} with Crypto ⚡ (Auto)`, `checkout:${product.id}:${qty}`).row();
  }
  // One button per manually-verified method (Binance, Bybit, …).
  for (const m of config.manualMethods) {
    const auto = m.key === 'BINANCE' && config.binanceAutoVerify;
    const label = auto
      ? `${m.emoji} Pay ${money(total)} with ${m.label} ⚡ (Auto)`
      : `${m.emoji} Pay ${money(total)} with ${m.label}`;
    kb.text(label, `mchk:${m.key}:${product.id}:${qty}`).row();
  }
  // Offer wallet payment when the customer has enough balance.
  if (opts.balance !== undefined && opts.balance >= total) {
    kb.text(`💰 Pay ${money(total)} with Balance`, `paybal:${product.id}:${qty}`).row();
  }
  // The quantity control lives here rather than on its own screen, so the
  // common case (one unit) costs no extra tap. Doubles as a readout.
  if (maxQty > 1) kb.text(`🔢 Quantity: ${qty} — tap to change`, `pq:${product.id}`).row();
  kb.text('⬅️ Back to Shop', 'shop').text('🏠 Menu', 'menu');
  return kb;
}

// Shown after a manually-verified order is created.
export function manualPayKeyboard(order, { autoVerify = false, payId = '', idLabel = 'ID' } = {}) {
  const kb = new InlineKeyboard();
  // Telegram's copy_text button puts the id straight on the clipboard, so the
  // customer never has to select it by hand on a phone.
  if (payId) kb.copyText(`📋 Copy ${idLabel}`, String(payId)).row();
  if (autoVerify) {
    // The prompt is already armed — this only re-arms it if they navigated away.
    kb.text('🧾 Paste Transaction ID', `mpaid:${order.id}`).row();
  } else {
    kb.text("✅ I've Paid — Notify Admin", `mpaid:${order.id}`).row();
  }
  kb.text('❌ Cancel Order', `mcancel:${order.id}`).text('🏠 Menu', 'menu');
  return kb;
}

// Older name kept for any remaining importer.
export const binancePayKeyboard = manualPayKeyboard;

// After an invoice is created
export function payKeyboard(order) {
  const kb = new InlineKeyboard();
  if (order.payUrl) kb.url('💎 Pay Now', order.payUrl).row();
  kb.text('🔄 Check Payment Status', `check:${order.id}`).row();
  kb.text('❌ Cancel Order', `cancel:${order.id}`).text('🏠 Menu', 'menu');
  return kb;
}

export function ordersKeyboard(orders) {
  const kb = new InlineKeyboard();
  for (const o of orders) {
    const emoji = statusEmoji(o.status);
    kb.text(`${emoji} ${o.publicId} — ${money(num(o.amount), o.currency)}`, `order:${o.id}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

export function orderDetailKeyboard(order) {
  const kb = new InlineKeyboard();
  if (order.status === 'PENDING' && order.payUrl) {
    kb.url('💎 Pay Now', order.payUrl).row();
  kb.text('🔄 Check Payment Status', `check:${order.id}`).row();
  }
  kb.text('⬅️ My Orders', 'orders').text('🏠 Menu', 'menu');
  return kb;
}

export function backMenuKeyboard() {
  return new InlineKeyboard().text('🏠 Main Menu', 'menu');
}

// Shown while the customer is typing a custom quantity.
export function qtyPromptKeyboard(productId) {
  return new InlineKeyboard().text('⬅️ Back', `pq:${productId}`).text('🏠 Menu', 'menu');
}
export function supportKeyboard() {
  const kb = new InlineKeyboard();
  if (config.telegram.supportTelegramId) {
    kb.url('💬 Contact Support', `tg://user?id=${config.telegram.supportTelegramId}`).row();
  } else if (config.telegram.supportUsername) {
    kb.url('💬 Chat with Admin', `https://t.me/${config.telegram.supportUsername}`).row();
  }
  if (config.telegram.whatsapp) {
    kb.url('📱 WhatsApp Admin', `https://wa.me/${config.telegram.whatsapp}`).row();
  }
  kb.text('🏠 Main Menu', 'menu');
  return kb;
}

export function statusEmoji(status) {
  return (
    {
      PENDING: '⏳',
      PAID: '💵',
      DELIVERED: '✅',
      CANCELLED: '❌',
      EXPIRED: '⌛',
      REFUNDED: '↩️',
      FAILED: '⚠️',
    }[status] || '•'
  );
}
