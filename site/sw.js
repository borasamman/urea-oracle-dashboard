/* Dreymoor Urea Oracle — service worker (PWA shell, installed 24 Aug 2026)
 *
 * Strategy:
 *  - The edition page (index.html) is NETWORK-FIRST: every launch tries the
 *    live site so a fresh 13:00 / 19:00 flip is always shown; if the phone is
 *    offline the last edition seen is served from cache.
 *  - Static shell files (icons, manifest) are cache-first.
 *  - Nothing from other origins (Apps Script Weekly Digest, Google) is ever
 *    cached or intercepted.
 * The publisher only rewrites site/index.html, so this file survives every
 * publish. Bump CACHE when this file changes so old caches are dropped.
 */
const CACHE = 'oracle-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => null)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch Apps Script / Google

  const isPage = req.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('/index.html');

  if (isPage) {
    // network-first, cache fallback
    e.respondWith(
      fetch(new Request(req, { cache: 'no-store' }))
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // static shell: cache-first, refresh in background
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
