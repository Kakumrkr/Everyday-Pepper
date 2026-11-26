import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calendarEventBodyOf } from '@pepper/contracts';
import {
  GOOGLE_CALENDARS_URL,
  GOOGLE_FREEBUSY_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  GoogleCalendarProvider,
  formEncoded,
} from './google.js';
import { CalendarProviderError } from './provider.js';

// Contract tests on Google's documented request and answer shapes (ADR-0069 §1–3, AC-X-152,
// AC-X-155): what Pepper sends, and what it makes of each answer.

const CLIENT_ID = '1234-test.apps.googleusercontent.com';
const SECRET = 'GOCSPX-test-secret';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`;
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
      // A 204 (a delete) has no body.
      new Response(status === 204 ? null : JSON.stringify(answer), {
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
  it('asks offline for the email, free/busy and the bookings calendar, with the state and PKCE', () => {
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
      scope:
        'openid email https://www.googleapis.com/auth/calendar.freebusy https://www.googleapis.com/auth/calendar.app.created',
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

describe('formEncoded (RFC 6749 Appendix B)', () => {
  it('encodes as a form does, not as a URI component', () => {
    expect(formEncoded("a b!'()*~:")).toBe('a+b%21%27%28%29*%7E%3A');
    expect(formEncoded('GOCSPX-abc_123')).toBe('GOCSPX-abc_123');
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

// Google Calendar out (S71, ADR-0069 §10, AC-X-167…170, AC-X-174): the calendar Pepper makes and
// its events. Shapes from Calendar's v3 reference (read 2026-11-26).
describe('the bookings calendar and its events', () => {
  const CALENDAR =
    'c_0f9d8a7b6c5e4d3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f@group.calendar.google.com';
  const event = calendarEventBodyOf({
    bookingId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    serviceName: 'Skin fade',
    clientFirstName: 'Ana',
    startsAt: new Date('2026-12-01T15:00:00Z'),
    endsAt: new Date('2026-12-01T15:45:00Z'),
  });
  const eventUrl = `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(CALENDAR)}/events/${event.id}`;

  it('makes "Pepper bookings" in the business\'s time zone and keeps its id', async () => {
    const { fetch, seen } = stub([200, fixture('calendar-created')]);
    const made = await provider(fetch).createCalendar({
      accessToken: 'ya29.a',
      name: 'Pepper bookings',
      timeZone: 'America/New_York',
    });
    expect(made).toEqual({ id: CALENDAR });
    expect(seen[0]).toMatchObject({
      url: GOOGLE_CALENDARS_URL,
      method: 'POST',
      headers: { Authorization: 'Bearer ya29.a', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({
      summary: 'Pepper bookings',
      timeZone: 'America/New_York',
    });
    await expect(
      provider(stub([200, { summary: 'no id' }]).fetch).createCalendar({
        accessToken: 'a',
        name: 'Pepper bookings',
        timeZone: 'UTC',
      }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('inserts the event with its own id; "already exists" is an answer, not a failure', async () => {
    const { fetch, seen } = stub([200, fixture('event-written')]);
    expect(
      await provider(fetch).insertEvent({ accessToken: 'a', calendarId: CALENDAR, event }),
    ).toBe('created');
    expect(seen[0]?.url).toBe(`${GOOGLE_CALENDARS_URL}/${encodeURIComponent(CALENDAR)}/events`);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(JSON.parse(JSON.stringify(event)));
    expect(
      await provider(stub([409, fixture('error-409-duplicate')]).fetch).insertEvent({
        accessToken: 'a',
        calendarId: CALENDAR,
        event,
      }),
    ).toBe('exists');
  });

  it('says not_found when the calendar is gone, and refuses an answer about another event', async () => {
    await expect(
      provider(stub([404, fixture('error-404')]).fetch).insertEvent({
        accessToken: 'a',
        calendarId: CALENDAR,
        event,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      provider(stub([200, { id: 'pepperother', status: 'confirmed' }]).fetch).insertEvent({
        accessToken: 'a',
        calendarId: CALENDAR,
        event,
      }),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('patches the event by id; a missing one says so', async () => {
    const { fetch, seen } = stub([200, fixture('event-written')]);
    expect(
      await provider(fetch).patchEvent({ accessToken: 'a', calendarId: CALENDAR, event }),
    ).toBe('updated');
    expect(seen[0]).toMatchObject({ url: eventUrl, method: 'PATCH' });
    for (const [status, body] of [
      [404, fixture('error-404')],
      [410, fixture('error-410-deleted')],
    ] as const) {
      expect(
        await provider(stub([status, body]).fetch).patchEvent({
          accessToken: 'a',
          calendarId: CALENDAR,
          event,
        }),
      ).toBe('missing');
    }
  });

  it('deletes an event or the calendar; one already gone is fine', async () => {
    const { fetch, seen } = stub([204, {}]);
    await provider(fetch).deleteEvent({
      accessToken: 'a',
      calendarId: CALENDAR,
      eventId: event.id,
    });
    expect(seen[0]).toMatchObject({ url: eventUrl, method: 'DELETE' });
    await provider(stub([410, fixture('error-410-deleted')]).fetch).deleteEvent({
      accessToken: 'a',
      calendarId: CALENDAR,
      eventId: event.id,
    });
    await provider(stub([404, fixture('error-404')]).fetch).deleteCalendar({
      accessToken: 'a',
      calendarId: CALENDAR,
    });
  });

  it('maps a 401, a rate limit and a 5xx as the read does', async () => {
    const write = (status: number, body: unknown) =>
      provider(stub([status, body]).fetch).patchEvent({
        accessToken: 'a',
        calendarId: CALENDAR,
        event,
      });
    await expect(write(401, fixture('error-401'))).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(write(403, fixture('error-403-rate'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(write(503, {})).rejects.toMatchObject({ code: 'unavailable' });
    // Any other 403: the grant lacks the permission; not worth trying again soon.
    await expect(
      write(403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      provider(stub([500, {}]).fetch).deleteEvent({
        accessToken: 'a',
        calendarId: CALENDAR,
        eventId: event.id,
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('reading "Pepper bookings" back (S71.2, AC-X-175, AC-X-180)', () => {
  const CALENDAR = 'c_0f9d@group.calendar.google.com';
  const listUrl = `${GOOGLE_CALENDARS_URL}/${encodeURIComponent(CALENDAR)}/events`;

  it('reads every event the first time, deleted ones too, keeping only what Pepper reads', async () => {
    const { fetch, seen } = stub([200, fixture('events-page')]);
    const page = await provider(fetch).listEvents({
      accessToken: 'ya29.a',
      calendarId: CALENDAR,
      syncToken: null,
      pageToken: null,
    });
    expect(seen[0]).toMatchObject({
      url: `${listUrl}?showDeleted=true&maxResults=250`,
      method: 'GET',
      headers: { Authorization: 'Bearer ya29.a' },
    });
    if (page === 'sync_expired') throw new Error('expired');
    expect(page.nextSyncToken).toBeNull();
    expect(page.nextPageToken).toMatch(/^Cig/u);
    expect(page.events).toEqual([
      {
        id: 'pepper0193a1b2c3d47e5f8a9b0c1d2e3f4a5b',
        status: 'confirmed',
        summary: 'Skin fade · Ana',
        start: { dateTime: '2026-12-01T11:00:00-05:00' },
        end: { dateTime: '2026-12-01T11:45:00-05:00' },
      },
      {
        id: '2j4kd8v0q6m1p3rteu5o7c9b1a',
        status: 'confirmed',
        summary: 'Lunch',
        start: { date: '2026-12-02' },
        end: { date: '2026-12-03' },
      },
    ]);
    // Nothing a member typed beyond the title is kept: no description, place or guests.
    expect(JSON.stringify(page.events)).not.toMatch(/Back room|ana@example|Booked in Pepper/u);
  });

  it('goes on with the sync and page tokens, and ends with the next sync token', async () => {
    const { fetch, seen } = stub([200, fixture('events-last')]);
    const page = await provider(fetch).listEvents({
      accessToken: 'a',
      calendarId: CALENDAR,
      syncToken: 'CPD=',
      pageToken: 'Cig+/',
    });
    expect(new URL(seen[0]?.url ?? '').searchParams.get('syncToken')).toBe('CPD=');
    expect(new URL(seen[0]?.url ?? '').searchParams.get('pageToken')).toBe('Cig+/');
    expect(page).toEqual({
      events: [{ id: 'pepper0193a1b2c3d47e5f8a9b0c1d2e3f4a6c', status: 'cancelled' }],
      nextPageToken: null,
      nextSyncToken: 'CPDAlvWDx70CEPDAlvWDx70CGAU=',
    });
  });

  it("answers Google's 410 as a full read needed, and the rest as failures", async () => {
    const input = { accessToken: 'a', calendarId: CALENDAR, syncToken: 'old', pageToken: null };
    expect(await provider(stub([410, fixture('error-410-sync')]).fetch).listEvents(input)).toBe(
      'sync_expired',
    );
    await expect(
      provider(stub([404, fixture('error-404')]).fetch).listEvents(input),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      provider(stub([401, fixture('error-401')]).fetch).listEvents(input),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(
      provider(stub([403, fixture('error-403-rate')]).fetch).listEvents(input),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    // A page that names neither what follows nor a sync token, or both, isn't Google's answer.
    for (const bad of [
      { items: [] },
      { items: [], nextPageToken: 'p', nextSyncToken: 's' },
      { items: [{ status: 'confirmed' }], nextSyncToken: 's' },
    ]) {
      await expect(provider(stub([200, bad]).fetch).listEvents(input)).rejects.toBeInstanceOf(
        CalendarProviderError,
      );
    }
  });
});
