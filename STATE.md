# STATE.md — поточний стан

**Статус:** 🔴 у роботі — v1.3.1 у GitHub (коміт `d21cd6f`), але **продакшн падає**:
контейнер у циклі перезапусків із `no such column: source`. Потрібен редеплой у Portainer.
APK ще не зібрано.

**Останнє оновлення:** 2026-10-18 00:05

---

## Що вже зроблено (стисло)

Деталі по кожній версії — у [HISTORY.md](HISTORY.md).

- **v1.1.0** — аудит: 52 дефекти (5 критичних) знайдено й виправлено. Кодування
  `index.html`, stored XSS, JWT у `localStorage`, `.env` не читався, rate-lift через XFF.
- **v1.2.0** — `server.js` 1386 рядків → `src/`; 59 тестів; GPS зберігається завжди.
- **v1.3.0** — трекінг: `devices` + `track_segments`, `/api/track/segments`, Android-трекер
  (`android/`), UI маршруту (MapLibre + PMTiles), SW v7, `docs/TRACKING-MAP.md`.
- **v1.3.1** — гарячий фікс: міграція падала на існуючій БД (`no such column: source`);
  +7 тестів на шлях оновлення (89 разом).

---

## Що в роботі зараз

Код v1.3.1 готовий і запушений; продакшн ще на старому образі й падає.
Залишилось поза кодом: **редеплой**, збірка APK, (опційно) `region.pmtiles`.

Рішення власника (2026-10-17), деталі в `DECISIONS.md`:
- карта = **C** (локальний `region.pmtiles`, без зовнішніх тайлів);
- одометр питаємо **на початку паузи** (після відновлення руху водій уже їде);
- телефони: один Android + один iPhone → трекер лише на Android;
- обмеження «без збірки» **зняте** для `android/` (PWA залишається без збірки).

**Стан інструментів для Android:** Android SDK є (`%LOCALAPPDATA%/Android/Sdk`,
platform android-37.0, build-tools 36.0.0), але JDK лише 8, а AGP 8 потребує 17;
Gradle відсутній. Тому збірка APK — через GitHub Actions, не локально.

## Що заблоковано і чому

| Блокер | Причина | Що потрібно |
|--------|---------|-------------|
| Редеплой продакшену | Контейнер у циклі перезапусків — фікс уже в `origin/main`, треба Pull and redeploy | Доступ до Portainer |
| APK не зібрано | CI-воркфлоу падав на `android-actions/setup-android@v3`; виправлено в `67e7b66` | Перезапустити воркфлоу вручну: Actions → Run workflow |
| Бекап БД | Робиться на рівні хоста, не застосунку | Рішення власника: cron + `sqlite3 .backup` |
| Cloudflare Access | Налаштовується в Zero Trust, не в коді | Рішення власника |

## Наступні 3 кроки

1. **Редеплой у Portainer** → `https://trip.bojumbohost.pp.ua/api/health` → `{"status":"ok"}`.
   Це одночасно довершить міграцію БД (додасть `source`/`device_id` у `records`). Увійти заново.
2. **Зібрати APK** (Actions → `app-debug.apk`), поставити на Android, вставити токен із веб-застосунку.
3. **Налаштувати щоденний бекап** `data/database.sqlite` на хості + офлайн-тест на телефоні.

---

## Передача (для наступної сесії)

**Де ми:** v1.3.1 у `origin/main` (коміт `d21cd6f`). Усе написано й перевірено (89 тестів),
але продакшн залишається на старому образі й падає — потрібен редеплой. APK не зібрано.

**Що зроблено (цієї сесії):** схема (`devices`, `track_segments`, `records.source/device_id`),
`/api/devices/*`, `/api/track/segments`, `/api/trips/:id/track`, `/api/tiles`, geo-хелпери,
23 нових теста, `android/` на Kotlin, `.github/workflows/android.yml`,
UI маршруту (MapLibre + PMTiles, `public/vendor/`), `docs/TRACKING-MAP.md`, SW v7.

**На чому зупинились:** код v1.3.1 запушено; продакшн-БД у «напівмігрованому» стані
(таблиці `devices`/`track_segments` створились, колонки — ні). Редеплой довершить міграцію.

**Що робити далі:** див. «Наступні 3 кроки» вище. Опційно — згенерувати
`region.pmtiles` за `docs/TRACKING-MAP.md` і покласти в `tiles/`.

**Як підняти локально:**
```bash
npm install
ADMIN_PASSWORD=test1234 PORT=3000 npm start   # http://127.0.0.1:3000
npm test && npm run check
```

**Важливо:** локальний `curl` у цьому середовищі йде через проксі — для localhost
обов'язково `curl --noproxy '*'`.
