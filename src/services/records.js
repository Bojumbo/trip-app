'use strict';

const db = require('../db');
const { ApiError } = require('../lib/errors');
const { actionKind } = require('../lib/validate');

/**
 * Створює запис і синхронізує пов'язану доставку в одній транзакції.
 *
 * - «Загрузка» → нова доставка (in_transit)
 * - «Вигрузка» → закриває вибрану або останню відкриту доставку рейсу
 * - якщо активного рейсу немає — запис зберігається без прив'язки (з попередженням)
 */
function insertRecord(input) {
  const kind = actionKind(input.action);

  const tx = db.transaction(() => {
    let tripId = input.trip_id;

    if (tripId) {
      if (!db.prepare('SELECT id FROM trips WHERE id = ?').get(tripId)) {
        throw new ApiError(400, 'Вказаний рейс не існує');
      }
    } else {
      const active = db.prepare("SELECT id FROM trips WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
      tripId = active ? active.id : null;
    }

    let deliveryId = input.delivery_id;
    if (deliveryId && !db.prepare('SELECT id FROM deliveries WHERE id = ?').get(deliveryId)) {
      throw new ApiError(400, 'Вказану доставку не знайдено');
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
      const cargo = input.cargo || (input.location ? `Вантаж (${input.location})` : 'Вантаж');
      const delInfo = db.prepare(`
        INSERT INTO deliveries (trip_id, cargo, load_record_id, status) VALUES (?, ?, ?, 'in_transit')
      `).run(tripId, cargo, recordId);

      deliveryId = delInfo.lastInsertRowid;
      db.prepare('UPDATE records SET delivery_id = ? WHERE id = ?').run(deliveryId, recordId);
    }

    if (tripId && kind === 'unload') {
      let target = null;

      if (deliveryId) {
        target = db.prepare('SELECT id, status FROM deliveries WHERE id = ?').get(deliveryId);
        if (target && target.status === 'delivered') {
          // Доставка вже закрита — просто прив'язуємо запис, статус не змінюємо
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
  // Будь-який запис без рейсу не потрапить у звіт — попереджаємо завжди
  if (!result.tripId) {
    result.warning = 'Немає активного рейсу — запис збережено без прив\'язки до рейсу.';
  }
  return result;
}

/**
 * Видаляє запис і приводить доставки до консистентного стану:
 * - якщо це початок доставки без вигрузки → доставка видаляється
 * - якщо це початок закритої доставки → посилання обнуляється
 * - якщо це вигрузка → доставка повертається у стан in_transit
 */
function deleteRecord(recordId) {
  const record = db.prepare('SELECT * FROM records WHERE id = ?').get(recordId);
  if (!record) throw new ApiError(404, 'Запис не знайдено');

  db.transaction(() => {
    const asLoad = db.prepare('SELECT * FROM deliveries WHERE load_record_id = ?').all(record.id);

    for (const delivery of asLoad) {
      if (delivery.unload_record_id) {
        db.prepare('UPDATE deliveries SET load_record_id = NULL WHERE id = ?').run(delivery.id);
      } else {
        db.prepare('UPDATE records SET delivery_id = NULL WHERE delivery_id = ?').run(delivery.id);
        db.prepare('DELETE FROM deliveries WHERE id = ?').run(delivery.id);
      }
    }

    db.prepare("UPDATE deliveries SET unload_record_id = NULL, status = 'in_transit' WHERE unload_record_id = ?")
      .run(record.id);

    db.prepare('DELETE FROM records WHERE id = ?').run(record.id);
  })();

  return record;
}

module.exports = { insertRecord, deleteRecord };
