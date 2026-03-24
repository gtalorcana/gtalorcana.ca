const CACHE = 'lore-counter-20260324021254';

const PRECACHE = [
  '/lore-counter/',
  '/lore-counter/index.html',
  '/lore-counter/lore-counter.css',
  '/lore-counter/lore-counter.js',
  '/shared.css',
  '/tools.css',
  '/shared.js',
  '/gtalorcana-logo.svg',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  // Navigation (HTML): network-first so page is never stale; cache fallback for offline
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }
  // Static assets: cache-first for speed and offline support
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
