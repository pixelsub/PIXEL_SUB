import crypto from 'node:crypto';
import express from 'express';
import { syncSupplier } from '../../suppliers/index.js';
import prisma from '../../db.js';
import logger from '../../logger.js';
import { verifyWebhookSignature } from '../../payments/cryptomus.js';
import { verifyIpnSignature } from '../../payments/nowpayments.js';
import { reconcileOrder } from '../../services/orders.js';

const router = express.Router();

// Cryptomus payment callback. We ALWAYS re-verify the real status via the API
// inside reconcileOrder(), so a spoofed webhook cannot trigger delivery.
router.post('/cryptomus', async (req, res) => {
  const body = req.body || {};
  const sigOk = verifyWebhookSignature(body);
  if (!sigOk) {
    logger.warn({ order_id: body.order_id, uuid: body.uuid }, 'webhook signature check failed (will still verify via API)');
  }

  // Ack fast so Cryptomus doesn't retry storm; do the work but keep it quick.
  try {
    const order = await prisma.order.findFirst({
      where: {
        OR: [
          body.order_id ? { invoiceOrderId: String(body.order_id) } : undefined,
          body.uuid ? { invoiceUuid: String(body.uuid) } : undefined,
        ].filter(Boolean),
      },
    });

    if (!order) {
      logger.warn({ order_id: body.order_id, uuid: body.uuid }, 'webhook: order not found');
      return res.status(200).json({ ok: true, note: 'order not found' });
    }

    // Authoritative re-check + deliver if paid.
    const status = await reconcileOrder(order);
    logger.info({ order: order.publicId, status }, 'webhook processed');
    return res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'webhook processing error');
    // Return 200 anyway; the poller will catch it on the next tick.
    return res.status(200).json({ ok: true, note: 'deferred to poller' });
  }
});

// NOWPayments IPN callback. The signature is a first-line filter only, like
// Cryptomus: a real payment once went undelivered because the signer's JSON
// serialization differed from ours. Delivery is decided solely by
// reconcileOrder() re-reading the payment from the NOWPayments API, which
// requires that payment to carry THIS order's order_id and full price — so a
// forged IPN can at worst trigger a harmless lookup.
router.post('/nowpayments', async (req, res) => {
  const body = req.body || {};
  if (!body.order_id || !body.payment_id) return res.status(400).json({ ok: false });
  const sigOk = verifyIpnSignature(body, req.get('x-nowpayments-sig'));
  if (!sigOk) {
    logger.warn({ order_id: body.order_id, payment_id: body.payment_id }, 'NOWPayments IPN signature check failed (will still verify via API)');
  }

  try {
    const order = body.order_id
      ? await prisma.order.findFirst({ where: { invoiceOrderId: String(body.order_id), method: 'NOWPAYMENTS' } })
      : null;
    if (!order) {
      logger.warn({ order_id: body.order_id, payment_id: body.payment_id }, 'NOWPayments IPN: order not found');
      return res.status(200).json({ ok: true, note: 'order not found' });
    }
    const status = await reconcileOrder(order, { paymentId: body.payment_id ? String(body.payment_id) : undefined });
    logger.info({ order: order.publicId, ipnStatus: body.payment_status, status }, 'NOWPayments IPN processed');
    return res.status(200).json({ ok: true });
  } catch (e) {
    logger.error({ err: e.message }, 'NOWPayments IPN processing error');
    // 500 so NOWPayments retries; the stored paymentRef also lets the poller catch it.
    return res.status(500).json({ ok: false });
  }
});

// Hangout restock webhook. Set it up by sending `/api webhook <PUBLIC_URL>/api/webhook/hangout`
// to @hangoutrobot, then put the signing key it gives you in HANGOUT_WEBHOOK_SECRET.
// The payload is never trusted for data: a verified event only triggers a fresh
// sync of the Hangout supplier(s), and syncSupplier announces anything that
// went from 0 to in stock to all users.
const MAX_SKEW_MS = 5 * 60 * 1000;
const seenEvents = new Map(); // event id -> ts (deliveries can be retried)

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

router.post('/hangout', async (req, res) => {
  const secret = process.env.HANGOUT_WEBHOOK_SECRET || '';
  if (!secret) return res.status(503).json({ ok: false, error: 'webhook secret not configured' });

  const eventId = String(req.get('x-hangout-event-id') || '');
  const timestamp = String(req.get('x-hangout-timestamp') || '');
  const signature = String(req.get('x-hangout-signature') || '').replace(/^sha256=/i, '');
  const raw = req.rawBody;
  if (!eventId || !timestamp || !signature || !raw) return res.status(400).json({ ok: false });

  let tsMs = Number(timestamp);
  if (!Number.isFinite(tsMs)) tsMs = Date.parse(timestamp);
  if (tsMs < 1e12) tsMs *= 1000; // seconds -> ms
  if (!Number.isFinite(tsMs) || Math.abs(Date.now() - tsMs) > MAX_SKEW_MS) {
    return res.status(401).json({ ok: false, error: 'stale timestamp' });
  }

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${eventId}.`).update(raw).digest('hex');
  if (!safeEqualHex(expected, signature.toLowerCase())) {
    logger.warn({ eventId }, 'hangout webhook signature mismatch');
    return res.status(401).json({ ok: false, error: 'bad signature' });
  }

  // Dedupe by event id, then ack with 2xx straight away.
  const now = Date.now();
  for (const [id, ts] of seenEvents) if (now - ts > 60 * 60 * 1000) seenEvents.delete(id);
  if (seenEvents.has(eventId)) return res.status(200).json({ ok: true, duplicate: true });
  seenEvents.set(eventId, now);
  res.status(200).json({ ok: true });

  try {
    const suppliers = await prisma.supplier.findMany({ where: { isActive: true, type: 'hangout' }, select: { id: true } });
    for (const s of suppliers) {
      await syncSupplier(s.id).catch((e) => logger.warn({ err: e.message }, 'hangout webhook sync failed'));
    }
    logger.info({ eventId, suppliers: suppliers.length }, 'hangout restock webhook processed');
  } catch (e) {
    logger.error({ err: e.message }, 'hangout webhook processing error');
  }
});

export default router;
