/**
 * Trip Tracker — сервер
 * Express + better-sqlite3. Один процес, синхронна БД.
 */

'use strict';

// .env підтримується, але не є обов'язковим (у Docker змінні приходять з оточення)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv не встановлено — працюємо лише з process.env
}

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ==========================================
// КОНФІГУРАЦІЯ (fail fast)
// ==========================================
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'tt_sid';
const MAX_RECORDS_ALL = 50000;
const MAX_REPORT_RECORDS = 20000;
const BULK_IMPORT_LIMIT = '5mb';
const JSON_LIMIT = '1mb';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function logWarn(msg, extra) { console.warn(JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg, ...extra })); }
function logError(msg, extra) { console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', msg, ...extra })); }

/**
 * У продакшн-режимі пароль обов'язковий.
 * У розробці допускається тимчасовий пароль, але з гучним попередженням.
 */
function resolveAdminPassword() {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv && fromEnv.length >= 6) return fromEnv;
  if (IS_PROD) {
    logError('ADMIN_PASSWORD не задано або коротший за 6 символів — запуск неможливий');
    process.exit(1);
  }
  logWarn('ADMIN_PASSWORD не задано. Використовується тимчасовий пароль "admin123" (лише для розробки).');
  return 'admin123';
}

const ADMIN_PASSWORD = resolveAdminPassword();

