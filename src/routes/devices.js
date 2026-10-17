'use strict';

const express = require('express');
const db = require('../db');
const logger = require('../logger');
const { ApiError } = require('../lib/errors');
const { cleanText } = require('../lib/validate');
const { createDeviceToken, requireSession } = require('../lib/sessions');

const router = express.Router();

/**
 * Стан для самого трекера: чи він активний, чи є відкритий рейс.
 * Викликається з APK при старті та раз на кілька хвилин.
 */
router.get('/me', (req, res) => {
  if (req.actor !== 'device') throw new ApiError(403, 'Потрібен токен пристрою');

  const activeTrip = db.prepare("SELECT id, name, start_odometer FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  const lastOdometer = db.prepare(`
    SELECT odometer FROM records
    WHERE odometer IS NOT NULL AND CAST(odometer AS INTEGER) > 0
    ORDER BY date DESC, time DESC, id DESC LIMIT 1
  `).get();

  res.json({
    device: { id: req.device.id, name: req.device.name, is_tracker: Boolean(req.device.is_tracker) },
    activeTrip: activeTrip || null,
    lastOdometer: lastOdometer ? lastOdometer.odometer : null
  });
});

// Далі — лише веб-сесія
router.use(requireSession);

/** Список пристроїв (без токенів). */
router.get('/', (req, res) => {
  const devices = db.prepare(`
    SELECT id, name, platform, is_tracker, created_at, last_seen FROM devices ORDER BY id ASC
  `).all();

  res.json(devices.map(d => ({
    ...d,
    online: d.last_seen ? (Date.now() - d.last_seen) < 10 * 60 * 1000 : false
  })));
});

/** Створює пристрій. Токен повертається ОДИН раз — збережіть його. */
router.post('/', (req, res) => {
  const name = cleanText((req.body || {}).name, 100) || 'Телефон';
  const platform = cleanText((req.body || {}).platform, 20) || 'android';

  const { token, hash } = createDeviceToken();
  const info = db.prepare(`
    INSERT INTO devices (name, token_hash, platform, created_at) VALUES (?, ?, ?, ?)
  `).run(name, hash, platform, Date.now());

  logger.info('device_created', { deviceId: info.lastInsertRowid, name });

  res.json({ success: true, id: info.lastInsertRowid, token, name, platform });
});

/** Видаляє пристрій (його токен перестає працювати). */
router.delete('/:id', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) throw new ApiError(404, 'Пристрій не знайдено');

  db.prepare('DELETE FROM devices WHERE id = ?').run(device.id);
  logger.info('device_deleted', { deviceId: device.id });
  res.json({ success: true });
});

/** Призначає пристрій активним трекером (решта — ні). */
router.post('/:id/tracker', (req, res) => {
  const device = db.prepare('SELECT * FROM devices WHERE id = ?').get(req.params.id);
  if (!device) throw new ApiError(404, 'Пристрій не знайдено');

  db.transaction(() => {
    db.prepare('UPDATE devices SET is_tracker = 0').run();
    db.prepare('UPDATE devices SET is_tracker = 1 WHERE id = ?').run(device.id);
  })();

  res.json({ success: true });
});

/**
 * Стан для самого трекера: чи він активний, чи є відкритий рейс.
 * Викликається з APK при старті та раз на кілька хвилин.
 */
router.get('/me', (req, res) => {
  if (req.actor !== 'device') throw new ApiError(403, 'Потрібен токен пристрою');

  const activeTrip = db.prepare("SELECT id, name, start_odometer FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  const lastOdometer = db.prepare(`
    SELECT odometer FROM records
    WHERE odometer IS NOT NULL AND CAST(odometer AS INTEGER) > 0
    ORDER BY date DESC, time DESC, id DESC LIMIT 1
  `).get();

  res.json({
    device: { id: req.device.id, name: req.device.name, is_tracker: Boolean(req.device.is_tracker) },
    activeTrip: activeTrip || null,
    lastOdometer: lastOdometer ? lastOdometer.odometer : null
  });
});

module.exports = router;
