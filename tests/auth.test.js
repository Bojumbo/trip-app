'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, createClient } = require('./helpers');

let server;
let client;

test.before(async () => {
  server = await startTestServer();
  client = createClient(server.base);
});

test.after(async () => {
  await server.close();
});

test('без cookie API повертає 401', async () => {
  const res = await client.get('/api/records');
  assert.equal(res.status, 401);
});

test('невірний пароль → 401', async () => {
  const res = await client.login('wrong-password');
  assert.equal(res.status, 401);
  assert.match(res.data.error, /Невірний пароль/);
});

test('порожній пароль → 400', async () => {
  const res = await client.post('/api/login', { password: '' }, { noCookie: true });
  assert.equal(res.status, 400);
});

test('успішний вхід ставить HttpOnly cookie', async () => {
  const res = await client.login();
  assert.equal(res.status, 200);
  assert.equal(res.data.success, true);

  const rawCookie = res.headers.getSetCookie().join(';');
  assert.match(rawCookie, /tt_sid=/);
  assert.match(rawCookie, /HttpOnly/);
  assert.match(rawCookie, /SameSite=Strict/);
  assert.equal(res.data.token, undefined, 'токен не має повертатися в тілі');
});

test('з cookie сесія активна', async () => {
  const res = await client.get('/api/session');
  assert.equal(res.status, 200);
  assert.equal(res.data.authenticated, true);
});

test('логаут інвалідує сесію на сервері', async () => {
  const before = client.cookie;
  const logout = await client.post('/api/logout', {});
  assert.equal(logout.status, 200);

  // навіть якщо підставити стару cookie вручну — 401
  const res = await client.get('/api/records', { headers: { Cookie: before } });
  assert.equal(res.status, 401);
});
