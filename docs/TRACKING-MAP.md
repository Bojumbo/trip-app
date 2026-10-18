# Офлайн-карта регіону (варіант C)

Маршрут рейсу малює **MapLibre GL JS**, який лежить локально в `public/vendor/`
(CDN відключено правилами CSP). Підкладка регіону — файл `public/tiles/region.pmtiles`
у форматі [PMTiles](https://github.com/protomaps/PMTiles). Саме тому маршрут видно
і без інтернету, і нікуди не йдуть запити про місцезнаходження водія.

## Що вже працює без файлу

Якщо `region.pmtiles` відсутній, `GET /api/tiles` повертає `{"available":false}` —
і карта малюється на однотонній підкладці: суцільна синя лінія «рух авто»,
пунктирна помаранчева «ходьба», сірі пункти «стан» і «немає сигналу», червоні
точки — записи з GPS. Масштаб, переміщення, зум і підказки працюють повноцінно.
Тобто відсутність плиток не ламає жодної функції — просто не видно вулиць.

## Як згенерувати `region.pmtiles`

Потрібен один раз, локально. Результат — файл 20–350 МБ залежно від регіону; в git він
**не комітиться** (`public/tiles/.gitignore` + `tiles/` у корені). У продакшені він лежить
на хості і монтується томом `./tiles:/app/public/tiles` (див. `docker-compose.yml`) —
інакше `Pull and redeploy` його зітре.

### Варіант 1 — вирізати з готового Protomaps (без Docker, ~10 хв)

Найшвидший шлях: у Protomaps є щоденні збірки всієї планети у PMTiles, з яких
можна витягти лише свій регіон — по HTTP Range, без завантаження 139 ГБ.

```bash
# 1. Бінарник pmtiles CLI (Windows/Linux/macOS)
curl -L -o pmtiles.zip \
  https://github.com/protomaps/go-pmtiles/releases/latest/download/go-pmtiles_1.31.2_Windows_x86_64.zip
unzip pmtiles.zip

# 2. Полігон регіону (можна bbox: --bbox=minlon,minlat,maxlon,maxlat)
#    Тут — вся Україна з Natural Earth (14 МБ, витягуємо один feature)
curl -L -o countries.geojson \
  https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson

# 3. Оцінка розміру без завантаження
pmtiles extract https://build.protomaps.com/20261017.pmtiles ua.pmtiles \
  --region=ukraine.geojson --maxzoom=12 --dry-run

# 4. Сама екстракція
pmtiles extract https://build.protomaps.com/20261017.pmtiles ua.pmtiles \
  --region=ukraine.geojson --maxzoom=12 --download-threads=16
```

Перевірені цифри для всієї України (18.10.2026): **19 707 тайлів, 324 МБ, 6.5 хв**.
Дата у URL — це дата збірки (`build.protomaps.com/YYYYMMDD.pmtiles`), беріть свіжу.
`--maxzoom=12` дає вулиці на рівні міста; 13+ множить розмір учетверо, а трек
однаково малюється поверх.

### Варіант 2 — planetiler + OpenMapTiles (потрібен Docker)

```bash
curl -O https://download.geofabrik.de/europe/ukraine-latest.osm.pbf   # 880 МБ
docker run --rm -v "$PWD:/data" \
  ghcr.io/onthego/planetiler-openmaptiles:latest \
  --input=/data/ukraine-latest.osm.pbf \
  --output=/data/region.pmtiles \
  --minzoom=5 --maxzoom=12 --bounds=22.1,44.3,40.3,52.5
```

Довше (десятки хвилин) і потребує 4–8 ГБ RAM, зате схема OpenMapTiles.
Фронтенд розуміє обидві схеми — див. «Як це працює в коді».

### Покласти файл і перевірити

```bash
mkdir -p tiles
cp ua.pmtiles tiles/region.pmtiles     # на хості; у Docker — том ./tiles
curl -s https://trip.bojumbohost.pp.ua/api/tiles   # {"available":true,"sizeMb":...}
```

Для локального запуску без Docker: `cp tiles/region.pmtiles public/tiles/`.

Після цього маршрут у веб-застосунку відображатиметься на справжній карті.

## Як це працює в коді

| Файл | Роль |
|---|---|
| `public/vendor/maplibre-gl.js`, `maplibre-gl.css` | рендерер карти (~800 КБ,BSD-3) |
| `public/vendor/pmtiles.js` | протокол `pmtiles://` — читає архів по HTTP Range |
| `public/app.js` → `openTrackModal()` | ліниве підключення бібліотек, запит `/api/trips/:id/track` |
| `public/app.js` → `renderTrackMap()` | декодує полілінії, будує шари треку, додає підкладку |
| `public/app.js` → `addBasemapLayers()` | малює підкладку: полігони — заливкою, лінії — лініями |
| `public/app.js` → `basemapLayerSpec()` | визначає тип шару за назвою source-layer (OMT і Protomaps) |
| `src/routes/meta.js` → `GET /api/tiles` | чи є файл (реєструється до `authMiddleware`) |
| `public/sw.js` | `/tiles/*` навмисно **не кешує** — Range-запити ламають кеш SW |

## Обмеження, про які варто знати

1. **Плитки не кешуються сервіс-воркером** — у повністю офлайн-режимі без попереднього
   перегляду підкладки не буде, буде лише трек. Це свідомий компроміс: кешувати
   100+ МБ у Cache Storage і взагалі не можна коректно обробляти `Range`.
2. **Файл не в образі** → його треба покласти на хост у `./tiles/` (том
   `./tiles:/app/public/tiles` у `docker-compose.yml`). Без цього після
   `Pull and redeploy` підкладки не буде — трек залишиться.
3. **Розмір образу.** 100 МБ плиток = +100 МБ образу. Якщо це забагато —
   зменшіть `--bounds` або `--maxzoom`.
4. **Підписів вулиць і назв міст немає** — для `symbol`-шарів потрібні гліфи, яких
   в архіві немає. Тому підкладка — це заливки (земля, вода, забудова) і лінії
   (дороги, межі). Назви населених пунктів можна додати пізніше, поклавши поруч
   `glyphs`-каталог і додавши `symbol`-шар.

## Альтернативи, які відкинули

- **Варіант A** (свій рендер на сітці): вулиць не видно взагалі.
- **Варіант B** (Leaflet + OSM): зовнішні запити до чужих серверів — ламає CSP
  і зливає маршрути водія. Саме те, від чого вся система уникає.
