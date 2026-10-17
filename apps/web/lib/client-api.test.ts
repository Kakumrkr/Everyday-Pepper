import { describe, expect, it, vi } from 'vitest';
import { messageFor, sendJson } from './client-api';

describe('messageFor', () => {
  it.each([
    [401, { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' }, 'match'],
    [422, { code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL' }, 'already exists'],
    [409, { code: 'slug_taken', message: 'x' }, 'booking link is taken'],
    [409, { code: 'business_limit_reached', message: 'x' }, 'at most 5 businesses'],
    [401, { code: 'INVALID_CODE' }, 'code didn’t work'],
  ])('explains %i %j', (status, body, expected) => {
    expect(messageFor(status, body)).toContain(expected);
  });

  it('explains rate limiting', () => {
    expect(messageFor(429, null)).toContain('Too many attempts');
  });

  it('never shows raw server text for unknown errors', () => {
    expect(messageFor(500, { code: 'SOMETHING', message: 'stack trace at db.ts:1' })).toBe(
      'Something went wrong. Try again.',
    );
  });
});

describe('sendJson', () => {
  it('posts JSON to the same origin and returns the data', async () => {
    const fetch = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(Response.json({ id: 1 })),
    );
    const result = await sendJson('POST', '/v1/tenants', { name: 'J' }, fetch as never);
    expect(result).toEqual({ ok: true, data: { id: 1 } });
    expect(fetch).toHaveBeenCalledWith('/v1/tenants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"J"}',
      credentials: 'same-origin',
    });
  });

  it('returns a friendly message on failure', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(Response.json({ code: 'INVALID_CODE' }, { status: 401 })),
    );
    await expect(sendJson('POST', '/x', {}, fetch as never)).resolves.toMatchObject({
      ok: false,
      status: 401,
      message: expect.stringContaining('code didn’t work') as unknown,
    });
  });

  it('handles an empty body and being offline', async () => {
    const empty = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(sendJson('PUT', '/x', {}, empty as never)).resolves.toEqual({
      ok: true,
      data: null,
    });
    const offline = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(sendJson('PUT', '/x', {}, offline as never)).resolves.toMatchObject({
      ok: false,
      status: 0,
    });
  });
});
