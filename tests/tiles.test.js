'use strict';

// Має стояти ДО require('../src/...'): конфіг читає NODE_ENV при завантаженні
// і в тестах не ходить у мережу (MAP.allowNetwork).
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { startTestServer, createClient } = require('./helpers');

const { decodePolyline, bboxOfPoints } = require('../src/lib/geo');
const { tilesForBbox, chooseZoom } = require('../src/services/map-tiles');

// ---------------------------------------------------------------- чисті функції

test('decodePolyline повторює формат трекера (Google encoded polyline)', () => {
  // Класичний приклад з документації Google: три точки в Каліфорнії.
  const points = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');

  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0].lat - 38.5) < 1e-6);
  assert.ok(Math.abs(points[0].lon - -120.2) < 1e-6);
  assert.ok(Math.abs(points[1].lat - 40.7) < 1e-6);
  assert.ok(Math.abs(points[1].lon - -120.95) < 1e-6);
  assert.ok(Math.abs(points[2].lat - 43.252) < 1e-6);
  assert.ok(Math.abs(points[2].lon - -126.453) < 1e-6);
});

test('decodePolyline не падає на смітті', () => {
  assert.deepEqual(decodePolyline(''), []);
  assert.deepEqual(decodePolyline(null), []);
  assert.ok(Array.isArray(decodePolyline('~~~~')));
});

test('bboxOfPoints охоплює всі точки й розширюється на pad', () => {
  const bbox = bboxOfPoints([{ lat: 50, lon: 30 }, { lat: 52, lon: 32 }], 0.5);
  assert.deepEqual(bbox, [29.5, 49.5, 32.5, 52.5]);

  assert.equal(bboxOfPoints([]), null);
  assert.equal(bboxOfPoints([{ lat: NaN, lon: NaN }]), null);
});

test('bboxOfPoints не виходить за межі світу', () => {
  const bbox = bboxOfPoints([{ lat: 85, lon: 179.9 }], 5);
  assert.ok(bbox[0] >= -180 && bbox[2] <= 180);
  assert.ok(bbox[1] >= -85 && bbox[3] <= 85);
});

test('tilesForBbox дає один тайл на нульовому зумі', () => {
  assert.deepEqual(tilesForBbox([-180, -85, 180, 85], 0), [[0, 0, 0]]);
});

test('tilesForBbox покриває невелику ділянку одним тайлом', () => {
  // 0.2° на зумі 8 — це приблизно десята частина тайла.
  const tiles = tilesForBbox([30.4, 50.4, 30.6, 50.6], 8);
  assert.equal(tiles.length, 1);
  assert.equal(tiles[0][0], 8);
});

test('chooseZoom тримає кількість тайлів у ліміті', () => {
  const ukraine = [22.1, 44.3, 40.2, 52.4];
  const zoom = chooseZoom(ukraine, 160, 14);

  assert.ok(zoom >= 0 && zoom <= 14);
  assert.ok(tilesForBbox(ukraine, zoom).length <= 160,
    `на зумі ${zoom} тайлів ${tilesForBbox(ukraine, zoom).length}, ліміт 160`);

  // Маленька ділянка має отримати детальніший зум, ніж уся країна.
  const city = [30.4, 50.4, 30.6, 50.6];
  assert.ok(chooseZoom(city, 160, 14) > zoom);
});

// ---------------------------------------------------------------------- маршрути

// Один сервер на файл: БД у тестах спільна, повторний старт після close() не працює.
let server;
let client;

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
  await client.login();
});

test.after(async () => {
  if (server) await server.close();
});

test('/api/tiles віддає режим підкладки без авторизації', async () => {
  const res = await fetch(`${server.base}/api/tiles`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const info = await res.json();
  assert.equal(typeof info.available, 'boolean');
  assert.ok(['offline', 'online', 'none'].includes(info.mode), `несподіваний режим: ${info.mode}`);
  assert.equal(info.tileUrl, '/tiles/{z}/{x}/{y}.mvt');
  assert.equal(typeof info.maxZoom, 'number');
  assert.equal(typeof info.cachedTiles, 'number');

  // Офлайн-файл або онлайн-тайлсервер — щось таки має бути доступне.
  assert.equal(info.available, info.mode !== 'none');
  if (info.mode === 'offline') assert.equal(info.url, '/tiles/region.pmtiles');
});

test('/tiles/:z/:x/:y.mvt відхиляє некоректні координати', async () => {
  for (const bad of ['/tiles/99/0/0.mvt', '/tiles/1/5/0.mvt', '/tiles/1/0/-1.mvt', '/tiles/x/0/0.mvt']) {
    const res = await fetch(server.base + bad);
    assert.equal(res.status, 400, `${bad} має давати 400`);
  }
});

test('/tiles/:z/:x/:y.mvt без мережі відповідає 404, а не 500', async () => {
  // У тестах MAP.allowNetwork = false: сервіс не ходить у Protomaps,
  // тож тайла немає — карта просто лишить фон під треком.
  const res = await fetch(`${server.base}/tiles/3/4/2.mvt`);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/api/tiles/warm вимагає авторизації та коректного bbox', async () => {
  const anon = await createClient(server.base).post('/api/tiles/warm', { bbox: [30, 50, 31, 51] });
  assert.equal(anon.status, 401);

  const bad = await client.post('/api/tiles/warm', { bbox: [30, 50] });
  assert.equal(bad.status, 400);

  const ok = await client.post('/api/tiles/warm', { bbox: [30.4, 50.4, 30.6, 50.6], zoom: 11 });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.zoom, 11);
  assert.equal(typeof ok.data.requested, 'number');
  // Без мережі жоден тайл не завантажиться, але відповідь має бути валідною.
  assert.equal(ok.data.ready, 0);
});
