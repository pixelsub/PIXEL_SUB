import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import logger from '../logger.js';

import webhookRoutes from './routes/webhook.js';
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import productRoutes from './routes/products.js';
import stockRoutes from './routes/stock.js';
import orderRoutes from './routes/orders.js';
import userRoutes from './routes/users.js';
import referralRoutes from './routes/referrals.js';
import settingsRoutes from './routes/settings.js';
import broadcastRoutes from './routes/broadcast.js';
import apiKeyRoutes from './routes/api_keys.js';
import publicApiRoutes from './routes/public_api.js';
import supplierRoutes from './routes/suppliers.js';
import channelRoutes from './routes/channel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../../public');

export function createServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Health check (Railway pings this)
  app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

  // Payment webhook (no auth; verified internally)
  app.use('/api/webhook', webhookRoutes);

  // Admin API
  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/products', productRoutes);
  app.use('/api/stock', stockRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/referrals', referralRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/broadcast', broadcastRoutes);
  app.use('/api/api-keys', apiKeyRoutes);
  app.use('/api/suppliers', supplierRoutes);
  app.use('/api/channel', channelRoutes);

  // Public reseller API (API-key auth, read-only catalog + live stock)
  app.use('/api/v1', publicApiRoutes);

  // Static admin panel
  app.use(express.static(publicDir, { extensions: ['html'] }));

  // SPA fallback -> index.html (admin panel handles its own routing)
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // JSON error handler
  app.use((err, req, res, next) => {
    logger.error({ err: err.message, path: req.path }, 'unhandled route error');
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export function startServer() {
  const app = createServer();
  return new Promise((resolve) => {
    const server = app.listen(config.port, () => {
      logger.info({ port: config.port, publicUrl: config.publicUrl }, 'Web server + admin panel listening');
      resolve(server);
    });
  });
}
