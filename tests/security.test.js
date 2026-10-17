'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createTrip } = require('./helpers');

let server;
let client;

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
});

test.after(async () => {
  await server.close();
});

test('публічний /api/health без авторизації', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.status, 'ok');
});

test('безпекові заголовки на сторінці', async () => {
  const res = await fetch(server.base + '/');
  assert.equal(res.status, 200);

  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'CSP має бути присутній');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.equal(/script-src[^;]*unsafe-inline/.test(csp), false, 'inline-скрипти заборонені');

  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null, 'Express не має палити версію');
  assert.match(res.headers.get('permissions-policy'), /geolocation=\(self\)/);
});

test('API-відповіді не кешуються', async () => {
  await client.login();
  const res = await fetch(server.base + '/api/trips');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('невідомий API-ендпоінт → JSON 404', async () => {
  const res = await client.get('/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.data.error, 'Ендпоінт не знайдено');
});

test('некоректний JSON → 400 з безпечним текстом', async () => {
  const res = await fetch(server.base + '/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: client.cookie },
    body: '{ broken'
  });

  assert.equal(res.status, 400);
  const data = await res.json();
  assert.match(data.error, /Некоректний JSON/);
});

test('CSRF: чужий Origin відхиляється', async () => {
  const res = await fetch(server.base + '/api/trips', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: client.cookie,
      Origin: 'https://evil.example.com'
    },
    body: JSON.stringify({ name: 'CSRF' })
  });

  assert.equal(res.status, 403);
});

test('пошук не трактує % як шаблон', async () => {
  const tripId = await createTrip(client, { name: 'Пошук' });
  await client.post('/api/records', {
    date: '2026-10-17', time: '09:00', action: 'Пауза', location: 'Київ', trip_id: tripId
  });

  const wildcard = await client.get('/api/records?search=%25');
  assert.equal(wildcard.data.total, 0, 'символ % має шукатися буквально');

  const normal = await client.get('/api/records?search=Київ');
  assert.equal(normal.data.total, 1);
});

test('невалідні параметри фільтра → 400', async () => {
  const res = await client.get('/api/records?date_from=2026-13-45');
  assert.equal(res.status, 400);
});

test('ліміт сторінки обмежений зверху', async () => {
  const res = await client.get('/api/records?limit=100000');
  assert.equal(res.status, 200);
  assert.ok(res.data.records.length <= 500);
});
