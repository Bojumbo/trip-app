'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createTrip } = require('./helpers');

let server;
let client;

async function createDevice(name = 'Телефон') {
  const res = await client.post('/api/devices', { name });
  assert.equal(res.status, 200);
  return res.data; // { id, token, name, platform }
}

function deviceClient(token) {
  return {
    get: (url, opts = {}) => request(token, 'GET', url, undefined, opts),
    post: (url, body) => request(token, 'POST', url, body),
    put: (url, body) => request(token, 'PUT', url, body),
    del: (url) => request(token, 'DELETE', url, undefined)
  };

  async function request(tk, method, url, body, opts = {}) {
    const res = await fetch(server.base + url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tk}`,
        ...(opts.headers || {})
      },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length) return { status: res.status, data: null, headers: res.headers };

    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data, headers: res.headers };
  }
}

function today() { return new Date().toISOString().slice(0, 10); }

/** Завершує активний рейс, щоб тест міг створити новий. */
async function completeActiveTrip() {
  const active = await client.get('/api/trips/active');
  const trip = active.data && active.data.activeTrip;
  if (!trip) return;
  await client.post(`/api/trips/${trip.id}/complete`, {
    end_date: today(), end_time: '23:59'
  });
}

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
  await client.login();
});

test.after(async () => {
  await server.close();
});

test('створення пристрою повертає токен один раз', async () => {
  const device = await createDevice('Samsung');
  assert.ok(device.token && device.token.length >= 32);
  assert.equal(device.name, 'Samsung');

  const list = await client.get('/api/devices');
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].token, undefined, 'токен не повертається у списку');
});

test('пристрій читає власний стан через /devices/me', async () => {
  const device = (await client.post('/api/devices', { name: 'Android-1' })).data;
  const tracker = deviceClient(device.token);

  const me = await tracker.get('/api/devices/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.device.id, device.id);
  assert.equal(me.data.device.is_tracker, false);

  // без токена і без cookie — 401
  const anonymous = await client.get('/api/devices/me', { noCookie: true });
  assert.equal(anonymous.status, 401);

  // з cookie, але не пристрій — 403
  const fromWeb = await client.get('/api/devices/me');
  assert.equal(fromWeb.status, 403);
});

test('пристрій не може керувати рейсами та звітами', async () => {
  const device = (await client.post('/api/devices', { name: 'Android-2' })).data;
  const tracker = deviceClient(device.token);

  const makeTrip = await tracker.post('/api/trips', { name: 'Hack', start_date: '2026-10-01', start_time: '08:00' });
  assert.equal(makeTrip.status, 403);

  const report = await tracker.get('/api/report');
  assert.equal(report.status, 403);

  const edit = await tracker.put('/api/records/1', { date: '2026-10-01', time: '08:00', action: 'Пауза' });
  assert.equal(edit.status, 403);
});

test('пристрій бачить відкритий рейс і останній одометр', async () => {
  const tripId = await createTrip(client, { name: 'Рейс для трекера', start_odometer: 100000 });
  const device = (await client.post('/api/devices', { name: 'Android-3' })).data;

  await client.post('/api/records', { date: '2026-10-01', time: '08:00', action: 'Пауза', odometer: 100010, trip_id: tripId });

  const tracker = deviceClient(device.token);
  const me = await tracker.get('/api/devices/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.activeTrip.id, tripId);
  assert.equal(me.data.lastOdometer, 100010);
});

test('пристрій пише автопаузу зі source=auto', async () => {
  const device = (await client.post('/api/devices', { name: 'Android-4' })).data;
  const tracker = deviceClient(device.token);

  const res = await tracker.post('/api/records', {
    date: today(),
    time: '10:00',
    action: 'Пауза',
    odometer: 105000,
    coords: '50.450100, 30.523400',
    comment: 'автопауза',
    source: 'auto',
    client_uuid: 'auto-pause-1'
  });

  assert.equal(res.status, 200);
  assert.ok(res.data.id);

  const list = await client.get('/api/records?limit=5');
  const record = list.data.records.find(r => r.id === res.data.id);
  assert.equal(record.source, 'auto');
});

test('повторна автопауза в тому ж місці й часі не створює дубль', async () => {
  const device = (await client.post('/api/devices', { name: 'Android-5' })).data;
  const tracker = deviceClient(device.token);

  const payload = {
    date: today(),
    time: '12:30',
    action: 'Пауза',
    odometer: 106000,
    coords: '50.450100, 30.523400',
    source: 'auto',
    client_uuid: 'auto-pause-2'
  };

  const first = await tracker.post('/api/records', payload);
  const second = await tracker.post('/api/records', payload);

  assert.equal(first.data.duplicate, undefined);
  assert.equal(second.data.duplicate, true);
  assert.equal(second.data.id, first.data.id);

  // інший клієнтський uuid, але те саме місце й час — теж дубль
  const third = await tracker.post('/api/records', {
    ...payload,
    client_uuid: 'auto-pause-3',
    coords: '50.450200, 30.523300'
  });
  assert.equal(third.data.duplicate, true);
});

test('пауза пізніше 5 хвилин — не дубль', async () => {
  const device = (await client.post('/api/devices', { name: 'Android-6' })).data;
  const tracker = deviceClient(device.token);

  await tracker.post('/api/records', {
    date: today(), time: '15:00', action: 'Пауза', odometer: 107000,
    coords: '49.000000, 32.000000', source: 'auto', client_uuid: 'auto-pause-4'
  });

  const later = await tracker.post('/api/records', {
    date: today(), time: '15:40', action: 'Пауза', odometer: 107500,
    coords: '49.000000, 32.000000', source: 'auto', client_uuid: 'auto-pause-5'
  });

  assert.equal(later.data.duplicate, undefined);
  assert.notEqual(later.data.id, undefined);
});

test('пристрій позначається активним трекером', async () => {
  const a = (await client.post('/api/devices', { name: 'A' })).data;
  const b = (await client.post('/api/devices', { name: 'B' })).data;

  await client.post(`/api/devices/${a.id}/tracker`, {});
  await client.post(`/api/devices/${b.id}/tracker`, {});

  const list = await client.get('/api/devices');
  const trackers = list.data.filter(d => Boolean(d.is_tracker));
  assert.equal(trackers.length, 1);
  assert.equal(trackers[0].id, b.id);
});

test('видалений пристрій втрачає доступ', async () => {
  const device = await createDevice('На видалення');
  const tracker = deviceClient(device.token);

  const before = await tracker.get('/api/devices/me');
  assert.equal(before.status, 200);

  await client.del(`/api/devices/${device.id}`);

  const after = await tracker.get('/api/devices/me');
  assert.equal(after.status, 401);
});

test('запис із пристрою позначається source=auto і device_id', async () => {
  await completeActiveTrip();
  const tripId = await createTrip(client, { name: 'Рейс із трекером' });
  const dev = await createDevice('Pixel');

  const res = await deviceClient(dev.token).post('/api/records', {
    date: today(), time: '11:17', action: 'Пауза',
    coords: '50.4601, 30.4634', source: 'auto'
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.duplicate, undefined, 'новий запис не має вважатись дублем');

  const list = await client.get('/api/records?limit=50');
  const created = list.data.records.find(r => r.id === res.data.id);
  assert.ok(created, 'запис має з' + "'явитися в списку");
  assert.equal(created.source, 'auto', 'запис має бути позначений як авто');
  assert.equal(created.device_id, dev.id, 'запис має посилатись на пристрій');
  assert.equal(created.trip_id, tripId);
});

test('два пристрої дають одну паузу на зупинку (дедуплікація)', async () => {
  await completeActiveTrip();
  await createTrip(client, { name: 'Рейс на двох телефонах' });
  const a = await createDevice('Телефон A');
  const b = await createDevice('Телефон B');

  const first = await deviceClient(a.token).post('/api/records', {
    date: today(), time: '12:41', action: 'Пауза',
    coords: '50.4455, 30.4712', source: 'auto'
  });
  assert.equal(first.status, 200);
  assert.equal(first.data.duplicate, undefined);

  const second = await deviceClient(b.token).post('/api/records', {
    date: today(), time: '12:43', action: 'Пауза',
    coords: '50.4457, 30.4715', source: 'auto'
  });
  assert.equal(second.data.duplicate, true, 'пауза з іншого телефону поруч — дубль');

  const all = await client.get('/api/records?limit=50');
  const pauses = all.data.records.filter(r => r.action === 'Пауза' && r.time.startsWith('12:4'));
  assert.equal(pauses.length, 1, 'на одну зупинку має бути одна пауза');
});
