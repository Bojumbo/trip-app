'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createTrip } = require('./helpers');

let server;
let client;

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
  await client.login();
  await createTrip(client);
});

test.after(async () => {
  await server.close();
});

test('імпорт приймає валідні рядки', async () => {
  const rawText = [
    '2026-10-17\t09:00\t100100\tЗагрузка\tКиїв\tCMR 1',
    '2026-10-17\t13:00\t100600\tВигрузка\tЛьвів\t'
  ].join('\n');

  const res = await client.post('/api/records/bulk-import', { rawText });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 2);
  assert.equal(res.data.skipped, 0);
  assert.deepEqual(res.data.errors, []);
});

test('імпорт відхиляє некоректні дати та час', async () => {
  const rawText = [
    'абв\t99:99\t1\tЗагрузка',
    '31.02.2026\t10:00\t1\tЗагрузка'
  ].join('\n');

  const res = await client.post('/api/records/bulk-import', { rawText });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 0);
  assert.equal(res.data.errors.length, 2);
});

test('імпорт розуміє формат DD.MM.YY', async () => {
  const res = await client.post('/api/records/bulk-import', {
    rawText: '18.10.26\t07:30\t100900\tПауза\tСклад'
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.count, 1);

  const records = await client.get('/api/records?limit=100&search=Склад');
  assert.equal(records.data.records[0].date, '2026-10-18');
});

test('повторний імпорт того ж рядка пропускається', async () => {
  const rawText = '2026-10-17\t09:00\t100100\tЗагрузка\tКиїв\tCMR 1';

  const res = await client.post('/api/records/bulk-import', { rawText });
  assert.equal(res.status, 200);
  assert.equal(res.data.count, 0);
  assert.equal(res.data.skipped, 1);
});

test('імпорт без тексту → 400', async () => {
  const res = await client.post('/api/records/bulk-import', { rawText: '' });
  assert.equal(res.status, 400);
});

test('імпорт з обʼєктом замість тексту → 400 без внутрішньої помилки', async () => {
  const res = await client.post('/api/records/bulk-import', { rawText: { a: 1 } });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /порожній/);
  assert.equal(/is not a function/.test(res.data.error), false);
});

test('імпорт у неіснуючий рейс → 400', async () => {
  const res = await client.post('/api/records/bulk-import', {
    rawText: '2026-10-17\t10:00\t1\tПауза',
    trip_id: 999999
  });
  assert.equal(res.status, 400);
});
