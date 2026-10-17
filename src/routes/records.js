'use strict';

const express = require('express');
const db = require('../db');
const logger = require('../logger');
const { ApiError } = require('../lib/errors');
const {
  validateRecordInput, parseBool, isValidDate, isValidTime, normalizeImportDate
} = require('../lib/validate');
const { parseTSV } = require('../lib/tsv');
const { insertRecord, deleteRecord } = require('../services/records');
const { requireSession } = require('../lib/sessions');
const { parseCoords, distanceMeters, timeToMinutes } = require('../lib/geo');
const { LIMITS } = require('../config');

const router = express.Router();

/**
 * Дедуплікація автопауз: два пристрої або повторна відправка не мають
 * створювати дві паузи на одну зупинку (±5 хв і 200 м).
 */
function findNearbyPause(date, time, coords) {
  const minutes = timeToMinutes(time);
  if (minutes === null) return null;

  const rows = db.prepare(`
    SELECT id, coords FROM records
    WHERE date = ? AND action = 'Пауза'
      AND ABS((CAST(substr(time, 1, 2) AS INTEGER) * 60 + CAST(substr(time, 4, 2) AS INTEGER)) - ?) <= 5
  `).all(date, minutes);

  const point = parseCoords(coords);
  for (const row of rows) {
    if (!point) return row;
    const other = parseCoords(row.coords);
    if (!other || distanceMeters(point, other) <= 200) return row;
  }
  return null;
}

// ---------- Створення (дозволено і сесії, і пристрою) ----------
router.post('/', (req, res) => {
  const input = validateRecordInput(req.body || {});
  if (req.device) input.device_id = req.device.id;

  // Ідемпотентність для офлайн-черги
  if (input.client_uuid) {
    const existing = db.prepare('SELECT id, trip_id, delivery_id FROM records WHERE client_uuid = ?').get(input.client_uuid);
    if (existing) {
      return res.json({
        success: true,
        id: existing.id,
        trip_id: existing.trip_id,
        delivery_id: existing.delivery_id,
        duplicate: true
      });
    }
  }

  if (input.source === 'auto') {
    const nearby = findNearbyPause(input.date, input.time, input.coords);
    if (nearby) {
      return res.json({ success: true, id: nearby.id, duplicate: true, reason: 'nearby_pause' });
    }
  }

  const result = insertRecord(input);
  res.json({
    success: true,
    id: result.recordId,
    trip_id: result.tripId,
    delivery_id: result.deliveryId,
    warning: result.warning || undefined
  });
});

// ---------- Далі — лише веб-сесія ----------
router.use(requireSession);

// ---------- Імпорт ----------
router.post('/bulk-import', express.json({ limit: LIMITS.bulkImport }), (req, res) => {
  const rawText = req.body && req.body.rawText;
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new ApiError(400, 'Текст для імпорту порожній');
  }
  if (rawText.length > LIMITS.bulkImportText) {
    throw new ApiError(413, 'Текст завеликий (максимум 3 МБ)');
  }

  const rows = parseTSV(rawText.trim());
  const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  const requestedTrip = req.body.trip_id ? Number(req.body.trip_id) : null;
  const targetTripId = requestedTrip || (active ? active.id : null);

  if (targetTripId && !db.prepare('SELECT id FROM trips WHERE id = ?').get(targetTripId)) {
    throw new ApiError(400, 'Вказаний рейс не існує');
  }

  const existsStmt = db.prepare(`
    SELECT id FROM records
    WHERE date = ? AND time = ? AND action = ? AND COALESCE(odometer, -1) = COALESCE(?, -1)
    LIMIT 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported, trip_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const errors = [];
  let count = 0;
  let skipped = 0;

  db.transaction(() => {
    rows.forEach((col, idx) => {
      if (!col || col.length < 3) return;
      if (col[0].toLowerCase().includes('дата')) return;

      const date = normalizeImportDate(col[0]);
      const time = String(col[1] || '').trim().slice(0, 5);

      if (!date) { errors.push(`Рядок ${idx + 1}: некоректна дата «${col[0]}»`); return; }
      if (!isValidTime(time)) { errors.push(`Рядок ${idx + 1}: некоректний час «${col[1]}»`); return; }

      const odoRaw = col[2] ? String(col[2]).trim() : '';
      const odometer = odoRaw !== '' && Number.isInteger(Number(odoRaw)) && Number(odoRaw) >= 0
        ? Number(odoRaw)
        : null;

      const action = (col[3] || '').trim() || 'Інше (коментар)';
      const location = (col[4] || '').trim().slice(0, 255);
      const comment = (col[5] || '').trim().slice(0, 2000);
      const coords = (col[6] || '').trim().slice(0, 100);
      const isReported = ['так', 'yes', '1', 'true'].includes(String(col[7] || '').toLowerCase().trim()) ? 1 : 0;

      if (existsStmt.get(date, time, action, odometer)) { skipped++; return; }

      insertStmt.run(date, time, odometer, action, location, comment, coords, isReported, targetTripId);
      count++;
    });
  })();

  logger.info('bulk_import', { count, skipped, errors: errors.length, ip: req.ip });
  res.json({ success: true, count, skipped, errors: errors.slice(0, 20), trip_id: targetTripId });
});

// ---------- Масове оновлення статусу ----------
router.post('/bulk-report-status', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new ApiError(400, 'Список ID порожній або некоректний');
  }
  if (body.ids.length > LIMITS.bulkReportIds) {
    throw new ApiError(400, `Забагато записів в одному запиті (максимум ${LIMITS.bulkReportIds})`);
  }

  const ids = body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new ApiError(400, 'Некоректні ID');

  const value = parseBool(body.is_reported) ? 1 : 0;
  const stmt = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?');

  const changed = db.transaction(() => {
    let total = 0;
    for (const id of ids) total += stmt.run(value, id).changes;
    return total;
  })();

  res.json({ success: true, count: changed, requested: ids.length, is_reported: value });
});

// ---------- Читання ----------
router.get('/all', (req, res) => {
  const dateFrom = req.query.date_from ? String(req.query.date_from).trim() : '';
  const dateTo = req.query.date_to ? String(req.query.date_to).trim() : '';
  const tripId = req.query.trip_id;

  const where = [];
  const params = [];

  if (tripId) { where.push('trip_id = ?'); params.push(tripId); }
  if (dateFrom) {
    if (!isValidDate(dateFrom)) throw new ApiError(400, 'Некоректна дата «від»');
    where.push('date >= ?'); params.push(dateFrom);
  }
  if (dateTo) {
    if (!isValidDate(dateTo)) throw new ApiError(400, 'Некоректна дата «до»');
    where.push('date <= ?'); params.push(dateTo);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) c FROM records ${whereSql}`).get(...params).c;

  if (total > LIMITS.recordsAll) {
    throw new ApiError(413, `Забагато записів (${total}). Зменшіть період або оберіть рейс.`);
  }

  res.json(db.prepare(`SELECT * FROM records ${whereSql} ORDER BY date ASC, time ASC, id ASC`).all(...params));
});