// ==========================================
// БАЗА ДАНИХ
// ==========================================
const db = new Database(path.join(dataDir, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');

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
`);

// --- Міграції для існуючих баз ---
function tableColumns(table) {
  return db.pragma(`table_info(${table})`).map(c => c.name);
}
function addColumnIfMissing(table, column, ddl) {
  if (!tableColumns(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

addColumnIfMissing('records', 'is_reported', 'INTEGER DEFAULT 0');
addColumnIfMissing('records', 'trip_id', 'INTEGER REFERENCES trips(id) ON DELETE SET NULL');
addColumnIfMissing('records', 'delivery_id', 'INTEGER REFERENCES deliveries(id) ON DELETE SET NULL');
addColumnIfMissing('records', 'client_uuid', 'TEXT');
addColumnIfMissing('trips', 'notes', 'TEXT');

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_client_uuid ON records(client_uuid) WHERE client_uuid IS NOT NULL');

// --- Прибирання «сиріт» перед увімкненням зовнішніх ключів ---
const orphanCleanup = db.transaction(() => {
  db.exec(`UPDATE records SET trip_id = NULL
           WHERE trip_id IS NOT NULL AND trip_id NOT IN (SELECT id FROM trips)`);
  db.exec(`UPDATE records SET delivery_id = NULL
           WHERE delivery_id IS NOT NULL AND delivery_id NOT IN (SELECT id FROM deliveries)`);
  db.exec(`DELETE FROM deliveries WHERE trip_id NOT IN (SELECT id FROM trips)`);
  db.exec(`UPDATE deliveries SET load_record_id = NULL
           WHERE load_record_id IS NOT NULL AND load_record_id NOT IN (SELECT id FROM records)`);
  db.exec(`UPDATE deliveries SET unload_record_id = NULL
           WHERE unload_record_id IS NOT NULL AND unload_record_id NOT IN (SELECT id FROM records)`);
});
orphanCleanup();

// Тепер зовнішні ключі справді працюють (CASCADE / SET NULL)
db.pragma('foreign_keys = ON');

// --- Початкові дані ---
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

const deliveriesCount = db.prepare('SELECT count(*) as count FROM deliveries').get().count;
if (deliveriesCount === 0 && unassignedRecords > 0) {
  const loads = db.prepare(`
    SELECT * FROM records
    WHERE (lower(action) LIKE '%загруз%' OR lower(action) LIKE '%завантаж%')
    ORDER BY date ASC, time ASC, id ASC
  `).all();

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

  const backfill = db.transaction(() => {
    for (const loadRec of loads) {
      if (loadRec.delivery_id) continue;
      const unloadRec = findUnload.get(loadRec.date, loadRec.date, loadRec.time);
      const cargoText = loadRec.comment
        ? loadRec.comment.slice(0, 255)
        : (loadRec.location ? `Вантаж (${loadRec.location})` : 'Вантаж');
      const info = insertDelivery.run(
        loadRec.trip_id || null,
        cargoText,
        loadRec.id,
        unloadRec ? unloadRec.id : null,
        unloadRec ? 'delivered' : 'in_transit'
      );
      linkRecord.run(info.lastInsertRowid, loadRec.id);
      if (unloadRec) linkRecord.run(info.lastInsertRowid, unloadRec.id);
    }
  });
  backfill();
}

const countActions = db.prepare('SELECT count(*) as count FROM actions').get();
if (countActions.count === 0) {
  const insertAction = db.prepare('INSERT INTO actions (name) VALUES (?)');
  ['Загрузка', 'Вигрузка', 'Пауза', 'Відкрив зміну', 'Закрив зміну', 'Інше (коментар)'].forEach(a => insertAction.run(a));
}

db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// ==========================================
// ЛОГУВАННЯ
// ==========================================
function log(level, msg, extra) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

// ==========================================
// ДОПОМІЖНІ ФУНКЦІЇ
// ==========================================
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || 'ERROR';
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}
function isValidTime(value) {
  return typeof value === 'string' && TIME_RE.test(value);
}
function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}
function parseInteger(value, { min = 0, max = 99999999 } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num < min || num > max) return null;
  return num;
}
function parseBool(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}
function requireDate(value, field) {
  if (!isValidDate(value)) throw new ApiError(400, `Некоректна дата (${field}) — очікується YYYY-MM-DD`);
  return value;
}
function requireTime(value, field) {
  if (!isValidTime(value)) throw new ApiError(400, `Некоректний час (${field}) — очікується HH:MM`);
  return value;
}

function validateRecordInput(body) {
  const date = requireDate(body.date, 'дата');
  const time = requireTime(body.time, 'час');
  const action = cleanText(body.action, 100);
  if (!action) throw new ApiError(400, 'Поле «Дія» є обов\'язковим');

  const odometer = parseInteger(body.odometer);
  if (body.odometer !== undefined && body.odometer !== null && body.odometer !== '' && odometer === null) {
    throw new ApiError(400, 'Одометр має бути невід\'ємним цілим числом');
  }

  return {
    date,
    time,
    action,
    odometer,
    location: cleanText(body.location, 255),
    comment: cleanText(body.comment, 2000),
    coords: cleanText(body.coords, 100),
    is_reported: parseBool(body.is_reported) ? 1 : 0,
    trip_id: body.trip_id ? Number(body.trip_id) : null,
    delivery_id: body.delivery_id ? Number(body.delivery_id) : null,
    cargo: cleanText(body.cargo, 255),
    client_uuid: body.client_uuid ? cleanText(body.client_uuid, 64) : null
  };
}

function actionKind(action) {
  const a = String(action || '').toLowerCase();
  if (a.includes('загруз') || a.includes('завантаж')) return 'load';
  if (a.includes('вигруз') || a.includes('розвантаж')) return 'unload';
  return null;
}

function getTripOrFail(id) {
  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(id);
  if (!trip) throw new ApiError(404, 'Рейс не знайдено');
  return trip;
}

// ==========================================
// EXPRESS
// ==========================================
const app = express();
app.disable('x-powered-by');

// ---- Довіра до проксі (Cloudflare Tunnel / cloudflared у приватній мережі) ----
function isPrivateAddress(ip) {
  if (!ip) return false;
  const s = String(ip).replace(/^::ffff:/i, '').toLowerCase();
  if (s === '::1' || s === 'localhost') return true;
  if (s.includes(':')) {
    return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
  }
  const parts = s.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function resolveTrustProxy() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return isPrivateAddress; // безпечний дефолт
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true') {
    logWarn('TRUST_PROXY=true — довіряємо будь-якому X-Forwarded-For. Використовуйте лише за надійним проксі.');
    return true;
  }
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return isPrivateAddress;
}
app.set('trust proxy', resolveTrustProxy());

// ---- Безпекові заголовки ----
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  if (IS_PROD && (req.secure || req.headers['x-forwarded-proto'] === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

// ---- Логування API-запитів ----
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    log('info', 'request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      ip: req.ip
    });
  });
  next();
});

// ---- Розбір тіла запиту ----
// Імпорт має власний, більший ліміт, тому для нього глобальний парсер пропускаємо
const jsonParser = express.json({ limit: JSON_LIMIT });
app.use((req, res, next) => {
  if (req.path === '/api/records/bulk-import') return next();
  return jsonParser(req, res, next);
});

// ==========================================
// RATE LIMITING
// ==========================================
function createLimiter({ windowMs, max, blockMs, message }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of buckets.entries()) {
      if (rec.blockedUntil && now >= rec.blockedUntil) buckets.delete(key);
      else if (!rec.blockedUntil && now - rec.firstSeen > windowMs) buckets.delete(key);
    }
  }, 60 * 1000);
  timer.unref();

  return function limiter(req, res, next) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let rec = buckets.get(key);
    if (!rec) {
      rec = { count: 0, firstSeen: now, blockedUntil: 0 };
      buckets.set(key, rec);
    }
    if (rec.blockedUntil) {
      if (now < rec.blockedUntil) {
        const waitMin = Math.ceil((rec.blockedUntil - now) / 60000);
        res.setHeader('Retry-After', String(Math.ceil((rec.blockedUntil - now) / 1000)));
        return res.status(429).json({ error: `Забагато запитів. Зачекайте ${waitMin} хв.` });
      }
      buckets.delete(key);
      rec = { count: 0, firstSeen: now, blockedUntil: 0 };
      buckets.set(key, rec);
    }
    if (now - rec.firstSeen > windowMs) {
      rec.count = 0;
      rec.firstSeen = now;
    }
    rec.count++;
    if (rec.count > max) {
      rec.blockedUntil = now + blockMs;
      log('warn', 'rate_limit_blocked', { ip: req.ip, path: req.path });
      return res.status(429).json({ error: message });
    }
    next();
  };
}

const loginLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  blockMs: 15 * 60 * 1000,
  message: 'Забагато спроб входу. Спробуйте через 15 хвилин.'
});

const apiLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 600,
  blockMs: 60 * 1000,
  message: 'Перевищено ліміт запитів. Спробуйте за хвилину.'
});

/**
 * Глобальний запобіжник для входу: навіть якщо IP підробити (X-Forwarded-For),
 * розподілений перебір впирається у спільний ліміт невдалих спроб.
 */
const globalLoginGuard = { failures: 0, windowStart: Date.now(), blockedUntil: 0 };
const GLOBAL_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_LOGIN_MAX_FAILURES = 30;

function globalLoginBlocked() {
  const now = Date.now();
  if (globalLoginGuard.blockedUntil && now < globalLoginGuard.blockedUntil) return true;
  if (globalLoginGuard.blockedUntil && now >= globalLoginGuard.blockedUntil) {
    globalLoginGuard.blockedUntil = 0;
    globalLoginGuard.failures = 0;
    globalLoginGuard.windowStart = now;
  }
  if (now - globalLoginGuard.windowStart > GLOBAL_LOGIN_WINDOW_MS) {
    globalLoginGuard.failures = 0;
    globalLoginGuard.windowStart = now;
  }
  return false;
}
function registerGlobalFailure() {
  globalLoginGuard.failures++;
  if (globalLoginGuard.failures >= GLOBAL_LOGIN_MAX_FAILURES) {
    globalLoginGuard.blockedUntil = Date.now() + GLOBAL_LOGIN_WINDOW_MS;
    log('warn', 'global_login_block', { failures: globalLoginGuard.failures });
  }
}

// ==========================================
// СЕСІЇ (httpOnly cookie)
// ==========================================
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
    }
  }
  return out;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(req, res, token) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function createSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token_hash, created_at, last_seen, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), now, now, now + SESSION_TTL_MS);
  setSessionCookie(req, res, token);
}

function verifyPassword(input, stored) {
  if (!stored || !input) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(input, stored);
    } catch {
      return false;
    }
  }
  // Порівняння сталої тривалості незалежно від довжини рядків
  const a = crypto.createHash('sha256').update(String(input), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(stored), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });

  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Сесія завершилась. Увійдіть знову.' });
  }

  // Ковзне продовження сесії (не частіше ніж раз на добу)
  const now = Date.now();
  if (now - row.last_seen > 24 * 60 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?')
      .run(now, now + SESSION_TTL_MS, row.id);
    setSessionCookie(req, res, token);
  }

  req.session = row;
  next();
}

// Захист від CSRF для змінювальних запитів (додатково до SameSite=Strict)
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // не-браузерні клієнти (curl) не надсилають Origin
  try {
    const expectedHost = req.headers.host;
    if (new URL(origin).host !== expectedHost) {
      return res.status(403).json({ error: 'Запит відхилено (CSRF)' });
    }
  } catch {
    return res.status(403).json({ error: 'Запит відхилено (CSRF)' });
  }
  next();
}

// ==========================================
// СЛУЖБОВІ МАРШРУТИ
// ==========================================
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  } catch (e) {
    res.status(503).json({ status: 'error' });
  }
});

app.post('/api/login', loginLimiter, (req, res) => {
  if (globalLoginBlocked()) {
    return res.status(429).json({ error: 'Тимчасово заблоковано через велику кількість невдалих спроб. Спробуйте пізніше.' });
  }

  const password = req.body && req.body.password;
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Введіть пароль' });
  }
  if (!verifyPassword(password.trim(), ADMIN_PASSWORD)) {
    registerGlobalFailure();
    log('warn', 'login_failed', { ip: req.ip });
    return res.status(401).json({ error: 'Невірний пароль' });
  }
  globalLoginGuard.failures = 0;
  createSession(req, res);
  log('info', 'login_success', { ip: req.ip });
  res.json({ success: true });
});

app.post('/api/logout', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.session.id);
  clearSessionCookie(res);
  res.json({ success: true });
});

app.get('/api/session', authMiddleware, (req, res) => {
  res.json({ authenticated: true });
});

// Далі — усе під авторизацією
app.use('/api', apiLimiter, csrfGuard, authMiddleware);

// ==========================================
// ДОВІДНИКИ
// ==========================================
app.get('/api/actions', (req, res) => {
  const actions = db.prepare('SELECT name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

app.get('/api/odometer/last', (req, res) => {
  const row = db.prepare(`
    SELECT odometer FROM records
    WHERE odometer IS NOT NULL AND CAST(odometer AS INTEGER) > 0
    ORDER BY date DESC, time DESC, id DESC
    LIMIT 1
  `).get();
  res.json({ lastOdometer: row ? row.odometer : '' });
});

// ==========================================
// РЕЙСИ
// ==========================================
app.get('/api/trips/active', (req, res) => {
  const activeTrip = db.prepare("SELECT * FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!activeTrip) return res.json({ activeTrip: null, activeDeliveries: [] });

  const activeDeliveries = db.prepare(`
    SELECT d.*, r.location AS load_location, r.date AS load_date, r.time AS load_time, r.odometer AS load_odometer
    FROM deliveries d
    LEFT JOIN records r ON d.load_record_id = r.id
    WHERE d.trip_id = ? AND d.status = 'in_transit'
    ORDER BY d.id ASC
  `).all(activeTrip.id);

  res.json({ activeTrip, activeDeliveries });
});

app.get('/api/trips', (req, res) => {
  const trips = db.prepare(`
    SELECT t.*,
      (SELECT count(*) FROM records r WHERE r.trip_id = t.id) AS records_count,
      (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id) AS deliveries_count,
      (SELECT count(*) FROM deliveries d WHERE d.trip_id = t.id AND d.status = 'delivered') AS delivered_count
    FROM trips t
    ORDER BY t.id DESC
  `).all();
  res.json(trips);
});

app.post('/api/trips', (req, res) => {
  const body = req.body || {};
  const name = cleanText(body.name, 255);
  if (!name) throw new ApiError(400, 'Вкажіть назву або маршрут рейсу');

  const startDate = body.start_date ? requireDate(body.start_date, 'дата початку') : new Date().toISOString().slice(0, 10);
  const startTime = body.start_time ? requireTime(body.start_time, 'час початку') : new Date().toTimeString().slice(0, 5);

  let startOdometer = null;
  if (body.start_odometer !== undefined && body.start_odometer !== null && body.start_odometer !== '') {
    startOdometer = parseInteger(body.start_odometer);
    if (startOdometer === null) throw new ApiError(400, 'Початковий одометр має бути невід\'ємним цілим числом');
  }

  const existingActive = db.prepare("SELECT id, name FROM trips WHERE status = 'active' LIMIT 1").get();
  if (existingActive) {
    throw new ApiError(409, `Вже є активний «${existingActive.name}» (#${existingActive.id}). Спочатку завершіть його.`);
  }

  const info = db.prepare(`
    INSERT INTO trips (name, status, start_date, start_time, start_odometer, notes)
    VALUES (?, 'active', ?, ?, ?, ?)
  `).run(name, startDate, startTime, startOdometer, cleanText(body.notes, 1000));

  res.json({ success: true, id: info.lastInsertRowid });
});

