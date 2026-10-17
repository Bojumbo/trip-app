'use strict';

const logger = require('../logger');

/**
 * Ковзне вікно з блокуванням на blockMs після перевищення max.
 *
 * Два режими:
 *  - middleware(req,res,next) — рахує КОЖЕН запит (для загального API-ліміту)
 *  - check(req,res) + fail(req) — рахує лише невдалі спроби (для входу)
 */
function createLimiter({ windowMs, max, blockMs, message }) {
  const buckets = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of buckets.entries()) {
      if (rec.blockedUntil && now >= rec.blockedUntil) buckets.delete(key);
      else if (!rec.blockedUntil && now - rec.firstSeen > windowMs) buckets.delete(key);
    }
  }, 60 * 1000);
  if (timer.unref) timer.unref();

  function getRecord(key) {
    const now = Date.now();
    let rec = buckets.get(key);

    if (!rec) {
      rec = { count: 0, firstSeen: now, blockedUntil: 0 };
      buckets.set(key, rec);
      return rec;
    }

    if (rec.blockedUntil && now >= rec.blockedUntil) {
      rec = { count: 0, firstSeen: now, blockedUntil: 0 };
      buckets.set(key, rec);
      return rec;
    }

    if (!rec.blockedUntil && now - rec.firstSeen > windowMs) {
      rec.count = 0;
      rec.firstSeen = now;
    }
    return rec;
  }

  function respondBlocked(res, rec) {
    const waitMin = Math.max(1, Math.ceil((rec.blockedUntil - Date.now()) / 60000));
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil((rec.blockedUntil - Date.now()) / 1000))));
    res.status(429).json({ error: `Забагато запитів. Зачекайте ${waitMin} хв.` });
  }

  /** true — запит заблоковано (відповідь уже надіслана). */
  function check(req, res) {
    const key = req.ip || 'unknown';
    const rec = getRecord(key);

    if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
      respondBlocked(res, rec);
      return true;
    }
    return false;
  }

  function fail(req) {
    const key = req.ip || 'unknown';
    const rec = getRecord(key);
    rec.count++;

    if (rec.count >= max && !rec.blockedUntil) {
      rec.blockedUntil = Date.now() + blockMs;
      logger.warn('rate_limit_blocked', { ip: req.ip, path: req.path, scope: 'failures' });
    }
  }

  function middleware(req, res, next) {
    const key = req.ip || 'unknown';
    const rec = getRecord(key);

    if (rec.blockedUntil && Date.now() < rec.blockedUntil) {
      return respondBlocked(res, rec);
    }

    rec.count++;
    if (rec.count > max) {
      rec.blockedUntil = Date.now() + blockMs;
      logger.warn('rate_limit_blocked', { ip: req.ip, path: req.path });
      return respondBlocked(res, rec);
    }

    next();
  }

  middleware.check = check;
  middleware.fail = fail;
  middleware._buckets = buckets; // для тестів

  return middleware;
}

/**
 * Глобальний запобіжник входу: навіть якщо IP підробити,
 * розподілений перебір впирається у спільний ліміт невдалих спроб.
 */
function createLoginGuard({ windowMs = 15 * 60 * 1000, maxFailures = 30 } = {}) {
  const state = { failures: 0, windowStart: Date.now(), blockedUntil: 0 };

  function isBlocked() {
    const now = Date.now();

    if (state.blockedUntil) {
      if (now < state.blockedUntil) return true;
      state.blockedUntil = 0;
      state.failures = 0;
      state.windowStart = now;
    }
    if (now - state.windowStart > windowMs) {
      state.failures = 0;
      state.windowStart = now;
    }
    return false;
  }

  function registerFailure() {
    state.failures++;
    if (state.failures >= maxFailures) {
      state.blockedUntil = Date.now() + windowMs;
      logger.warn('global_login_block', { failures: state.failures });
    }
  }

  function reset() {
    state.failures = 0;
    state.windowStart = Date.now();
    state.blockedUntil = 0;
  }

  return { isBlocked, registerFailure, reset, _state: state };
}

module.exports = { createLimiter, createLoginGuard };
