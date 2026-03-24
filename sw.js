const CACHE = 'lore-counter-20260323224052';

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
  // Only handle same-origin requests
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
