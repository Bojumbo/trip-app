'use strict';

/** Розбір рядка "50.450100, 30.523400" → {lat, lon} або null. */
function parseCoords(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(',');
  if (parts.length !== 2) return null;

  const lat = Number(parts[0].trim());
  const lon = Number(parts[1].trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  return { lat, lon };
}

/** Відстань між двома точками в метрах (haversine). */
function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

/** "HH:MM" → хвилини від початку доби. */
function timeToMinutes(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

module.exports = { parseCoords, distanceMeters, timeToMinutes };
