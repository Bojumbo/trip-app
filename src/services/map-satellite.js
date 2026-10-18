'use strict';

/**
 * Супутникова підкладка (Esri World Imagery) через власний проксі.
 *
 * Навіщо проксі, а не пряме посилання в браузер:
 *   1. CSP лишається `connect-src 'self'` — жодних зовнішніх хостів у політиці;
 *   2. IP водія та його маршрут не потрапляють до Esri (у мережу ходить сервер);
 *   3. можемо шанувати `Cache-Control`, який віддає джерело.
 *
 * Про кеш. Esri відповідає `Cache-Control: max-age=86400`, тобто сам дозволяє
 * добове зберігання. Довше не тримаємо — це вже була б наша вигадка, а не їхні
 * умови. Прострочений тайл віддаємо лише тоді, коли свіжий узяти не вдалося:
 * краще трохи стара зйомка, ніж сіра діра замість неї.
 *
 * Нічого не кидає назовні: супутник — необов'язкова прикраса, а не основа.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const config = require('../config');
const logger = require('../logger');

const { MAP } = config;

/** Скільки живе підрахунок файлів у кеші (readdir по тисячах тек не безкоштовний). */
const COUNT_TTL_MS = 60 * 1000;
/** Таймаут на один тайл: 12 с — водій не має чекати вічність. */
const FETCH_TIMEOUT_MS = 12000;
/** Як часто прибираємо старі тайли (не на кожен запит — це обхід диска). */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const inflight = new Map();
let active = 0;
const waiting = [];

let cachedCount = 0;
let countedAt = 0;

/** Публічний хост Esri, коли ключа немає. */
const PUBLIC_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/'
  + 'World_Imagery/MapServer/tile/{z}/{y}/{x}';

/** Ліцензований хост ArcGIS Location Platform, коли ключ є. */
const KEYED_URL = 'https://basemaps-api.arcgis.com/arcgis/rest/services/'
  + 'World_Imagery/MapServer/tile/{z}/{y}/{x}';

function isEnabled() {
  return Boolean(MAP.satellite && MAP.allowNetwork);
}

/** Шаблон апстрім-адреси з урахуванням ключа. */
function upstreamTemplate() {
  if (MAP.satelliteUrl) return MAP.satelliteUrl;
  return MAP.satelliteToken ? KEYED_URL : PUBLIC_URL;
}

/**
 * Адреса тайла в Esri. Порядок саме z/y/x — це їхня схема.
 * Винесено окремо, щоб можна було перевірити тестом без мережі.
 */
function buildUpstreamUrl(z, x, y) {
  let url = upstreamTemplate()
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));

  if (MAP.satelliteToken) {
    url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(MAP.satelliteToken);
  }
  return url;
}

function tilePath(z, x, y) {
  return path.join(MAP.cacheDir, 'satellite', String(z), String(x), `${y}.jpg`);
}

/** Обмежувач одночасних запитів до Esri. */
function acquire() {
  if (active < MAP.satelliteConcurrency) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/** Читає файл із кешу; повертає вік у мс або null. */
async function readCached(file) {
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size < 128) return null;
    return { data: await fsp.readFile(file), ageMs: Date.now() - stat.mtimeMs };
  } catch {
    return null;
  }
}

