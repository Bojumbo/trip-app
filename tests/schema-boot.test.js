'use strict';

/**
 * Спалювання справжнього продакшн-шляху: підняти застосунок на ФАЙЛІ
 * зі старою схемою.
 *
 * Саме цього не вистачало, коли продакшн упав з «no such column: source»:
 * усі тести створювали свіжу БД, де колонку додає CREATE TABLE, тож шлях
 * міграції на існуючій БД ніхто не перевіряв.
 *
 * node:test запускає кожен файл в окремому процесі, тому сінглтон `../src/db`
 * тут ініціалізується саме з нашим DB_PATH.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const LEGACY_SQL = `
  CREATE TABLE trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, status TEXT DEFAULT 'active',
    start_date TEXT NOT NULL, start_time TEXT NOT NULL, start_odometer INTEGER,
    end_date TEXT, end_time TEXT, end_odometer INTEGER, notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    cargo TEXT, load_record_id INTEGER, unload_record_id INTEGER,
    status TEXT DEFAULT 'in_transit', created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, time TEXT NOT NULL,
    odometer INTEGER, action TEXT NOT NULL, location TEXT, comment TEXT, coords TEXT,
    is_reported INTEGER DEFAULT 0,
    trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
    delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE actions (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL);
  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
  );
  INSERT INTO actions (name) VALUES ('Загрузка');
  INSERT INTO trips (name, status, start_date, start_time, start_odometer)
    VALUES ('Старий рейс', 'active', '2026-10-01', '08:00', 100000);
  INSERT INTO records (date, time, odometer, action, location, trip_id)
    VALUES ('2026-10-01', '08:10', 100010, 'Загрузка', 'Київ', 1);
`;

let tmpDir;

test.before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-boot-'));
  const file = path.join(tmpDir, 'database.sqlite');
  const legacy = new Database(file);
  legacy.exec(LEGACY_SQL);
  legacy.close();

  // ENV має бути виставлене ДО require('../src/db') — воно читає config.DB_PATH
  process.env.NODE_ENV = 'production';
  process.env.DB_PATH = file;
  process.env.ADMIN_PASSWORD = 'boot-test-password';
  process.env.TRUST_PROXY = '0';
});

test.after(() => {
  try { require('../src/db').close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('застосунок піднімається на старій БД і мігрує її', () => {
  // Якщо міграція впаде — require кине виняток і тест червонкий
  const db = require('../src/db');

  const cols = db.pragma('table_info(records)').map(c => c.name);
  for (const col of ['client_uuid', 'source', 'device_id']) {
    assert.ok(cols.includes(col), `колонка ${col} має з'явитися після міграції`);
  }

  assert.equal(db.prepare('SELECT count(*) AS c FROM records').get().c, 1);
  assert.equal(db.prepare('SELECT count(*) AS c FROM trips').get().c, 1);
  assert.equal(
    db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='index' AND name='idx_records_source'").get().c,
    1
  );
});

test('після міграції застосунок реально працює (Express + API)', async () => {
  const { createApp } = require('../src/app');
  const app = createApp({ adminPassword: 'boot-test-password' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  try {
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    const login = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'boot-test-password' })
    });
    assert.equal(login.status, 200);

    const cookie = login.headers.getSetCookie()[0].split(';')[0];
    const records = await fetch(`${base}/api/records?limit=10`, { headers: { Cookie: cookie } });
    assert.equal(records.status, 200);

    const body = await records.json();
    assert.equal(body.total, 1, 'стара запис має зберегтися');
    assert.equal(body.records[0].source, 'manual');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
