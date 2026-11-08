// "Reseller API" section of the customer bot: resellers generate their own API
// key (linked to their Telegram account, so API orders spend their wallet
// balance) and read the docs for connecting their store.
import { InlineKeyboard } from 'grammy';
import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { money, num, escapeHtml } from '../utils.js';
import { generateApiKey } from '../services/api_keys.js';

const apiBase = () => `${config.publicUrl}/api/v1`;

// Stop a user hammering "Generate" — each press invalidates the previous key.
const GENERATE_COOLDOWN_MS = 30 * 1000;
const lastGenerated = new Map();

async function send(ctx, text, keyboard) {
  const opts = { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } };
  if (ctx.callbackQuery?.message) {
    try { await ctx.editMessageText(text, opts); return; }
    catch (e) { if (!String(e.description || e.message).includes('not modified')) await ctx.reply(text, opts).catch(() => {}); return; }
  }
  await ctx.reply(text, opts);
}

// A reseller has one key row; regenerating rotates it in place so their
// sales history in the admin panel stays on one record.
function findKey(userId) {
  return prisma.apiKey.findFirst({ where: { userId }, orderBy: { id: 'asc' } });
}

function keyName(from) {
  const who = from.username ? '@' + from.username : [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Reseller';
  return `${who} (${from.id})`.slice(0, 100);
}

export async function showResellerApi(ctx) {
  const [user, key] = await Promise.all([
    prisma.user.findUnique({ where: { id: ctx.dbUser.id } }),
    findKey(ctx.dbUser.id),
  ]);
  const sales = key
    ? await prisma.order.aggregate({ where: { apiKeyId: key.id, status: 'DELIVERED' }, _count: { _all: true }, _sum: { amount: true } })
    : null;

  let status;
  if (!key) status = '🔴 <b>No API key yet</b> — tap <b>Generate API Key</b> to get started.';
  else if (!key.isActive) status = '⛔ <b>Your API access is disabled.</b> Please contact support.';
  else {
    status =
      `🟢 <b>API key active</b>: <code>${escapeHtml(key.keyPrefix)}…</code>\n` +
      `🕒 Last used: ${key.lastUsedAt ? key.lastUsedAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}\n` +
      `🧾 API orders: <b>${sales._count._all}</b> (${money(num(sales._sum.amount))})`;
  }

  const text =
    `🔌 <b>Reseller API</b>\n\n` +
    `Connect your own store or website to our shop:\n` +
    `• Show our products with <b>live stock</b>\n` +
    `• Place orders automatically, paid from your <b>wallet balance</b>\n` +
    `• Get the codes/accounts instantly in the API response\n\n` +
    `${status}\n\n` +
    `💳 Wallet balance: <b>${money(num(user.balance))}</b>`;

  const kb = new InlineKeyboard();
  if (!key) kb.text('🔑 Generate API Key', 'rapi:gen').row();
  else if (key.isActive) kb.text('♻️ Regenerate API Key', 'rapi:regen').row();
  kb.text('📘 API Docs', 'rapi:docs').text('💻 Code Examples', 'rapi:ex').row();
  kb.text('💳 Top Up Balance', 'w:topup').row();
  kb.text('🏠 Main Menu', 'menu');
  await send(ctx, text, kb);
}

async function confirmRegenerate(ctx) {
  const text =
    `♻️ <b>Regenerate API key?</b>\n\n` +
    `Your current key will <b>stop working immediately</b>. You'll need to put the new key into your store.`;
  const kb = new InlineKeyboard()
    .text('✅ Yes, regenerate', 'rapi:gen').row()
    .text('⬅️ Back', 'rapi');
  await send(ctx, text, kb);
}

async function generateKey(ctx) {
  const uid = ctx.dbUser.id;
  const now = Date.now();
  const wait = GENERATE_COOLDOWN_MS - (now - (lastGenerated.get(uid) || 0));
  if (wait > 0) {
    await ctx.answerCallbackQuery({ text: `Please wait ${Math.ceil(wait / 1000)}s before generating again.`, show_alert: true }).catch(() => {});
    return;
  }

  const existing = await findKey(uid);
  if (existing && !existing.isActive) {
    // Disabled by the shop owner — a reseller must not be able to re-enable themselves.
    await ctx.answerCallbackQuery({ text: 'Your API access is disabled. Please contact support.', show_alert: true }).catch(() => {});
    return showResellerApi(ctx);
  }
  await ctx.answerCallbackQuery().catch(() => {});

  const { raw, hash, prefix } = generateApiKey();
  if (existing) {
    await prisma.apiKey.update({ where: { id: existing.id }, data: { keyHash: hash, keyPrefix: prefix, lastUsedAt: null } });
  } else {
    await prisma.apiKey.create({ data: { name: keyName(ctx.from), keyPrefix: prefix, keyHash: hash, userId: uid } });
  }
  lastGenerated.set(uid, now);
  logger.info({ userId: uid, rotated: Boolean(existing) }, 'reseller generated API key in bot');

  // Sent as its own message so it is easy to copy and can be deleted on its own.
  await ctx.reply(
    `🔑 <b>Your ${existing ? 'new ' : ''}API key</b>\n\n` +
      `<code>${escapeHtml(raw)}</code>\n\n` +
      `👆 Tap the key to copy it.\n\n` +
      `⚠️ <b>Keep it secret.</b> Anyone with this key can place orders with your balance. ` +
      `Use it only on your server — never in public website code.\n` +
      (existing ? `\nYour previous key no longer works.\n` : '') +
      `\nThis key is shown only once. Save it, then delete this message.`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard()
        .copyText('📋 Copy API Key', raw).row()
        .text("🗑 I've saved it — delete this message", 'rapi:del'),
    }
  );
  // Refresh the menu above so it shows the new key's status.
  await showResellerApi(ctx).catch(() => {});
}

