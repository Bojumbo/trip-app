'use strict';

const logger = require('../logger');

const DDL = `
  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'active',
    start_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    start_odometer INTEGER,
    end_date TEXT,
    end_time TEXT,
    end_odometer INTEGER,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    cargo TEXT,
    load_record_id INTEGER,
    unload_record_id INTEGER,
    status TEXT DEFAULT 'in_transit',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    odometer INTEGER,
    action TEXT NOT NULL,
    location TEXT,
    comment TEXT,
    coords TEXT,
    is_reported INTEGER DEFAULT 0,
    trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
    delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_records_date_time ON records(date, time);
  CREATE INDEX IF NOT EXISTS idx_records_odometer ON records(odometer);
  CREATE INDEX IF NOT EXISTS idx_records_is_reported ON records(is_reported);
  CREATE INDEX IF NOT EXISTS idx_records_trip_id ON records(trip_id);
  CREATE INDEX IF NOT EXISTS idx_records_delivery_id ON records(delivery_id);
  CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_trip_id ON deliveries(trip_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`;

const DEFAULT_ACTIONS = [
  'Загрузка',
  'Вигрузка',
  'Пауза',
  'Відкрив зміну',
  'Закрив зміну',
  'Інше (коментар)'
];

function tableColumns(db, table) {
  return db.pragma(`table_info(${table})`).map(c => c.name);
}

function addColumnIfMissing(db, table, column, ddl) {
  if (!tableColumns(db, table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Видаляє посилання на неіснуючі сутності, щоб увімкнення FK не ламало запис. */
function cleanupOrphans(db) {
  db.transaction(() => {
    db.exec(`UPDATE records SET trip_id = NULL
             WHERE trip_id IS NOT NULL AND trip_id NOT IN (SELECT id FROM trips)`);
    db.exec(`UPDATE records SET delivery_id = NULL
             WHERE delivery_id IS NOT NULL AND delivery_id NOT IN (SELECT id FROM deliveries)`);
    db.exec('DELETE FROM deliveries WHERE trip_id NOT IN (SELECT id FROM trips)');
    db.exec(`UPDATE deliveries SET load_record_id = NULL
             WHERE load_record_id IS NOT NULL AND load_record_id NOT IN (SELECT id FROM records)`);
    db.exec(`UPDATE deliveries SET unload_record_id = NULL
             WHERE unload_record_id IS NOT NULL AND unload_record_id NOT IN (SELECT id FROM records)`);
  })();
}

/** Створює «Рейс #1» для історії, що лишилась без прив'язки. */
function seedInitialTrip(db) {
  const tripsCount = db.prepare('SELECT count(*) AS count FROM trips').get().count;
  const unassigned = db.prepare('SELECT count(*) AS count FROM records WHERE trip_id IS NULL').get().count;

  if (tripsCount !== 0 || unassigned === 0) return;

  const first = db.prepare('SELECT date, time, odometer FROM records ORDER BY date ASC, time ASC, id ASC LIMIT 1').get();
  const last = db.prepare('SELECT date, time, odometer FROM records ORDER BY date DESC, time DESC, id DESC LIMIT 1').get();

  const info = db.prepare(`
    INSERT INTO trips (name, status, start_date, start_time, start_odometer, end_date, end_time, end_odometer, notes)
    VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Рейс #1 (Початковий)',
    first ? first.date : new Date().toISOString().slice(0, 10),
    first ? first.time : '08:00',
    first ? first.odometer : null,
    last ? last.date : null,
    last ? last.time : null,
    last ? last.odometer : null,
    'Автоматично створений рейс для збереженої історії'
  );

  db.prepare('UPDATE records SET trip_id = ? WHERE trip_id IS NULL').run(info.lastInsertRowid);
}

/** Зв'язує старі пари «загрузка/вигрузка» у доставки. */
function backfillDeliveries(db) {
  const deliveriesCount = db.prepare('SELECT count(*) AS count FROM deliveries').get().count;
  if (deliveriesCount !== 0) return;

  const loads = db.prepare(`
    SELECT * FROM records
    WHERE (lower(action) LIKE '%загруз%' OR lower(action) LIKE '%завантаж%')
    ORDER BY date ASC, time ASC, id ASC
  `).all();

  if (loads.length === 0) return;

  const insertDelivery = db.prepare(`
    INSERT INTO deliveries (trip_id, cargo, load_record_id, unload_record_id, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const findUnload = db.prepare(`
    SELECT * FROM records
    WHERE (lower(action) LIKE '%вигруз%' OR lower(action) LIKE '%розвантаж%')
      AND (date > ? OR (date = ? AND time >= ?))
      AND delivery_id IS NULL
    ORDER BY date ASC, time ASC, id ASC
    LIMIT 1
  `);
  const linkRecord = db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?');

  db.transaction(() => {
    for (const loadRec of loads) {
      if (loadRec.delivery_id) continue;

      const unloadRec = findUnload.get(loadRec.date, loadRec.date, loadRec.time);
      const cargo = loadRec.comment
        ? loadRec.comment.slice(0, 255)
        : (loadRec.location ? `Вантаж (${loadRec.location})` : 'Вантаж');

      const info = insertDelivery.run(
        loadRec.trip_id || null,
        cargo,
        loadRec.id,
        unloadRec ? unloadRec.id : null,
        unloadRec ? 'delivered' : 'in_transit'
      );

      linkRecord.run(info.lastInsertRowid, loadRec.id);
      if (unloadRec) linkRecord.run(info.lastInsertRowid, unloadRec.id);
    }
  })();
}

function seedActions(db) {
  const count = db.prepare('SELECT count(*) AS count FROM actions').get().count;
  if (count > 0) return;
  const insert = db.prepare('INSERT INTO actions (name) VALUES (?)');
  DEFAULT_ACTIONS.forEach(a => insert.run(a));
}

/** Повна ініціалізація схеми. Ідемпотентна — можна викликати при кожному старті. */
function initSchema(db) {
  db.exec(DDL);

  addColumnIfMissing(db, 'records', 'is_reported', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'records', 'trip_id', 'INTEGER REFERENCES trips(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'records', 'delivery_id', 'INTEGER REFERENCES deliveries(id) ON DELETE SET NULL');
  addColumnIfMissing(db, 'records', 'client_uuid', 'TEXT');
  addColumnIfMissing(db, 'trips', 'notes', 'TEXT');

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_client_uuid ON records(client_uuid) WHERE client_uuid IS NOT NULL');

  cleanupOrphans(db);
  db.pragma('foreign_keys = ON');

  seedInitialTrip(db);
  backfillDeliveries(db);
  seedActions(db);

  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

  logger.info('db_ready', {
    path: db.name,
    records: db.prepare('SELECT count(*) AS c FROM records').get().c,
    trips: db.prepare('SELECT count(*) AS c FROM trips').get().c
  });
}

module.exports = { initSchema, DDL, DEFAULT_ACTIONS };
