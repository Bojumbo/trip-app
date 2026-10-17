'use strict';

const express = require('express');
const db = require('../db');
const logger = require('../logger');
const { ApiError } = require('../lib/errors');
const { cleanText } = require('../lib/validate');
const { LIMITS } = require('../config');

const router = express.Router();

const MODES = new Set(['drive', 'walk', 'still', 'nosignal']);
const MAX_POLYLINE = 200000;

function validateSegment(raw, idx) {
  const mode = String(raw.mode || '').trim();
  if (!MODES.has(mode)) throw new ApiError(400, `Сегмент ${idx + 1}: некоректний режим «${raw.mode}»`);

  const startedAt = Number(raw.started_at);
  const endedAt = Number(raw.ended_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt <= startedAt) {
    throw new ApiError(400, `Сегмент ${idx + 1}: некоректний інтервал часу`);
  }

  const polyline = typeof raw.polyline === 'string' ? raw.polyline : '';
  if (polyline.length > MAX_POLYLINE) throw new ApiError(413, `Сегмент ${idx + 1}: маршрут завеликий`);
  if (polyline && !/^[\x20-\x7E]*$/.test(polyline)) {
    throw new ApiError(400, `Сегмент ${idx + 1}: некоректний формат polyline`);
  }

  return {
    mode,
    started_at: Math.round(startedAt),
    ended_at: Math.round(endedAt),
    distance_m: Number.isFinite(Number(raw.distance_m)) ? Math.max(0, Math.round(Number(raw.distance_m))) : null,
    points: Number.isFinite(Number(raw.points)) ? Math.max(0, Math.round(Number(raw.points))) : null,
    polyline,
    pause_record_id: raw.pause_record_id ? Number(raw.pause_record_id) : null,
    client_uuid: raw.client_uuid ? cleanText(raw.client_uuid, 64) : null
  };
}

/**
 * Приймає пачку сегментів маршруту від трекера.
 * Ідемпотентність — за client_uuid: повторна відправка не створює дубль.
 * Сегменти завжди прив'язуються до активного рейсу.
 */
router.post('/segments', (req, res) => {
  const body = req.body || {};

  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    throw new ApiError(400, 'Список сегментів порожній');
  }
  if (body.segments.length > LIMITS.trackBatch) {
    throw new ApiError(400, `Забагато сегментів в одному запиті (максимум ${LIMITS.trackBatch})`);
  }

  const activeTrip = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!activeTrip) {
    throw new ApiError(409, 'Немає активного рейсу — трек нема куди писати');
  }

  const segments = body.segments.map(validateSegment);
  const existsStmt = db.prepare('SELECT id FROM track_segments WHERE client_uuid = ?');
  const insertStmt = db.prepare(`
    INSERT INTO track_segments
      (trip_id, device_id, mode, started_at, ended_at, distance_m, points, polyline, pause_record_id, client_uuid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = db.transaction(() => {
    let saved = 0;
    let skipped = 0;

    for (const seg of segments) {
      if (seg.client_uuid && existsStmt.get(seg.client_uuid)) { skipped++; continue; }

      if (seg.pause_record_id && !db.prepare('SELECT id FROM records WHERE id = ?').get(seg.pause_record_id)) {
        seg.pause_record_id = null; // запис уже видалили — сегмент лишаємо без прив'язки
      }

      insertStmt.run(
        activeTrip.id, req.device ? req.device.id : null,
        seg.mode, seg.started_at, seg.ended_at,
        seg.distance_m, seg.points, seg.polyline, seg.pause_record_id, seg.client_uuid
      );
      saved++;
    }

    return { saved, skipped };
  })();

  logger.info('track_segments', { ...result, tripId: activeTrip.id, deviceId: req.device ? req.device.id : null });
  res.json({ success: true, trip_id: activeTrip.id, ...result });
});

module.exports = router;
