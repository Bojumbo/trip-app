# NOTES.md — технічні нотатки

> Пастки, правила і кваірки середовища, на яких уже витрачено час.
> STATE.md тримає стан роботи; тут — те, що треба знати перш ніж щось міняти.
> Правило 5: файл <= ~150 рядків.

## Міграції SQLite (найнебезпечніше місце)

- **Індекс на колонку з `addColumnIfMissing` НІКОЛИ не може бути в `DDL`.**
  На існуючій БД `CREATE TABLE IF NOT EXISTS` не виконується, колонки ще немає,
  `IF NOT EXISTS` охороняє лише ім'я індексу -> `SQLITE_ERROR: no such column`.
  Саме цим упав продакшн (v1.3.1). Індекс — тільки після блоку міграцій.
- **Тести на свіжій БД не бачать помилок міграції.** Свіжа БД отримує колонку з
  `CREATE TABLE`, тому шлях «стара БД -> нова версія» треба тестувати окремо:
  `tests/schema-migration.test.js`, `tests/schema-boot.test.js`.
- `node --test` запускає **кожен файл в окремому процесі**, тому в тесті можна
  виставити `DB_PATH` і зробити `require('../src/db')` — сінглтон ініціалізується свіжий.
- `db.exec(DDL)` виконує оператори послідовно: якщо впав на індексі, таблиці
  **до** нього вже створені. Тому БД може опинитись у «напівмігрованому» стані —
  це нормально і має бути покрито тестом.
- `addColumnIfMissing` з `REFERENCES` працює лише з `NULL` за замовчуванням.

## CI для Android

- `android-actions/setup-android@v3` **не працює** (падав на кроці setup).
  На раннерах Ubuntu SDK уже стоїть у `/usr/local/lib/android/sdk` — достатньо
  доставити компоненти через `sdkmanager` і прописати `sdk.dir` у `local.properties`.
- `gradlew` відсутній у репозиторії (немає JDK 17 локально, щоб його згенерувати),
  тому Gradle ставиться у воркфлоу розпакуванням архіву.
- Артефакт `trip-tracker-apk` живе 30 днів — завантажувати треба вчасно.
- Один і той самий debug-підпис: оновлювати APK можна лише тим самим підписом.

## Помилки ресурсів Android (AAPT)

- `inputType="textNoSuggestion"` — **не існує**, правильний `textNoSuggestions`.
  AAPT ловить це лише на linking ресурсів, тобто в CI, і падає весь `assembleDebug`.
- Тому додано `scripts/check-android-res.js` (входить у `npm run check`): перевіряє
  всі флаги `android:inputType` у `res/**` ще до збірки.
- Лог збірки CI дублюється у гілку `ci-logs` (`logs/<run_id>.log`) — читається
  звичайним `git fetch origin ci-logs`, бо API віддає артефакти лише адмінам.

## Локальна збірка APK (без CI)

- JDK 17 і Gradle 8.7 лежать у `.workbuddy-ai/build-tools/` (каталог у `.gitignore`).
  `JAVA_HOME=E:/trip-app/.workbuddy-ai/build-tools/jdk-17.0.20.1+1`,
  Gradle — `.workbuddy-ai/build-tools/gradle-8.7/bin/gradle`.
- `android/local.properties` (не в git): `sdk.dir=C\:\\Users\\<user>\\AppData\\Local\\Android\\Sdk`.
- Мережа тут через проксі → Gradle потрібні system properties:
  `GRADLE_OPTS="-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=<порт> -Dhttps.proxyHost=... -Dhttps.proxyPort=..."`
  (порт — з `HTTP_PROXY`; без них завантаження залежностей висить).
- У SDK є лише `platforms/android-37.0`; AGP сам доставляє `platforms;android-34` і
  `build-tools;34.0.0`, бо ліцензія вже прийнята (`licenses/android-sdk-license`).
- Перша збірка ~5 хв, далі швидше: `gradle assembleDebug --no-daemon` →
  `android/app/build/outputs/apk/debug/app-debug.apk`.
- Debug-підпис генерується локально (`~/.android/debug.keystore`) і **не збігається** з підписом
  CI: APK з різних джерел не оновлюють один одного — треба видалити застосунок.

## Карта (MapLibre + PMTiles)

- **`vectorLayerIds()` у MapLibre НЕ існує** — це API Mapbox GL JS. Код, що перебирав
  шари підкладки через нього, тихо падав у `try/catch`, і підкладка не додавалась зовсім
  (маршрут малювався, вулиць не було). Список source-layer беріть із фіксованого переліку
  (`BASEMAP_LAYER_ORDER`) — шар із неіснуючим source-layer просто нічого не малює.
- **Не збирайте URL тайла через `new URL()`** — він кодує `{z}/{x}/{y}` у `%7Bz%7D`,
  і MapLibre не завантажує жодного тайла (шари є, полотно порожнє, помилок у консолі немає).
  Тільки конкатенація: `location.origin + '/tiles/{z}/{x}/{y}.mvt'`.
