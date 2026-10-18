'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { startTestServer } = require('./helpers');

const TILES_FILE = path.join(__dirname, '..', 'public', 'tiles', 'region.pmtiles');

test('/api/tiles повідомляє наявність офлайн-карти згідно з файлом на диску', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.base}/api/tiles`);
    assert.equal(res.status, 200);

    const info = await res.json();
    assert.equal(typeof info.available, 'boolean');
    assert.equal(info.url, '/tiles/region.pmtiles');

    // Файл плиток не в git: тест не вимагає його наявності, а лише перевіряє,
    // що відповідь збігається з реальним станом диска.
    let exists = false;
    try {
      exists = fs.statSync(TILES_FILE).size > 127;
    } catch { /* файлу немає */ }

    assert.equal(info.available, exists, 'available має відповідати наявності файлу');
    if (exists) assert.ok(info.sizeMb > 0, 'для наявного файлу має бути розмір у МБ');
  } finally {
    await server.close();
  }
});

test('/api/tiles доступний без авторизації (його читає карта після логіну)', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.base}/api/tiles`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});
