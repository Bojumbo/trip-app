'use strict';

const express = require('express');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { ApiError } = require('./lib/errors');
const { securityHeaders, csrfGuard, requestLogger, resolveTrustProxy } = require('./lib/security');
const { createLimiter } = require('./lib/rate-limit');
const { authMiddleware } = require('./lib/sessions');
const { createAuthRoutes } = require('./routes/auth');

const { router: metaRoutes, publicTilesRouter } = require('./routes/meta');
const tripsRoutes = require('./routes/trips');
const deliveriesRoutes = require('./routes/deliveries');
const recordsRoutes = require('./routes/records');
const reportRoutes = require('./routes/report');
const devicesRoutes = require('./routes/devices');
const trackRoutes = require('./routes/track');

/**
 * Збирає Express-застосунок. Не запускає сервер — це робить server.js,
 * завдяки чому застосунок можна підняти в тестах на випадковому порту.
 *
 * @param {{ adminPassword?: string }} [options]
 */
function createApp(options = {}) {
  const adminPassword = options.adminPassword || config.resolveAdminPassword();
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', resolveTrustProxy());

  app.use(securityHeaders);
  app.use(requestLogger);

  // Розбір тіла: імпорт має власний (більший) ліміт, тому для нього пропускаємо
  const jsonParser = express.json({ limit: config.LIMITS.json });
  app.use((req, res, next) => {
    if (req.path === '/api/records/bulk-import') return next();
    return jsonParser(req, res, next);
  });

  // --- Публічні ендпоінти ---
  app.get('/api/health', (req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
    } catch {
      res.status(503).json({ status: 'error' });
    }
  });

  app.use('/api', createAuthRoutes({ adminPassword }));

  // --- Далі все під авторизацією ---
  const apiLimiter = createLimiter({
    windowMs: 60 * 1000,
    max: 600,
    blockMs: 60 * 1000,
    message: 'Перевищено ліміт запитів. Спробуйте за хвилину.'
  });

  app.use('/api', publicTilesRouter);   // без авторизації: наявність офлайн-карти
  app.use('/api', apiLimiter, csrfGuard, authMiddleware);

  app.use('/api', metaRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/trips', tripsRoutes);
  app.use('/api/deliveries', deliveriesRoutes);
  app.use('/api/records', recordsRoutes);
  app.use('/api/report', reportRoutes);
  app.use('/api/track', trackRoutes);

  // --- Статика ---
  const publicDir = path.join(config.ROOT, 'public');
  app.use(express.static(publicDir, { etag: true, maxAge: 0 }));

  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // --- 404 ---
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Ендпоінт не знайдено' });
    }
    res.status(404).sendFile(path.join(publicDir, 'index.html'));
  });

  // --- Обробник помилок ---
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: err.message });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Некоректний JSON у запиті' });
    }
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Запит завеликий' });
    }

    logger.error('unhandled_error', {
      path: req.path,
      method: req.method,
      error: err && err.message,
      stack: err && err.stack
    });
    res.status(500).json({ error: 'Внутрішня помилка сервера' });
  });

  return app;
}

module.exports = { createApp };
