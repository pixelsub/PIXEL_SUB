// Background loop for suppliers:
//  1. sync each active supplier's catalog, price and live stock
//  2. finish orders whose supplier purchase is still pending (timeout,
//     supplier processing, rate limit). Retrying is safe: the purchase reuses
//     the order line's Idempotency-Key, so the supplier never charges twice.
import prisma from '../db.js';
import logger from '../logger.js';
import { syncSupplier } from './index.js';
import { fulfillAndDeliver } from '../services/orders.js';
import { notifyAdmins } from '../bot/delivery.js';

const SYNC_EVERY_MS = Math.max(30, Number(process.env.SUPPLIER_SYNC_SECONDS) || 60) * 1000;
const PENDING_GIVE_UP_MS = 6 * 60 * 60 * 1000; // stop retrying (and alert) after 6h
const ALERT_AFTER_MS = 15 * 60 * 1000;

let timer = null;
let running = false;
const alerted = new Set();

export async function retryPendingSupplierOrders() {
  const candidates = await prisma.order.findMany({
    where: {
      status: 'PAID',
      createdAt: { gte: new Date(Date.now() - PENDING_GIVE_UP_MS) },
      events: { some: { type: 'supplier_pending' } },
    },
    include: { events: { orderBy: { id: 'desc' }, take: 1 } },
    take: 20,
  });
  let delivered = 0;
  for (const o of candidates) {
    // Only orders still waiting on the supplier — not ones that later failed
    // and were handed to an admin.
    if (o.events[0]?.type !== 'supplier_pending') continue;
    try {
      const r = await fulfillAndDeliver(o.id);
      if (r.delivered) delivered++;
      else if (r.reason === 'supplier_pending' && Date.now() - o.createdAt > ALERT_AFTER_MS && !alerted.has(o.id)) {
        alerted.add(o.id);
        await notifyAdmins(`⏳ <b>Order ${o.publicId}</b> has been waiting on the supplier for over 15 minutes. It is retried automatically every minute.`).catch(() => {});
      }
    } catch (e) {
      logger.warn({ err: e.message, order: o.publicId }, 'supplier pending retry failed');
    }
  }
  return delivered;
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const suppliers = await prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true } });
    for (const s of suppliers) {
      try {
        await syncSupplier(s.id);
      } catch (e) {
        logger.warn({ err: e.message, code: e.code, supplier: s.name }, 'supplier sync failed');
      }
    }
    await retryPendingSupplierOrders();
  } catch (e) {
    logger.error({ err: e.message }, 'supplier worker tick error');
  } finally {
    running = false;
  }
}

export function startSupplierWorker() {
  logger.info({ everySec: SYNC_EVERY_MS / 1000 }, 'Starting supplier sync worker');
  timer = setInterval(tick, SYNC_EVERY_MS);
  setTimeout(tick, 8000);
}

export function stopSupplierWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
