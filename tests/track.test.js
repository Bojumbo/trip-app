'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient, createTrip } = require('./helpers');

let server;
let client;

async function makeDevice(name = 'Android') {
  const res = await client.post('/api/devices', { name });
  assert.equal(res.status, 200);
  return res.data;
}

function trackerFor(token) {
  async function req(method, url, body) {
    const res = await fetch(server.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { status: res.status, data };
  }
  return {
    post: (url, body) => req('POST', url, body),
    get: (url) => req('GET', url)
  };
}

const POLYLINE = '_p~iF~ps|U_ulLnnqC';

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
  await client.login();
});

test.after(async () => {
  await server.close();
});

test('пристрій пише сегменти маршруту', async () => {
  const tripId = await createTrip(client, { name: 'Рейс з маршрутом' });
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{
      mode: 'drive',
      started_at: 1730000000000,
      ended_at: 1730000300000,
      distance_m: 12000,
      points: 42,
      polyline: POLYLINE,
      client_uuid: 'seg-1'
    }]
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.saved, 1);
  assert.equal(res.data.trip_id, tripId);

  const fromWeb = await client.get(`/api/trips/${tripId}/track`);
  assert.equal(fromWeb.status, 200);
  assert.equal(fromWeb.data.segments.length, 1);
  assert.equal(fromWeb.data.segments[0].mode, 'drive');
  assert.equal(fromWeb.data.segments[0].polyline, POLYLINE);
});

test('повторна відправка того ж сегмента не дублює його', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const segment = {
    mode: 'drive',
    started_at: 1730001000000,
    ended_at: 1730000600000 + 600000,
    distance_m: 500,
    polyline: POLYLINE,
    client_uuid: 'seg-dup'
  };

  const first = await tracker.post('/api/track/segments', { segments: [segment] });
  const second = await tracker.post('/api/track/segments', { segments: [segment] });

  assert.equal(first.data.saved, 1);
  assert.equal(second.data.saved, 0);
  assert.equal(second.data.skipped, 1);
});

test('некоректний режим → 400', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{ mode: 'flying', started_at: 1, ended_at: 2, polyline: POLYLINE }]
  });
  assert.equal(res.status, 400);
});

test('некоректний інтервал часу → 400', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{ mode: 'drive', started_at: 500, ended_at: 100, polyline: POLYLINE }]
  });
  assert.equal(res.status, 400);
});

test('завеликий polyline → 413', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{
      mode: 'drive',
      started_at: 1730002000000,
      ended_at: 1730002100000,
      polyline: 'x'.repeat(200001)
    }]
  });
  assert.equal(res.status, 413);
});

test('порожній список → 400', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', { segments: [] });
  assert.equal(res.status, 400);
});

test('забагато сегментів в одному запиті → 400', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const segments = Array.from({ length: 51 }, (_, i) => ({
    mode: 'still',
    started_at: 1730003000000 + i * 1000,
    ended_at: 1730003001000 + i * 1000,
    polyline: POLYLINE
  }));

  const res = await tracker.post('/api/track/segments', { segments });
  assert.equal(res.status, 400);
});

test('без активного рейсу — 409', async () => {
  // завершуємо єдиний активний рейс
  const trips = await client.get('/api/trips');
  const active = trips.data.find(t => t.status === 'active');
  if (active) await client.post(`/api/trips/${active.id}/complete`, {});

  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{
      mode: 'drive', started_at: 1730004000000, ended_at: 1730004100000, polyline: POLYLINE
    }]
  });

  assert.equal(res.status, 409);
});

test('маршрут можна читати лише з веб-застосунку', async () => {
  const tripId = await createTrip(client, { name: 'Рейс для читання' });
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.get(`/api/trips/${tripId}/track`);
  assert.equal(res.status, 403);
});

test('сегмент з неіснуючим записом паузи лишається без прив\'язки', async () => {
  const device = await makeDevice();
  const tracker = trackerFor(device.token);

  const res = await tracker.post('/api/track/segments', {
    segments: [{
      mode: 'walk',
      started_at: 1730005000000,
      ended_at: 1730005200000,
      distance_m: 250,
      polyline: POLYLINE,
      pause_record_id: 999999,
      client_uuid: 'seg-walk'
    }]
  });

  assert.equal(res.status, 200);
  const trips = await client.get('/api/trips');
  const trip = trips.data.find(t => t.status === 'active');
  const track = await client.get(`/api/trips/${trip.id}/track`);
  assert.equal(track.data.segments[0].pause_record_id, null);
  assert.equal(track.data.segments[0].mode, 'walk');
});
