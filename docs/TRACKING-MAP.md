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

Потрібен один раз, локально, на комп'ютері з Docker (або Node 20+).
Результат — файл 20–300 МБ залежно від розміру регіону; в git він **не комітиться**
(`public/tiles/.gitignore` + `tiles/` у корені). У продакшені він лежить на хості
і монтується томом `./tiles:/app/public/tiles` (див. `docker-compose.yml`) —
інакше `Pull and redeploy` його зітре.

### 1. Отримати дані OpenStreetMap

Варіант А — [Geofabrik](https://download.geofabrik.de/europe/ukraine.html):
качаєте регіон (наприклад `kyiv-oblast-latest.osm.pbf`, ~50 МБ).

Варіант Б — Overpass API, щоб вирізати тільки потрібний bounding box:
```bash
curl -G https://overpass-api.de/api/interpreter \
  --data-urlencode 'data=[out:xml][bbox:50.2,30.2,50.6,30.8];(way;rel;);out meta;' \
  -o region.osm
```

### 2. Побудувати PMTiles (planetiler)

```bash
docker run --rm -v "$PWD:/data" \
  ghcr.io/onthego/planetiler-openmaptiles:latest \
  --input=/data/kyiv-oblast-latest.osm.pbf \
  --output=/data/region.pmtiles \
  --minzoom=5 --maxzoom=14 --bounds=30.2,50.2,30.8,50.6
```

Параметри, які важливі:
- `--maxzoom=14` — для маршруту достатньо; збільшення до 15–16 помножує розмір на 2–4.
- `--bounds=...` — обрізає все зайве. Тримайте вузький прямокутник навколо робочого регіону.
- `--minzoom=5` — дає загальний огляд на віддаленні.

### 3. Покласти файл і перевірити

```bash
mkdir -p tiles
cp region.pmtiles tiles/          # на хості; у Docker — том ./tiles
curl -s https://trip.bojumbohost.pp.ua/api/tiles   # {"available":true,"sizeMb":...}
```

Для локального запуску без Docker достатньо `cp region.pmtiles public/tiles/`.

Після цього маршрут у веб-застосунку відображатиметься на справжній карті.

## Як це працює в коді

| Файл | Роль |
|---|---|
| `public/vendor/maplibre-gl.js`, `maplibre-gl.css` | рендерер карти (~800 КБ,BSD-3) |
| `public/vendor/pmtiles.js` | протокол `pmtiles://` — читає архів по HTTP Range |
| `public/app.js` → `openTrackModal()` | ліниве підключення бібліотек, запит `/api/trips/:id/track` |
| `public/app.js` → `renderTrackMap()` | декодує полілінії, будує шари, додає підкладку |
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
4. **Підписи вулиць відсутні** — шар `region-*` малює лише лінії, без `symbol`-шару
   (йому потрібні гліфи, яких у PMTiles немає). Це ціна компактності архіву.

## Альтернативи, які відкинули

- **Варіант A** (свій рендер на сітці): вулиць не видно взагалі.
- **Варіант B** (Leaflet + OSM): зовнішні запити до чужих серверів — ламає CSP
  і зливає маршрути водія. Саме те, від чого вся система уникає.
