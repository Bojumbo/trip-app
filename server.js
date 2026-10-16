const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// Створення папки під дані
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'database.sqlite'));

// Ініціалізація структури бази
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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );
`);

// Базові дії
const countActions = db.prepare('SELECT count(*) as count FROM actions').get();
if (countActions.count === 0) {
  const insertAction = db.prepare('INSERT INTO actions (name) VALUES (?)');
  ['Загрузка', 'Вигрузка', 'Пауза', 'Відкрив зміну', 'Закрив зміну', 'Інше (коментар)'].forEach(a => insertAction.run(a));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Middleware авторизації
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
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token });
  }
  res.status(400).json({ success: false, error: 'Невірний пароль' });
});

// 2. Дії (Спадний список)
app.get('/api/actions', authMiddleware, (req, res) => {
  const actions = db.prepare('SELECT name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

// 3. Останній показник одометра
app.get('/api/odometer/last', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT odometer FROM records WHERE odometer IS NOT NULL AND odometer != "" ORDER BY id DESC LIMIT 1').get();
  res.json({ lastOdometer: row ? row.odometer : '' });
});

// 4. Додавання одного запису
app.post('/api/records', authMiddleware, (req, res) => {
  const { date, time, odometer, action, location, comment, coords } = req.body;
  try {
    const stmt = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(date, time, odometer ? Number(odometer) : null, action, location, comment, coords);
    res.json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Розумний парсер для вставки з Excel / Google Sheets
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

// 6. Масовий імпорт з тексту (Excel / Google Sheets)
app.post('/api/records/bulk-import', authMiddleware, (req, res) => {
  const { rawText } = req.body;
  if (!rawText) return res.status(400).json({ error: 'Текст для імпорту порожній' });

  try {
    const rows = parseTSV(rawText.trim());
    const stmt = db.prepare(`
      INSERT INTO records (date, time, odometer, action, location, comment, coords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    let count = 0;
    const insertTx = db.transaction(() => {
      for (const col of rows) {
        if (!col || col.length < 3) continue;
        if (col[0].toLowerCase().includes('дата')) continue; // Пропускаємо заголовок

        let d = col[0] ? col[0].trim() : '';
        if (d.includes('.')) {
          const p = d.split('.');
          if (p.length === 3) d = `${p[2]}-${p[1]}-${p[0]}`;
        }

        const t = col[1] ? col[1].trim() : '';
        const odoRaw = col[2] ? col[2].toString().trim() : '';
        const odo = (odoRaw !== '' && !isNaN(odoRaw)) ? Number(odoRaw) : null;
        const act = col[3] ? col[3].trim() : 'Інше (коментар)';
        const loc = col[4] ? col[4].trim() : '';
        const comm = col[5] ? col[5].trim() : '';
        const coords = col[6] ? col[6].trim() : '';

        stmt.run(d, t, odo, act, loc, comm, coords);
        count++;
      }
    });

    insertTx();
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Таблиця (пагінація: LIMIT & OFFSET)
app.get('/api/records', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const offset = parseInt(req.query.offset) || 0;

  const records = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT count(*) as total FROM records').get().total;

  res.json({ records, total, hasMore: offset + records.length < total });
});

// 8. Редагування запису
app.put('/api/records/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { date, time, odometer, action, location, comment } = req.body;
  try {
    db.prepare(`
      UPDATE records 
      SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?
      WHERE id = ?
    `).run(date, time, odometer ? Number(odometer) : null, action, location, comment, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Отримання всіх записів для Звіту
app.get('/api/records/all', authMiddleware, (req, res) => {
  const records = db.prepare('SELECT * FROM records ORDER BY id ASC').all();
  res.json(records);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер працює на порті ${PORT}`);
});