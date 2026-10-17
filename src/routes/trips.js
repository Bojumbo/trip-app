'use strict';

const express = require('express');
const db = require('../db');
const logger = require('../logger');
const { ApiError } = require('../lib/errors');
const { cleanText, parseBool, parseInteger, requireDate, requireTime } = require('../lib/validate');

const router = express.Router();

function getTripOrFail(id) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  if (!trip) throw new ApiError(404, 'Рейс не знайдено');
  return trip;
}

router.get('/active', (req, res) => {
  const activeTrip = db.prepare("SELECT * FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!activeTrip) return res.json({ activeTrip: null, activeDeliveries: [] });

  const activeDeliveries = db.prepare(`
    SELECT d.*, r.location AS load_location, r.date AS load_date, r.time AS load_time, r.odometer AS load_odometer
    FROM deliveries d
    LEFT JOIN records r ON d.load_record_id = r.id
    WHERE d.trip_id = ? AND d.status = 'in_transit'
    ORDER BY d.id ASC
  `).all(activeTrip.id);

  res.json({ activeTrip, activeDeliveries });
});

router.get('/', (req, res) => {
  const trips = db.prepare(`
    SELECT t.*,
      (SELECT count(*) FROM records r WHERE r.trip_id = t.id) AS records_count,
      (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id) AS deliveries_count,
      (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id AND d.status = 'delivered') AS delivered_count
    FROM trips t
    ORDER BY t.id DESC
  `).all();

  res.json(trips);
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name, 255);
  if (!name) throw new ApiError(400, 'Вкажіть назву або маршрут рейсу');

  const startDate = body.start_date ? requireDate(body.start_date, 'дата початку') : new Date().toISOString().slice(0, 10);
  const startTime = body.start_time ? requireTime(body.start_time, 'час початку') : new Date().toTimeString().slice(0, 5);

  let startOdometer = null;
  if (body.start_odometer !== undefined && body.start_odometer !== null && body.start_odometer !== '') {
    startOdometer = parseInteger(body.start_odometer);
    if (startOdometer === null) throw new ApiError(400, 'Початковий одометр має бути невід\'ємним цілим числом');
  }

  const existingActive = db.prepare("SELECT id, name FROM trips WHERE status = 'active' LIMIT 1").get();
  if (existingActive) {
    throw new ApiError(409, `Вже є активний «${existingActive.name}» (#${existingActive.id}). Спочатку завершіть його.`);
  }

  const info = db.prepare(`
    INSERT INTO trips (name, status, start_date, start_time, start_odometer, notes)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(name, startDate, startTime, startOdometer, cleanText(body.notes, 1000));

  res.json({ success: true, id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  const body = req.body || {};

  const name = body.name !== undefined ? cleanText(body.name, 255) : trip.name;
  if (!name) throw new ApiError(400, 'Назва рейсу не може бути порожньою');

  const startDate = body.start_date !== undefined ? requireDate(body.start_date, 'дата початку') : trip.start_date;
  const startTime = body.start_time !== undefined ? requireTime(body.start_time, 'час початку') : trip.start_time;

  let startOdometer = trip.start_odometer;
  if (body.start_odometer !== undefined) {
    startOdometer = parseInteger(body.start_odometer);
    if (body.start_odometer !== null && body.start_odometer !== '' && startOdometer === null) {
      throw new ApiError(400, 'Початковий одометр має бути невід\'ємним цілим числом');
    }
  }

  const notes = body.notes !== undefined ? cleanText(body.notes, 1000) : trip.notes;

  db.prepare(`
    UPDATE trips SET name = ?, start_date = ?, start_time = ?, start_odometer = ?, notes = ? WHERE id = ?
  `).run(name, startDate, startTime, startOdometer, notes, trip.id);

  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  const withRecords = parseBool(req.query.with_records);

  const result = db.transaction(() => {
    const deliveryIds = db.prepare('SELECT id FROM deliveries WHERE trip_id = ?').all(trip.id).map(d => d.id);
    for (const id of deliveryIds) {
      db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(id);
    }
    db.prepare('DELETE FROM deliveries WHERE trip_id = ?').run(trip.id);

    let deletedRecords = 0;
    if (withRecords) {
      deletedRecords = db.prepare('DELETE FROM records WHERE trip_id = ?').run(trip.id).changes;
    } else {
      db.prepare('UPDATE records SET trip_id = NULL WHERE trip_id = ?').run(trip.id);
    }

    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    return { deletedRecords };
  })();

  logger.info('trip_deleted', { tripId: trip.id, withRecords, ip: req.ip });
  res.json({ success: true, ...result });
});

router.post('/:id/complete', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  if (trip.status !== 'active') throw new ApiError(409, 'Цей рейс вже завершено');

  const body = req.body || {};
  const endDate = body.end_date ? requireDate(body.end_date, 'дата завершення') : new Date().toISOString().slice(0, 10);
  const endTime = body.end_time ? requireTime(body.end_time, 'час завершення') : new Date().toTimeString().slice(0, 5);

  let endOdometer = null;
  if (body.end_odometer !== undefined && body.end_odometer !== null && body.end_odometer !== '') {
    endOdometer = parseInteger(body.end_odometer);
    if (endOdometer === null) throw new ApiError(400, 'Кінцевий одометр має бути невід\'ємним цілим числом');
  }
  if (endOdometer !== null && trip.start_odometer !== null && endOdometer < trip.start_odometer) {
    throw new ApiError(400, 'Кінцевий одометр не може бути меншим за початковий');
  }

  const notes = body.notes !== undefined && body.notes !== '' ? cleanText(body.notes, 1000) : trip.notes;

  const closedDeliveries = db.transaction(() => {
    // Відкриті доставки не мають висіти «В дорозі» вічно
    const closed = db.prepare(`
      UPDATE deliveries SET status = 'incomplete'
      WHERE trip_id = ? AND status = 'in_transit'
    `).run(trip.id).changes;

    db.prepare(`
      UPDATE trips SET status = 'completed', end_date = ?, end_time = ?, end_odometer = ?, notes = ? WHERE id = ?
    `).run(endDate, endTime, endOdometer, notes, trip.id);

    return closed;
  })();

  res.json({ success: true, closedDeliveries });
});

router.get('/:id/details', (req, res) => {
  const trip = getTripOrFail(req.params.id);

  const deliveries = db.prepare(`
    SELECT d.*,
      lr.date AS load_date, lr.time AS load_time, lr.location AS load_location, lr.odometer AS load_odometer,
      ur.date AS unload_date, ur.time AS unload_time, ur.location AS unload_location, ur.odometer AS unload_odometer
    FROM deliveries d
    LEFT JOIN records lr ON d.load_record_id = lr.id
    LEFT JOIN records ur ON d.unload_record_id = ur.id
    WHERE d.trip_id = ?
    ORDER BY d.id ASC
  `).all(trip.id);

  const records = db.prepare('SELECT * FROM records WHERE trip_id = ? ORDER BY date ASC, time ASC, id ASC').all(trip.id);

  res.json({ trip, deliveries, records });
});

module.exports = router;
