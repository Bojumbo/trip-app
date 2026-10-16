const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

// Перевірка секретів
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? null : 'dev_jwt_secret_key_trip_tracker_123');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? null : 'admin123');

if (IS_PROD && (!JWT_SECRET || !ADMIN_PASSWORD)) {
  console.error('❌ КРИТИЧНА ПОМИЛКА: У продакшн-режимі змінні JWT_SECRET та ADMIN_PASSWORD є обов\'язковими!');
  process.exit(1);
}

if (!IS_PROD && (!process.env.JWT_SECRET || !process.env.ADMIN_PASSWORD)) {
  console.warn('⚠️ УВАГА: Сервер запущено в режимі розробки з дефолтними секретами. Задайте ADMIN_PASSWORD та JWT_SECRET у файлі .env');
}

// Довіряти reverse proxy для коректного визначення client IP
app.set('trust proxy', 1);

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'database.sqlite'));

// Оптимізація SQLite: режим WAL та швидка синхронізація
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// 1. Ініціалізація структури БД (Рейси, Доставки, Записи, Дії)
db.exec(`
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

  CREATE INDEX IF NOT EXISTS idx_records_date_time ON records(date, time);
  CREATE INDEX IF NOT EXISTS idx_records_odometer ON records(odometer);
  CREATE INDEX IF NOT EXISTS idx_records_is_reported ON records(is_reported);
  CREATE INDEX IF NOT EXISTS idx_records_trip_id ON records(trip_id);
  CREATE INDEX IF NOT EXISTS idx_records_delivery_id ON records(delivery_id);
  CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
  CREATE INDEX IF NOT EXISTS idx_deliveries_trip_id ON deliveries(trip_id);
`);

// 2. Міграції для існуючих таблиць
const recordCols = db.pragma('table_info(records)').map(c => c.name);
if (!recordCols.includes('is_reported')) {
  db.exec('ALTER TABLE records ADD COLUMN is_reported INTEGER DEFAULT 0');
}
if (!recordCols.includes('trip_id')) {
  db.exec('ALTER TABLE records ADD COLUMN trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL');
}
if (!recordCols.includes('delivery_id')) {
  db.exec('ALTER TABLE records ADD COLUMN delivery_id INTEGER REFERENCES deliveries(id) ON DELETE SET NULL');
}

// 3. Автоматична міграція існуючих даних у «Рейс #1», якщо база вже мала записи
const tripsCount = db.prepare('SELECT count(*) as count FROM trips').get().count;
const unassignedRecords = db.prepare('SELECT count(*) as count FROM records WHERE trip_id IS NULL').get().count;

if (tripsCount === 0 && unassignedRecords > 0) {
  const firstRec = db.prepare('SELECT date, time, odometer FROM records ORDER BY date ASC, time ASC, id ASC LIMIT 1').get();
  const lastRec = db.prepare('SELECT date, time, odometer FROM records ORDER BY date DESC, time DESC, id DESC LIMIT 1').get();

  const initTrip = db.prepare(`
    INSERT INTO trips (name, status, start_date, start_time, start_odometer, end_date, end_time, end_odometer, notes)
    VALUES (?, 'completed', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Рейс #1 (Початковий)',
    firstRec ? firstRec.date : new Date().toISOString().slice(0, 10),
    firstRec ? firstRec.time : '08:00',
    firstRec ? firstRec.odometer : null,
    lastRec ? lastRec.date : null,
    lastRec ? lastRec.time : null,
    lastRec ? lastRec.odometer : null,
    'Автоматично створений рейс для збереженої історії'
  );
  db.prepare('UPDATE records SET trip_id = ? WHERE trip_id IS NULL').run(initTrip.lastInsertRowid);
}

// Зв'язуємо існуючі пари загрузок/вигрузок у доставки, якщо таблиця deliveries порожня
const deliveriesCount = db.prepare('SELECT count(*) as count FROM deliveries').get().count;
if (deliveriesCount === 0 && unassignedRecords > 0) {
  const loads = db.prepare(`
    SELECT * FROM records 
    WHERE (lower(action) LIKE '%загруз%' OR lower(action) LIKE '%завантаж%')
    ORDER BY date ASC, time ASC, id ASC
  `).all();

  for (const loadRec of loads) {
    const unloadRec = db.prepare(`
      SELECT * FROM records 
      WHERE (lower(action) LIKE '%вигруз%' OR lower(action) LIKE '%розвантаж%')
        AND (date > ? OR (date = ? AND time >= ?))
        AND delivery_id IS NULL
      ORDER BY date ASC, time ASC, id ASC
      LIMIT 1
    `).get(loadRec.date, loadRec.date, loadRec.time);

    const cargoText = loadRec.comment ? loadRec.comment.slice(0, 255) : (loadRec.location ? `Вантаж (${loadRec.location})` : 'Вантаж');
    const isCompleted = unloadRec !== undefined;
    const info = db.prepare(`
      INSERT INTO deliveries (trip_id, cargo, load_record_id, unload_record_id, status)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      loadRec.trip_id || 1,
      cargoText,
      loadRec.id,
      unloadRec ? unloadRec.id : null,
      isCompleted ? 'delivered' : 'in_transit'
    );
    const delId = info.lastInsertRowid;
    db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(delId, loadRec.id);
    if (unloadRec) {
      db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(delId, unloadRec.id);
    }
  }
}

