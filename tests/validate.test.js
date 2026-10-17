'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidDate, isValidTime, parseInteger, parseBool, cleanText, actionKind,
  normalizeImportDate, validateRecordInput
} = require('../src/lib/validate');
const { parseTSV } = require('../src/lib/tsv');

test('isValidDate приймає реальні дати', () => {
  assert.equal(isValidDate('2026-10-17'), true);
  assert.equal(isValidDate('2024-02-29'), true); // високосний
});

test('isValidDate відхиляє неіснуючі дати та сміття', () => {
  assert.equal(isValidDate('2026-02-31'), false);
  assert.equal(isValidDate('2026-13-01'), false);
  assert.equal(isValidDate('2026-1-1'), false);
  assert.equal(isValidDate('abc'), false);
  assert.equal(isValidDate(''), false);
  assert.equal(isValidDate(null), false);
});

test('isValidTime приймає лише 00:00–23:59', () => {
  assert.equal(isValidTime('00:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('9:05'), false);
  assert.equal(isValidTime('99:99'), false);
});

test('parseInteger відсікає відʼємні, дробові та нечислові', () => {
  assert.equal(parseInteger('123'), 123);
  assert.equal(parseInteger(0), 0);
  assert.equal(parseInteger(''), null);
  assert.equal(parseInteger('-5'), null);
  assert.equal(parseInteger('1.5'), null);
  assert.equal(parseInteger('abc'), null);
});

test('parseBool не сприймає рядок "0" як true', () => {
  assert.equal(parseBool('0'), false);
  assert.equal(parseBool(0), false);
  assert.equal(parseBool('false'), false);
  assert.equal(parseBool('1'), true);
  assert.equal(parseBool(1), true);
  assert.equal(parseBool(true), true);
});

test('cleanText обрізає пробіли та довжину', () => {
  assert.equal(cleanText('  привіт  ', 10), 'привіт');
  assert.equal(cleanText('abcdef', 3), 'abc');
  assert.equal(cleanText(null, 5), '');
});

test('actionKind розпізнає загрузку/вигрузку', () => {
  assert.equal(actionKind('Загрузка'), 'load');
  assert.equal(actionKind('Завантаження'), 'load');
  assert.equal(actionKind('Вигрузка'), 'unload');
  assert.equal(actionKind('Розвантаження'), 'unload');
  assert.equal(actionKind('Пауза'), null);
});

test('normalizeImportDate розуміє DD.MM.YY та DD.MM.YYYY', () => {
  assert.equal(normalizeImportDate('17.10.2026'), '2026-10-17');
  assert.equal(normalizeImportDate('17.10.26'), '2026-10-17');
  assert.equal(normalizeImportDate('2026-10-17'), '2026-10-17');
  assert.equal(normalizeImportDate('31.02.2026'), null);
  assert.equal(normalizeImportDate('абв'), null);
});

test('validateRecordInput кидає помилку на некоректних даних', () => {
  assert.throws(() => validateRecordInput({ date: '2026-02-31', time: '10:00', action: 'Пауза' }), /дата/);
  assert.throws(() => validateRecordInput({ date: '2026-10-17', time: '25:00', action: 'Пауза' }), /час/);
  assert.throws(() => validateRecordInput({ date: '2026-10-17', time: '10:00', action: '' }), /Дія/);
  assert.throws(() => validateRecordInput({ date: '2026-10-17', time: '10:00', action: 'Пауза', odometer: -1 }), /Одометр/);
});

test('validateRecordInput нормалізує поля', () => {
  const result = validateRecordInput({
    date: '2026-10-17',
    time: '09:05',
    action: '  Пауза  ',
    odometer: '100500',
    is_reported: '0',
    location: '  Київ ',
    client_uuid: 'abc-123'
  });

  assert.equal(result.action, 'Пауза');
  assert.equal(result.odometer, 100500);
  assert.equal(result.is_reported, 0);
  assert.equal(result.location, 'Київ');
  assert.equal(result.client_uuid, 'abc-123');
});

test('parseTSV розбирає рядки, лапки та CRLF', () => {
  const rows = parseTSV('2026-10-17\t09:00\t100\tЗагрузка\tКиїв\r\n2026-10-18\t10:00\t200\t"Вигрузка"\t"Львів, склад"');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], ['2026-10-17', '09:00', '100', 'Загрузка', 'Київ']);
  assert.deepEqual(rows[1], ['2026-10-18', '10:00', '200', 'Вигрузка', 'Львів, склад']);
});

test('parseTSV обробляє екрановані лапки', () => {
  const rows = parseTSV('a\t"текст ""в лапках"""');
  assert.deepEqual(rows[0], ['a', 'текст "в лапках"']);
});

test('parseTSV ігнорує порожні рядки', () => {
  const rows = parseTSV('\n\n2026-10-17\t09:00\t1\tПауза\n\n');
  assert.equal(rows.length, 1);
});
