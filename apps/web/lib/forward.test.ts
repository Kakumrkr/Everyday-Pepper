import { describe, expect, it, vi } from 'vitest';
import { MAX_IMPORT_BYTES } from '@pepper/contracts';
import { bodyLimitOf, forwardToApi, MAX_BODY_BYTES, MAX_PHOTO_UPLOAD_BYTES } from './forward';

const API = 'http://api:4000';

function upstream(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn((url: URL, init?: RequestInit) => {
    calls.push({ url: url.href, init: init ?? {} });
    return Promise.resolve(response);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe('forwardToApi', () => {
  it('forwards path, query, method, body and allowed headers only', async () => {
    const { fetch, calls } = upstream(new Response('{}', { status: 201 }));
    const request = new Request('http://localhost:3000/v1/tenants?x=1', {
      method: 'POST',
      body: JSON.stringify({ name: 'Juniper' }),
      headers: {
        'content-type': 'application/json',
        cookie: 'pepper.session_token=abc',
        origin: 'http://localhost:3000',
        'x-forwarded-for': '203.0.113.7',
        authorization: 'Bearer should-not-pass',
        host: 'localhost:3000',
      },
    });

    const response = await forwardToApi(request, { apiBaseUrl: API, fetch });

    expect(response.status).toBe(201);
    const [call] = calls;
    expect(call?.url).toBe('http://api:4000/v1/tenants?x=1');
    expect(call?.init.method).toBe('POST');
    expect(new TextDecoder().decode(call?.init.body as ArrayBuffer)).toBe('{"name":"Juniper"}');
    const sent = new Headers(call?.init.headers);
    expect(Object.fromEntries(sent)).toEqual({
      'content-type': 'application/json',
      cookie: 'pepper.session_token=abc',
      origin: 'http://localhost:3000',
      'x-forwarded-for': '203.0.113.7',
    });
    expect(call?.init.redirect).toBe('manual');
  });

  it('sends no body for GET', async () => {
    const { fetch, calls } = upstream(new Response('{}'));
    await forwardToApi(new Request('http://localhost:3000/v1/me'), { apiBaseUrl: API, fetch });
    expect(calls[0]?.init).not.toHaveProperty('body');
  });

  it('passes back status, allowed headers and every cookie', async () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
      'x-powered-by': 'something',
      'content-encoding': 'gzip',
    });
    headers.append('set-cookie', 'pepper.session_token=a; HttpOnly; SameSite=Lax; Path=/');
    headers.append('set-cookie', 'pepper.session_data=; Max-Age=0; Path=/');
    const { fetch } = upstream(new Response('{"ok":true}', { status: 200, headers }));

    const response = await forwardToApi(
      new Request('http://localhost:3000/api/auth/sign-in/email', { method: 'POST', body: '{}' }),
      { apiBaseUrl: API, fetch },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toEqual([
      'pepper.session_token=a; HttpOnly; SameSite=Lax; Path=/',
      'pepper.session_data=; Max-Age=0; Path=/',
    ]);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  it('marks answers private and not to be stored unless the api says otherwise (S18)', async () => {
    const plain = upstream(new Response('{"clients":[]}'));
    const stored = await forwardToApi(new Request('http://localhost:3000/v1/clients'), {
      apiBaseUrl: API,
      fetch: plain.fetch,
    });
    expect(stored.headers.get('cache-control')).toBe('private, no-store');

    const cacheable = upstream(
      new Response('{}', { headers: { 'cache-control': 'public, max-age=60' } }),
    );
    const kept = await forwardToApi(new Request('http://localhost:3000/v1/templates'), {
      apiBaseUrl: API,
      fetch: cacheable.fetch,
    });
    expect(kept.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it.each([
    ['declared', { 'content-length': String(MAX_BODY_BYTES + 1) }, 'x'],
    ['actual', {}, 'x'.repeat(MAX_BODY_BYTES + 1)],
  ])(
    'refuses a body over the limit (%s size) without calling the api',
    async (_l, headers, body) => {
      const { fetch, calls } = upstream(new Response('{}'));
      const response = await forwardToApi(
        new Request('http://localhost:3000/v1/tenants', { method: 'POST', headers, body }),
        { apiBaseUrl: API, fetch },
      );
      expect(response.status).toBe(413);
      expect(calls).toHaveLength(0);
    },
  );

  it('lets a client import upload, and only that, carry up to 5 MB (S48.2)', async () => {
    expect(bodyLimitOf('POST', '/v1/imports')).toBe(MAX_IMPORT_BYTES);
    expect(bodyLimitOf('PUT', '/v1/imports/x/mapping')).toBe(MAX_BODY_BYTES);
    expect(bodyLimitOf('POST', '/v1/imports/x/commit')).toBe(MAX_BODY_BYTES);
    const { fetch, calls } = upstream(new Response('{}', { status: 201 }));
    const file = new Uint8Array(MAX_BODY_BYTES * 4);
    const response = await forwardToApi(
      new Request('http://localhost:3000/v1/imports?format=csv', {
        method: 'POST',
        headers: { 'content-type': 'text/csv' },
        body: file,
      }),
      { apiBaseUrl: API, fetch },
    );
    expect(response.status).toBe(201);
    expect((calls[0]?.init.body as ArrayBuffer).byteLength).toBe(file.byteLength);
  });

  it('lets a photo upload, and only that, carry up to 10 MB (S47.2)', async () => {
    expect(bodyLimitOf('POST', '/v1/tenant/photos')).toBe(MAX_PHOTO_UPLOAD_BYTES);
    expect(bodyLimitOf('PATCH', '/v1/tenant/photos')).toBe(MAX_BODY_BYTES);
    expect(bodyLimitOf('POST', '/v1/tenant/photos/x')).toBe(MAX_BODY_BYTES);
    expect(bodyLimitOf('POST', '/v1/tenants')).toBe(MAX_BODY_BYTES);
    const { fetch, calls } = upstream(new Response('{}', { status: 201 }));
    const photo = new Uint8Array(MAX_BODY_BYTES * 3);
    const response = await forwardToApi(
      new Request('http://localhost:3000/v1/tenant/photos?kind=cover', {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: photo,
      }),
      { apiBaseUrl: API, fetch },
    );
    expect(response.status).toBe(201);
    expect((calls[0]?.init.body as ArrayBuffer).byteLength).toBe(photo.byteLength);
    const refused = await forwardToApi(
      new Request('http://localhost:3000/v1/tenant/photos?kind=cover', {
        method: 'POST',
        headers: { 'content-length': String(MAX_PHOTO_UPLOAD_BYTES + 1) },
        body: 'x',
      }),
      { apiBaseUrl: API, fetch },
    );
    expect(refused.status).toBe(413);
    expect(calls).toHaveLength(1);
  });

  it('passes a photo’s own headers back', async () => {
    const { fetch } = upstream(
      new Response('webp', {
        headers: {
          'content-type': 'image/webp',
          'cache-control': 'public, max-age=31536000, immutable',
          'content-security-policy': "default-src 'none'",
          'cross-origin-resource-policy': 'same-origin',
        },
      }),
    );
    const response = await forwardToApi(
      new Request('http://localhost:3000/v1/public/businesses/fade/photos/x/640'),
      { apiBaseUrl: API, fetch },
    );
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('answers 502 without details when the api is unreachable', async () => {
    const fetch = vi.fn(() =>
      Promise.reject(new TypeError('connect ECONNREFUSED 10.0.0.5:4000')),
    ) as unknown as typeof globalThis.fetch;
    const response = await forwardToApi(new Request('http://localhost:3000/v1/me'), {
      apiBaseUrl: API,
      fetch,
    });
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain('api_unavailable');
    expect(body).not.toContain('10.0.0.5');
  });

  it('passes Last-Event-ID on, so a chat turn resumes after the last event (ADR-0030)', async () => {
    const { fetch, calls } = upstream(new Response(''));
    await forwardToApi(
      new Request('http://localhost:3000/v1/chat/turns/t/events', {
        headers: { 'last-event-id': '7', accept: 'text/event-stream' },
      }),
      { apiBaseUrl: API, fetch },
    );
    expect(new Headers(calls[0]?.init.headers).get('last-event-id')).toBe('7');
  });

  it('times out only until the api answers, so an event stream may run longer', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetch = vi.fn((_url: URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response('data: x\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        );
      }) as unknown as typeof globalThis.fetch;
      const response = await forwardToApi(
        new Request('http://localhost:3000/v1/chat/turns', { method: 'POST', body: '{}' }),
        {
          apiBaseUrl: API,
          fetch,
          timeoutMs: 1_000,
        },
      );
      vi.advanceTimersByTime(60_000);
      expect(signal?.aborted).toBe(false);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up when the api does not answer in time', async () => {
    const fetch = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        }),
    ) as unknown as typeof globalThis.fetch;
    const response = await forwardToApi(new Request('http://localhost:3000/v1/me'), {
      apiBaseUrl: API,
      fetch,
      timeoutMs: 20,
    });
    expect(response.status).toBe(502);
  });
});
