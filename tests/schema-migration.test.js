'use strict';

/**
 * Міграції схеми на ІСНУЮЧІЙ базі.
 *
 * На всяк випадок: саме тут вибухнув продакшн. У DDL був
 * `CREATE INDEX ... idx_records_source ON records(source)`, а на старій БД
 * `CREATE TABLE IF NOT EXISTS records` не виконується — колонки `source` ще немає.
 * Тести зі свіжою БД цього не бачили, бо там колонку створює CREATE TABLE.
 * Тому перевіряємо обидва сценарії: повністю стару БД і «напівмігровану».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { initSchema, DDL } = require('../src/db/schema');

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

const NEW_TABLES_SQL = `
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    token_hash TEXT UNIQUE NOT NULL, platform TEXT DEFAULT 'android',
    is_tracker INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER
  );
  CREATE TABLE track_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
    mode TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
    distance_m INTEGER, points INTEGER, polyline TEXT,
    pause_record_id INTEGER REFERENCES records(id) ON DELETE SET NULL,
    client_uuid TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

function withLegacyDb(extraSql = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-mig-'));
  const file = path.join(dir, 'legacy.sqlite');
  const db = new Database(file);
  db.exec(LEGACY_SQL);
  if (extraSql) db.exec(extraSql);
  return {
    db,
    columns: () => db.pragma('table_info(records)').map(c => c.name),
    indexExists: (name) => !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?"
    ).get(name),
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('повністю стара БИ: initSchema не падає і додає нові колонки', () => {
  const t = withLegacyDb();
  try {
    initSchema(t.db);

    const cols = t.columns();
    for (const col of ['client_uuid', 'source', 'device_id']) {
      assert.ok(cols.includes(col), `колонка ${col} має з'явитися`);
    }
    assert.ok(t.indexExists('idx_records_source'), 'індекс на source має бути створений');

    // Старі записи отримують значення за замовчуванням, а не NULL
    const row = t.db.prepare('SELECT source, device_id FROM records LIMIT 1').get();
    assert.equal(row.source, 'manual');
    assert.equal(row.device_id, null);

    // Нові таблиці тепер існують
    const tables = t.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('devices','track_segments')"
    ).all().map(r => r.name).sort();
    assert.deepEqual(tables, ['devices', 'track_segments']);
  } finally {
    t.close();
  }
});

test('«напівмігрована» БД (новий таблиці без source): initSchema не падає', () => {
  // Саме такий стан зараз у продакшені: DDL встиг створити devices/track_segments
  // і впав на індексі. Міграція має довільно довершитись.
  const t = withLegacyDb(NEW_TABLES_SQL);
  try {
    initSchema(t.db);
    assert.ok(t.columns().includes('source'), 'source має додатися');
    assert.ok(t.indexExists('idx_records_source'), 'індекс має створитися');
  } finally {
    t.close();
  }
});

test('initSchema ідемпотентний — повторний запуск не ламає БД', () => {
  const t = withLegacyDb();
  try {
    initSchema(t.db);
    assert.doesNotThrow(() => initSchema(t.db));
    assert.equal(t.db.prepare('SELECT count(*) AS c FROM records').get().c, 1);
  } finally {
    t.close();
  }
});

test('дані старого запису зберігаються після міграції', () => {
  const t = withLegacyDb();
  try {
    initSchema(t.db);
    const r = t.db.prepare('SELECT date, time, odometer, action, location, trip_id FROM records').get();
    assert.deepEqual(r, {
      date: '2026-10-01',
      time: '08:10',
      odometer: 100010,
      action: 'Загрузка',
      location: 'Київ',
      trip_id: 1
    });
  } finally {
    t.close();
  }
});

test('індекси DDL не ламаються на старій БД (прогон самого DDL)', () => {
  // Запобіжник від класу помилок «no such column» на міграції.
  //
  // Статично визначити небезпечний індекс неможливо: `idx_records_is_reported`
  // теж стоїть на міграційній колонці, але безпечний — він існував у першій
  // версії схеми, тому на старій БД вже створений і IF NOT EXISTS спрацьовує.
  // А от новий індекс на новій колонці — падає. Різниця історична, не структурна.
  //
  // Тому перевіряємо прямо: відкриваємо стару БД і виконуємо **самий DDL** —
  // як це робить initSchema першим кроком. Якщо хоч один індекс стоїть на
  // колонці, якої на старій БД немає, exec впаде тут.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trip-ddl-'));
  const file = path.join(dir, 'old.sqlite');
  const old = new Database(file);
  try {
    // Схема першої версії: без client_uuid/source/device_id, без devices/track_segments
    old.exec(LEGACY_SQL);
    old.exec(`
      CREATE INDEX IF NOT EXISTS idx_records_date_time ON records(date, time);
      CREATE INDEX IF NOT EXISTS idx_records_odometer ON records(odometer);
      CREATE INDEX IF NOT EXISTS idx_records_is_reported ON records(is_reported);
      CREATE INDEX IF NOT EXISTS idx_records_trip_id ON records(trip_id);
      CREATE INDEX IF NOT EXISTS idx_records_delivery_id ON records(delivery_id);
      CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
      CREATE INDEX IF NOT EXISTS idx_deliveries_trip_id ON deliveries(trip_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);
    old.close();

    const reopened = new Database(file);
    try {
      assert.doesNotThrow(() => reopened.exec(DDL), 'DDL має виконуватись на старій БД без помилок');
    } finally {
      reopened.close();
    }
  } finally {
    try { old.close(); } catch { /* вже закрита */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
