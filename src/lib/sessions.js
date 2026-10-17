'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { COOKIE_NAME, SESSION_TTL_MS, SESSION_TOUCH_MS } = require('../config');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
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
  return token;
}

function destroySession(sessionId, res) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  if (res) clearSessionCookie(res);
}

/** Порівняння пароля: bcrypt-хеш або звичайний текст (сталої тривалості). */
function verifyPassword(input, stored) {
  if (!stored || !input) return false;

  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try {
      return bcrypt.compareSync(input, stored);
    } catch {
      return false;
    }
  }

  const a = crypto.createHash('sha256').update(String(input), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(stored), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function authMiddleware(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });

  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!row || row.expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Сесія завершилась. Увійдіть знову.' });
  }

  // Ковзне продовження сесії (не частіше ніж раз на добу)
  const now = Date.now();
  if (now - row.last_seen > SESSION_TOUCH_MS) {
    db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?')
      .run(now, now + SESSION_TTL_MS, row.id);
    setSessionCookie(req, res, token);
  }

  req.session = row;
  next();
}

function cleanupExpiredSessions() {
  return db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes;
}

module.exports = {
  parseCookies,
  hashToken,
  createSession,
  destroySession,
  verifyPassword,
  authMiddleware,
  cleanupExpiredSessions
};
