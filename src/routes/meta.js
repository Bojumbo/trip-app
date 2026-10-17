'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');

const router = express.Router();

// /api/tiles реєструється ДО authMiddleware у src/app.js — його читає карта
// ще до того, як користувач увійшов (і невагоме, бо віддає лише наявність файлу).
const publicTilesRouter = express.Router();

/** Наявність офлайн-карти регіону (PMTiles). */
publicTilesRouter.get('/tiles', (req, res) => {
  const file = path.join(__dirname, '..', '..', 'public', 'tiles', 'region.pmtiles');
  let sizeMb = 0;
  let available = false;
  try {
    const stat = fs.statSync(file);
    available = stat.isFile() && stat.size > 127;
    sizeMb = Math.round((stat.size / (1024 * 1024)) * 10) / 10;
  } catch { /* файлу немає */ }

  res.json({ available, sizeMb, url: '/tiles/region.pmtiles' });
});

router.get('/actions', (req, res) => {
  const actions = db.prepare('SELECT name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

router.get('/odometer/last', (req, res) => {
  const row = db.prepare(`
    SELECT odometer FROM records
    WHERE odometer IS NOT NULL AND CAST(odometer AS INTEGER) > 0
    ORDER BY date DESC, time DESC, id DESC
    LIMIT 1
  `).get();

  res.json({ lastOdometer: row ? row.odometer : '' });
});

module.exports = { router, publicTilesRouter };
