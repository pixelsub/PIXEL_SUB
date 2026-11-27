import prisma from '../db.js';
import config from '../config.js';
import logger from '../logger.js';
import { reconcileOrder, expireStaleOrders } from '../services/orders.js';
import { isConfigured as cryptomusConfigured } from './cryptomus.js';
import { isConfigured as nowpaymentsConfigured } from './nowpayments.js';

let timer = null;
let running = false;

// Reconcile every PENDING order against Cryptomus. This is the safety net that
// guarantees payments are detected even if a webhook is missed or delayed.
async function tick() {
  if (running) return;
  running = true;
  try {
    await expireStaleOrders();

    // Only hosted-invoice orders can be reconciled by API. NOWPayments ones need
    // the payment_id the first IPN gave us (paymentRef) before they can be read.
    const or = [];
    if (cryptomusConfigured()) or.push({ method: 'CRYPTOMUS', invoiceUuid: { not: null } });
    if (nowpaymentsConfigured()) or.push({ method: 'NOWPAYMENTS', paymentRef: { not: null } });
    if (!or.length) return;
    const pending = await prisma.order.findMany({
      where: { status: 'PENDING', OR: or },
      orderBy: { createdAt: 'asc' },
      take: 40, // cap work per tick
    });

    if (pending.length) {
      logger.debug({ count: pending.length }, 'poller: reconciling pending orders');
    }
    for (const order of pending) {
      try {
        await reconcileOrder(order);
      } catch (e) {
        logger.warn({ err: e.message, order: order.publicId }, 'poller: reconcile failed');
      }
    }
  } catch (e) {
    logger.error({ err: e.message }, 'poller tick error');
  } finally {
    running = false;
  }
}

export function startPoller() {
  if (!cryptomusConfigured() && !nowpaymentsConfigured()) {
    logger.warn('No crypto provider configured — payment poller disabled.');
    return;
  }
  const intervalMs = Math.max(15, config.shop.pollIntervalSec) * 1000;
  logger.info({ everySec: intervalMs / 1000 }, 'Starting payment poller');
  timer = setInterval(tick, intervalMs);
  // Kick one off shortly after boot.
  setTimeout(tick, 5000);
}

export function stopPoller() {
  if (timer) clearInterval(timer);
  timer = null;
}
