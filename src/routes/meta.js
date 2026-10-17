'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

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

module.exports = router;
