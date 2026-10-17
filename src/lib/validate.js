'use strict';

const { ApiError } = require('./errors');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Календарна дата у форматі YYYY-MM-DD (31 лютого не проходить). */
function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === value;
}

/** Час у форматі HH:MM (00:00–23:59). */
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

/** Валідація тіла запиту для створення/редагування запису. */
function validateRecordInput(body = {}) {
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
    client_uuid: body.client_uuid ? cleanText(body.client_uuid, 64) : null,
    source: body.source === 'auto' ? 'auto' : 'manual'
  };
}

/** Тип дії за назвою: 'load' | 'unload' | null. */
function actionKind(action) {
  const a = String(action || '').toLowerCase();
  if (a.includes('загруз') || a.includes('завантаж')) return 'load';
  if (a.includes('вигруз') || a.includes('розвантаж')) return 'unload';
  return null;
}

/** Дата з таблиці: YYYY-MM-DD або DD.MM.YY(YY). Повертає ISO або null. */
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

module.exports = {
  DATE_RE,
  TIME_RE,
  isValidDate,
  isValidTime,
  cleanText,
  parseInteger,
  parseBool,
  requireDate,
  requireTime,
  validateRecordInput,
  actionKind,
  normalizeImportDate
};
