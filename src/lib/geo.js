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

/**
 * Google encoded polyline → [{lat, lon}].
 *
 * Той самий формат, що Polyline.encode у трекері та decodePolyline у app.js:
 * різниця координат у п'ятому знаку, зісунута на 63, розбита на 5-бітові групи.
 * Потрібен на сервері, щоб порахувати прямокутник рейсу для прогріву тайлів.
 */
function decodePolyline(str, precision = 5) {
  if (typeof str !== 'string' || str.length === 0) return [];

  const factor = 10 ** precision;
  const out = [];
  let index = 0;
  let lat = 0;
  let lon = 0;

  // Захист від зіпсованого рядка: кожна точка — щонайменше 2 символи.
  const maxPoints = Math.ceil(str.length / 2);

  while (index < str.length && out.length <= maxPoints) {
    let result = 0;
    let shift = 0;
    let byte;

    do {
      if (index >= str.length) return out;
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      if (index >= str.length) return out;
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);

    lon += result & 1 ? ~(result >> 1) : result >> 1;

    out.push({ lat: lat / factor, lon: lon / factor });
  }

  return out;
}

/**
 * Прямокутник [west, south, east, north] навколо точок.
 * `padDeg` розширює межі, щоб у кадр потрапило трохи околиць.
 */
function bboxOfPoints(points, padDeg = 0) {
  if (!Array.isArray(points) || points.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const p of points) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
  }

  if (!Number.isFinite(west)) return null;

  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  return [
    clamp(west - padDeg, -180, 180),
    clamp(south - padDeg, -85, 85),
    clamp(east + padDeg, -180, 180),
    clamp(north + padDeg, -85, 85)
  ];
}

module.exports = { parseCoords, distanceMeters, timeToMinutes, decodePolyline, bboxOfPoints };
