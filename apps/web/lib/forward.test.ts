import { describe, expect, it, vi } from 'vitest';
import { forwardToApi, MAX_BODY_BYTES } from './forward';

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
        cookie: 'floty.session_token=abc',
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
      cookie: 'floty.session_token=abc',
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
    headers.append('set-cookie', 'floty.session_token=a; HttpOnly; SameSite=Lax; Path=/');
    headers.append('set-cookie', 'floty.session_data=; Max-Age=0; Path=/');
    const { fetch } = upstream(new Response('{"ok":true}', { status: 200, headers }));

    const response = await forwardToApi(
      new Request('http://localhost:3000/api/auth/sign-in/email', { method: 'POST', body: '{}' }),
      { apiBaseUrl: API, fetch },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()).toEqual([
      'floty.session_token=a; HttpOnly; SameSite=Lax; Path=/',
      'floty.session_data=; Max-Age=0; Path=/',
    ]);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
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
});