async function fetchUpstream(z, x, y) {
  const url = buildUpstreamUrl(z, x, y);
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Esri ${res.status}`);
  }

  // Захист від HTML-сторінки помилки замість знімка.
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) {
    throw new Error(`не зображення (${type || 'без типу'})`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 128) throw new Error('порожній тайл');
  return { data: buf, contentType: type.split(';')[0] };
}

/**
 * Тайл супутника. Повертає { data, contentType } або null.
 * Ніколи не кидає — помилка означає «покажи що є».
 */
async function getTile(z, x, y) {
  if (!isEnabled()) return null;

  // Прибирання — у фоні й не частіше ніж раз на 6 годин, тож на швидкість
  // відповіді не впливає.
  pruneCache();

  const file = tilePath(z, x, y);
  const cached = await readCached(file);

  if (cached && cached.ageMs < MAP.satelliteTtlMs) {
    return { data: cached.data, contentType: 'image/jpeg' };
  }

  const key = `${z}/${x}/${y}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    await acquire();
    let fresh;
    try {
      fresh = await fetchUpstream(z, x, y);
    } finally {
      release();
    }

    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, fresh.data);
    if (!cached) cachedCount++;
    return fresh;
  })()
    .catch((e) => {
      logger.warn('satellite_tile_failed', { z, x, y, error: e.message });
      // Свіжий не приїхав — віддаємо прострочений, якщо він є.
      return cached ? { data: cached.data, contentType: 'image/jpeg' } : null;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

async function countCached() {
  if (countedAt && Date.now() - countedAt < COUNT_TTL_MS) return cachedCount;

  let count = 0;
  try {
    const files = await fsp.readdir(path.join(MAP.cacheDir, 'satellite'), { recursive: true });
    for (const f of files) if (String(f).endsWith('.jpg')) count++;
  } catch { /* кешу ще немає */ }
  cachedCount = count;
  countedAt = Date.now();
  return count;
}

/**
 * Прибирає тайли, старші за `MAP.satelliteCacheDays`.
 *
 * Без цього кеш росте безмежно: один тайл — близько 21 КБ, а активний водій
 * лишає сотні тайлів на день. Через рік це гігабайти на диску VPS, і про них
 * ніхто не дізнається, поки місце не скінчиться.
 *
 * Ходить по диску не частіше, ніж раз на 6 годин, і ніколи не кидає назовні.
 */
let prunedAt = 0;
let pruning = null;

function pruneCache() {
  // Перевіряємо саме вимикач функції, а не доступ до мережі: прибирання — це
  // гігієна диска, і воно має працювати навіть коли сервер офлайн.
  if (!MAP.satellite) return Promise.resolve(0);
  if (Date.now() - prunedAt < PRUNE_INTERVAL_MS) return Promise.resolve(0);
  if (pruning) return pruning;

  prunedAt = Date.now();
  pruning = (async () => {
    const dir = path.join(MAP.cacheDir, 'satellite');
    const maxAge = Math.max(1, MAP.satelliteCacheDays) * 86400000;
    const cutoff = Date.now() - maxAge;
    let removed = 0;

    let entries;
    try {
      entries = await fsp.readdir(dir, { recursive: true });
    } catch {
      return 0; // кешу немає — прибирати нічого
    }

    for (const entry of entries) {
      const rel = String(entry);
      if (!rel.endsWith('.jpg')) continue;
      const file = path.join(dir, rel);
      try {
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(file);
          removed++;
        }
      } catch { /* файл зник між readdir і stat — не біда */ }
    }

    if (removed) {
      // Підрахунок у /api/tiles має показати нове число, а не старе з кешу.
      countedAt = 0;
      logger.info('satellite_cache_pruned', { removed, keepDays: MAP.satelliteCacheDays });
    }
    return removed;
  })()
    .catch((e) => {
      logger.warn('satellite_prune_failed', { error: e.message });
      return 0;
    })
    .finally(() => { pruning = null; });

  return pruning;
}

async function getStatus() {
  return {
    enabled: Boolean(MAP.satellite),
    ready: isEnabled(),
    keyed: Boolean(MAP.satelliteToken),
    host: (() => {
      try { return new URL(upstreamTemplate().replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')).host; } catch { return null; }
    })(),
    maxZoom: MAP.satelliteMaxZoom,
    keepDays: MAP.satelliteCacheDays,
    cachedTiles: await countCached()
  };
}

module.exports = { getTile, getStatus, buildUpstreamUrl, isEnabled, pruneCache };