app.put('/api/trips/:id', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  const body = req.body || {};
  const name = body.name !== undefined ? cleanText(body.name, 255) : trip.name;
  if (!name) throw new ApiError(400, 'Назва рейсу не може бути порожньою');

  const startDate = body.start_date !== undefined ? requireDate(body.start_date, 'дата початку') : trip.start_date;
  const startTime = body.start_time !== undefined ? requireTime(body.start_time, 'час початку') : trip.start_time;

  let startOdometer = trip.start_odometer;
  if (body.start_odometer !== undefined) {
    startOdometer = parseInteger(body.start_odometer);
    if (body.start_odometer !== null && body.start_odometer !== '' && startOdometer === null) {
      throw new ApiError(400, 'Початковий одометр має бути невід\'ємним цілим числом');
    }
  }

  const notes = body.notes !== undefined ? cleanText(body.notes, 1000) : trip.notes;

  db.prepare(`
    UPDATE trips SET name = ?, start_date = ?, start_time = ?, start_odometer = ?, notes = ? WHERE id = ?
  `).run(name, startDate, startTime, startOdometer, notes, trip.id);

  res.json({ success: true });
});

app.delete('/api/trips/:id', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  const withRecords = parseBool(req.query.with_records);

  const run = db.transaction(() => {
    const deliveryIds = db.prepare('SELECT id FROM deliveries WHERE trip_id = ?').all(trip.id).map(d => d.id);
    for (const id of deliveryIds) {
      db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(id);
    }
    db.prepare('DELETE FROM deliveries WHERE trip_id = ?').run(trip.id);

    let deletedRecords = 0;
    if (withRecords) {
      deletedRecords = db.prepare('DELETE FROM records WHERE trip_id = ?').run(trip.id).changes;
    } else {
      db.prepare('UPDATE records SET trip_id = NULL WHERE trip_id = ?').run(trip.id);
    }
    db.prepare('DELETE FROM trips WHERE id = ?').run(trip.id);
    return { deletedRecords };
  });

  const result = run();
  log('info', 'trip_deleted', { tripId: trip.id, withRecords, ip: req.ip });
  res.json({ success: true, ...result });
});

