# PROJECT.md — trip app

> Головний файл. Єдине джерело правди про проєкт.
> Якщо код і цей файл розходяться — спершу фіксуємо розбіжність, потім правимо.

## Мета

Система обліку рейсів, доставок і робочих змін для водія вантажівки. Водій з телефона
записує події (загрузка, вигрузка, пауза, відкрив/закрив зміну), система автоматично
збирає з них доставки, зміни та звіт по рейсу. Працює офлайн у кабіні без зв'язку,
синхронізується при появі мережі, зберігає GPS-координати кожної події.
Розгорнуто як PWA на власному домені, користувач один — власник.

## Критерії успіху

Проєкт готовий, коли одночасно виконується все:

1. Водій вносить запис без інтернету — запис не губиться і після появи мережі
   з'являється в базі рівно один раз (без дублів).
2. «Загрузка» створює доставку, «Вигрузка» її закриває; у звіті видно маршрут,
   кілометраж і статус звіту по кожній доставці.
3. Кожен запис має GPS-координати (або явно позначено, що GPS недоступний).
4. `npm test` — 104/104 зелені, `npm run check` — без помилок.
5. Застосунок відкривається на `https://trip.bojumbohost.pp.ua/`, `/api/health` → `{"status":"ok"}`.
6. Дані не втрачаються при перезапуску контейнера (том `./data`).

## Обмеження

**Технології (зафіксовано):**
- Node.js 20+, Express 4, better-sqlite3 (SQLite у файлі), без ORM.
- Фронтенд — ванільний JS + CSS, без фреймворків, без збірки, без npm на клієнті.
- Графіки — Chart.js, локальна копія в `public/vendor/`.
- Тести — `node:test` (вбудований), без Jest/Vitest.

**Чого робити НЕ можна:**
- Не додавати React/Vue/jQuery/TypeScript-збірку — застосунок має лишатися одним HTML+JS.
- Не підключати зовнішні CDN — CSP `script-src 'self'`, усе локально.
- Не зберігати токени/паролі в `localStorage` — тільки httpOnly cookie.
- Не використовувати inline `onclick`/`onchange` — ламає CSP; тільки `data-action`.
- Не писати `err.message` у відповідь клієнту — тільки безпечний текст + лог.
- Не видаляти GPS-координати й не додавати термін давності (рішення власника).
- Не додавати користувачів/ролі/реєстрацію — система для власного користування.

**Стиль:**
- UI, коментарі, повідомлення про помилки — українською. Назви змінних/функцій — англійською.
- 2 пробіли, одинарні лапки в JS, `'use strict'` у кожному модулі.
- Кожен файл ≤ ~150 рядків; більший — розбити на модулі.

**Дедлайни:** немає, соло-розробка. Пріоритет — стабільність, а не швидкість.

## Структура проєкту

```
server.js                 Точка входу: конфіг, listen, graceful shutdown (~60 рядків)
src/
  config.js               Усі env-змінні та ліміти в одному місці
  logger.js               Структуроване JSON-логування
  app.js                  createApp() — збирання Express без listen (для тестів)
  db/
    index.js              Підключення до SQLite, PRAGMA
    schema.js             DDL, міграції, очищення сиріт, початкові дані
  lib/
    errors.js             ApiError зі статусом
    validate.js           Дати, час, числа, булеві, текст, імпорт
    tsv.js                Парсер TSV для імпорту з таблиць
    security.js           CSP, заголовки, CSRF, trust proxy
    rate-limit.js         Лімітер + глобальний запобіжник входу
    sessions.js           Cookie-сесії, bcrypt, auth-middleware
  lib/
    geo.js                Гавайська формула, nearestPointM, decodePolyline, bboxOfPoints
  services/
    records.js            Бізнес-логіка записів і доставок (insertRecord, deleteRecord)
    map-tiles.js          Тайли «на вимогу»: Protomaps по HTTP Range + дисковий кеш
    map-satellite.js      Проксі до Esri World Imagery, добовий кеш за Cache-Control
  routes/
    auth.js               /api/login, /api/logout, /api/session
    meta.js               /api/actions, /api/odometer/last
    tiles.js              /api/tiles (стан), /tiles/:z/:x/:y.mvt, /satellite/:z/:x/:y.jpg, /api/tiles/warm
    trips.js              CRUD рейсів, /active, /:id/complete, /:id/details
    deliveries.js         PATCH/DELETE доставок
    records.js            CRUD записів, /all, /bulk-import, /bulk-report-status
    devices.js            /api/devices/* — pairing і керування трекерами
    track.js              /api/track/segments — прийом маршруту з Android
    report.js             /api/report — агрегований звіт одним запитом
public/
  index.html              Розмітка (без inline-обробників)
  app.js                  Клієнт: стан, API-клієнт, рендер, делеговані події
  style.css               Стилі, світла/темна тема
  sw.js                   Service Worker, CACHE_NAME = версія релізу
  manifest.json           PWA-маніфест
  vendor/chart.umd.min.js Chart.js локально
  glyphs/                 Гліфи Noto Sans (кирилиця) для підписів карти, ~540 КБ
  icon*.svg|png           Іконки, maskable-варіант
tests/                    13 файлів, 104 перевірки (node:test); schema-boot і
                         schema-migration перевіряють міграцію на старій БД
android/                  Kotlin-трекер (окремий клієнт API), збірка через Actions
public/vendor/            Chart.js, MapLibre GL JS, pmtiles — локальні копії (CSP 'self')
tiles/region.pmtiles      ОПЦІЙНА офлайн-карта регіону, не в git (див. docs/TRACKING-MAP.md)
data/tilecache/           Кеш тайлів, наповнюється сам, можна видаляти
scripts/check-syntax.js   npm run check
data/database.sqlite      БД (том Docker, у git не потрапляє)
docs/AUDIT-2026-10-17.md  Повний аудит: 52 дефекти + що виправлено
Dockerfile, docker-compose.yml, .env.example
```

## Посилання на решту пам'яті

- [STATE.md](STATE.md) — поточний стан, що в роботі, наступні кроки, передача.
- [DECISIONS.md](DECISIONS.md) — журнал рішень із причинами (нове зверху).
- [TASKS.md](TASKS.md) — backlog: зараз / далі / колись / зроблено.
- [GLOSSARY.md](GLOSSARY.md) — терміни, назви модулів і API, домовленості.
- [HISTORY.md](HISTORY.md) — детальна історія по версіях (v1.1.0 → v1.3.1).
- [NOTES.md](NOTES.md) — технічні пастки: міграції SQLite, SW, MapLibre, середовище.
- [docs/AUDIT-2026-10-17.md](docs/AUDIT-2026-10-17.md) — аудит і перелік виправлень.
- `.workbuddy-ai/memory/YYYY-MM-DD.md` — технічні нотатки по сесіях (не дублюємо тут).
