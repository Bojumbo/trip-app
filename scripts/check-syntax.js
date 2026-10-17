'use strict';

/**
 * Перевірка синтаксису всіх JS-файлів проєкту без запуску.
 * Використання: npm run check
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGETS = ['server.js', 'public/app.js', 'public/sw.js', 'src', 'tests', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.workbuddy-ai', 'vendor']);

function collect(entry, acc = []) {
  const full = path.join(ROOT, entry);
  const stat = fs.statSync(full);

  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(full)) {
      if (SKIP_DIRS.has(name)) continue;
      collect(path.join(entry, name), acc);
    }
  } else if (entry.endsWith('.js')) {
    acc.push(full);
  }
  return acc;
}

const files = TARGETS.flatMap(t => collect(t));
let failed = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${path.relative(ROOT, file)}`);
    console.error(String(e.stderr || e.message).trim());
  }
}

if (failed > 0) {
  console.error(`\nПомилок синтаксису: ${failed}`);
  process.exit(1);
}

console.log(`✓ Синтаксис OK (${files.length} файлів)`);
