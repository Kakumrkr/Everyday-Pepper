import { describe, expect, it } from 'vitest';
import { GOOGLE_EVENTS_SCOPE, calendarEventBodyOf } from '@pepper/contracts';
import { SANDBOX_ACCOUNT_EMAIL, SandboxCalendarProvider } from './sandbox.js';

const REDIRECT = 'http://localhost:3000/more/calendar/google';
const NOW = Date.parse('2026-12-01T12:00:00Z');
const VERIFIER = 'v'.repeat(43);

describe('the sandbox', () => {
  const sandbox = new SandboxCalendarProvider(REDIRECT, () => NOW);

  it("sends the member straight back to the app's return page with a code and the state", () => {
    const url = new URL(sandbox.consentUrl({ state: 's'.repeat(43), codeChallenge: 'c' }));
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get('code')).toBe('sandbox-ok');
    expect(url.searchParams.get('state')).toBe('s'.repeat(43));
  });

  it('connects, refreshes and reads one busy hour a day', async () => {
    const granted = await sandbox.exchangeCode({ code: 'sandbox-ok', codeVerifier: VERIFIER });
    expect(granted.accountEmail).toBe(SANDBOX_ACCOUNT_EMAIL);
    const access = await sandbox.refresh(granted.refreshToken);
    expect(access.expiresAt).toEqual(new Date(NOW + 3_600_000));
    expect(
      await sandbox.freeBusy({
        accessToken: access.accessToken,
        from: new Date('2026-12-01T00:00:00Z'),
        to: new Date('2026-12-03T00:00:00Z'),
      }),
    ).toEqual([
      { start: '2026-12-01T17:00:00.000Z', end: '2026-12-01T18:00:00.000Z' },
      { start: '2026-12-02T17:00:00.000Z', end: '2026-12-02T18:00:00.000Z' },
    ]);
  });

  it('refuses an unknown code, a refresh token it expired, and a revoked one', async () => {
    await expect(sandbox.exchangeCode({ code: 'x', codeVerifier: VERIFIER })).rejects.toMatchObject(
      {
        code: 'invalid_grant',
      },
    );
    const expiring = await sandbox.exchangeCode({
      code: 'sandbox-expiring',
      codeVerifier: VERIFIER,
    });
    await expect(sandbox.refresh(expiring.refreshToken)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
    const ok = await sandbox.exchangeCode({ code: 'sandbox-ok', codeVerifier: VERIFIER });
    await sandbox.revoke(ok.refreshToken);
    await expect(sandbox.refresh(ok.refreshToken)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('sandbox-expired: an access token already run out and a refresh it refuses (S70.2)', async () => {
    const expired = await sandbox.exchangeCode({ code: 'sandbox-expired', codeVerifier: VERIFIER });
    expect(expired.expiresAt.getTime()).toBe(NOW);
    await expect(sandbox.refresh(expired.refreshToken)).rejects.toMatchObject({
      code: 'invalid_grant',
    });
  });

  it('refuses a token it did not make', async () => {
    await expect(
      sandbox.freeBusy({ accessToken: 'ya29.real', from: new Date(NOW), to: new Date(NOW + 1) }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });
});

describe("the sandbox's calendars (S71)", () => {
  const event = (startsAt: string) =>
    calendarEventBodyOf({
      bookingId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      serviceName: 'Skin fade',
      clientFirstName: 'Ana',
      startsAt: new Date(startsAt),
      endsAt: new Date(Date.parse(startsAt) + 45 * 60_000),
    });

  it('keeps one event per id, like Google, and brings a deleted one back by a patch', async () => {
    const sandbox = new SandboxCalendarProvider(REDIRECT, () => NOW);
    const accessToken = 'sbx-a-test';
    const { id: calendarId } = await sandbox.createCalendar({
      accessToken,
      name: 'Pepper bookings',
      timeZone: 'America/New_York',
    });
    const first = event('2026-12-01T15:00:00Z');
    expect(await sandbox.insertEvent({ accessToken, calendarId, event: first })).toBe('created');
    expect(await sandbox.insertEvent({ accessToken, calendarId, event: first })).toBe('exists');
    await sandbox.deleteEvent({ accessToken, calendarId, eventId: first.id });
    expect(sandbox.liveEvents(calendarId)).toEqual([]);
    expect(await sandbox.insertEvent({ accessToken, calendarId, event: first })).toBe('exists');
    const moved = event('2026-12-01T16:00:00Z');
    expect(await sandbox.patchEvent({ accessToken, calendarId, event: moved })).toBe('updated');
    expect(sandbox.liveEvents(calendarId)).toEqual([moved]);
  });

  it('says not_found for a calendar it never made or deleted, and refuses a bad token', async () => {
    const sandbox = new SandboxCalendarProvider(REDIRECT, () => NOW);
    const e = event('2026-12-01T15:00:00Z');
    await expect(
      sandbox.insertEvent({ accessToken: 'sbx-a-x', calendarId: 'nope', event: e }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await sandbox.patchEvent({ accessToken: 'sbx-a-x', calendarId: 'nope', event: e })).toBe(
      'missing',
    );
    await expect(
      sandbox.createCalendar({ accessToken: 'ya29', name: 'x', timeZone: 'UTC' }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('connects without the bookings permission for sandbox-busy-only', async () => {
    const sandbox = new SandboxCalendarProvider(REDIRECT, () => NOW);
    const granted = await sandbox.exchangeCode({
      code: 'sandbox-busy-only',
      codeVerifier: VERIFIER,
    });
    expect(granted.scopes).not.toContain(GOOGLE_EVENTS_SCOPE);
    expect(granted.scopes).toContain('https://www.googleapis.com/auth/calendar.freebusy');
  });
});
