'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { startTestServer, createClient } = require('./helpers');

test('/api/tiles повідомляє відсутність офлайн-карти у тестовому середовищі', async () => {
  const server = await startTestServer();
  try {
    const res = await fetch(`${server.base}/api/tiles`);
    assert.equal(res.status, 200);

    const info = await res.json();
    assert.equal(typeof info.available, 'boolean');
    assert.equal(info.available, false, 'у репозиторії region.pmtiles немає');
    assert.equal(info.url, '/tiles/region.pmtiles');
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
