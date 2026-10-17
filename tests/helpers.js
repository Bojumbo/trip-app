'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { once } = require('events');

const ADMIN_PASSWORD = 'test-password';

/**
 * Піднімає застосунок на випадковому порту з тимчасовою БД.
 * ENV має бути виставлене ДО require('../src/app').
 */
async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-test-'));

  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(dir, 'test.sqlite');
  process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.TRUST_PROXY = '0';
  delete process.env.DATA_DIR;

  const { createApp } = require('../src/app');
  const app = createApp({ adminPassword: ADMIN_PASSWORD });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise(resolve => server.close(resolve));
      try { require('../src/db').close(); } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };
}

/**
 * Додатковий інстанс застосунку на тій самій БД (свій лімітер у памʼяті).
 * Не чіпає ENV і не закриває БД — для перевірки лімітів у межах одного процесу.
 */
async function startAppOnly(adminPassword = ADMIN_PASSWORD) {
  const { createApp } = require('../src/app');
  const app = createApp({ adminPassword });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function createClient(base) {
  let cookie = '';

  async function request(method, url, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie && !opts.noCookie) headers.Cookie = cookie;

    const res = await fetch(base + url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      const raw = setCookies[0];
      cookie = raw.split(';')[0];
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }

    return { status: res.status, data, headers: res.headers };
  }

  return {
    get: (url, opts) => request('GET', url, undefined, opts),
    post: (url, body, opts) => request('POST', url, body, opts),
    put: (url, body, opts) => request('PUT', url, body, opts),
    patch: (url, body, opts) => request('PATCH', url, body, opts),
    del: (url, opts) => request('DELETE', url, undefined, opts),
    login: (password = ADMIN_PASSWORD) => request('POST', '/api/login', { password }, { noCookie: true }),
    get cookie() { return cookie; }
  };
}

/** Створює рейс і повертає його id. */
async function createTrip(client, overrides = {}) {
  const res = await client.post('/api/trips', {
    name: 'Тестовий рейс',
    start_date: '2026-10-17',
    start_time: '08:00',
    start_odometer: 100000,
    ...overrides
  });
  if (res.status !== 200) throw new Error(`Не вдалося створити рейс: ${JSON.stringify(res.data)}`);
  return res.data.id;
}

module.exports = { startTestServer, startAppOnly, createClient, createTrip, ADMIN_PASSWORD };
