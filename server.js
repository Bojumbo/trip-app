const express = require('express');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_jwt_key_12345';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'; // Пароль за замовчуванням

// Створення папки для БД
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'database.sqlite'));

// Ініціалізація таблиць
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

// Початкові дії, якщо таблиця дій порожня
const countActions = db.prepare('SELECT count(*) as count FROM actions').get();
if (countActions.count === 0) {
  const insertAction = db.prepare('INSERT INTO actions (name) VALUES (?)');
  ['Загрузка', 'Вигрузка', 'Пауза', 'Відкрив зміну', 'Закрив зміну', 'Інше (коментар)'].forEach(a => insertAction.run(a));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware перевірки авторизації
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

// 1. Логін
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '30d' });
    return res.json({ success: true, token });
  }
  res.status(400).json({ success: false, error: 'Невірний пароль' });
});

// 2. Отримання дій для випадаючого списку
app.get('/api/actions', authMiddleware, (req, res) => {
  const actions = db.prepare('SELECT id, name FROM actions ORDER BY id ASC').all();
  res.json(actions.map(a => a.name));
});

// Додавання нової дії прямо з додатку
app.post('/api/actions', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Назва обов’язкова' });
  try {
    db.prepare('INSERT INTO actions (name) VALUES (?)').run(name.trim());
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Така дія вже існує' });
  }
});

// 3. Останній показник одометра
app.get('/api/odometer/last', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT odometer FROM records WHERE odometer IS NOT NULL AND odometer != "" ORDER BY id DESC LIMIT 1').get();
  res.json({ lastOdometer: row ? row.odometer : '' });
});

// 4. Додавання запису
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

// 5. Таблиця Excel (Пагінація: LIMIT і OFFSET)
app.get('/api/records', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 30;
  const offset = parseInt(req.query.offset) || 0;

  const records = db.prepare('SELECT * FROM records ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  const total = db.prepare('SELECT count(*) as total FROM records').get().total;

  res.json({ records, total, hasMore: offset + records.length < total });
});

// 6. Оновлення запису (редагування рядка як в Excel)
app.put('/api/records/:id', authMiddleware, (req, res) => {
  const { id } = req.params;
  const { date, time, odometer, action, location, comment, coords } = req.body;
  try {
    db.prepare(`
      UPDATE records 
      SET date = ?, time = ?, odometer = ?, action = ?, location = ?, comment = ?, coords = ?
      WHERE id = ?
    `).run(date, time, odometer ? Number(odometer) : null, action, location, comment, coords, id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Видалення запису
app.delete('/api/records/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM records WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 8. Всі записи для Звіту по змінах
app.get('/api/records/all', authMiddleware, (req, res) => {
  const records = db.prepare('SELECT * FROM records ORDER BY id ASC').all();
  res.json(records);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер працює на порті ${PORT}`);
});