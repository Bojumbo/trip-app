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
| **PMTiles** | Офлайн-архів тайлів карти регіону; лежить у `tiles/region.pmtiles`, не в git | `docs/TRACKING-MAP.md` |
| **Пристрій** (device) | Android-трекер; ходить в API з Bearer-токеном замість cookie | `devices`, `src/routes/devices.js` |
| **Сегмент маршруту** | Шмат треку одного режиму + encoded polyline | `track_segments`, `src/routes/track.js` |
| **Автопауза** | Запис із `source='auto'` — створений трекером. У звіті з позначкою «🤖 авто» | `records.source` |
| **Продовження руху** | Дія, яку трекер пише, коли авто знову рушилось (>15 км/год упродовж 60 с) | `actions`, `DEFAULT_ACTIONS` |
| **CMR** | Міжнародна товарно-транспортна накладна; номер пишемо в полі «Вантаж / № CMR» | поле `cargo` |

## Статуси

| Сутність | Значення | Значення українською |
|----------|----------|----------------------|
| `track_segments.mode` | `drive` / `walk` / `still` / `nosignal` | авто / пішки / стоїть / немає сигналу |
| `records.source` | `manual` / `auto` | вручну / створено трекером |
| `trips.status` | `active` / `completed` | активний / завершений |
| `deliveries.status` | `in_transit` / `delivered` / `incomplete` | в дорозі / доставлено / не завершено (рейс закрили з відкритою доставкою) |

## Назви в коді

**Модулі (`src/`)**
- `config` — єдине місце для `process.env`; решта коду env не читає.
- `app.createApp()` — збирає Express, **не** слухає порт (тому тести можуть підняти свій інстанс).
- `lib/validate` — `isValidDate`, `isValidTime`, `parseBool`, `parseInteger`, `validateRecordInput`.
- `lib/security` — `securityHeaders`, `csrfGuard`, `resolveTrustProxy`, `isPrivateAddress`.
- `lib/sessions` — `createSession`, `createDeviceToken`, `authMiddleware`, `requireDevice`, `verifyPassword`.
- `lib/geo` — `haversineM`, `nearestPointM` (дедуплікація автопауз: ±5 хв, ~200 м).
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
GET    /tiles                  публічний: чи є офлайн-карта region.pmtiles (без авторизації)
GET    /trips/:id/track        сегменти маршруту рейсу (полілінії)
GET    /report                 агрегований звіт (trips + deliveries + records + unassigned)

# Пристрої (Bearer-токен, не cookie)
GET    /devices/me             стан пристрої + активний рейс + останній одометр
POST   /track/segments         прийом сегментів маршруту (batch до 20)
```

**Фронтенд (`public/app.js`)**
- `$('id')` — скорочення для `getElementById`; `val('id')` — значення поля.
- `api(path, opts)` — єдина точка запитів; кидає `ApiError`, на 401 показує екран входу.
- `data-action="..."` — будь-яка дія в розмітці. Обробники в `clickActions` / `changeActions` / `inputActions`.
- `recordsCache` — `Map` записів для модалки редагування (наповнюється з `/api/report` і таблиці).
- `openTrackModal(tripId)` — модалка маршруту; ліниво підтягує `/vendor/{pmtiles,maplibre-gl}.js`.
- `decodePolyline(str)` — декодер Google encoded polyline → `[lon, lat][]`.
- `trackState` — поточний `maplibregl.Map`, `loading`, `tripId`; `destroyTrackMap()` при закритті модалки.
- `renderTrackMap()` — будує GeoJSON, шари `track-drive/walk/still/nosignal`, точки `track-records`,
  підкладку `region-*` і перемикач `track-fit` (all / track / records).
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
  (зараз `trip-tracker-v7`), інакше користувачі сидітимуть на старому кеші.
- `android/` — єдиний виняток із правила «без збірки» (див. DECISIONS 2026-10-17).
