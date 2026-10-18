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

async function getStatus() {
  return {
    enabled: Boolean(MAP.satellite),
    ready: isEnabled(),
    keyed: Boolean(MAP.satelliteToken),
    host: (() => {
      try { return new URL(upstreamTemplate().replace('{z}', '0').replace('{x}', '0').replace('{y}', '0')).host; } catch { return null; }
    })(),
    maxZoom: MAP.satelliteMaxZoom,
    cachedTiles: await countCached()
  };
}

module.exports = { getTile, getStatus, buildUpstreamUrl, isEnabled };
