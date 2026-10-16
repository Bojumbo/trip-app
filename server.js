const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '2856023b';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'database.sqlite'));

// Ініціалізація структури БД
db.exec(`
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
`);

// Міграція для існуючих БД: перевірка наявності поля is_reported
const tableInfo = db.pragma('table_info(records)');
if (!tableInfo.some(col => col.name === 'is_reported')) {
  db.exec('ALTER TABLE records ADD COLUMN is_reported INTEGER DEFAULT 0');
}

const countActions = db.prepare('SELECT count(*) as count FROM actions').get();
if (countActions.count === 0) {
  const insertAction = db.prepare('INSERT INTO actions (name) VALUES (?)');
  ['Загрузка', 'Вигрузка', 'Пауза', 'Відкрив зміну', 'Закрив зміну', 'Інше (коментар)'].forEach(a => insertAction.run(a));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiter для входу (захист від brute-force)
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_TIME_MS = 15 * 60 * 1000; // 15 хвилин

function checkRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  if (!record) return { allowed: true };
  if (record.lockedUntil && now < record.lockedUntil) {
    const waitMin = Math.ceil((record.lockedUntil - now) / 60000);
    return { allowed: false, message: `Забагато спроб входу. Зачекайте ${waitMin} хв.` };
  }
  if (record.lockedUntil && now >= record.lockedUntil) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
  record.count += 1;
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
  // Якщо збережений пароль це bcrypt-хеш
  if (storedPassword.startsWith('$2a$') || storedPassword.startsWith('$2b$')) {
    try {
      return bcrypt.compareSync(inputPassword, storedPassword);
    } catch {
      return false;
    }
  }
  // Пряме порівняння відкритих рядків
  return inputPassword === storedPassword;
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Не авторизовано' });
  const token = authHeader.split(' ')[1];
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Недійсний токен' });
  }
}

// 1. Авторизація
app.post('/api/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
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

// 2. Довідник дій
app.get('/api/actions', authMiddleware, (req, res) => {
  const actions = db.prepare('SELECT name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

// 3. Останній заповнений одометр (> 0)
app.get('/api/odometer/last', authMiddleware, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT odometer FROM records 
      WHERE odometer IS NOT NULL 
        AND odometer != '' 
        AND CAST(odometer AS INTEGER) > 0 
      ORDER BY id DESC 
      LIMIT 1
    `).get();
    res.json({ lastOdometer: row ? row.odometer : '' });
  } catch (err) {
    res.json({ lastOdometer: '' });
  }
});

// Допоміжна валідація запису
function validateRecordInput(body) {
  const { date, time, action } = body;
  if (!date || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return 'Некоректний формат дати (очікується YYYY-MM-DD)';
  }
  if (!time || typeof time !== 'string' || !/^\d{1,2}:\d{2}$/.test(time)) {
    return 'Некоректний формат часу (очікується HH:MM)';
  }
  if (!action || typeof action !== 'string' || action.trim() === '') {
    return 'Поле "Дія" є обов\'язковим';
  }
  return null;
}

// 4. Додавання одного запису
app.post('/api/records', authMiddleware, (req, res) => {
  const error = validateRecordInput(req.body);
  if (error) return res.status(400).json({ error });

  const { date, time, odometer, action, location, comment, coords, is_reported } = req.body;
  try {
    const odoNum = (odometer !== '' && odometer !== null && !isNaN(odometer)) ? Number(odometer) : null;
    const isReportedVal = is_reported ? 1 : 0;
    const locClean = location ? String(location).slice(0, 255) : '';
    const commClean = comment ? String(comment).slice(0, 2000) : '';
    const coordsClean = coords ? String(coords).slice(0, 100) : '';

    const stmt = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(date, time, odoNum, action.trim(), locClean, commClean, coordsClean, isReportedVal);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Парсер TSV з лапками для імпорту
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

// 6. Масовий імпорт
app.post('/api/records/bulk-import', authMiddleware, (req, res) => {
  const { rawText } = req.body;
  if (!rawText) return res.status(400).json({ error: 'Текст для імпорту порожній' });

  try {
    const rows = parseTSV(rawText.trim());
    const stmt = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords, is_reported)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const insertTx = db.transaction(() => {
      for (const col of rows) {
        if (!col || col.length < 3) continue;
        if (col[0].toLowerCase().includes('дата')) continue;

        let d = col[0] ? col[0].trim() : '';
        if (d.includes('.')) {
          const p = d.split('.');
          if (p.length === 3) d = `${p[2]}-${p[1].padStart(2, '0')}-${p[0].padStart(2, '0')}`;
        }

        const t = col[1] ? col[1].trim() : '';
        const odoRaw = col[2] ? col[2].toString().trim() : '';
        const odo = (odoRaw !== '' && !isNaN(odoRaw)) ? Number(odoRaw) : null;
        const act = col[3] ? col[3].trim() : 'Інше (коментар)';
        const loc = col[4] ? col[4].trim() : '';
        const comm = col[5] ? col[5].trim() : '';
        const coords = col[6] ? col[6].trim() : '';
        // Якщо є колонка зі статусом звіту
        let isReported = 0;
        if (col[7]) {
          const val = col[7].toLowerCase().trim();
          if (val === 'так' || val === 'yes' || val === '1' || val === 'true') isReported = 1;
        }

        stmt.run(d, t, odo, act, loc, comm, coords, isReported);
        count++;
      }
    });

    insertTx();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Таблиця (Пагінація)
app.get('/api/records', authMiddleware, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 500);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const records = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT count(*) as total FROM records').get().total;

  res.json({ records, total, hasMore: offset + records.length < total });
});

// 8. Редагування запису
app.put('/api/records/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const error = validateRecordInput(req.body);
  if (error) return res.status(400).json({ error });

  const { date, time, odometer, action, location, comment, is_reported } = req.body;
  try {
    const odoNum = (odometer !== '' && odometer !== null && !isNaN(odometer)) ? Number(odometer) : null;
    const isReportedVal = is_reported ? 1 : 0;
    const locClean = location ? String(location).slice(0, 255) : '';
    const commClean = comment ? String(comment).slice(0, 2000) : '';

    const info = db.prepare(`
      UPDATE records 
      SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?, is_reported = ?
      WHERE id = ?
    `).run(date, time, odoNum, action.trim(), locClean, commClean, isReportedVal, id);

    if (info.changes > 0) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Запис не знайдено' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Швидке перемикання статусу "Звіт здано" (Так / Ні) для окремого елемента
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

// 10. Масове перемикання статусу "Звіт здано" для списку ID (наприклад, для всієї зміни)
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

// 11. Видалення запису
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

// 12. Всі записи для Звіту
app.get('/api/records/all', authMiddleware, (req, res) => {
  const records = db.prepare('SELECT * FROM records ORDER BY id ASC').all();
  res.json(records);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер працює на порті ${PORT}`);
});