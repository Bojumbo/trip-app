'use strict';

const express = require('express');
const db = require('../db');
const { ApiError } = require('../lib/errors');
const { cleanText } = require('../lib/validate');
const { requireSession } = require('../lib/sessions');

const router = express.Router();
router.use(requireSession);

const ALLOWED_STATUSES = ['in_transit', 'delivered', 'incomplete'];

router.patch('/:id', (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) throw new ApiError(404, 'Доставку не знайдено');

  const body = req.body || {};
  const cargo = body.cargo !== undefined ? cleanText(body.cargo, 255) : delivery.cargo;
  const status = body.status !== undefined ? String(body.status) : delivery.status;

  if (!ALLOWED_STATUSES.includes(status)) throw new ApiError(400, 'Некоректний статус доставки');

  db.prepare('UPDATE deliveries SET cargo = ?, status = ? WHERE id = ?').run(cargo, status, delivery.id);
  res.json({ success: true });
});

router.delete('/:id', (req, res) => {
  const delivery = db.prepare('SELECT * FROM deliveries WHERE id = ?').get(req.params.id);
  if (!delivery) throw new ApiError(404, 'Доставку не знайдено');

  db.transaction(() => {
    db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(delivery.id);
    db.prepare('DELETE FROM deliveries WHERE id = ?').run(delivery.id);
  })();

  res.json({ success: true });
});

module.exports = router;
