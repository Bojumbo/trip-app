'use strict';

const express = require('express');
const logger = require('../logger');
const { createLimiter, createLoginGuard } = require('../lib/rate-limit');
const { createSession, destroySession, verifyPassword, authMiddleware } = require('../lib/sessions');

/**
 * @param {{ adminPassword: string }} deps
 */
function createAuthRoutes({ adminPassword }) {
  const router = express.Router();

  const loginLimiter = createLimiter({
    windowMs: 15 * 60 * 1000,
    max: 5,
    blockMs: 15 * 60 * 1000,
    message: 'Забагато спроб входу. Спробуйте через 15 хвилин.'
  });

  const loginGuard = createLoginGuard();

  router.post('/login', (req, res) => {
    // Ліміт рахує лише невдалі спроби — успішні входи не витрачають квоту
    if (loginLimiter.check(req, res)) return;

    if (loginGuard.isBlocked()) {
      return res.status(429).json({ error: 'Тимчасово заблоковано через велику кількість невдалих спроб. Спробуйте пізніше.' });
    }

    const password = req.body && req.body.password;
    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Введіть пароль' });
    }

    if (!verifyPassword(password.trim(), adminPassword)) {
      loginLimiter.fail(req);
      loginGuard.registerFailure();
      logger.warn('login_failed', { ip: req.ip });
      return res.status(401).json({ error: 'Невірний пароль' });
    }

    loginGuard.reset();
    createSession(req, res);
    logger.info('login_success', { ip: req.ip });
    res.json({ success: true });
  });

  router.post('/logout', authMiddleware, (req, res) => {
    destroySession(req.session.id, res);
    res.json({ success: true });
  });

  router.get('/session', authMiddleware, (req, res) => {
    res.json({ authenticated: true });
  });

  return router;
}

module.exports = { createAuthRoutes };
