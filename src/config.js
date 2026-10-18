'use strict';

/**
 * Централізована конфігурація.
 * Усі значення читаються тут, решта коду не звертається до process.env напряму.
 */

const path = require('path');
const fs = require('fs');

// .env підтримується, але не є обов'язковим (у Docker змінні приходять з оточення)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv не встановлено — працюємо лише з process.env
}

const ROOT = path.resolve(__dirname, '..');
const IS_PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, 'database.sqlite');

const PORT = Number(process.env.PORT || 3000);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'tt_sid';

const LIMITS = {
  json: '1mb',
  bulkImport: '5mb',
  bulkImportText: 3 * 1024 * 1024,
  recordsAll: 50000,
  reportRecords: 20000,
  unassignedPreview: 200,
  pageSize: 500,
  bulkReportIds: 1000,
  trackBatch: 50
};

/**
 * Підкладка карти.
 *
 * За замовчуванням працює онлайн-режим: сервер сам тягне потрібні тайли
 * з публічного PMTiles-архіву Protomaps (по HTTP Range) і кешує їх на диску.
 * Локальний файл `public/tiles/region.pmtiles` (якщо є) має приоритет —
 * це офлайн-режим без інтернету.
 */
const MAP = {
  enabled: process.env.MAP_TILES !== '0',
  // Пряме посилання на архів; порожнє — беремо найсвіжішу збірку Protomaps
  archiveUrl: process.env.MAP_TILES_URL || '',
  buildBase: process.env.MAP_BUILD_BASE || 'https://build.protomaps.com',
  // Скільки днів назад шукати збірку, якщо сьогоднішньої ще немає
  buildLookbackDays: Number(process.env.MAP_BUILD_LOOKBACK || 5),
  maxZoom: Number(process.env.MAP_MAX_ZOOM || 14),
  // Скільки тайлів дозволено прогрівати одним запитом prefetch
  prefetchLimit: Number(process.env.MAP_PREFETCH_LIMIT || 400),
  // Скільки тайлів максимум на один прогрів ділянки рейсу (визначає зум)
  warmMaxTiles: Number(process.env.MAP_WARM_TILES || 160),
  // Скільки запитів до архіву тримаємо одночасно (решта чекає в черзі)
  concurrency: Number(process.env.MAP_CONCURRENCY || 8),
  cacheDir: process.env.MAP_CACHE_DIR
    ? path.resolve(process.env.MAP_CACHE_DIR)
    : path.join(DATA_DIR, 'tilecache'),
  // Локальний region.pmtiles має приоритет; MAP_LOCAL_TILES=0 змушує онлайн-режим
  preferLocal: process.env.MAP_LOCAL_TILES !== '0',
  // У тестах і з MAP_TILES_NETWORK=0 сервер у мережу не ходить зовсім
  allowNetwork: process.env.MAP_TILES_NETWORK !== '0' && process.env.NODE_ENV !== 'test',

  // --- Супутникова підкладка (Esri World Imagery) -------------------------
  // Вмикається перемикачем «Схема / Супутник» на карті рейсу.
  satellite: process.env.MAP_SATELLITE !== '0',
  // Шаблон тайла. Порядок саме z/y/x — це схема Esri, а не slippy-карт.
  satelliteUrl: process.env.MAP_SATELLITE_URL || '',
  // Ключ ArcGIS Location Platform. Порожній — працюємо з публічного хоста
  // Esri (без ключа); з ключем ідемо на ліцензований basemaps-api.
  satelliteToken: process.env.MAP_SATELLITE_TOKEN || '',
  satelliteMaxZoom: Number(process.env.MAP_SATELLITE_MAX_ZOOM || 19),
  // Esri віддає Cache-Control: max-age=86400, тому більше за добу не тримаємо.
  satelliteTtlMs: Number(process.env.MAP_SATELLITE_TTL || 86400) * 1000,
  // Скільки діб тайл лежить на диску, перш ніж його прибере прибирання.
  // Без цього кеш росте безмежно: ~21 КБ на тайл, сотні мегабайт на рік.
  satelliteCacheDays: Number(process.env.MAP_SATELLITE_CACHE_DAYS || 7),
  satelliteConcurrency: Number(process.env.MAP_SATELLITE_CONCURRENCY || 6)
};

function resolveAdminPassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length >= 6) return fromEnv;

  if (IS_PROD) {
    throw new Error('ADMIN_PASSWORD не задано або коротший за 6 символів — запуск неможливий');
  }
  return 'admin123';
}

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
  ROOT,
  IS_PROD,
  DATA_DIR,
  DB_PATH,
  PORT,
  SESSION_TTL_MS,
  SESSION_TOUCH_MS,
  COOKIE_NAME,
  LIMITS,
  MAP,
  ensureDataDir,
  resolveAdminPassword
};
