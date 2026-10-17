# GLOSSARY.md — терміни й домовленості

## Доменні терміни

| Термін | Значення | Де в коді |
|--------|----------|-----------|
| **Рейс** (trip) | Поїздка з датою/часом початку й кінця, одометром і нотатками. Одночасно може бути лише **один активний** | `trips`, `src/routes/trips.js` |
| **Доставка** (delivery) | Вантаж у межах рейсу: створюється дією «Загрузка», закривається «Вигрузкою» | `deliveries`, `src/services/records.js` |
| **Запис** (record) | Одна подія водія: дата, час, дія, одометр, локація, коментар, GPS | `records`, `src/routes/records.js` |
| **Дія** (action) | Назва події з довідника: Загрузка, Вигрузка, Пауза, Відкрив зміну, Закрив зміну, Інше | таблиця `actions` |
| **Зміна** (shift) | Проміжок між «Відкрив зміну» і «Закрив зміну». Групується на клієнті, не в БД | `groupIntoShifts()` у `public/app.js` |
| **Звіт здано** | Прапорець `is_reported` — чи внесено запис у звіт замовнику | `records.is_reported` |
| **Активний рейс** | Рейс зі `status='active'`; нові записи автоматично прив'язуються до нього | `/api/trips/active` |
| **Офлайн-черга** | Записи, збережені в `localStorage`, коли немає мережі; синхронізуються при появі зв'язку | `trip_offline_queue`, `syncOfflineQueue()` |
| **«Поза доставками»** | Записи рейсу, не прив'язані до жодної доставки (паузи, зміни) | блок у звіті |
| **«Без рейсу»** | Записи з `trip_id = NULL` — створені, коли активного рейсу не було | блок «⚠️ Записи без рейсу» |
| **CMR** | Міжнародна товарно-транспортна накладна; номер пишемо в полі «Вантаж / № CMR» | поле `cargo` |

## Статуси

| Сутність | Значення | Значення українською |
|----------|----------|----------------------|
| `trips.status` | `active` / `completed` | активний / завершений |
| `deliveries.status` | `in_transit` / `delivered` / `incomplete` | в дорозі / доставлено / не завершено (рейс закрили з відкритою доставкою) |

## Назви в коді

**Модулі (`src/`)**
- `config` — єдине місце для `process.env`; решта коду env не читає.
- `app.createApp()` — збирає Express, **не** слухає порт (тому тести можуть підняти свій інстанс).
- `lib/validate` — `isValidDate`, `isValidTime`, `parseBool`, `parseInteger`, `validateRecordInput`.
- `lib/security` — `securityHeaders`, `csrfGuard`, `resolveTrustProxy`, `isPrivateAddress`.
- `lib/sessions` — `createSession`, `authMiddleware`, `verifyPassword`.
- `services/records` — `insertRecord`, `deleteRecord` (уся логіка доставок тут, не в роутах).

**API (усі під `/api`, крім `/health` і `/login`)**
```
GET    /health                 публічний
POST   /login  /logout         cookie tt_sid
GET    /session                перевірка сесії при старті
GET    /actions  /odometer/last
GET    /trips  /trips/active  /trips/:id/details
POST   /trips  /trips/:id/complete
PUT    /trips/:id      DELETE /trips/:id?with_records=0|1
PATCH  /deliveries/:id DELETE /deliveries/:id
GET    /records  /records/all
POST   /records  /records/bulk-import  /records/bulk-report-status
PUT    /records/:id    PATCH /records/:id/report-status   DELETE /records/:id
GET    /report                 агрегований звіт (trips + deliveries + records + unassigned)
```

**Фронтенд (`public/app.js`)**
- `$('id')` — скорочення для `getElementById`; `val('id')` — значення поля.
- `api(path, opts)` — єдина точка запитів; кидає `ApiError`, на 401 показує екран входу.
- `data-action="..."` — будь-яка дія в розмітці. Обробники в `clickActions` / `changeActions` / `inputActions`.
- `recordsCache` — `Map` записів для модалки редагування (наповнюється з `/api/report` і таблиці).
- `reportTripsCache` — рейси для модалок завершення/редагування.
- `showToast(text, type, ms)` — єдиний спосіб повідомити користувача (не `alert`).

## Домовленості

**Мова**
- UI, повідомлення, коментарі, документація — українською.
- Назви змінних, функцій, файлів, таблиць, API — англійською.
- Дати в API — `YYYY-MM-DD`, час — `HH:MM` (24 год). У CSV — те саме.

**Код**
- 2 пробіли, одинарні лапки, `'use strict'` на початку модуля.
- Кожен модуль ≤ ~150 рядків. Більший — розбити.
- Помилки: `throw new ApiError(status, 'текст українською')`; назовні — тільки безпечний текст.
- SQL — тільки параметризований (`?`), ніколи конкатенація.
- Усі змінювальні операції з БД — у `db.transaction()`.

**Фронтенд**
- Ніяких inline `onclick`/`onchange` — тільки `data-action` (CSP `script-src 'self'`).
- Будь-який текст із БД у HTML — через `escapeHtml()`.
- Запити — тільки через `api()`, не голий `fetch`.
- Повідомлення користувачу — `showToast()`, не `alert()`.

**Git**
- Повідомлення комітів — українською, префікс: `fix:`, `refactor:`, `docs:`, `feat:`.
- Гілка одна — `main`, деплой із неї.
- `data/`, `.env`, `node_modules/`, `.workbuddy-ai/` — у `.gitignore`, не комітимо.

**Версії**
- `package.json` `version` = версія релізу; `CACHE_NAME` у `sw.js` збільшуємо при кожному релізі
  (зараз `trip-tracker-v6`), інакше користувачі сидітимуть на старому кеші.