app.post('/api/trips/:id/complete', (req, res) => {
  const trip = getTripOrFail(req.params.id);
  if (trip.status !== 'active') throw new ApiError(409, 'Цей рейс вже завершено');

  const body = req.body || {};
  const endDate = body.end_date ? requireDate(body.end_date, 'дата завершення') : new Date().toISOString().slice(0, 10);
  const endTime = body.end_time ? requireTime(body.end_time, 'час завершення') : new Date().toTimeString().slice(0, 5);

  let endOdometer = null;
  if (body.end_odometer !== undefined && body.end_odometer !== null && body.end_odometer !== '') {
    endOdometer = parseInteger(body.end_odometer);
    if (endOdometer === null) throw new ApiError(400, 'Кінцевий одометр має бути невід\'ємним цілим числом');
  }
  if (endOdometer !== null && trip.start_odometer !== null && endOdometer < trip.start_odometer) {
    throw new ApiError(400, 'Кінцевий одометр не може бути меншим за початковий');
  }

  const notes = body.notes !== undefined && body.notes !== '' ? cleanText(body.notes, 1000) : trip.notes;

  const complete = db.transaction(() => {
    // Відкриті доставки не мають висіти «В дорозі» вічно
    const closed = db.prepare(`
      UPDATE deliveries SET status = 'incomplete'
      WHERE trip_id = ? AND status = 'in_transit'
    `).run(trip.id).changes;

    db.prepare(`
      UPDATE trips SET status = 'completed', end_date = ?, end_time = ?, end_odometer = ?, notes = ? WHERE id = ?
    `).run(endDate, endTime, endOdometer, notes, trip.id);

    return closed;
  });

  const closedDeliveries = complete();
  res.json({ success: true, closedDeliveries });
});

