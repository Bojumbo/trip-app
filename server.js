'use strict';

/**
 * Точка входу. Уся логіка — у src/.
 */

const config = require('./src/config');
const logger = require('./src/logger');
const db = require('./src/db');
const { createApp } = require('./src/app');
const { cleanupExpiredSessions } = require('./src/lib/sessions');
const mapTiles = require('./src/services/map-tiles');

let adminPassword;
try {
  adminPassword = config.resolveAdminPassword();
  if (!process.env.ADMIN_PASSWORD && !config.IS_PROD) {
    logger.warn('ADMIN_PASSWORD не задано. Використовується тимчасовий пароль "admin123" (лише для розробки).');
  }
} catch (e) {
  logger.error('startup_failed', { error: e.message });
  process.exit(1);
}

const app = createApp({ adminPassword });

const server = app.listen(config.PORT, '0.0.0.0', () => {
  logger.info('server_started', {
    port: config.PORT,
    env: config.IS_PROD ? 'production' : 'development',
    db: config.DB_PATH
  });

  // Підкладка карти: шукаємо архів Protomaps заздалегідь, щоб перший тайл
  // не чекав на це. Якщо мережі немає — просто лишиться error у /api/tiles.
  mapTiles.warmUp();
});

// Прибирання прострочених сесій раз на годину
const cleanupTimer = setInterval(() => {
  try {
    const removed = cleanupExpiredSessions();
    if (removed > 0) logger.info('sessions_cleaned', { removed });
  } catch (e) {
    logger.error('session_cleanup_failed', { error: e.message });
  }
}, 60 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutdown_started', { signal });

  const forceTimer = setTimeout(() => {
    logger.warn('shutdown_forced');
    process.exit(1);
  }, 10000);
  if (forceTimer.unref) forceTimer.unref();

  server.close(() => {
    try {
      db.close();
      logger.info('shutdown_complete');
    } catch (e) {
      logger.error('db_close_failed', { error: e.message });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
