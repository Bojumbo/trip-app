'use strict';

const logger = require('../logger');
const { IS_PROD } = require('../config');

/**
 * Довіра до X-Forwarded-For лише від приватних адрес.
 * Cloudflared (на хості або в docker-мережі) приходить із приватної адреси,
 * а прямий доступ з інтернету — ні, тому підробити заголовок не вийде.
 */
function isPrivateAddress(ip) {
  if (!ip) return false;
  const s = String(ip).replace(/^::ffff:/i, '').toLowerCase();
  if (s === '::1' || s === 'localhost') return true;
  if (s.includes(':')) return s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');

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
  if (raw === undefined || raw === '') return isPrivateAddress;
  if (raw === 'false' || raw === '0') return false;
  if (raw === 'true') {
    logger.warn('TRUST_PROXY=true — довіряємо будь-якому X-Forwarded-For. Використовуйте лише за надійним проксі.');
    return true;
  }
  const hops = Number(raw);
  if (Number.isInteger(hops) && hops >= 0) return hops;
  return isPrivateAddress;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

function securityHeaders(req, res, next) {
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
}

/** Додатковий захист від CSRF поверх SameSite=Strict. */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // не-браузерні клієнти (curl) не надсилають Origin

  try {
    if (new URL(origin).host !== req.headers.host) {
      return res.status(403).json({ error: 'Запит відхилено (CSRF)' });
    }
  } catch {
    return res.status(403).json({ error: 'Запит відхилено (CSRF)' });
  }
  next();
}

function requestLogger(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    logger.info('request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
      ip: req.ip
    });
  });
  next();
}

module.exports = { isPrivateAddress, resolveTrustProxy, securityHeaders, csrfGuard, requestLogger };