app.get('/api/trips/:id/details', (req, res) => {
  const trip = getTripOrFail(req.params.id);

  const deliveries = db.prepare(`
    SELECT d.*,
      lr.date AS load_date, lr.time AS load_time, lr.location AS load_location, lr.odometer AS load_odometer,
      ur.date AS unload_date, ur.time AS unload_time, ur.location AS unload_location, ur.odometer AS unload_odometer
    FROM deliveries d
    LEFT JOIN records lr ON d.load_record_id = lr.id
    LEFT JOIN records ur ON d.unload_record_id = ur.id
    WHERE d.trip_id = ?
    ORDER BY d.id ASC
  `).all(trip.id);

  const records = db.prepare('SELECT * FROM records WHERE trip_id = ? ORDER BY date ASC, time ASC, id ASC').all(trip.id);

  res.json({ trip, deliveries, records });
});

// Агрегований звіт: один запит замість N+1
app.get('/api/report', (req, res) => {
  const tripId = req.query.trip_id ? Number(req.query.trip_id) : null;

  const trips = tripId
    ? db.prepare('SELECT * FROM trips WHERE id = ?').all(tripId)
    : db.prepare('SELECT * FROM trips ORDER BY id DESC').all();

  const tripIds = trips.map(t => t.id);
  if (tripIds.length === 0) {
    const unassigned = db.prepare('SELECT * FROM records WHERE trip_id IS NULL ORDER BY date DESC, time DESC, id DESC LIMIT 200').all();
    return res.json({ trips: [], deliveries: [], records: [], unassigned });
  }

  const placeholders = tripIds.map(() => '?').join(',');

  const total = db.prepare(`SELECT count(*) c FROM records WHERE trip_id IN (${placeholders})`).get(...tripIds).c;
  if (total > MAX_REPORT_RECORDS) {
    throw new ApiError(413, `Забагато записів для звіту (${total}). Оберіть конкретний рейс.`);
  }

  const deliveries = db.prepare(`
    SELECT d.*,
      lr.date AS load_date, lr.time AS load_time, lr.location AS load_location, lr.odometer AS load_odometer,
      ur.date AS unload_date, ur.time AS unload_time, ur.location AS unload_location, ur.odometer AS unload_odometer
    FROM deliveries d
    LEFT JOIN records lr ON d.load_record_id = lr.id
    LEFT JOIN records ur ON d.unload_record_id = ur.id
    WHERE d.trip_id IN (${placeholders})
    ORDER BY d.id ASC
  `).all(...tripIds);

  const records = db.prepare(`
    SELECT * FROM records WHERE trip_id IN (${placeholders}) ORDER BY date ASC, time ASC, id ASC
  `).all(...tripIds);

  const unassigned = db.prepare(`
    SELECT * FROM records WHERE trip_id IS NULL ORDER BY date DESC, time DESC, id DESC LIMIT 200
  `).all();

  res.json({ trips, deliveries, records, unassigned });
});

