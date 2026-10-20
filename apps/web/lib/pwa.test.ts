import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { color, COLORS, type ColorToken } from '@pepper/ui';
import { describe, expect, it, vi } from 'vitest';
import { MANIFEST_URL, registerServiceWorker, SERVICE_WORKER_URL } from './pwa';
import { SECURITY_HEADERS, SERVICE_WORKER_HEADERS } from './security-headers';

const publicFile = (path: string) => new URL(`../public${path}`, import.meta.url);

describe('registerServiceWorker', () => {
  it('registers the worker for the whole app in production', async () => {
    const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
    await expect(registerServiceWorker({ serviceWorker: { register } }, true)).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does nothing in development or where workers are not supported', async () => {
    const register = vi.fn(() => Promise.resolve({} as ServiceWorkerRegistration));
    await expect(registerServiceWorker({ serviceWorker: { register } }, false)).resolves.toBe(
      false,
    );
    await expect(registerServiceWorker({}, true)).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('never throws when registering fails (e.g. a private window)', async () => {
    const register = vi.fn(() => Promise.reject(new Error('SecurityError')));
    await expect(registerServiceWorker({ serviceWorker: { register } }, true)).resolves.toBe(false);
  });
});

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(publicFile(path));
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe('the web app manifest', () => {
  const manifest = JSON.parse(readFileSync(publicFile(MANIFEST_URL), 'utf8')) as {
    name: string;
    start_url: string;
    scope: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: { src: string; sizes: string; type: string; purpose: string }[];
  };

  it('makes the app installable: standalone, the whole app, Pepper’s colors', () => {
    expect(manifest).toMatchObject({
      name: 'Pepper',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: color('bg', 'light'),
      theme_color: color('bg', 'light'),
    });
  });

  it('lists 192 and 512 px icons and a maskable one, each the size it says', () => {
    expect(manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '512x512 maskable',
    ]);
    for (const icon of manifest.icons) {
      const [width, height] = pngSize(icon.src);
      expect(`${String(width)}x${String(height)}`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
    expect(pngSize('/icons/apple-touch-icon.png')).toEqual([180, 180]);
  });
});

describe('the offline page', () => {
  const html = readFileSync(publicFile('/offline.html'), 'utf8');
  const [light = '', dark = ''] = html.split('@media (prefers-color-scheme: dark)');

  it('carries the design tokens of both themes', () => {
    const tokens = [...light.matchAll(/--([a-z0-9-]+): (#[0-9a-f]{6});/g)];
    expect(tokens.length).toBeGreaterThan(5);
    for (const [, name = '', hex = ''] of tokens) {
      expect(name in COLORS, name).toBe(true);
      expect(hex).toBe(color(name as ColorToken, 'light').toLowerCase());
      expect(dark).toContain(`--${name}: ${color(name as ColorToken, 'dark').toLowerCase()};`);
    }
  });

  it('loads nothing from the network: no external script, style, image or font', () => {
    expect(html).not.toMatch(/\s(src|href)=/);
    expect(html).not.toMatch(/url\(/);
  });
});

describe('response headers', () => {
  const headers = Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]));

  it('forbid framing by any site, MIME sniffing and full referrers', () => {
    expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
  });

  it('keep the worker script fresh', () => {
    expect(SERVICE_WORKER_HEADERS).toContainEqual({ key: 'Cache-Control', value: 'no-cache' });
  });
});

type Listener = (event: unknown) => void;

/** Runs public/sw.js in a sandbox with fake caches and network; returns its listeners. */
function loadWorker({ online }: { online: boolean }) {
  const listeners = new Map<string, Listener>();
  const stored = new Map<string, Map<string, Response>>([
    ['pepper-offline-v0', new Map()],
    ['someone-else', new Map()],
  ]);
  const offlinePage = new Response('<h1>You’re offline</h1>');
  const fetch = vi.fn((request: Request) =>
    online
      ? Promise.resolve(new Response(`page ${new URL(request.url).pathname}`))
      : Promise.reject(new TypeError('Failed to fetch')),
  );
  const caches = {
    open: (name: string) => {
      const cache = stored.get(name) ?? new Map<string, Response>();
      stored.set(name, cache);
      return Promise.resolve({
        add: (request: Request) => {
          cache.set(new URL(request.url, 'https://pepper.test').pathname, offlinePage);
          return Promise.resolve();
        },
      });
    },
    keys: () => Promise.resolve([...stored.keys()]),
    delete: (name: string) => Promise.resolve(stored.delete(name)),
    match: (url: string, { cacheName }: { cacheName: string }) =>
      Promise.resolve(stored.get(cacheName)?.get(url)),
  };
  const windows: {
    url: string;
    focus: () => Promise<unknown>;
    navigate: (url: string) => Promise<unknown>;
  }[] = [];
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(() => Promise.resolve()),
    location: { origin: 'https://pepper.test' },
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
    clients: {
      claim: vi.fn(() => Promise.resolve()),
      matchAll: vi.fn(() => Promise.resolve(windows)),
      openWindow: vi.fn(() => Promise.resolve(null)),
    },
  };
  runInNewContext(readFileSync(publicFile(SERVICE_WORKER_URL), 'utf8'), {
    self,
    caches,
    fetch,
    Request: class extends Request {
      constructor(url: string, init?: RequestInit) {
        super(new URL(url, 'https://pepper.test'), init);
      }
    },
    Response,
    URL,
  });

  async function dispatch(type: string, event: object): Promise<unknown> {
    let waited: Promise<unknown> = Promise.resolve(undefined);
    let answered: Promise<unknown> | undefined;
    listeners.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => (waited = promise),
      respondWith: (promise: Promise<unknown>) => (answered = promise),
    });
    await waited;
    return answered === undefined ? undefined : await answered;
  }
  const page = (path: string, init: { mode?: string; method?: string } = {}) => ({
    request: { url: `https://pepper.test${path}`, mode: 'navigate', method: 'GET', ...init },
  });
  return { dispatch, page, stored, fetch, offlinePage, self, windows };
}

describe('the service worker (public/sw.js)', () => {
  it('keeps the offline page on install and drops only its own older caches', async () => {
    const worker = loadWorker({ online: true });
    await worker.dispatch('install', {});
    expect([...(worker.stored.get('pepper-offline-v1')?.keys() ?? [])]).toEqual(['/offline.html']);
    expect(worker.self.skipWaiting).toHaveBeenCalled();

    await worker.dispatch('activate', {});
    expect([...worker.stored.keys()].sort()).toEqual(['pepper-offline-v1', 'someone-else']);
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });

  it('loads pages from the network when online and never stores them', async () => {
    const worker = loadWorker({ online: true });
    await worker.dispatch('install', {});
    const answer = (await worker.dispatch('fetch', worker.page('/calendar'))) as Response;
    expect(await answer.text()).toBe('page /calendar');
    expect([...(worker.stored.get('pepper-offline-v1')?.keys() ?? [])]).toEqual(['/offline.html']);
  });

  it('shows the offline page for any page when the network fails', async () => {
    const worker = loadWorker({ online: false });
    worker.stored.set('pepper-offline-v1', new Map([['/offline.html', worker.offlinePage]]));
    await expect(worker.dispatch('fetch', worker.page('/clients/abc'))).resolves.toBe(
      worker.offlinePage,
    );
  });

  it('leaves api calls, assets and writes alone', async () => {
    const worker = loadWorker({ online: true });
    for (const event of [
      worker.page('/v1/bookings', { mode: 'cors' }),
      worker.page('/_next/static/chunks/app.js', { mode: 'no-cors' }),
      worker.page('/v1/bookings', { method: 'POST' }),
    ]) {
      await expect(worker.dispatch('fetch', event)).resolves.toBeUndefined();
    }
    expect(worker.fetch).not.toHaveBeenCalled();
  });
});

describe('pushes in the service worker (ADR-0026)', () => {
  const pushOf = (data: unknown) => ({
    data: {
      json: () => {
        if (typeof data === 'string') throw new SyntaxError('not JSON');
        return data;
      },
    },
  });

  it('shows the push with its title, line and tag, opening an app page', async () => {
    const worker = loadWorker({ online: true });
    await worker.dispatch(
      'push',
      pushOf({
        title: 'New booking',
        body: 'Haircut, Tue 10:00 AM',
        url: '/calendar?date=2026-11-03',
        tag: 'booking-1',
      }),
    );
    expect(worker.self.registration.showNotification).toHaveBeenCalledWith('New booking', {
      body: 'Haircut, Tue 10:00 AM',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'booking-1',
      data: { url: 'https://pepper.test/calendar?date=2026-11-03' },
    });
  });

  it.each(['//evil.test/x', '/\\evil.test', 'https://evil.test/', 'calendar', 42])(
    'opens Home, never another site, for %j',
    async (url) => {
      const worker = loadWorker({ online: true });
      await worker.dispatch('push', pushOf({ title: 'x', url }));
      expect(worker.self.registration.showNotification).toHaveBeenCalledWith(
        'x',
        expect.objectContaining({ data: { url: 'https://pepper.test/' } }),
      );
    },
  );

  it('still shows something for a push that is not ours', async () => {
    const worker = loadWorker({ online: true });
    await worker.dispatch('push', pushOf('garbage'));
    await worker.dispatch('push', { data: null });
    expect(worker.self.registration.showNotification).toHaveBeenCalledTimes(2);
    expect(worker.self.registration.showNotification).toHaveBeenLastCalledWith(
      'Pepper',
      expect.objectContaining({ body: '', data: { url: 'https://pepper.test/' } }),
    );
  });

  const click = (url: unknown) => {
    const close = vi.fn();
    return { close, event: { notification: { close, data: { url } } } };
  };

  it('a tap opens the page in an open window of the app, else a new one', async () => {
    const worker = loadWorker({ online: true });
    const { close, event } = click('https://pepper.test/calendar?date=2026-11-03');
    await worker.dispatch('notificationclick', event);
    expect(close).toHaveBeenCalled();
    expect(worker.self.clients.openWindow).toHaveBeenCalledWith(
      'https://pepper.test/calendar?date=2026-11-03',
    );

    const navigate = vi.fn(() => Promise.resolve(null));
    const app = { url: 'https://pepper.test/', navigate, focus: () => Promise.resolve(app) };
    worker.windows.push(
      { url: 'https://other.test/', navigate, focus: () => Promise.resolve(null) },
      app,
    );
    await worker.dispatch('notificationclick', click('https://pepper.test/').event);
    expect(navigate).toHaveBeenCalledWith('https://pepper.test/');
    expect(worker.self.clients.openWindow).toHaveBeenCalledTimes(1);
  });

  it('a tap on a notification with another site in its data opens Home', async () => {
    const worker = loadWorker({ online: true });
    for (const url of ['https://evil.test/x', 'https://pepper.test.evil.test/x', null]) {
      await worker.dispatch('notificationclick', click(url).event);
    }
    expect(worker.self.clients.openWindow.mock.calls).toEqual([
      ['https://pepper.test/'],
      ['https://pepper.test/'],
      ['https://pepper.test/'],
    ]);
  });
});
