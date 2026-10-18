'use strict';

/**
 * Тайли підкладки карти «на вимогу».
 *
 * Беремо їх із публічного PMTiles-архіву Protomaps (усі регіони світу) через
 * HTTP Range: потрібен лише той шматок архіву, де лежить тайл. Кожен тайл
 * зберігається на диску (`data/tilecache/`), тому повторні перегляди й робота
 * без інтернету для вже переглянутих ділянок не залежать від мережі.
 *
 * Нічого не кидає назовні: карта без підкладки — не привід ламати звіт.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { PMTiles, FetchSource } = require('pmtiles');

const config = require('../config');
const logger = require('../logger');
const { decodePolyline, bboxOfPoints } = require('../lib/geo');

const { MAP } = config;

/** Як часто перепитуємо Protomaps, якщо архів уже знайдено. */
const SOURCE_TTL_MS = 6 * 60 * 60 * 1000;
/** Пауза після невдалого пошуку архіву, щоб не довбати мережу на кожен тайл. */
const RETRY_MS = 5 * 60 * 1000;
/** Скільки живе підрахунок файлів у кеші (readdir по тисячі тек — не безкоштовний). */
const COUNT_TTL_MS = 60 * 1000;

let archiveUrl = null;
let archive = null;
let resolvedAt = 0;
let failedAt = 0;
let lastError = null;
let probing = null;

let cachedCount = 0;
let countedAt = 0;

const inflight = new Map();
let active = 0;
const waiting = [];