// ==========================================
// ДОСТАВКИ
// ==========================================
app.patch('/api/deliveries/:id', (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) throw new ApiError(404, 'Доставку не знайдено');

  const body = req.body || {};
  const cargo = body.cargo !== undefined ? cleanText(body.cargo, 255) : delivery.cargo;
  const allowed = ['in_transit', 'delivered', 'incomplete'];
  const status = body.status !== undefined ? String(body.status) : delivery.status;
  if (!allowed.includes(status)) throw new ApiError(400, 'Некоректний статус доставки');

  db.prepare('UPDATE deliveries SET cargo = ?, status = ? WHERE id = ?').run(cargo, status, delivery.id);
  res.json({ success: true });
});

app.delete('/api/deliveries/:id', (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) throw new ApiError(404, 'Доставку не знайдено');

  const run = db.transaction(() => {
    db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(delivery.id);
    db.prepare('DELETE FROM deliveries WHERE id = ?').run(delivery.id);
  });
  run();
  res.json({ success: true });
});

// ==========================================
// ЗАПИСИ
// ==========================================
function insertRecord(input) {
  const kind = actionKind(input.action);

  const tx = db.transaction(() => {
    let tripId = input.trip_id;
    if (tripId) {
      const exists = db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId);
      if (!exists) throw new ApiError(400, 'Вказаний рейс не існує');
    } else {
      const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
      tripId = active ? active.id : null;
    }

    let deliveryId = input.delivery_id;
    if (deliveryId) {
      const del = db.prepare('SELECT id FROM deliveries WHERE id = ?').get(deliveryId);
      if (!del) throw new ApiError(400, 'Вказану доставку не знайдено');
    }

    const info = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported, trip_id, delivery_id, client_uuid)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.date, input.time, input.odometer, input.action, input.location, input.comment,
      input.coords, input.is_reported, tripId, deliveryId, input.client_uuid
    );
    const recordId = info.lastInsertRowid;

    if (tripId && kind === 'load') {
      const cargoDesc = input.cargo || (input.location ? `Вантаж (${input.location})` : 'Вантаж');
      const delInfo = db.prepare(`
        INSERT INTO deliveries (trip_id, cargo, load_record_id, status) VALUES (?, ?, ?, 'in_transit')
      `).run(tripId, cargoDesc, recordId);
      deliveryId = delInfo.lastInsertRowid;
      db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(deliveryId, recordId);
    }

    if (tripId && kind === 'unload') {
      let target = null;
      if (deliveryId) {
        target = db.prepare('SELECT id, status FROM deliveries WHERE id = ?').get(deliveryId);
        if (target && target.status === 'delivered') {
          db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(target.id, recordId);
          return { recordId, tripId, deliveryId, warning: null };
        }
      } else {
        // Авто-вибір: остання відкрита доставка цього рейсу
        target = db.prepare(
          "SELECT id, status FROM deliveries WHERE trip_id = ? AND status = 'in_transit' ORDER BY id DESC LIMIT 1"
        ).get(tripId);
      }

      if (target) {
        deliveryId = target.id;
        db.prepare("UPDATE deliveries SET unload_record_id = ?, status = 'delivered' WHERE id = ?")
          .run(recordId, target.id);
        db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(target.id, recordId);
      } else {
        deliveryId = null;
      }
    }

    return { recordId, tripId, deliveryId, warning: null };
  });

  const result = tx();
  if (!result.tripId && kind) {
    result.warning = 'Немає активного рейсу — запис збережено без прив\'язки до рейсу.';
  }
  return result;
}

app.post('/api/records', (req, res) => {
  const input = validateRecordInput(req.body || {});

  // Ідемпотентність для офлайн-черги
  if (input.client_uuid) {
    const existing = db.prepare('SELECT id, trip_id, delivery_id FROM records WHERE client_uuid = ?').get(input.client_uuid);
    if (existing) {
      return res.json({ success: true, id: existing.id, trip_id: existing.trip_id, delivery_id: existing.delivery_id, duplicate: true });
    }
  }

  const result = insertRecord(input);
  res.json({
    success: true,
    id: result.recordId,
    trip_id: result.tripId,
    delivery_id: result.deliveryId,
    warning: result.warning || undefined
  });
});

app.put('/api/records/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!existing) throw new ApiError(404, 'Запис не знайдено');

  const input = validateRecordInput(req.body || {});

  let tripId = existing.trip_id;
  if (input.trip_id !== null) {
    const trip = db.prepare('SELECT id FROM trips WHERE id = ?').get(input.trip_id);
    if (!trip) throw new ApiError(400, 'Вказаний рейс не існує');
    tripId = input.trip_id;
  }

  // delivery_id зберігаємо, якщо клієнт його не передав
  const deliveryId = req.body && Object.prototype.hasOwnProperty.call(req.body, 'delivery_id')
    ? input.delivery_id
    : existing.delivery_id;

  db.prepare(`
    UPDATE records
    SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?, coords = ?, is_reported = ?, trip_id = ?, delivery_id = ?
    WHERE id = ?
  `).run(
    input.date, input.time, input.odometer, input.action, input.location, input.comment,
    input.coords, input.is_reported, tripId, deliveryId, existing.id
  );

  res.json({ success: true, trip_id: tripId, delivery_id: deliveryId });
});

