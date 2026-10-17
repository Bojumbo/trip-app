/* Service Worker — офлайн-режим */

const CACHE_NAME = 'trip-tracker-v5';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/vendor/chart.umd.min.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-180.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Кешуємо поштучно: збій одного файлу не ламає весь офлайн-режим
      await Promise.all(
        STATIC_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (err) {
            console.warn('[SW] Не вдалося закешувати', url);
          }
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // сторонні ресурси не чіпаємо
  if (url.pathname.startsWith('/api/')) return;      // API — завжди мережа

  // Навігація: спочатку мережа (щоб оновлення доходили), потім кеш
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', clone)).catch(() => {});
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html');
          return cached || new Response(
            '<!DOCTYPE html><meta charset="utf-8"><p style="font-family:sans-serif;padding:24px">Офлайн. Сторінка недоступна — відкрийте застосунок пізніше.</p>',
            { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          );
        })
    );
    return;
  }

  // Статика: кеш → мережа з оновленням кешу
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
