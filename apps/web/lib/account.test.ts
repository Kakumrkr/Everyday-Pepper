import { MeResponseSchema, type MeResponse } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  checkSignUp,
  confirmedUrl,
  emailError,
  newEmailError,
  passwordError,
  loadAccount,
  loadCurrentBusiness,
  loadInvites,
  loadMembers,
  loadPaymentAccount,
  loadPublicBusiness,
  requiredStep,
  ROUTES,
  withNext,
  type Account,
} from './account';

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

const base = { baseUrl: 'http://api:4000', cookie: 'pepper.session_token=abc' };

describe('loadAccount', () => {
  it('passes the cookie and returns the parsed account', async () => {
    const { fetch, calls } = answering(200, me);
    await expect(loadAccount({ ...base, fetch })).resolves.toEqual({ state: 'signed-in', me });
    expect(calls[0]?.url).toBe('http://api:4000/v1/me');
    expect(calls[0]?.init?.headers).toEqual({ cookie: 'pepper.session_token=abc' });
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
      templateId: null,
      brandColor: null,
      phone: null,
      publicAddress: null,
      cancellationPolicy: null,
      depositRefundHours: 24,
    },
    role: 'owner',
    permissions: ['business.read', 'members.read'],
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

describe('loadMembers and loadInvites', () => {
  const member = {
    userId: OTHER,
    name: 'Jess',
    email: 'jess@example.test',
    role: 'staff',
    joinedAt: '2026-10-17T12:00:00.000Z',
  };
  const invite = {
    id: OTHER,
    email: 'priya@example.test',
    role: 'manager',
    invitedBy: null,
    createdAt: '2026-10-17T12:00:00.000Z',
    expiresAt: '2026-10-24T12:00:00.000Z',
  };

  it('return the lists from their endpoints', async () => {
    const members = answering(200, { members: [member] });
    await expect(loadMembers({ ...base, fetch: members.fetch })).resolves.toEqual([member]);
    expect(members.calls[0]?.url).toBe('http://api:4000/v1/members');
    const invites = answering(200, { invites: [invite] });
    await expect(loadInvites({ ...base, fetch: invites.fetch })).resolves.toEqual([invite]);
    expect(invites.calls[0]?.url).toBe('http://api:4000/v1/invites');
  });

  it('return null when the api refuses (e.g. staff) or answers nonsense', async () => {
    const forbidden = answering(403, { code: 'forbidden', message: 'x' });
    await expect(loadMembers({ ...base, fetch: forbidden.fetch })).resolves.toBeNull();
    const nonsense = answering(200, { invites: [{ id: 1 }] });
    await expect(loadInvites({ ...base, fetch: nonsense.fetch })).resolves.toBeNull();
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

  it('sends a manager without MFA to set it up', () => {
    const manager = signedIn({
      user: { ...me.user, twoFactorEnabled: false },
      businesses: [{ tenantId: TENANT, name: 'Juniper', slug: 'juniper', role: 'manager' }],
    });
    expect(requiredStep(manager)).toBe(ROUTES.twoFactor);
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

describe('withNext', () => {
  it('adds the page to return to, encoded', () => {
    expect(withNext(ROUTES.signIn, '/invite')).toBe('/sign-in?next=%2Finvite');
    expect(withNext(ROUTES.signUp, null)).toBe('/sign-up');
  });
});

describe('loadPublicBusiness', () => {
  const page = {
    name: 'Juniper Hair Studio',
    slug: 'juniper',
    timeZone: 'America/New_York',
    brandColor: null,
    phone: null,
    publicAddress: null,
    cancellationPolicy: null,
    photos: { logo: null, cover: null, gallery: [] },
    services: [],
    staff: [],
  };

  it('asks without a cookie, passing the visitor’s address', async () => {
    const { fetch, calls } = answering(200, page);
    await expect(
      loadPublicBusiness('juniper', {
        baseUrl: 'http://api:4000',
        cookie: null,
        forwardedFor: '203.0.113.7',
        fetch,
      }),
    ).resolves.toEqual({ state: 'found', business: page });
    expect(calls[0]?.url).toBe('http://api:4000/v1/public/businesses/juniper');
    expect(calls[0]?.init?.headers).toEqual({ 'x-forwarded-for': '203.0.113.7' });
  });

  it('tells a missing page from an api that fails', async () => {
    const options = { baseUrl: 'http://api:4000', cookie: null };
    expect(
      await loadPublicBusiness('nobody', { ...options, fetch: answering(404, {}).fetch }),
    ).toEqual({ state: 'missing' });
    expect(
      await loadPublicBusiness('juniper', { ...options, fetch: answering(503, {}).fetch }),
    ).toEqual({ state: 'unavailable' });
    expect(
      await loadPublicBusiness('juniper', { ...options, fetch: answering(200, { name: 1 }).fetch }),
    ).toEqual({ state: 'unavailable' });
  });
});

describe('checkSignUp', () => {
  it('says what each empty or short field needs, before anything is sent', () => {
    expect(checkSignUp({ name: ' ', email: '', password: '' })).toEqual({
      name: 'Enter your name, as your team and clients will see it.',
      email: 'Enter your email. You’ll sign in with it.',
      password: 'Use a password of at least 10 characters.',
    });
    expect(checkSignUp({ name: 'Ana', email: 'ana@', password: 'x'.repeat(129) })).toEqual({
      email: 'Enter your email. You’ll sign in with it.',
      password: 'Use a password of at most 128 characters.',
    });
  });

  it('passes a filled-in form', () => {
    expect(
      checkSignUp({ name: 'Ana Reyes', email: 'ana@example.com', password: 'correct horse' }),
    ).toEqual({});
  });
});

describe('account recovery checks (S44)', () => {
  it('asks for an email address, a long enough password, and a new email that differs', () => {
    expect(emailError('ana@example.test')).toBeUndefined();
    expect(emailError('ana@', 'Enter the email you sign in with.')).toBe(
      'Enter the email you sign in with.',
    );
    expect(passwordError('short')).toBe('Use a password of at least 10 characters.');
    expect(passwordError('x'.repeat(129))).toBe('Use a password of at most 128 characters.');
    expect(passwordError('a long passphrase')).toBeUndefined();
    expect(newEmailError('ANA@example.test ', 'ana@example.test')).toBe(
      'That’s already your email. Enter a different one.',
    );
    expect(newEmailError('nope', 'ana@example.test')).toBe(
      'Enter the new email you want to sign in with.',
    );
    expect(newEmailError('ana@new.example', 'ana@example.test')).toBeUndefined();
  });

  it('sends an emailed link back through /email-confirmed, keeping an allowed next page', () => {
    expect(confirmedUrl(null)).toBe('/email-confirmed');
    expect(confirmedUrl('/invite')).toBe('/email-confirmed?next=%2Finvite');
  });
});

describe('loadPaymentAccount (AC-X-106)', () => {
  const account = {
    status: 'ready',
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
    due: [],
    eventuallyDue: [],
    dueBy: null,
    disabledReason: null,
    syncedAt: '2026-11-22T15:00:00.000Z',
    canManage: true,
  };
  const options = (fetch: typeof globalThis.fetch) => ({
    baseUrl: 'http://api:3001',
    cookie: 'pepper=1',
    fetch,
  });

  it('reads the account with the cookie', async () => {
    const { fetch, calls } = answering(200, account);
    await expect(loadPaymentAccount(options(fetch))).resolves.toEqual({ state: 'on', account });
    expect(calls[0]?.url).toBe('http://api:3001/v1/payments/account');
  });

  it('is off only for the api’s own payments_off', async () => {
    const off = answering(404, { code: 'payments_off', message: 'x' });
    await expect(loadPaymentAccount(options(off.fetch))).resolves.toEqual({ state: 'off' });
    const other = answering(404, { code: 'not_found', message: 'x' });
    await expect(loadPaymentAccount(options(other.fetch))).resolves.toEqual({
      state: 'unavailable',
    });
  });

  it('is unavailable for a refusal, a failure or another shape', async () => {
    for (const [status, body] of [
      [403, { code: 'forbidden', message: 'x' }],
      [500, null],
      [200, { ...account, status: 'mystery' }],
    ] as const) {
      const { fetch } = answering(status, body);
      await expect(loadPaymentAccount(options(fetch))).resolves.toEqual({ state: 'unavailable' });
    }
    const down = vi.fn(() => Promise.reject(new Error('down')));
    await expect(loadPaymentAccount(options(down))).resolves.toEqual({ state: 'unavailable' });
  });
});
