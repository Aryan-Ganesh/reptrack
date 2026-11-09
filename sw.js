// RepTrack service worker.
// Strategy: NETWORK-FIRST for app files (so updates always appear when online),
// falling back to the cache when offline. Bump VERSION on every deploy.
const VERSION = 'v3';
const CACHE = 'reptrack-' + VERSION;
const FILES = ['./', './index.html', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // cache:'reload' skips the browser's HTTP cache so we never store stale copies
      Promise.all(FILES.map(f => fetch(new Request(f, { cache: 'reload' })).then(r => {
        if (!r.ok) throw new Error('Precache failed: ' + f);
        return cache.put(f, r);
      })))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    fetch(req, { cache: 'no-cache' })            // always revalidate with the server
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(hit => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});