const countActions = db.prepare('SELECT count(*) as count FROM actions').get();
if (countActions.count === 0) {
  const insertAction = db.prepare('INSERT INTO actions (name) VALUES (?)');
  ['Загрузка', 'Вигрузка', 'Пауза', 'Відкрив зміну', 'Закрив зміну', 'Інше (коментар)'].forEach(a => insertAction.run(a));
}

// Безпекові заголовки
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiter для захисту від brute-force з очищенням пам'яті
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of loginAttempts.entries()) {
    if (rec.lockedUntil && now >= rec.lockedUntil) {
      loginAttempts.delete(ip);
    } else if (!rec.lockedUntil && now - rec.firstAttempt > ATTEMPT_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();

function getClientIp(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };

  if (record.lockedUntil) {
    if (now < record.lockedUntil) {
      const waitMin = Math.ceil((record.lockedUntil - now) / 60000);
      return { allowed: false, message: `Забагато спроб входу. Зачекайте ${waitMin} хв.` };
    }
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }

  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  if (now - record.firstAttempt > ATTEMPT_WINDOW_MS) {
    record.count = 1;
    record.firstAttempt = now;
  } else {
    record.count += 1;
  }

  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCK_TIME_MS;
  }
  loginAttempts.set(ip, record);
}

function clearFailedLogin(ip) {
  loginAttempts.delete(ip);
}

function verifyPassword(inputPassword, storedPassword) {
  if (!storedPassword || !inputPassword) return false;
  if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$')) {
    try {
      return bcrypt.compareSync(inputPassword, storedPassword);
    } catch {
      return false;
    }
  }
  try {
    const inputBuf = Buffer.from(inputPassword, 'utf8');
    const storedBuf = Buffer.from(storedPassword, 'utf8');
    if (inputBuf.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(inputBuf, storedBuf);
  } catch {
    return false;
  }
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Не авторизовано' });
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний або прострочений токен' });
  }
}

// 1. Авторизація
app.post('/api/login', (req, res) => {
  const clientIp = getClientIp(req);
  const rateLimit = checkRateLimit(clientIp);
  if (!rateLimit.allowed) {
    return res.status(429).json({ success: false, error: rateLimit.message });
  }

  const { password } = req.body;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ success: false, error: 'Введіть пароль' });
  }

  if (verifyPassword(password.trim(), ADMIN_PASSWORD)) {
    clearFailedLogin(clientIp);
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token });
  }

  recordFailedLogin(clientIp);
  res.status(401).json({ success: false, error: 'Невірний пароль' });
});

// ==========================================
// 2. КЕРУВАННЯ РЕЙСАМИ (TRIPS)
// ==========================================

