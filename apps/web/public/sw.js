// Pepper's service worker (ADR-0023): the installed app opens to an offline page when there is
// no connection. It keeps only that page, which carries its own styles and mark. Nothing else
// is cached: pages and /v1 answers hold a business's data and are always fetched from the
// network, so a shared device never shows one person's calendar to another, and sign-out
// needs no cache clean-up.
// It also shows the team's pushes (ADR-0026): a title, a line and an app page to open. They
// never name a client, and a tap only ever opens a page of this app.
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

/**
 * The app page a push asks to open, as a full URL of this origin; Home for anything else (a
 * full URL, `//host`, or `/\\host`, which browsers also read as another host).
 */
function appUrl(url) {
  const home = new URL('/', self.location.origin).href;
  if (typeof url !== 'string' || !url.startsWith('/')) return home;
  try {
    const target = new URL(url, self.location.origin);
    return target.origin === self.location.origin ? target.href : home;
  } catch {
    return home;
  }
}

self.addEventListener('push', (event) => {
  let push = {};
  try {
    push = event.data ? event.data.json() : {};
  } catch {
    // Not ours or damaged: still show something, as browsers require for a push.
  }
  const title = typeof push.title === 'string' && push.title !== '' ? push.title : 'Pepper';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof push.body === 'string' ? push.body : '',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      ...(typeof push.tag === 'string' && { tag: push.tag }),
      data: { url: appUrl(push.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Set by the push handler; checked again, as the notification's data outlives this code.
  const stored = event.notification.data && event.notification.data.url;
  const origin = self.location.origin;
  const target = appUrl(
    typeof stored === 'string' && stored.startsWith(`${origin}/`)
      ? stored.slice(origin.length)
      : '/',
  );
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      // Reuse an open window of the app when there is one.
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) return open.focus().then((client) => client.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});
