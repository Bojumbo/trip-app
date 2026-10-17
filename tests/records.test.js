'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createTrip } = require('./helpers');

let server;
let client;
let tripId;

async function getRecord(id) {
  const res = await client.get('/api/records?limit=200');
  return res.data.records.find(r => r.id === id);
}

async function getDelivery(id) {
  const res = await client.get(`/api/trips/${tripId}/details`);
  return res.data.deliveries.find(d => d.id === id);
}

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
  await client.login();
  tripId = await createTrip(client);
});

test.after(async () => {
  await server.close();
});

test('«Загрузка» створює відкриту доставку', async () => {
  const res = await client.post('/api/records', {
    date: '2026-10-17',
    time: '09:00',
    action: 'Загрузка',
    odometer: 100100,
    location: 'Київ',
    cargo: 'Побутова техніка'
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.delivery_id, 'має створитися доставка');
  assert.equal(res.data.trip_id, tripId);

  const delivery = await getDelivery(res.data.delivery_id);
  assert.equal(delivery.status, 'in_transit');
  assert.equal(delivery.cargo, 'Побутова техніка');
  assert.equal(delivery.load_record_id, res.data.id);
});

test('«Вигрузка» закриває останню відкриту доставку', async () => {
  const active = await client.get('/api/trips/active');
  const openId = active.data.activeDeliveries[0].id;

  const res = await client.post('/api/records', {
    date: '2026-10-17',
    time: '13:00',
    action: 'Вигрузка',
    odometer: 100600,
    location: 'Львів'
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.delivery_id, openId);

  const delivery = await getDelivery(openId);
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.unload_record_id, res.data.id);
});

test('вигрузка без відкритих доставок зберігається без delivery_id', async () => {
  const res = await client.post('/api/records', {
    date: '2026-10-17',
    time: '14:00',
    action: 'Вигрузка',
    odometer: 100700
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.delivery_id, null);
});

test('редагування запису не відвʼязує його від доставки', async () => {
  const created = await client.post('/api/records', {
    date: '2026-10-17',
    time: '15:00',
    action: 'Загрузка',
    odometer: 100800,
    cargo: 'Цегла'
  });
  const recordId = created.data.id;
  const deliveryId = created.data.delivery_id;

  // фронтенд НЕ передає delivery_id
  const res = await client.put(`/api/records/${recordId}`, {
    date: '2026-10-17',
    time: '15:05',
    action: 'Загрузка',
    odometer: 100810,
    comment: 'виправлено',
    is_reported: 0
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.delivery_id, deliveryId);

  const record = await getRecord(recordId);
  assert.equal(record.delivery_id, deliveryId);
  assert.equal(record.comment, 'виправлено');
});

test('is_reported: "0" не перетворюється на 1', async () => {
  const res = await client.post('/api/records', {
    date: '2026-10-17',
    time: '16:00',
    action: 'Пауза',
    is_reported: '0'
  });

  const record = await getRecord(res.data.id);
  assert.equal(record.is_reported, 0);
});

test('некоректна дата/час → 400', async () => {
  const badDate = await client.post('/api/records', { date: '2026-02-31', time: '10:00', action: 'Пауза' });
  assert.equal(badDate.status, 400);

  const badTime = await client.post('/api/records', { date: '2026-10-17', time: '99:99', action: 'Пауза' });
  assert.equal(badTime.status, 400);
});

test('видалення запису-загрузки прибирає відкриту доставку', async () => {
  const created = await client.post('/api/records', {
    date: '2026-10-17',
    time: '17:00',
    action: 'Загрузка',
    odometer: 100900,
    cargo: 'Тимчасовий вантаж'
  });

  const deliveryId = created.data.delivery_id;
  assert.ok(deliveryId);

  const del = await client.del(`/api/records/${created.data.id}`);
  assert.equal(del.status, 200);

  const details = await client.get(`/api/trips/${tripId}/details`);
  assert.equal(details.data.deliveries.some(d => d.id === deliveryId), false, 'доставка має зникнути');
});

test('видалення вигрузки повертає доставку у стан «в дорозі»', async () => {
  const load = await client.post('/api/records', {
    date: '2026-10-17',
    time: '18:00',
    action: 'Загрузка',
    odometer: 101000,
    cargo: 'Зворотний тест'
  });
  const unload = await client.post('/api/records', {
    date: '2026-10-17',
    time: '19:00',
    action: 'Вигрузка',
    odometer: 101100
  });

  await client.del(`/api/records/${unload.data.id}`);

  const delivery = await getDelivery(load.data.delivery_id);
  assert.equal(delivery.status, 'in_transit');
  assert.equal(delivery.unload_record_id, null);
});

test('повторний POST з тим самим client_uuid не створює дубль', async () => {
  const uuid = 'test-uuid-1111-2222';
  const payload = {
    date: '2026-10-17',
    time: '20:00',
    action: 'Пауза',
    client_uuid: uuid
  };

  const first = await client.post('/api/records', payload);
  const second = await client.post('/api/records', payload);

  assert.equal(first.data.duplicate, undefined);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.id, first.data.id);
});

test('запис без активного рейсу зберігається з попередженням', async () => {
  const complete = await client.post(`/api/trips/${tripId}/complete`, {
    end_date: '2026-10-18',
    end_time: '09:00',
    end_odometer: 101500
  });
  assert.equal(complete.status, 200);

  const res = await client.post('/api/records', {
    date: '2026-10-18',
    time: '10:00',
    action: 'Пауза'
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.trip_id, null);
  assert.match(res.data.warning, /без прив'язки/);
});

test('видалення неіснуючого запису → 404', async () => {
  const res = await client.del('/api/records/999999');
  assert.equal(res.status, 404);
});