/** Дата збірки Protomaps у форматі YYYYMMDD (offset — днів тому). */
function buildDate(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

async function urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Обмежувач одночасних запитів до архіву: решта чекає в черзі. */
function acquire() {
  if (active < MAP.concurrency) {
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

/**
 * Знаходить актуальний архів: явний URL з env або найсвіжіша збірка Protomaps.
 * Результат кешується на 6 годин, невдача — на 5 хвилин.
 */
async function resolveArchive() {
  if (!MAP.enabled || !MAP.allowNetwork) return null;
  if (archive && Date.now() - resolvedAt < SOURCE_TTL_MS) return archive;
  if (!archive && failedAt && Date.now() - failedAt < RETRY_MS) return null;
  if (probing) return probing;

  probing = (async () => {
    let url = MAP.archiveUrl;

    if (!url) {
      for (let i = 0; i <= MAP.buildLookbackDays; i++) {
        const candidate = `${MAP.buildBase}/${buildDate(i)}.pmtiles`;
        if (await urlExists(candidate)) {
          url = candidate;
          break;
        }
      }
    }

    if (!url) {
      failedAt = Date.now();
      lastError = 'архів Protomaps недоступний';
      logger.warn('map_source_missing', { lookbackDays: MAP.buildLookbackDays });
      return null;
    }

    archiveUrl = url;
    archive = new PMTiles(new FetchSource(url));
    resolvedAt = Date.now();
    failedAt = 0;
    lastError = null;
    logger.info('map_source_ready', { url });
    return archive;
  })()
    .catch((e) => {
      failedAt = Date.now();
      lastError = e.message;
      logger.warn('map_source_failed', { error: e.message });
      return null;
    })
    .finally(() => { probing = null; });

  return probing;
}

/** Тека кешу для поточного архіву (дата збірки в назві — старі збірки не змішуються). */
function sourceKey() {
  if (!archiveUrl) return 'unknown';
  return path.basename(archiveUrl, '.pmtiles').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function tilePath(z, x, y) {
  return path.join(MAP.cacheDir, sourceKey(), String(z), String(x), `${y}.mvt`);
}

async function readCached(z, x, y) {
  try {
    return await fsp.readFile(tilePath(z, x, y));
  } catch {
    return null;
  }
}

/**
 * Тайл у форматі MVT (уже розпакований) або null, якщо джерело недоступне.
 * Повторні запити того самого тайла склеюються в один похід у мережу.
 */
async function getTile(z, x, y) {
  const cached = await readCached(z, x, y);
  if (cached) return cached;

  const key = `${z}/${x}/${y}`;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const arc = await resolveArchive();
    if (!arc) return null;

    await acquire();
    let tile;
    try {
      tile = await arc.getZxy(z, x, y);
    } finally {
      release();
    }
    if (!tile || !tile.data) return null;

    const buf = Buffer.from(tile.data);
    const file = tilePath(z, x, y);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, buf);
    cachedCount++;
    return buf;
  })()
    .catch((e) => {
      logger.warn('map_tile_failed', { z, x, y, error: e.message });
      return null;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Тайли, що покривають bbox на заданому зумі. */
function tilesForBbox(bbox, zoom) {
  const [west, south, east, north] = bbox;
  const n = 2 ** zoom;
  const x0 = clamp(Math.floor(((west + 180) / 360) * n), 0, n - 1);
  const x1 = clamp(Math.floor(((east + 180) / 360) * n), 0, n - 1);

  const latToY = (lat) => {
    const rad = (clamp(lat, -85.0511, 85.0511) * Math.PI) / 180;
    const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
    return clamp(Math.floor(y * n), 0, n - 1);
  };

  const y0 = latToY(north);
  const y1 = latToY(south);
  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) tiles.push([zoom, x, y]);
  }
  return tiles;
}

/**
 * Найбільший зум, на якому ділянка вкладається в ліміт тайлів.
 * Так короткий міський рейс отримує детальну підкладку, а рейс через пів світу —
 * оглядову, і жоден прогрів не перетворюється на тисячі запитів.
 */
function chooseZoom(bbox, maxTiles = MAP.warmMaxTiles, maxZoom = MAP.maxZoom) {
  for (let z = maxZoom; z >= 0; z--) {
    if (tilesForBbox(bbox, z).length <= maxTiles) return z;
  }
  return 0;
}

/**
 * Прогріває кеш для прямокутника. `limit` — жорстка стеля кількості тайлів.
 */
async function prefetch(bbox, zoom, limit = MAP.prefetchLimit) {
  const z = clamp(Math.round(zoom), 0, MAP.maxZoom);
  const all = tilesForBbox(bbox, z);
  const list = all.slice(0, limit);

  let ready = 0;
  const chunk = MAP.concurrency;
  for (let i = 0; i < list.length; i += chunk) {
    const batch = list.slice(i, i + chunk);
    const results = await Promise.all(batch.map(([tz, tx, ty]) => getTile(tz, tx, ty)));
    ready += results.filter(Boolean).length;
  }

  return { zoom: z, requested: list.length, ready, skipped: all.length - list.length };
}

// Прогрів іде у фоні; одночасно — не більше одного, і не частіше ніж раз на 10 с
// для тієї самої ділянки (інакше відкриття карти кілька разів поспіль дає чергу).
let warming = false;
let warmKey = '';
let warmAt = 0;

/**
 * Прогрів підкладки для ділянки рейсу: саме та поведінка, коли «карта
 * підвантажується сама там, де є точки». Ніколи не кидає і не блокує відповідь.
 */
async function warmSegments(segments) {
  if (!MAP.enabled || !MAP.allowNetwork) return null;
  if (warming) return null;

  const points = [];
  for (const seg of segments || []) {
    if (!seg || !seg.polyline) continue;
    const decoded = decodePolyline(String(seg.polyline));
    for (let i = 0; i < decoded.length; i += 4) points.push(decoded[i]);
    if (decoded.length) points.push(decoded[decoded.length - 1]);
  }

  const bbox = bboxOfPoints(points, 0.05);
  if (!bbox) return null;

  const zoom = chooseZoom(bbox);
  const key = `${bbox.map((n) => n.toFixed(2)).join(',')}@${zoom}`;
  if (key === warmKey && Date.now() - warmAt < 10_000) return null;

  warming = true;
  warmKey = key;
  warmAt = Date.now();

  try {
    const stats = await prefetch(bbox, zoom, MAP.warmMaxTiles);
    logger.info('map_warm_done', stats);
    return stats;
  } catch (e) {
    logger.warn('map_warm_failed', { error: e.message });
    return null;
  } finally {
    warming = false;
  }
}

async function countCached() {
  if (countedAt && Date.now() - countedAt < COUNT_TTL_MS) return cachedCount;

  const dir = path.join(MAP.cacheDir, sourceKey());
  try {
    const entries = await fsp.readdir(dir, { recursive: true });
    cachedCount = entries.filter((f) => f.endsWith('.mvt')).length;
  } catch {
    cachedCount = 0;
  }
  countedAt = Date.now();
  return cachedCount;
}

/**
 * Стан підкладки для /api/tiles. У мережу не ходить — відповідь має бути
 * миттєвою, інакше карта чекає на неї перед першим кадром.
 */
async function getStatus() {
  return {
    enabled: MAP.enabled,
    online: Boolean(archive),
    source: archiveUrl,
    maxZoom: MAP.maxZoom,
    cachedTiles: await countCached(),
    error: lastError
  };
}

module.exports = {
  getTile,
  getStatus,
  prefetch,
  warmSegments,
  tilesForBbox,
  chooseZoom,
  resolveArchive
};