function docsText() {
  const b = escapeHtml(apiBase());
  return (
    `📘 <b>Reseller API — Docs</b>\n\n` +
    `<b>Base URL</b>\n<code>${b}</code>\n\n` +
    `<b>Authentication</b>\nSend your key in every request header:\n<code>X-API-Key: YOUR_API_KEY</code>\n\n` +
    `<b>1. Products &amp; live stock</b>\n` +
    `<code>GET /products</code> — all products: <i>id, name, price, stock, inStock</i>\n` +
    `<code>GET /products/{id}</code> — one product\n` +
    `<code>GET /stock</code> — only stock: <code>{"5": 15, "8": 0}</code>\n` +
    `<i>stock = null means unlimited.</i>\n\n` +
    `<b>2. Wallet balance</b>\n<code>GET /balance</code>\n\n` +
    `<b>3. Place an order</b>\n<code>POST /orders</code>\n` +
    `<pre>{"productId": 5, "quantity": 1, "reference": "your-order-123"}</pre>` +
    `Paid from your balance. The codes/accounts are in <code>order.items[].delivered</code>.\n` +
    `<code>reference</code> = your own order id (optional). Sending the same reference again returns the same order — it is never charged twice.\n\n` +
    `<b>4. Order history</b>\n` +
    `<code>GET /orders</code> — your recent orders\n` +
    `<code>GET /orders/{id or reference}</code> — one order\n\n` +
    `<b>Errors</b>\n` +
    `401 wrong/disabled key · 402 low balance · 409 not enough stock · 404 product not found · 429 too many requests\n\n` +
    `<b>Tips</b>\n` +
    `• Limit: 120 requests/minute — refresh stock every 30–60 seconds.\n` +
    `• Call the API from your server, never from browser code.\n` +
    `• Keep enough balance — orders fail with 402 when it runs out.`
  );
}

function examplesText() {
  const base = apiBase();
  const curl =
    `# Products + live stock\n` +
    `curl -H "X-API-Key: YOUR_API_KEY" ${base}/products\n\n` +
    `# Buy 1 unit of product 5\n` +
    `curl -X POST ${base}/orders \\\n` +
    `  -H "X-API-Key: YOUR_API_KEY" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"productId":5,"quantity":1,"reference":"order-1001"}'`;
  const js =
    `const API = "${base}";\n` +
    `const KEY = process.env.PIXEL_API_KEY;\n\n` +
    `// Live stock for your store\n` +
    `const { products } = await fetch(API + "/products", {\n` +
    `  headers: { "X-API-Key": KEY },\n` +
    `}).then(r => r.json());\n\n` +
    `// When your customer pays, buy from us\n` +
    `const res = await fetch(API + "/orders", {\n` +
    `  method: "POST",\n` +
    `  headers: { "X-API-Key": KEY, "Content-Type": "application/json" },\n` +
    `  body: JSON.stringify({ productId: 5, quantity: 1, reference: "order-1001" }),\n` +
    `});\n` +
    `const data = await res.json();\n` +
    `if (res.ok) console.log(data.order.items[0].delivered); // the codes\n` +
    `else console.log(data.code, data.error); // e.g. INSUFFICIENT_BALANCE`;
  const php =
    `$ch = curl_init("${base}/orders");\n` +
    `curl_setopt_array($ch, [\n` +
    `  CURLOPT_POST => true,\n` +
    `  CURLOPT_RETURNTRANSFER => true,\n` +
    `  CURLOPT_HTTPHEADER => ["X-API-Key: YOUR_API_KEY", "Content-Type: application/json"],\n` +
    `  CURLOPT_POSTFIELDS => json_encode(["productId" => 5, "quantity" => 1, "reference" => "order-1001"]),\n` +
    `]);\n` +
    `$data = json_decode(curl_exec($ch), true);`;
  return (
    `💻 <b>Code Examples</b>\n\n` +
    `<b>cURL</b>\n<pre><code class="language-bash">${escapeHtml(curl)}</code></pre>\n` +
    `<b>JavaScript (Node.js)</b>\n<pre><code class="language-javascript">${escapeHtml(js)}</code></pre>\n` +
    `<b>PHP</b>\n<pre><code class="language-php">${escapeHtml(php)}</code></pre>\n` +
    `Replace <code>YOUR_API_KEY</code> with your key and <code>5</code> with a product id from <code>/products</code>.`
  );
}

const docsKeyboard = (other) => new InlineKeyboard()
  .text(other === 'ex' ? '💻 Code Examples' : '📘 API Docs', other === 'ex' ? 'rapi:ex' : 'rapi:docs').row()
  .text('⬅️ Reseller API', 'rapi').text('🏠 Menu', 'menu');

export function registerResellerHandlers(bot) {
  bot.command('api', showResellerApi);
  bot.callbackQuery('rapi', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await showResellerApi(ctx);
  });
  bot.callbackQuery('rapi:regen', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await confirmRegenerate(ctx);
  });
  bot.callbackQuery('rapi:gen', generateKey);
  bot.callbackQuery('rapi:docs', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await send(ctx, docsText(), docsKeyboard('ex'));
  });
  bot.callbackQuery('rapi:ex', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await send(ctx, examplesText(), docsKeyboard('docs'));
  });
  bot.callbackQuery('rapi:del', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Deleted' }).catch(() => {});
    await ctx.deleteMessage().catch(() => {});
  });
}
