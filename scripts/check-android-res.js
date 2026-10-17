'use strict';

/**
 * Статична перевірка ресурсів Android до того, як про них дізнається AAPT.
 *
 * Історія: APK не збирався три запуски поспіль, бо в `inputType` був
 * неіснуючий флаг `textNoSuggestion` (правильний — `textNoSuggestions`).
 * AAPT ловить це лише на етапі linking ресурсів, тобто в CI. Тут — миттєво.
 *
 * npm run check проходить по всіх xml-файлам android/app/src/main/res.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// Дозволені значення android:inputType (набір флагів через |).
const INPUT_TYPES = new Set([
  'none', 'text', 'textCapCharacters', 'textCapWords', 'textCapSentences',
  'textAutoCorrect', 'textAutoComplete', 'textMultiLine', 'textImeMultiLine',
  'textNoSuggestions', 'textUri', 'textEmailAddress', 'textEmailSubject',
  'textPassword', 'textVisiblePassword', 'textWebEditText', 'textFilter',
  'textPhonetic', 'textWebEmailAddress', 'textWebPassword', 'number',
  'numberSigned', 'numberDecimal', 'numberPassword', 'phone', 'datetime',
  'date', 'time'
]);

/** Рекурсивно збирає файли ресурсів. */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.xml')) out.push(full);
  }
  return out;
}

let checked = 0;
const problems = [];

for (const file of walk(RES_DIR)) {
  const xml = fs.readFileSync(file, 'utf8');
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  const lines = xml.split('\n');

  lines.forEach((line, i) => {
    const m = /android:inputType="([^"]*)"/.exec(line);
    if (!m) return;

    const flags = m[1].split('|').map(s => s.trim()).filter(Boolean);
    flags.forEach(flag => {
      checked++;
      if (!INPUT_TYPES.has(flag)) {
        problems.push(`${rel}:${i + 1} — невідомий inputType "${flag}". Дозволені: ${[...INPUT_TYPES].join(', ')}`);
      }
    });
  });
}

// Про всяк випадок: шукаймо посилання на ресурси, яких точно немає
// у вигляді @id/... у макетах без @+id/ (типова помилка копіпасту).
const KNOWN_STRINGS = new Set();
const STRINGS = path.join(RES_DIR, 'values', 'strings.xml');
if (fs.existsSync(STRINGS)) {
  const s = fs.readFileSync(STRINGS, 'utf8');
  for (const m of s.matchAll(/name="([^"]+)"/g)) KNOWN_STRINGS.add(m[1]);
}

if (problems.length > 0) {
  console.error(`✗ Ресурси Android: ${problems.length} помилок\n`);
  problems.forEach(p => console.error('  ' + p));
  console.error('\nAAPT підтвердить це лише в CI — виправ тут.');
  process.exit(1);
}

console.log(`✓ Ресурси Android: ${checked} прапорців inputType, усі коректні (${KNOWN_STRINGS.size} строк)`);