app.patch('/api/records/:id/report-status', (req, res) => {
  const value = parseBool(req.body && req.body.is_reported) ? 1 : 0;
  const info = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?').run(value, req.params.id);
  if (info.changes === 0) throw new ApiError(404, 'Запис не знайдено');
  res.json({ success: true, id: Number(req.params.id), is_reported: value });
});

app.post('/api/records/bulk-report-status', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    throw new ApiError(400, 'Список ID порожній або некоректний');
  }
  if (body.ids.length > 1000) throw new ApiError(400, 'Забагато записів в одному запиті (максимум 1000)');

  const ids = body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (ids.length === 0) throw new ApiError(400, 'Некоректні ID');

  const value = parseBool(body.is_reported) ? 1 : 0;
  const stmt = db.prepare('UPDATE records SET is_reported = ? WHERE id = ?');

  const run = db.transaction(() => {
    let changed = 0;
    for (const id of ids) changed += stmt.run(value, id).changes;
    return changed;
  });

  const changed = run();
  res.json({ success: true, count: changed, requested: ids.length, is_reported: value });
});

app.delete('/api/records/:id', (req, res) => {
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(req.params.id);
  if (!record) throw new ApiError(404, 'Запис не знайдено');

  const run = db.transaction(() => {
    // Якщо запис — початок доставки
    const asLoad = db.prepare('SELECT * FROM deliveries WHERE load_record_id = ?').all(record.id);
    for (const d of asLoad) {
      if (d.unload_record_id) {
        db.prepare('UPDATE deliveries SET load_record_id = NULL WHERE id = ?').run(d.id);
      } else {
        // Відкрита доставка без вигрузки втрачає сенс — видаляємо
        db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(d.id);
        db.prepare('DELETE FROM deliveries WHERE id = ?').run(d.id);
      }
    }
    // Якщо запис — завершення доставки
    db.prepare("UPDATE deliveries SET unload_record_id = NULL, status = 'in_transit' WHERE unload_record_id = ?")
      .run(record.id);

    db.prepare('DELETE FROM records WHERE id = ?').run(record.id);
  });

  run();
  log('info', 'record_deleted', { recordId: record.id, ip: req.ip });
  res.json({ success: true });
});

app.get('/api/records', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = req.query.search ? String(req.query.search).trim().slice(0, 200) : '';
  const dateFrom = req.query.date_from ? String(req.query.date_from).trim() : '';
  const dateTo = req.query.date_to ? String(req.query.date_to).trim() : '';
  const isReported = req.query.is_reported;
  const tripId = req.query.trip_id;

  const whereClauses = [];
  const params = [];

  if (tripId) {
    whereClauses.push('r.trip_id = ?');
    params.push(tripId);
  }
  if (search) {
    const term = `%${search.replace(/[\\%_]/g, ch => `\\${ch}`)}%`;
    whereClauses.push("(r.location LIKE ? ESCAPE '\\' OR r.comment LIKE ? ESCAPE '\\' OR r.action LIKE ? ESCAPE '\\')");
    params.push(term, term, term);
  }
  if (dateFrom) {
    if (!isValidDate(dateFrom)) throw new ApiError(400, 'Некоректна дата «від»');
    whereClauses.push('r.date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    if (!isValidDate(dateTo)) throw new ApiError(400, 'Некоректна дата «до»');
    whereClauses.push('r.date <= ?');
    params.push(dateTo);
  }
  if (isReported !== undefined && isReported !== '') {
    whereClauses.push('r.is_reported = ?');
    params.push(isReported === '1' ? 1 : 0);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) AS total FROM records r ${whereSql}`).get(...params).total;

  const records = db.prepare(`
    SELECT r.*, t.name AS trip_name, d.cargo AS delivery_cargo
    FROM records r
    LEFT JOIN trips t ON r.trip_id = t.id
    LEFT JOIN deliveries d ON r.delivery_id = d.id
    ${whereSql}
    ORDER BY r.date DESC, r.time DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ records, total, hasMore: offset + records.length < total });
});

