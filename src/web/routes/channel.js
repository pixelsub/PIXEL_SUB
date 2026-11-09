// Admin API for Telegram channel posting.
import express from 'express';
import prisma from '../../db.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { emojiPlain } from '../../emoji.js';
import { getAllSettings, setSettings } from '../../services/settings.js';
import { STOCK_COUNT, stockOf } from '../../services/stock.js';
import {
  normalizeChannelId, testConnection, postTestMessage, postDailyStock, postProduct,
  postPriceUpdate, postSoldOut, postCustom, deletePost, schedulerStatus, buildDailyStock,
} from '../../services/channel.js';

const router = express.Router();
router.use(requireAuth);

const KEYS = ['channel_id', 'channel_daily_enabled', 'channel_daily_time', 'channel_daily_show_soldout', 'channel_new_enabled', 'channel_daily_header', 'channel_footer'];

function fail(res, e) {
  const status = { bad_request: 400, not_found: 404, no_channel: 400, no_bot: 400, empty: 400, not_member: 400, duplicate: 409 }[e.code] || 502;
  res.status(status).json({ error: e.message, code: e.code || 'error' });
}

// Block accidental double clicks: same manual post within 30 seconds.
async function recentDuplicate(kind, productId) {
  return prisma.channelPost.findFirst({
    where: { kind, productId: productId ?? null, status: { in: ['pending', 'sent'] }, createdAt: { gte: new Date(Date.now() - 30_000) } },
  });
}

router.get('/', async (req, res) => {
  const s = await getAllSettings(true);
  const settings = Object.fromEntries(KEYS.map((k) => [k, s[k] ?? '']));
  const [posts, status] = await Promise.all([
    prisma.channelPost.findMany({ orderBy: { id: 'desc' }, take: 40 }),
    schedulerStatus(),
  ]);
  const names = new Map((await prisma.product.findMany({
    where: { id: { in: posts.map((p) => p.productId).filter(Boolean) } }, select: { id: true, name: true },
  })).map((p) => [p.id, p.name]));
  res.json({
    settings,
    status,
    posts: posts.map((p) => ({ ...p, productName: p.productId ? names.get(p.productId) || `#${p.productId}` : null })),
  });
});

router.put('/settings', async (req, res) => {
  const b = req.body || {};
  const out = {};
  if (b.channel_id !== undefined) {
    out.channel_id = normalizeChannelId(b.channel_id);
    if (b.channel_id && !out.channel_id) return res.status(400).json({ error: 'Channel must be @username, a t.me link, or a numeric id like -1001234567890' });
  }
  if (b.channel_daily_time !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.channel_daily_time).trim());
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return res.status(400).json({ error: 'Time must be HH:MM (24h), e.g. 10:00' });
    out.channel_daily_time = `${m[1].padStart(2, '0')}:${m[2]}`;
  }
  for (const k of ['channel_daily_enabled', 'channel_new_enabled', 'channel_daily_show_soldout']) {
    if (b[k] !== undefined) out[k] = b[k] === true || b[k] === 'true' ? 'true' : 'false';
  }
  for (const k of ['channel_daily_header', 'channel_footer']) {
    if (b[k] !== undefined) out[k] = String(b[k]).slice(0, 1000);
  }
  if (Object.keys(out).length) await setSettings(out);
  res.json({ ok: true, settings: out });
});

router.post('/test', async (req, res) => {
  try { res.json({ ok: true, ...(await testConnection(req.body?.channel_id)) }); }
  catch (e) { res.json({ ok: false, error: e.message, code: e.code }); }
});

router.post('/test-message', async (req, res) => {
  try { res.json({ ok: true, post: await postTestMessage(req.admin?.username) }); }
  catch (e) { fail(res, e); }
});

// Plain-text preview of today's stock post for the panel.
router.get('/preview/daily', async (req, res) => {
  const { text, count } = await buildDailyStock();
  res.json({ text, count });
});

// Products the channel can post about (same list the shop sells).
router.get('/products', async (req, res) => {
  const products = await prisma.product.findMany({
    where: { OR: [{ supplierId: null }, { supplierSelected: true }] },
    orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { id: 'asc' }],
    include: STOCK_COUNT,
  });
  res.json({
    products: products.map((p) => ({
      id: p.id, name: p.name, emoji: emojiPlain(p.emoji), price: num(p.price), isActive: p.isActive,
      stock: p.usesStock ? stockOf(p) : null,
    })),
  });
});

router.post('/post/daily', async (req, res) => {
  if (await recentDuplicate('daily_stock', null)) return res.status(409).json({ error: 'Today Stock was just posted — wait 30 seconds to post again.' });
  try { res.json({ ok: true, post: await postDailyStock({ createdBy: req.admin?.username || 'admin' }) }); }
  catch (e) { fail(res, e); }
});

router.post('/post/product', async (req, res) => {
  const productId = Number(req.body?.productId);
  const type = String(req.body?.type || 'product');
  if (!Number.isInteger(productId)) return res.status(400).json({ error: 'Choose a product' });
  const kind = { product: 'product', price_update: 'price_update', sold_out: 'sold_out' }[type];
  if (!kind) return res.status(400).json({ error: 'Unknown post type' });
  if (await recentDuplicate(kind, productId)) return res.status(409).json({ error: 'This was just posted — wait 30 seconds to post it again.' });
  const by = req.admin?.username || 'admin';
  try {
    const post = kind === 'price_update'
      ? await postPriceUpdate(productId, { oldPrice: req.body?.oldPrice, createdBy: by })
      : kind === 'sold_out'
        ? await postSoldOut(productId, { createdBy: by })
        : await postProduct(productId, { createdBy: by });
    res.json({ ok: true, post });
  } catch (e) { fail(res, e); }
});

router.post('/post/custom', async (req, res) => {
  const b = req.body || {};
  const recent = await prisma.channelPost.findFirst({
    where: { kind: 'custom', status: { in: ['pending', 'sent'] }, preview: String(b.text || '').trim().slice(0, 300), createdAt: { gte: new Date(Date.now() - 30_000) } },
  });
  if (recent) return res.status(409).json({ error: 'This message was just posted — wait 30 seconds to post it again.' });
  try {
    res.json({ ok: true, post: await postCustom({ text: b.text, shopButton: Boolean(b.shopButton), buttonText: b.buttonText, buttonUrl: b.buttonUrl, createdBy: req.admin?.username || 'admin' }) });
  } catch (e) { fail(res, e); }
});

router.post('/posts/:id/delete', async (req, res) => {
  try { res.json({ ok: true, ...(await deletePost(req.params.id)) }); }
  catch (e) { fail(res, e); }
});

export default router;
