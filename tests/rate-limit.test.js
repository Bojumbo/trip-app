'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer, startAppOnly, createClient } = require('./helpers');

/**
 * Окремий файл (окремий процес і окремий інстанс) — лімітер живе в памʼяті,
 * тому блокування не має впливати на інші тести.
 */

let server;

test.before(async () => {
  server = await startTestServer();
});

test.after(async () => {
  await server.close();
});

test('після 5 невдалих спроб вхід блокується (429)', async () => {
  const client = createClient(server.base);
  const codes = [];

  for (let i = 0; i < 6; i++) {
    const res = await client.login('nope');
    codes.push(res.status);
  }

  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);

  // навіть правильний пароль уже не проходить
  const blocked = await client.login();
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /Забагато/);
});

test('успішний вхід не витрачає квоту невдалих спроб', async () => {
  const extra = await startAppOnly();
  try {
    const client = createClient(extra.base);

    for (let i = 0; i < 5; i++) {
      const ok = await client.login();
      assert.equal(ok.status, 200, `спроба ${i + 1} має бути успішною`);
      await client.post('/api/logout', {});
    }
  } finally {
    await extra.close();
  }
});
