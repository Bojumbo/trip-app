'use strict';

const express = require('express');
const db = require('../db');
const { ApiError } = require('../lib/errors');
const { LIMITS } = require('../config');

const router = express.Router();

/**
 * Агрегований звіт: один запит замість N+1.
 * Повертає пласкі масиви — групування робить клієнт.
 */
router.get('/', (req, res) => {
  const tripId = req.query.trip_id ? Number(req.query.trip_id) : null;

  const trips = tripId
    ? db.prepare('SELECT * FROM trips WHERE id = ?').all(tripId)
    : db.prepare('SELECT * FROM trips ORDER BY id DESC').all();

  const unassigned = db.prepare(`
    SELECT * FROM records WHERE trip_id IS NULL ORDER BY date DESC, time DESC, id DESC LIMIT ?
  `).all(LIMITS.unassignedPreview);

  const tripIds = trips.map(t => t.id);
  if (tripIds.length === 0) {
    return res.json({ trips: [], deliveries: [], records: [], unassigned });
  }

  const placeholders = tripIds.map(() => '?').join(',');

  const total = db.prepare(`SELECT count(*) c FROM records WHERE trip_id IN (${placeholders})`).get(...tripIds).c;
  if (total > LIMITS.reportRecords) {
    throw new ApiError(413, `Забагато записів для звіту (${total}). Оберіть конкретний рейс.`);
  }

  const deliveries = db.prepare(`
    SELECT d.*,
      lr.date AS load_date, lr.time AS load_time, lr.location AS load_location, lr.odometer AS load_odometer,
      ur.date AS unload_date, ur.time AS unload_time, ur.location AS unload_location, ur.odometer AS unload_odometer
    FROM deliveries d
    LEFT JOIN records lr ON d.load_record_id = lr.id
    LEFT JOIN records ur ON d.unload_record_id = ur.id
    WHERE d.trip_id IN (${placeholders})
    ORDER BY d.id ASC
  `).all(...tripIds);

  const records = db.prepare(`
    SELECT * FROM records WHERE trip_id IN (${placeholders}) ORDER BY date ASC, time ASC, id ASC
  `).all(...tripIds);

  res.json({ trips, deliveries, records, unassigned });
});

module.exports = router;
