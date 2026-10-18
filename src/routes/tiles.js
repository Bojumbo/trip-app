'use strict';

/**
 * Маршрути підкладки карти.
 *
 * Три речі:
 *   GET  /api/tiles            — стан підкладки (читає карта перед першим кадром)
 *   GET  /tiles/:z/:x/:y.mvt   — сам тайл (публічно, з дисковим кешем)
 *   POST /api/tiles/warm       — прогрів ділянки вручну (під авторизацією)
 *
 * Тайли віддаються без авторизації: вони не містять даних користувача,
 * а браузер запитує їх десятками, поки користувач тягне карту.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const tiles = require('../services/map-tiles');

const LOCAL_FILE = path.join(config.ROOT, 'public', 'tiles', 'region.pmtiles');

/** Публічна частина: стан підкладки. */
const publicRouter = express.Router();

/** Публічна частина: тайли. Монтується в корінь, перед статикою. */
const tileRouter = express.Router();

/** Під авторизацією. */
const router = express.Router();

function localFileInfo() {
  if (!config.MAP.preferLocal) return { available: false, sizeMb: 0 };

  let sizeMb = 0;
  let available = false;
  try {
    const stat = fs.statSync(LOCAL_FILE);
    available = stat.isFile() && stat.size > 127;
    sizeMb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;
  } catch { /* файлу немає — працюємо онлайн */ }
  return { available, sizeMb };
}

publicRouter.get('/tiles', async (req, res) => {
  const local = localFileInfo();
  const status = await tiles.getStatus();

  // Офлайн-файл має приоритет: він працює навіть без інтернету.
  const mode = local.available ? 'offline' : (config.MAP.enabled ? 'online' : 'none');

  res.set('Cache-Control', 'no-store');
  res.json({
    available: mode !== 'none',
    mode,
    sizeMb: local.sizeMb,
    url: local.available ? '/tiles/region.pmtiles' : null,
    tileUrl: '/tiles/{z}/{x}/{y}.mvt',
    maxZoom: status.maxZoom,
    cachedTiles: status.cachedTiles,
    source: status.source
  });
});

/** Перевіряє z/x/y: цілі числа в межах сітки тайлів. */
function parseTileParams(params) {
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);

  if (!Number.isInteger(z) || z < 0 || z > config.MAP.maxZoom) return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;

  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) return null;

  return { z, x, y };
}

tileRouter.get('/tiles/:z/:x/:y.mvt', async (req, res) => {
  const tile = parseTileParams(req.params);
  if (!tile) return res.status(400).json({ error: 'Некоректні координати тайла' });

  const data = await tiles.getTile(tile.z, tile.x, tile.y);
  if (!data) {
    // Джерело недоступне або тайла немає — порожня ділянка, карта просто лишить фон.
    res.set('Cache-Control', 'no-store');
    return res.status(404).end();
  }

  res.set('Content-Type', 'application/x-protobuf');
  res.set('Cache-Control', 'public, max-age=604800, immutable');
  res.send(data);
});

router.post('/tiles/warm', async (req, res) => {
  const bbox = Array.isArray(req.body && req.body.bbox) ? req.body.bbox.map(Number) : null;
  if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    return res.status(400).json({ error: 'Потрібен bbox: [west, south, east, north]' });
  }

  const zoom = Number(req.body.zoom);
  const status = await tiles.getStatus();
  if (!status.enabled) return res.status(409).json({ error: 'Підкладку вимкнено (MAP_TILES=0)' });

  const stats = await tiles.prefetch(bbox, Number.isFinite(zoom) ? zoom : tiles.chooseZoom(bbox));
  res.json(stats);
});

module.exports = { publicRouter, tileRouter, router };