// Отримати активний рейс та його відкриті доставки
app.get('/api/trips/active', authMiddleware, (req, res) => {
  try {
    const activeTrip = db.prepare("SELECT * FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    if (!activeTrip) {
      return res.json({ activeTrip: null, activeDeliveries: [] });
    }

    const activeDeliveries = db.prepare(`
      SELECT d.*, 
             r.location as load_location, 
             r.date as load_date, 
             r.time as load_time,
             r.odometer as load_odometer
      FROM deliveries d
      LEFT JOIN records r ON d.load_record_id = r.id
      WHERE d.trip_id = ? AND d.status = 'in_transit'
      ORDER BY d.id ASC
    `).all(activeTrip.id);

    res.json({ activeTrip, activeDeliveries });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Список усіх рейсів
app.get('/api/trips', authMiddleware, (req, res) => {
  try {
    const trips = db.prepare(`
      SELECT t.*,
        (SELECT count(*) FROM records r WHERE r.trip_id = t.id) as records_count,
        (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id) as deliveries_count,
        (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id AND d.status = 'delivered') as delivered_count
      FROM trips t
      ORDER BY t.id DESC
    `).all();
    res.json(trips);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Створення / Відкриття нового рейсу
app.post('/api/trips', authMiddleware, (req, res) => {
  const { name, start_date, start_time, start_odometer, notes } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Вкажіть назву або маршрут рейсу' });

  // Перевірка чи немає вже активного рейсу
  const existingActive = db.prepare("SELECT id, name FROM trips WHERE status = 'active' LIMIT 1").get();
  if (existingActive) {
    return res.status(400).json({ 
      error: `Вже є активний "${existingActive.name}" (#${existingActive.id}). Спочатку завершіть його!` 
    });
  }

  const sDate = start_date || new Date().toISOString().slice(0, 10);
  const sTime = start_time || new Date().toTimeString().slice(0, 5);
  const sOdo = (start_odometer !== '' && start_odometer !== null && !isNaN(start_odometer)) ? Math.round(Number(start_odometer)) : null;

  try {
    const stmt = db.prepare(`
      INSERT INTO trips (name, status, start_date, start_time, start_odometer, notes)
      VALUES (?, 'active', ?, ?, ?, ?)
    `);
    const info = stmt.run(name.trim(), sDate, sTime, sOdo, notes ? String(notes).trim().slice(0, 1000) : '');
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Завершення рейсу
app.post('/api/trips/:id/complete', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { end_date, end_time, end_odometer, notes } = req.body;

  const eDate = end_date || new Date().toISOString().slice(0, 10);
  const eTime = end_time || new Date().toTimeString().slice(0, 5);
  const eOdo = (end_odometer !== '' && end_odometer !== null && !isNaN(end_odometer)) ? Math.round(Number(end_odometer)) : null;

  try {
    const info = db.prepare(`
      UPDATE trips 
      SET status = 'completed', end_date = ?, end_time = ?, end_odometer = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).run(eDate, eTime, eOdo, notes ? String(notes).trim().slice(0, 1000) : null, id);

    if (info.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Рейс не знайдено' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Повні деталі рейсу: доставки, зміни, події
app.get('/api/trips/:id/details', authMiddleware, (req, res) => {
  const { id } = req.params;
  try {
    const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
    if (!trip) return res.status(404).json({ error: 'Рейс не знайдено' });

    const deliveries = db.prepare(`
      SELECT d.*, 
        lr.date as load_date, lr.time as load_time, lr.location as load_location, lr.odometer as load_odometer,
        ur.date as unload_date, ur.time as unload_time, ur.location as unload_location, ur.odometer as unload_odometer
      FROM deliveries d
      LEFT JOIN records lr ON d.load_record_id = lr.id
      LEFT JOIN records ur ON d.unload_record_id = ur.id
      WHERE d.trip_id = ?
      ORDER BY d.id ASC
    `).all(id);

    const records = db.prepare('SELECT * FROM records WHERE trip_id = ? ORDER BY date ASC, time ASC, id ASC').all(id);

    res.json({ trip, deliveries, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Довідник дій
app.get('/api/actions', authMiddleware, (req, res) => {
  const actions = db.prepare('SELECT name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

// Останній заповнений одометр (> 0)
app.get('/api/odometer/last', authMiddleware, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT odometer FROM records 
      WHERE odometer IS NOT NULL 
        AND odometer != '' 
        AND CAST(odometer AS INTEGER) > 0 
      ORDER BY date DESC, time DESC, id DESC 
      LIMIT 1
    `).get();
    res.json({ lastOdometer: row ? row.odometer : '' });
  } catch (err) {
    res.json({ lastOdometer: '' });
  }
});

// Допоміжна валідація запису
function validateRecordInput(body) {
  const { date, time, action, odometer } = body;
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) {
    return 'Некоректний формат дати (очікується YYYY-MM-DD)';
  }
  if (!time || typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time)) {
    return 'Некоректний формат часу (очікується HH:MM)';
  }
  if (!action || typeof action !== 'string' || action.trim() === '') {
    return 'Поле "Дія" є обов\'язковим';
  }
  if (odometer !== undefined && odometer !== null && odometer !== '') {
    const odo = Number(odometer);
    if (isNaN(odo) || odo < 0 || !Number.isInteger(odo)) {
      return 'Одометр має бути невід\'ємним цілим числом';
    }
  }
  return null;
}

// Додавання одного запису (з авто-прив'язкою до Рейсу та Доставки)
app.post('/api/records', authMiddleware, (req, res) => {
  const error = validateRecordInput(req.body);
  if (error) return res.status(400).json({ error });

  const { date, time, odometer, action, location, comment, coords, is_reported, cargo, delivery_id, trip_id } = req.body;
  try {
    const odoNum = (odometer !== '' && odometer !== null && !isNaN(odometer)) ? Math.round(Number(odometer)) : null;
    const isReportedVal = is_reported ? 1 : 0;
    const locClean = location ? String(location).trim().slice(0, 255) : '';
    const commClean = comment ? String(comment).trim().slice(0, 2000) : '';
    const coordsClean = coords ? String(coords).trim().slice(0, 100) : '';

    // Якщо trip_id не вказано - беремо активний рейс
    let targetTripId = trip_id ? Number(trip_id) : null;
    if (!targetTripId) {
      const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
      if (active) targetTripId = active.id;
    }

    let assignedDeliveryId = delivery_id ? Number(delivery_id) : null;
    const actLower = action.trim().toLowerCase();

    const insertTx = db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported, trip_id, delivery_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(date, time, odoNum, action.trim(), locClean, commClean, coordsClean, isReportedVal, targetTripId, assignedDeliveryId);
      const newRecordId = info.lastInsertRowid;

      // Якщо дія - Загрузка: створюємо нову Доставку
      if (targetTripId && (actLower.includes('загруз') || actLower.includes('завантаж'))) {
        const cargoDesc = cargo ? String(cargo).trim().slice(0, 255) : (locClean ? `Вантаж (${locClean})` : 'Вантаж');
        const delInfo = db.prepare(`
          INSERT INTO deliveries (trip_id, cargo, load_record_id, status)
          VALUES (?, ?, ?, 'in_transit')
        `).run(targetTripId, cargoDesc, newRecordId);
        assignedDeliveryId = delInfo.lastInsertRowid;
        db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(assignedDeliveryId, newRecordId);
      }

      // Якщо дія - Вигрузка: завершуємо відповідну Доставку
      if (targetTripId && (actLower.includes('вигруз') || actLower.includes('розвантаж'))) {
        let targetDel = null;
        if (assignedDeliveryId) {
          targetDel = db.prepare('SELECT id FROM deliveries WHERE id = ?').get(assignedDeliveryId);
        } else {
          // Беремо найпершу відкриту доставку цього рейсу
          targetDel = db.prepare("SELECT id FROM deliveries WHERE trip_id = ? AND status = 'in_transit' ORDER BY id ASC LIMIT 1").get(targetTripId);
        }

        if (targetDel) {
          assignedDeliveryId = targetDel.id;
          db.prepare(`
            UPDATE deliveries 
            SET unload_record_id = ?, status = 'delivered' 
            WHERE id = ?
          `).run(newRecordId, targetDel.id);
          db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(targetDel.id, newRecordId);
        }
      }

      return newRecordId;
    });

    const newId = insertTx();
    res.json({ success: true, id: newId, trip_id: targetTripId, delivery_id: assignedDeliveryId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Парсер TSV
function parseTSV(text) {
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentCell += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === '\t' && !insideQuotes) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if ((char === '\r' || char === '\n') && !insideQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      currentRow.push(currentCell.trim());
      currentCell = '';
      if (currentRow.some(c => c !== '')) rows.push(currentRow);
      currentRow = [];
    } else {
      currentCell += char;
    }
  }
  if (currentCell || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some(c => c !== '')) rows.push(currentRow);
  }
  return rows;
}

// Масовий імпорт
app.post('/api/records/bulk-import', authMiddleware, (req, res) => {
  const { rawText } = req.body;
  if (!rawText) return res.status(400).json({ error: 'Текст для імпорту порожній' });

  try {
    const rows = parseTSV(rawText.trim());
    const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
    const targetTripId = active ? active.id : 1;

    const stmt = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported, trip_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const insertTx = db.transaction(() => {
      for (const col of rows) {
        if (!col || col.length < 3) continue;
        if (col[0].toLowerCase().includes('дата')) continue;

        let d = col[0] ? col[0].trim() : '';
        if (d.includes('.')) {
          const p = d.split('.');
          if (p.length === 3) {
            let year = p[2].trim();
            if (year.length === 2) year = '20' + year;
            d = `${year}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
          }
        }

        let t = col[1] ? col[1].trim() : '';
        if (t.length > 5 && t.includes(':')) {
          t = t.slice(0, 5);
        }

        const odoRaw = col[2] ? col[2].toString().trim() : '';
        const odo = (odoRaw !== '' && !isNaN(odoRaw)) ? Math.round(Number(odoRaw)) : null;
        const act = col[3] ? col[3].trim() : 'Інше (коментар)';
        const loc = col[4] ? col[4].trim() : '';
        const comm = col[5] ? col[5].trim() : '';
        const coords = col[6] ? col[6].trim() : '';
        let isReported = 0;
        if (col[7]) {
          const val = col[7].toLowerCase().trim();
          if (val === 'так' || val === 'yes' || val === '1' || val === 'true') isReported = 1;
        }

        if (d && t && act) {
          stmt.run(d, t, odo, act, loc, comm, coords, isReported, targetTripId);
          count++;
        }
      }
    });

    insertTx();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Таблиця записів (з фільтрацією за trip_id)
app.get('/api/records', authMiddleware, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = req.query.search ? String(req.query.search).trim() : '';
  const dateFrom = req.query.date_from ? String(req.query.date_from).trim() : '';
  const dateTo = req.query.date_to ? String(req.query.date_to).trim() : '';
  const isReported = req.query.is_reported;
  const tripId = req.query.trip_id;

  const whereClauses = [];
  const params = [];

  if (tripId) {
    whereClauses.push('trip_id = ?');
    params.push(tripId);
  }

  if (search) {
    whereClauses.push('(location LIKE ? OR comment LIKE ? OR action LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term);
  }

  if (dateFrom) {
    whereClauses.push('date >= ?');
    params.push(dateFrom);
  }

  if (dateTo) {
    whereClauses.push('date <= ?');
    params.push(dateTo);
  }

  if (isReported !== undefined && isReported !== '') {
    whereClauses.push('is_reported = ?');
    params.push(isReported === '1' ? 1 : 0);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const totalStmt = db.prepare(`SELECT count(*) as total FROM records ${whereSql}`);
  const total = totalStmt.get(...params).total;

  const recordsStmt = db.prepare(`
    SELECT r.*, t.name as trip_name, d.cargo as delivery_cargo
    FROM records r
    LEFT JOIN trips t ON r.trip_id = t.id
    LEFT JOIN deliveries d ON r.delivery_id = d.id
    ${whereSql} 
    ORDER BY r.date DESC, r.time DESC, r.id DESC 
    LIMIT ? OFFSET ?
  `);
  const records = recordsStmt.all(...params, limit, offset);

  res.json({ records, total, hasMore: offset + records.length < total });
});

// Редагування запису
app.put('/api/records/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const error = validateRecordInput(req.body);
  if (error) return res.status(400).json({ error });

  const { date, time, odometer, action, location, comment, coords, is_reported, trip_id, delivery_id } = req.body;
  try {
    const odoNum = (odometer !== '' && odometer !== null && !isNaN(odometer)) ? Math.round(Number(odometer)) : null;
    const isReportedVal = is_reported ? 1 : 0;
    const locClean = location ? String(location).trim().slice(0, 255) : '';
    const commClean = comment ? String(comment).trim().slice(0, 2000) : '';
    const coordsClean = coords ? String(coords).trim().slice(0, 100) : '';

    const info = db.prepare(`
      UPDATE records 
      SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?, coords = ?, is_reported = ?, trip_id = COALESCE(?, trip_id), delivery_id = ?
      WHERE id = ?
    `).run(date, time, odoNum, action.trim(), locClean, commClean, coordsClean, isReportedVal, trip_id || null, delivery_id || null, id);

    if (info.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Запис не знайдено' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Швидке перемикання статусу "Звіт здано"
app.patch('/api/records/:id/report-status', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { is_reported } = req.body;
  const isReportedVal = is_reported ? 1 : 0;
  try {
    const info = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?').run(isReportedVal, id);
    if (info.changes > 0) {
      res.json({ success: true, id: Number(id), is_reported: isReportedVal });
    } else {
      res.status(404).json({ error: 'Запис не знайдено' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Масове перемикання статусу "Звіт здано"
app.post('/api/records/bulk-report-status', authMiddleware, (req, res) => {
  const { ids, is_reported } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Список ID порожній або некоректний' });
  }
  const isReportedVal = is_reported ? 1 : 0;
  try {
    const updateStmt = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?');
    const updateTx = db.transaction(() => {
      for (const id of ids) {
        updateStmt.run(isReportedVal, id);
      }
    });
    updateTx();
    res.json({ success: true, count: ids.length, is_reported: isReportedVal });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Видалення запису
app.delete('/api/records/:id', authMiddleware, (req, res) => {
  try {
    const info = db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
    if (info.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Запис не знайдено' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Всі записи для Звіту (хронологічно: date ASC, time ASC, id ASC)
app.get('/api/records/all', authMiddleware, (req, res) => {
  try {
    const dateFrom = req.query.date_from ? String(req.query.date_from).trim() : '';
    const dateTo = req.query.date_to ? String(req.query.date_to).trim() : '';
    const tripId = req.query.trip_id;

    const whereClauses = [];
    const params = [];

    if (tripId) {
      whereClauses.push('trip_id = ?');
      params.push(tripId);
    }
    if (dateFrom) {
      whereClauses.push('date >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      whereClauses.push('date <= ?');
      params.push(dateTo);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const records = db.prepare(`SELECT * FROM records ${whereSql} ORDER BY date ASC, time ASC, id ASC`).all(...params);
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Глобальний обробник помилок
app.use((err, req, res, next) => {
  console.error('Неперехоплена помилка:', err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер працює на порті ${PORT} (${IS_PROD ? 'production' : 'development'})`);
});

// Коректне закриття бази даних при завершенні процесу
function gracefulShutdown(signal) {
  console.log(`\nЗупинка сервера за сигналом ${signal}...`);
  server.close(() => {
    try {
      db.close();
      console.log('✅ З\'єднання з SQLite успішно закрито.');
    } catch (e) {
      console.error('Помилка закриття SQLite:', e);
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));