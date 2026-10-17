import { MeResponseSchema, type MeResponse } from '@floty/contracts';
import { describe, expect, it, vi } from 'vitest';
import { loadAccount, loadCurrentBusiness, requiredStep, ROUTES, type Account } from './account';

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';
const OTHER = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708194';
const me: MeResponse = MeResponseSchema.parse({
  user: {
    id: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193',
    name: 'Ana',
    email: 'ana@example.test',
    twoFactorEnabled: true,
  },
  activeTenantId: TENANT,
  businesses: [{ tenantId: TENANT, name: 'Juniper', slug: 'juniper', role: 'owner' }],
});

function answering(status: number, body: unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn((url: URL, init?: RequestInit) => {
    calls.push({ url: url.href, ...(init && { init }) });
    return Promise.resolve(Response.json(body, { status }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const base = { baseUrl: 'http://api:4000', cookie: 'floty.session_token=abc' };

describe('loadAccount', () => {
  it('passes the cookie and returns the parsed account', async () => {
    const { fetch, calls } = answering(200, me);
    await expect(loadAccount({ ...base, fetch })).resolves.toEqual({ state: 'signed-in', me });
    expect(calls[0]?.url).toBe('http://api:4000/v1/me');
    expect(calls[0]?.init?.headers).toEqual({ cookie: 'floty.session_token=abc' });
  });

  it('sends no cookie header without a cookie', async () => {
    const { fetch, calls } = answering(401, {});
    await expect(loadAccount({ ...base, cookie: null, fetch })).resolves.toEqual({
      state: 'signed-out',
    });
    expect(calls[0]?.init?.headers).toEqual({});
  });

  it.each([
    ['an error status', answering(500, {}).fetch],
    ['an unexpected body', answering(200, { hello: 'world' }).fetch],
    [
      'a network failure',
      vi.fn(() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    ],
  ])('is unavailable on %s', async (_label, fetch) => {
    await expect(loadAccount({ ...base, fetch })).resolves.toEqual({ state: 'unavailable' });
  });
});

describe('loadCurrentBusiness', () => {
  const business = {
    business: {
      id: TENANT,
      name: 'Juniper',
      slug: 'juniper',
      timeZone: 'America/New_York',
      locale: 'en-US',
    },
    role: 'owner',
  };

  it('returns the business', async () => {
    const { fetch, calls } = answering(200, business);
    await expect(loadCurrentBusiness({ ...base, fetch })).resolves.toEqual(business);
    expect(calls[0]?.url).toBe('http://api:4000/v1/tenant');
  });

  it.each([
    [403, { code: 'mfa_required', message: 'x' }],
    [200, { nope: true }],
  ])('returns null for %i %j', async (status, body) => {
    const { fetch } = answering(status, body);
    await expect(loadCurrentBusiness({ ...base, fetch })).resolves.toBeNull();
  });
});

describe('requiredStep', () => {
  const signedIn = (overrides: Record<string, unknown>): Account => ({
    state: 'signed-in',
    me: MeResponseSchema.parse({ ...me, ...overrides }),
  });

  it('sends signed-out visitors to sign in', () => {
    expect(requiredStep({ state: 'signed-out' })).toBe(ROUTES.signIn);
  });

  it('sends a user without a business to create one', () => {
    expect(requiredStep(signedIn({ businesses: [], activeTenantId: null }))).toBe(
      ROUTES.createBusiness,
    );
  });

  it('sends an owner without MFA to set it up', () => {
    expect(requiredStep(signedIn({ user: { ...me.user, twoFactorEnabled: false } }))).toBe(
      ROUTES.twoFactor,
    );
  });

  it('lets staff without MFA in, and anyone else who is set up', () => {
    const staff = signedIn({
      user: { ...me.user, twoFactorEnabled: false },
      businesses: [{ tenantId: TENANT, name: 'Juniper', slug: 'juniper', role: 'staff' }],
    });
    expect(requiredStep(staff)).toBeNull();
    expect(requiredStep(signedIn({}))).toBeNull();
  });

  it('does not force MFA for an owner whose active business is another one', () => {
    const account = signedIn({
      user: { ...me.user, twoFactorEnabled: false },
      activeTenantId: OTHER,
      businesses: [
        { tenantId: TENANT, name: 'Juniper', slug: 'juniper', role: 'owner' },
        { tenantId: OTHER, name: 'Other', slug: 'other', role: 'staff' },
      ],
    });
    expect(requiredStep(account)).toBeNull();
  });

  it('shows the page (with its own error) when the api is unavailable', () => {
    expect(requiredStep({ state: 'unavailable' })).toBeNull();
  });
});
