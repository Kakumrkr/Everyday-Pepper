// Pepper's service worker (ADR-0023): the installed app opens to an offline page when there is
// no connection. It keeps only that page, which carries its own styles and mark. Nothing else
// is cached: pages and /v1 answers hold a business's data and are always fetched from the
// network, so a shared device never shows one person's calendar to another, and sign-out
// needs no cache clean-up.
// Bump VERSION when the offline page changes.

const VERSION = 'v1';
const CACHE = `pepper-offline-${VERSION}`;
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('pepper-') && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  // Only page loads; every other request goes to the network as if there were no worker.
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  event.respondWith(
    fetch(request).catch(() =>
      caches.match(OFFLINE_URL, { cacheName: CACHE }).then((page) => page ?? Response.error()),
    ),
  );
});