- **`pmtiles.getZxy()` віддає вже розпакований MVT** (`tileCompression` застосовується
  всередині), тому віддавати треба як `application/x-protobuf` **без** `Content-Encoding`.
  Перевірка магії: MVT починається з `1a` (поле `layers`), gzip — з `1f 8b`.
- Онлайн-режим: `src/services/map-tiles.js` тягне тайл із `build.protomaps.com/YYYYMMDD.pmtiles`
  по HTTP Range і кешує в `data/tilecache/<дата>/z/x/y.mvt`. Дата збірки шукається назад
  на `MAP_BUILD_LOOKBACK` днів; вдалий пошук кешується 6 год, невдалий — пауза 5 хв.
- **`MAP.allowNetwork` фіксується при завантаженні `config`** — у тестах `NODE_ENV=test`
  треба виставляти **до** першого `require('../src/...')`, інакше сервіс піде в мережу
  (тест стане повільним і нестабільним).
- `region.pmtiles` для всієї України (z12) — **324 МБ**, тепер **опційний** (офлайн-режим).
  Генерація без Docker:
  `pmtiles extract <protomaps-планета> out.pmtiles --region=ukraine.geojson --maxzoom=12`
  (бінарник `pmtiles.exe` лежить у `.workbuddy-ai/build-tools/`, не в git). Деталі —
  `docs/TRACKING-MAP.md`.
- Два місця для файлу: `tiles/region.pmtiles` — том Docker (`./tiles:/app/public/tiles`),
  `public/tiles/region.pmtiles` — локальний запуск. Обидва в `.gitignore`.
  `MAP_LOCAL_TILES=0` змушує онлайн-режим навіть коли файл є.
- `/api/tiles` у мережу **не ходить** (інакше карта чекала б на відповідь перед першим
  кадром) — він віддає `enabled`/`mode`/`maxZoom`/`cachedTiles` з пам'яті й диска.
- Тайли віддаються або `express.static` з Range (офлайн-файл), або `GET /tiles/:z/:x/:y.mvt`
  (онлайн) — у будь-якому разі SW їх не перехоплює.

## Залежності від середовища

- `better-sqlite3` **вмикає `foreign_keys` за замовчуванням** (v7+), тож `CASCADE`
  спрацьовує і без явного `PRAGMA`. Але явний `db.pragma('foreign_keys = ON')`
  у `src/db/index.js` лишається — як документація наміру.
- У PATH JDK лише 8, а AGP 8 потребує 17 → для локальної збірки беремо JDK 17
  з `.workbuddy-ai/build-tools` (розділ вище).
- Локальний `curl` у цьому середовищі йде через проксі: для localhost обов'язково
  `curl --noproxy '*'`, інакше `exit code 7`.
- Windows-python `/tmp` != Git Bash `/tmp`. Проміжні файли класти в `.workbuddy-ai/`.

## Service Worker

- `CACHE_NAME` підвищувати при КОЖНОМУ релізі.
- Статика: **мережа спочатку**, кеш лише офлайн. Інакше після релізу користувач
  сидить на старому коді до другого оновлення (v7 це виправив).
- `/tiles/*` не перехопляти: Range-запити на 100+ МБ у Cache Storage не коректні.

## Фронтенд

- MapLibre `addControl()` вимагає об'єкт із `onAdd`/`onRemove`; голий DOM-елемент не приймає.
- Без `background`-шару MapLibre малює білий/прозорий фон — завжди додавай `bg`.
- PMTiles потребує `worker-src 'self' blob:'` у CSP.
- Текст із БД у HTML — тільки через `escapeHtml()`.

## Правила, які виникли з інцидентів

| Дата | Правило |
|------|---------|
| 2026-10-17 | Будь-яка зміна `src/db/schema.js` -> тест, що відкриває БД зі старою схемою |
| 2026-10-17 | Нова колонка + індекс -> індекс після `addColumnIfMissing`, не в DDL |
| 2026-10-17 | Перед пушем у прод: локально `npm test` + відкрити legacy-файл БД |
| 2026-10-18 | Трекер: у `worker` (один потік) не можна тримати блокуючий цикл — він займає його назавжди; цикли → окремий потік |
| 2026-10-18 | Kotlin: виклик усередині `apply { }` іде на ресивер; після блоку потрібен явний `obj.put(...)`, інакше `Unresolved reference` (ловить лише компілятор) |
| 2026-10-18 | Не покладатись на API Mapbox GL у MapLibre (`vectorLayerIds`) — перевіряти, що шар реально додався (`map.getLayer(id)`) |
| 2026-10-18 | Порожній `catch` навколо `addLayer` ховає цілу відсутню підкладку — логувати хоч `console.warn` |