router.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), LIMITS.pageSize);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = req.query.search ? String(req.query.search).trim().slice(0, 200) : '';
  const dateFrom = req.query.date_from ? String(req.query.date_from).trim() : '';
  const dateTo = req.query.date_to ? String(req.query.date_to).trim() : '';
  const isReported = req.query.is_reported;
  const tripId = req.query.trip_id;

  const where = [];
  const params = [];

  if (tripId) { where.push('r.trip_id = ?'); params.push(tripId); }

  if (search) {
    const term = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
    where.push("(r.location LIKE ? ESCAPE '\\' OR r.comment LIKE ? ESCAPE '\\' OR r.action LIKE ? ESCAPE '\\')");
    params.push(term, term, term);
  }
  if (dateFrom) {
    if (!isValidDate(dateFrom)) throw new ApiError(400, 'Некоректна дата «від»');
    where.push('r.date >= ?'); params.push(dateFrom);
  }
  if (dateTo) {
    if (!isValidDate(dateTo)) throw new ApiError(400, 'Некоректна дата «до»');
    where.push('r.date <= ?'); params.push(dateTo);
  }
  if (isReported !== undefined && isReported !== '') {
    where.push('r.is_reported = ?');
    params.push(isReported === '1' ? 1 : 0);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) AS total FROM records r ${whereSql}`).get(...params).total;

  const records = db.prepare(`
    SELECT r.*, t.name AS trip_name, d.cargo AS delivery_cargo
    FROM records r
    LEFT JOIN trips t ON r.trip_id = t.id
    LEFT JOIN deliveries d ON r.delivery_id = d.id
    ${whereSql}
    ORDER BY r.date DESC, r.time DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ records, total, hasMore: offset + records.length < total });
});

// ---------- Оновлення ----------
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Запис не знайдено');

  const input = validateRecordInput(req.body || {});

  let tripId = existing.trip_id;
  if (input.trip_id !== null) {
    if (!db.prepare('SELECT id FROM trips WHERE id = ?').get(input.trip_id)) {
      throw new ApiError(400, 'Вказаний рейс не існує');
    }
    tripId = input.trip_id;
  }

  // delivery_id зберігаємо, якщо клієнт його не передав
  const deliveryId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'delivery_id')
    ? input.delivery_id
    : existing.delivery_id;

  db.prepare(`
    UPDATE records
    SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?, coords = ?, is_reported = ?, trip_id = ?, delivery_id = ?
    WHERE id = ?
  `).run(
    input.date, input.time, input.odometer, input.action, input.location, input.comment,
    input.coords, input.is_reported, tripId, deliveryId, existing.id
  );

  res.json({ success: true, trip_id: tripId, delivery_id: deliveryId });
});

router.patch('/:id/report-status', (req, res) => {
  const value = parseBool(req.body && req.body.is_reported) ? 1 : 0;
  const info = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?').run(value, req.params.id);
  if (info.changes === 0) throw new ApiError(404, 'Запис не знайдено');
  res.json({ success: true, id: Number(req.params.id), is_reported: value });
});

// ---------- Видалення ----------
router.delete('/:id', (req, res) => {
  const record = deleteRecord(req.params.id);
  logger.info('record_deleted', { recordId: record.id, ip: req.ip });
  res.json({ success: true });
});

module.exports = router;
