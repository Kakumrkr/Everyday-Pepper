import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_FREEBUSY_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleCalendarProvider,
} from './google.js';
import { CalendarProviderError } from './provider.js';

// Contract tests on Google's documented request and answer shapes (ADR-0069 §1–3, AC-X-152,
// AC-X-155): what Pepper sends, and what it makes of each answer.

const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const SECRET = 'GOCSPX-test-secret';
const BASIC = `Basic ${Buffer.from(`${encodeURIComponent(CLIENT_ID)}:${encodeURIComponent(SECRET)}`).toString('base64')}`;
const REDIRECT = 'https://app.pepper.test/more/calendar/google';
const NOW = Date.parse('2026-12-01T12:00:00Z');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
}

function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

const CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1100000000001',
  exp: NOW / 1000 + 3600,
  email: 'Jo.Barber@gmail.com',
  email_verified: true,
};

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stub(...answers: [number, unknown][]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fake = (input: string | URL, init?: RequestInit): Promise<Response> => {
    seen.push({
      url: input.toString(),
      method: init?.method ?? 'GET',
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const [status, answer] = answers[Math.min(seen.length - 1, answers.length - 1)] ?? [500, {}];
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  return { fetch: fake as typeof fetch, seen };
}

function provider(fake: typeof fetch): GoogleCalendarProvider {
  return new GoogleCalendarProvider({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    redirectUri: REDIRECT,
    fetch: fake,
    now: () => NOW,
  });
}

const withIdToken = (claims: Record<string, unknown>) => ({
  ...(fixture('token-code') as object),
  id_token: idToken(claims),
});

describe('the consent URL', () => {
  it('asks offline for the email and free/busy only, with the state and PKCE', () => {
    const url = new URL(
      provider(stub().fetch).consentUrl({
        state: 's'.repeat(43),
        codeChallenge: 'c'.repeat(43),
        loginHint: 'jo@gmail.com',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid email https://www.googleapis.com/auth/calendar.freebusy',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: 's'.repeat(43),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
      login_hint: 'jo@gmail.com',
    });
  });
});

describe('the code exchange', () => {
  it('posts the code, the verifier and the client to the token endpoint', async () => {
    const { fetch, seen } = stub([200, withIdToken(CLAIMS)]);
    const granted = await provider(fetch).exchangeCode({
      code: '4/0Ab-code',
      codeVerifier: 'v'.repeat(43),
    });
    expect(seen[0]?.url).toBe(GOOGLE_TOKEN_URL);
    expect(seen[0]?.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      grant_type: 'authorization_code',
      code: '4/0Ab-code',
      code_verifier: 'v'.repeat(43),
      redirect_uri: REDIRECT,
    });
    // The client goes in a Basic header (RFC 6749 §2.3.1), never in the body (S70.2).
    expect(seen[0]?.headers['Authorization']).toBe(BASIC);
    expect(granted).toEqual({
      refreshToken: '1//0g-test-refresh-token',
      accessToken: 'ya29.a0AfB_byC-test-access-token',
      expiresAt: new Date(NOW + 3599_000),
      scopes: [
        'https://www.googleapis.com/auth/calendar.freebusy',
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      accountEmail: 'jo.barber@gmail.com',
    });
  });

  it.each([
    ['another audience', { ...CLAIMS, aud: 'someone-else.apps.googleusercontent.com' }],
    ['an expired ID token', { ...CLAIMS, exp: NOW / 1000 - 1 }],
    ['an unverified email', { ...CLAIMS, email_verified: 'false' }],
    ['another issuer', { ...CLAIMS, iss: 'https://evil.example' }],
  ])('refuses %s', async (_, claims) => {
    await expect(
      provider(stub([200, withIdToken(claims)]).fetch).exchangeCode({
        code: 'c',
        codeVerifier: 'v',
      }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses an answer without a refresh token (no offline access granted)', async () => {
    const rest: Record<string, unknown> = { ...withIdToken(CLAIMS) };
    delete rest['refresh_token'];
    await expect(
      provider(stub([200, rest]).fetch).exchangeCode({ code: 'c', codeVerifier: 'v' }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('says invalid_grant for a used or expired code, without Google’s text', async () => {
    const error = await provider(stub([400, fixture('token-invalid-grant')]).fetch)
      .exchangeCode({ code: 'c', codeVerifier: 'v' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CalendarProviderError);
    expect(error).toMatchObject({ code: 'invalid_grant', status: 400 });
    expect(String(error)).not.toContain('expired or revoked');
  });
});

describe('the refresh (AC-X-155)', () => {
  it('posts the refresh token and gives the new access token with its expiry', async () => {
    const { fetch, seen } = stub([200, fixture('token-refresh')]);
    expect(await provider(fetch).refresh('1//0g-test-refresh-token')).toEqual({
      accessToken: 'ya29.a0AfB_byC-test-refreshed-token',
      expiresAt: new Date(NOW + 3599_000),
    });
    expect(Object.fromEntries(new URLSearchParams(seen[0]?.body))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: '1//0g-test-refresh-token',
    });
    expect(seen[0]?.headers['Authorization']).toBe(BASIC);
  });

  it('says invalid_grant when Google refused the refresh token (testing mode’s 7 days)', async () => {
    await expect(
      provider(stub([400, fixture('token-invalid-grant')]).fetch).refresh('1//old'),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it.each([
    [401, 'unauthorized'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('maps a %d to %s', async (status, code) => {
    await expect(provider(stub([status, {}]).fetch).refresh('1//x')).rejects.toMatchObject({
      code,
    });
  });
});

describe('freeBusy', () => {
  const input = {
    accessToken: 'ya29.token',
    from: new Date('2026-12-01T00:00:00Z'),
    to: new Date('2027-01-30T00:00:00Z'),
  };

  it('asks about the primary calendar with the bearer token and gives its busy times', async () => {
    const { fetch, seen } = stub([200, fixture('freebusy')]);
    expect(await provider(fetch).freeBusy(input)).toEqual([
      { start: '2026-12-01T09:00:00-05:00', end: '2026-12-01T10:00:00-05:00' },
      { start: '2026-12-02T15:00:00Z', end: '2026-12-02T16:30:00Z' },
    ]);
    expect(seen[0]?.url).toBe(GOOGLE_FREEBUSY_URL);
    expect(seen[0]?.headers['Authorization']).toBe('Bearer ya29.token');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      timeMin: '2026-12-01T00:00:00.000Z',
      timeMax: '2027-01-30T00:00:00.000Z',
      items: [{ id: 'primary' }],
    });
  });

  it.each([
    ['a 401 (an expired access token)', 401, 'error-401', 'unauthorized'],
    ['a 403 rate limit', 403, 'error-403-rate', 'rate_limited'],
    ['a calendar error', 200, 'freebusy-not-found', 'not_found'],
  ])('maps %s', async (_, status, name, code) => {
    await expect(
      provider(stub([status, fixture(name)]).fetch).freeBusy(input),
    ).rejects.toMatchObject({
      code,
    });
  });

  it('refuses an answer without the primary calendar', async () => {
    await expect(
      provider(
        stub([
          200,
          { timeMin: input.from.toISOString(), timeMax: input.to.toISOString(), calendars: {} },
        ]).fetch,
      ).freeBusy(input),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('says unavailable when the network fails', async () => {
    const failing = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    await expect(provider(failing).freeBusy(input)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('revoke', () => {
  it('posts the token; a token already gone is fine', async () => {
    const { fetch, seen } = stub([400, { error: 'invalid_token' }]);
    await provider(fetch).revoke('1//old');
    expect(seen[0]?.url).toBe(GOOGLE_REVOKE_URL);
    expect(seen[0]?.body).toBe('token=1%2F%2Fold');
  });

  it('says unavailable on a 5xx', async () => {
    await expect(provider(stub([503, {}]).fetch).revoke('t')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });
});
