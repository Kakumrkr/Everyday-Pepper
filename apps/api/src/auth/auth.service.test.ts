import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Database } from '@floty/db';
import { describe, expect, it, vi } from 'vitest';
import { BetterAuthService } from './auth.service.js';
import type { BetterAuth } from './better-auth.js';

const USER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';
const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';

function serviceReturning(result: unknown) {
  const getSession = vi.fn(() => Promise.resolve(result));
  const auth = { api: { getSession }, handler: vi.fn() } as unknown as BetterAuth;
  return { service: new BetterAuthService(auth, {} as Database), getSession };
}

describe('BetterAuthService.getSession', () => {
  it('returns null without a session', async () => {
    await expect(serviceReturning(null).service.getSession({})).resolves.toBeNull();
  });

  it('maps the session, passing the request headers', async () => {
    const { service, getSession } = serviceReturning({
      session: { id: 's1', token: 'secret-token', activeTenantId: TENANT },
      user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
    });
    await expect(service.getSession({ cookie: 'floty.session_token=x' })).resolves.toEqual({
      id: 's1',
      user: { id: USER, name: 'Ana', email: 'ana@example.test', twoFactorEnabled: true },
      activeTenantId: TENANT,
    });
    const [[{ headers }]] = getSession.mock.calls as unknown as [[{ headers: Headers }]];
    expect(headers.get('cookie')).toBe('floty.session_token=x');
  });

  it('treats missing optional fields as "no business" and "no second factor"', async () => {
    const { service } = serviceReturning({
      session: { id: 's1', activeTenantId: null },
      user: { id: USER, name: 'Ana', email: 'ana@example.test' },
    });
    await expect(service.getSession({})).resolves.toMatchObject({
      activeTenantId: null,
      user: { twoFactorEnabled: false },
    });
  });

  it('fails loudly on an unexpected shape rather than trusting it', async () => {
    const { service } = serviceReturning({
      session: { id: 's1', activeTenantId: 'not-a-uuid' },
      user: { id: USER, name: 'Ana', email: 'ana@example.test' },
    });
    await expect(service.getSession({})).rejects.toThrow();
  });
});

describe('BetterAuthService.handle', () => {
  function fakeRequest(headers: Record<string, string>) {
    const request = Object.assign(new EventEmitter(), {
      method: 'GET',
      url: '/api/auth/ok',
      headers: { host: 'localhost:4000', ...headers },
      socket: { remoteAddress: '203.0.113.7' },
    });
    return request as unknown as IncomingMessage;
  }

  async function handle(headers: Record<string, string>) {
    const seen: Request[] = [];
    const auth = {
      api: {},
      handler: vi.fn((request: Request) => {
        seen.push(request);
        return Promise.resolve(new Response('ok'));
      }),
    } as unknown as BetterAuth;
    const response = Object.assign(new EventEmitter(), {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      write: vi.fn(() => true),
      end: vi.fn(),
    }) as unknown as ServerResponse;
    await new BetterAuthService(auth, {} as Database).handle(fakeRequest(headers), response);
    return seen[0]?.headers.get('x-forwarded-for');
  }

  it("keys rate limits on the socket address when nothing forwarded the client's", async () => {
    await expect(handle({})).resolves.toBe('203.0.113.7');
  });

  it('keeps the client address the web app forwarded', async () => {
    await expect(handle({ 'x-forwarded-for': '198.51.100.9' })).resolves.toBe('198.51.100.9');
  });
});