app.get('/api/records/all', (req, res) => {
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
    if (!isValidDate(dateFrom)) throw new ApiError(400, 'Некоректна дата «від»');
    whereClauses.push('date >= ?');
    params.push(dateFrom);
  }
  if (dateTo) {
    if (!isValidDate(dateTo)) throw new ApiError(400, 'Некоректна дата «до»');
    whereClauses.push('date <= ?');
    params.push(dateTo);
  }

  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT count(*) c FROM records ${whereSql}`).get(...params).c;
  if (total > MAX_RECORDS_ALL) {
    throw new ApiError(413, `Забагато записів (${total}). Зменшіть період або оберіть рейс.`);
  }

  const records = db.prepare(`SELECT * FROM records ${whereSql} ORDER BY date ASC, time ASC, id ASC`).all(...params);
  res.json(records);
});

// ==========================================
// ІМПОРТ
// ==========================================
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

function normalizeImportDate(raw) {
  const value = String(raw || '').trim();
  if (DATE_RE.test(value) && isValidDate(value)) return value;
  if (value.includes('.')) {
    const p = value.split('.');
    if (p.length === 3) {
      let year = p[2].trim();
      if (year.length === 2) year = `20${year}`;
      const iso = `${year}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
      if (isValidDate(iso)) return iso;
    }
  }
  return null;
}

app.post('/api/records/bulk-import', express.json({ limit: BULK_IMPORT_LIMIT }), (req, res) => {
  const rawText = req.body && req.body.rawText;
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw new ApiError(400, 'Текст для імпорту порожній');
  }
  if (rawText.length > 3 * 1024 * 1024) throw new ApiError(413, 'Текст завеликий (максимум 3 МБ)');

  const rows = parseTSV(rawText.trim());
  const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  const requestedTrip = req.body.trip_id ? Number(req.body.trip_id) : null;
  const targetTripId = requestedTrip || (active ? active.id : null);

  if (targetTripId && !db.prepare('SELECT id FROM trips WHERE id = ?').get(targetTripId)) {
    throw new ApiError(400, 'Вказаний рейс не існує');
  }

  const existsStmt = db.prepare(`
    SELECT id FROM records WHERE date = ? AND time = ? AND action = ? AND COALESCE(odometer, -1) = COALESCE(?, -1) LIMIT 1
  `);
  const insertStmt = db.prepare(`
    INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported, trip_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const errors = [];
  let count = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    rows.forEach((col, idx) => {
      if (!col || col.length < 3) return;
      if (col[0].toLowerCase().includes('дата')) return;

      const date = normalizeImportDate(col[0]);
      const time = String(col[1] || '').trim().slice(0, 5);
      if (!date) { errors.push(`Рядок ${idx + 1}: некоректна дата «${col[0]}»`); return; }
      if (!isValidTime(time)) { errors.push(`Рядок ${idx + 1}: некоректний час «${col[1]}»`); return; }

      const odoRaw = col[2] ? String(col[2]).trim() : '';
      const odometer = odoRaw !== '' && Number.isInteger(Number(odoRaw)) && Number(odoRaw) >= 0 ? Number(odoRaw) : null;
      const action = (col[3] || '').trim() || 'Інше (коментар)';
      const location = (col[4] || '').trim().slice(0, 255);
      const comment = (col[5] || '').trim().slice(0, 2000);
      const coords = (col[6] || '').trim().slice(0, 100);
      const isReported = ['так', 'yes', '1', 'true'].includes(String(col[7] || '').toLowerCase().trim()) ? 1 : 0;

      if (existsStmt.get(date, time, action, odometer)) { skipped++; return; }

      insertStmt.run(date, time, odometer, action, location, comment, coords, isReported, targetTripId);
      count++;
    });
  });

  run();
  log('info', 'bulk_import', { count, skipped, errors: errors.length, ip: req.ip });
  res.json({ success: true, count, skipped, errors: errors.slice(0, 20), trip_id: targetTripId });
});

// ==========================================
// СТАТИКА
// ==========================================
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0 }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// 404 ТА ОБРОБНИК ПОМИЛОК
// ==========================================
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Ендпоінт не знайдено' });
  }
  res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некоректний JSON у запиті' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Запит завеликий' });
  }

  log('error', 'unhandled_error', {
    path: req.path,
    method: req.method,
    error: err && err.message,
    stack: err && err.stack
  });
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

// ==========================================
// ЗАПУСК
// ==========================================
const server = app.listen(PORT, '0.0.0.0', () => {
  log('info', 'server_started', { port: PORT, env: IS_PROD ? 'production' : 'development' });
});

const cleanupTimer = setInterval(() => {
  try {
    const removed = db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
    if (removed > 0) log('info', 'sessions_cleaned', { removed });
  } catch (e) {
    log('error', 'session_cleanup_failed', { error: e.message });
  }
}, 60 * 60 * 1000);
cleanupTimer.unref();

let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal });

  const forceTimer = setTimeout(() => {
    log('warn', 'shutdown_forced');
    process.exit(1);
  }, 10000);
  forceTimer.unref();

  server.close(() => {
    try {
      db.close();
      log('info', 'shutdown_complete');
    } catch (e) {
      log('error', 'db_close_failed', { error: e.message });
    }
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
