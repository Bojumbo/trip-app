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
});

test.after(async () => {
  await server.close();
});

test('створення рейсу', async () => {
  const res = await client.post('/api/trips', {
    name: '  Київ — Львів  ',
    start_date: '2026-10-17',
    start_time: '08:00',
    start_odometer: 100000,
    notes: 'Заявка №1'
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.id);

  const list = await client.get('/api/trips');
  const trip = list.data.find(t => t.id === res.data.id);
  assert.equal(trip.name, 'Київ — Львів');
  assert.equal(trip.status, 'active');
});

test('другий активний рейс → 409', async () => {
  const res = await client.post('/api/trips', {
    name: 'Другий',
    start_date: '2026-10-17',
    start_time: '09:00'
  });

  assert.equal(res.status, 409);
  assert.match(res.data.error, /Вже є активний/);
});

test('некоректні дата/час рейсу → 400', async () => {
  const badDate = await client.post('/api/trips', { name: 'X', start_date: 'nope', start_time: '08:00' });
  assert.equal(badDate.status, 400);

  const badTime = await client.post('/api/trips', { name: 'X', start_date: '2026-10-17', start_time: '99:99' });
  assert.equal(badTime.status, 400);

  const badOdo = await client.post('/api/trips', { name: 'X', start_date: '2026-10-17', start_time: '08:00', start_odometer: -5 });
  assert.equal(badOdo.status, 400);
});

test('порожня назва → 400', async () => {
  const res = await client.post('/api/trips', { name: '   ' });
  assert.equal(res.status, 400);
});

test('редагування рейсу', async () => {
  const list = await client.get('/api/trips');
  const trip = list.data[0];

  const res = await client.put(`/api/trips/${trip.id}`, { name: 'Київ — Львів — Київ', notes: 'оновлено' });
  assert.equal(res.status, 200);

  const updated = (await client.get('/api/trips')).data.find(t => t.id === trip.id);
  assert.equal(updated.name, 'Київ — Львів — Київ');
  assert.equal(updated.notes, 'оновлено');
});

test('завершення рейсу закриває відкриті доставки', async () => {
  const tripId = (await client.get('/api/trips')).data[0].id;

  await client.post('/api/records', {
    date: '2026-10-17',
    time: '09:30',
    action: 'Загрузка',
    odometer: 100100,
    cargo: 'Вантаж'
  });

  const res = await client.post(`/api/trips/${tripId}/complete`, {
    end_date: '2026-10-18',
    end_time: '18:00',
    end_odometer: 101000
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.closedDeliveries, 1);

  const details = await client.get(`/api/trips/${tripId}/details`);
  assert.equal(details.data.trip.status, 'completed');
  assert.equal(details.data.deliveries[0].status, 'incomplete');
});

test('повторне завершення → 409', async () => {
  const tripId = (await client.get('/api/trips')).data[0].id;
  const res = await client.post(`/api/trips/${tripId}/complete`, {});
  assert.equal(res.status, 409);
});

test('кінцевий одометр менший за початковий → 400', async () => {
  const tripId = await createTrip(client, { name: 'Новий рейс', start_odometer: 200000 });
  const res = await client.post(`/api/trips/${tripId}/complete`, { end_odometer: 199000 });
  assert.equal(res.status, 400);
});

test('видалення рейсу без записів залишає записи без рейсу', async () => {
  const tripId = (await client.get('/api/trips')).data.find(t => t.status === 'active').id;

  await client.post('/api/records', { date: '2026-10-18', time: '12:00', action: 'Пауза' });

  const res = await client.del(`/api/trips/${tripId}?with_records=0`);
  assert.equal(res.status, 200);

  const records = await client.get('/api/records?limit=100');
  const orphan = records.data.records.find(r => r.trip_id === null);
  assert.ok(orphan, 'записи мають лишитись без рейсу');
});

test('видалення рейсу разом із записами', async () => {
  const tripId = await createTrip(client, { name: 'Рейс на видалення' });
  await client.post('/api/records', { date: '2026-10-19', time: '08:00', action: 'Пауза' });

  const before = (await client.get('/api/records?limit=1')).data.total;

  const res = await client.del(`/api/trips/${tripId}?with_records=1`);
  assert.equal(res.status, 200);
  assert.equal(res.data.deletedRecords, 1);

  const after = (await client.get('/api/records?limit=1')).data.total;
  assert.equal(after, before - 1);
});

test('неіснуючий рейс → 404', async () => {
  const res = await client.get('/api/trips/999999/details');
  assert.equal(res.status, 404);
});
