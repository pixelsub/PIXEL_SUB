import express from 'express';
import { emojiPlain } from '../../emoji.js';
import prisma from '../../db.js';
import config from '../../config.js';
import { requireAuth } from '../auth.js';
import { num } from '../../utils.js';
import { redeliverOrder, reconcileOrder } from '../../services/orders.js';
import * as nowpayments from '../../payments/nowpayments.js';

const router = express.Router();
router.use(requireAuth);

function serializeOrder(o, full = false) {
  const base = {
    id: o.id,
    publicId: o.publicId,
    status: o.status,
    method: o.method,
    amount: num(o.amount),
    currency: o.currency,
    payCurrency: o.payCurrency,
    payAmount: o.payAmount,
    network: o.network,
    invoiceUuid: o.invoiceUuid,
    paymentRef: o.paymentRef,
    payUrl: o.payUrl,
    createdAt: o.createdAt,
    paidAt: o.paidAt,
    deliveredAt: o.deliveredAt,
    expiresAt: o.expiresAt,
    user: o.user
      ? {
          id: o.user.id,
          telegramId: o.user.telegramId.toString(),
          username: o.user.username,
          firstName: o.user.firstName,
        }
      : null,
    items: (o.items || []).map((i) => ({
      id: i.id,
      productName: i.productName,
      emoji: emojiPlain(i.emoji),
      unitPrice: num(i.unitPrice),
      quantity: i.quantity,
      lineTotal: num(i.lineTotal),
      delivered: (i.stock || []).map((s) => s.content),
    })),
  };
  if (full && o.events) {
    base.events = o.events.map((e) => ({ type: e.type, message: e.message, createdAt: e.createdAt }));
  }
  return base;
}

// List orders with filters + pagination
router.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
  const status = req.query.status;
  const search = (req.query.search || '').toString().trim();

  const where = {};
  if (status && status !== 'ALL') where.status = status;
  if (search) {
    const M = config.database.searchMode;
    where.OR = [
      { publicId: { contains: search, mode: M } },
      { user: { username: { contains: search, mode: M } } },
    ];
    if (/^\d+$/.test(search)) {
      where.OR.push({ user: { telegramId: BigInt(search) } });
    }
  }

  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { user: true, items: { include: { stock: true } } },
    }),
  ]);

  res.json({
    total,
    page,
    pageSize,
    pages: Math.ceil(total / pageSize),
    orders: orders.map((o) => serializeOrder(o)),
  });
});

router.get('/:id', async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: Number(req.params.id) },
    include: {
      user: true,
      items: { include: { stock: true } },
      events: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ order: serializeOrder(order, true) });
});

// Force a status re-check against the payment provider. For NOWPayments the
// admin may pass the customer's Payment ID (shown on the NOWPayments page) when
// no IPN reached us; it is only accepted if that payment belongs to this order.
router.post('/:id/recheck', async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: Number(req.params.id) } });
  if (!order) return res.status(404).json({ error: 'Not found' });
  const paymentId = String(req.body?.paymentId ?? '').trim();
  if (paymentId && !/^\d{1,20}$/.test(paymentId)) return res.status(400).json({ error: 'Payment ID must be numeric' });
  const status = await reconcileOrder(order, paymentId ? { paymentId } : {});

  // When a NOWPayments order still isn't paid, tell the admin exactly why.
  let diagnosis;
  if (order.method === 'NOWPAYMENTS' && status !== 'PAID') {
    const pid = paymentId || order.paymentRef;
    if (!pid) {
      diagnosis = 'No Payment ID yet — enter the one shown on the customer\'s NOWPayments page.';
    } else {
      try {
        const p = await nowpayments.getPayment(pid);
        const reasons = [];
        if (String(p.order_id) !== String(order.invoiceOrderId)) reasons.push(`payment order_id "${p.order_id}" ≠ this order's "${order.invoiceOrderId}"`);
        if (!(Number(p.price_amount) >= num(order.amount) - 0.01)) reasons.push(`price ${p.price_amount} < order ${num(order.amount)}`);
        if (String(p.price_currency || '').toLowerCase() !== String(order.currency).toLowerCase()) reasons.push(`currency "${p.price_currency}" ≠ "${order.currency}"`);
        diagnosis = `NOWPayments says: status=${p.payment_status}, order_id=${p.order_id}, price=${p.price_amount} ${p.price_currency}, ` +
          `pay=${p.pay_amount} ${p.pay_currency}, paid=${p.actually_paid}` +
          (reasons.length ? ` — NOT accepted: ${reasons.join('; ')}` : '');
      } catch (e) {
        diagnosis = `Could not read payment ${pid} from NOWPayments: ${e.message}`;
      }
    }
  }
  res.json({ ok: true, status, diagnosis });
});

// Re-send delivery to the customer
router.post('/:id/redeliver', async (req, res) => {
  try {
    const result = await redeliverOrder(Number(req.params.id));
    res.json({ ok: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Mark refunded (manual — actual crypto refund done in Cryptomus dashboard)
router.post('/:id/refund', async (req, res) => {
  try {
    const order = await prisma.order.update({
      where: { id: Number(req.params.id) },
      data: { status: 'REFUNDED' },
    });
    await prisma.orderEvent.create({
      data: { orderId: order.id, type: 'note', message: 'Marked refunded by admin' },
    });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// Cancel a pending order
router.post('/:id/cancel', async (req, res) => {
  try {
    const order = await prisma.order.update({
      where: { id: Number(req.params.id) },
      data: { status: 'CANCELLED' },
    });
    await prisma.orderEvent.create({
      data: { orderId: order.id, type: 'cancelled', message: 'Cancelled by admin' },
    });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

export default router;
