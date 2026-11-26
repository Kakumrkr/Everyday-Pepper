import type { CalendarConnection, CalendarConnectionAnswer } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  bookingCalendarLine,
  bookingCalendarPath,
  calendarSummary,
  disconnectedNote,
  calendarWords,
  finishGoogleReturn,
  googleArrival,
  googleOutcomeOf,
  needsReconnect,
  outcomeNote,
  readAgo,
  teamCalendarLine,
} from './calendar-connect';

// The words of Google Calendar on screen (S70.2, AC-X-160…164).

const NY = 'America/New_York';
const NOW = new Date('2026-11-25T15:00:00.000Z');

function connection(over: Partial<CalendarConnection> = {}): CalendarConnection {
  return {
    staffMemberId: '0193a8f0-0000-7000-8000-000000000001' as CalendarConnection['staffMemberId'],
    provider: 'google',
    accountEmail: 'jess@gmail.com',
    status: 'connected',
    syncedAt: '2026-11-25T14:57:00.000Z' as CalendarConnection['syncedAt'],
    connectedAt: '2026-11-20T10:00:00.000Z' as CalendarConnection['connectedAt'],
    writesBookings: true,
    ...over,
  };
}

function answer(c: CalendarConnection | null, canConnect = true): CalendarConnectionAnswer {
  return { canConnect, connection: c };
}

describe('readAgo', () => {
  it.each([
    ['2026-11-25T14:59:31.000Z', 'just now'],
    ['2026-11-25T14:59:00.000Z', '1 min ago'],
    ['2026-11-25T14:57:00.000Z', '3 min ago'],
    ['2026-11-25T14:00:01.000Z', '59 min ago'],
    ['2026-11-25T14:00:00.000Z', '1 h ago'],
    ['2026-11-24T15:00:01.000Z', '23 h ago'],
  ])('%s reads %s', (at, words) => {
    expect(readAgo(at, NY, NOW)).toBe(words);
  });

  it('a day or more is the day, in the business’s time zone', () => {
    // 03:00 UTC on the 24th is still the 23rd in New York.
    expect(readAgo('2026-11-24T03:00:00.000Z', NY, NOW)).toBe('Nov 23');
  });

  it('a clock a little ahead never says "in the future"', () => {
    expect(readAgo('2026-11-25T15:00:05.000Z', NY, NOW)).toBe('just now');
  });
});

describe('calendarWords (AC-X-160)', () => {
  it('not connected: Connect, and what Pepper sees', () => {
    const words = calendarWords(answer(null), NY, NOW);
    expect(words).toMatchObject({
      badge: 'Not connected',
      action: 'Connect Google Calendar',
      disconnect: false,
    });
    expect(words.lines.join(' ')).toContain('never what the event is');
  });

  it('no staff member: no action, who can link it', () => {
    const words = calendarWords(answer(null, false), NY, NOW);
    expect(words).toMatchObject({ badge: 'Not linked', action: null, disconnect: false });
    expect(words.lines.join(' ')).toContain('The owner can link it on Team.');
  });

  it('connected: the account and the last read, no main action', () => {
    const words = calendarWords(answer(connection()), NY, NOW);
    expect(words).toMatchObject({ badge: 'Connected', tone: 'ok', action: null, disconnect: true });
    expect(words.lines[0]).toBe('jess@gmail.com · Read 3 min ago');
  });

  it('connected, before the first read', () => {
    const words = calendarWords(answer(connection({ syncedAt: null })), NY, NOW);
    expect(words.lines[0]).toBe('jess@gmail.com · Not read yet');
  });

  it('needs reconnecting: Reconnect, and the busy times are kept', () => {
    const words = calendarWords(answer(connection({ status: 'needs_reconnect' })), NY, NOW);
    expect(words).toMatchObject({
      badge: 'Needs reconnecting',
      tone: 'warn',
      action: 'Reconnect Google Calendar',
      disconnect: true,
    });
    expect(words.lines[1]).toBe(
      'Until you reconnect, Pepper keeps the busy times it last read, so nothing gets booked over them.',
    );
  });

  it('never a system word', () => {
    for (const a of [
      answer(null),
      answer(null, false),
      answer(connection()),
      answer(connection({ status: 'needs_reconnect', syncedAt: null })),
      answer(connection({ writesBookings: false })),
    ]) {
      const text = JSON.stringify(calendarWords(a, NY, NOW));
      expect(text).not.toMatch(/token|sync|oauth|invalid_grant|tenant|needs_reconnect/i);
    }
  });
});

describe('calendarWords for bookings in Google Calendar (S71, AC-X-167, AC-X-172)', () => {
  it('says where bookings go, and the disconnect deletes that calendar', () => {
    const words = calendarWords(answer(connection()), NY, NOW);
    expect(words.lines[2]).toBe('Your bookings are added to “Pepper bookings” in Google Calendar.');
    expect(words.disconnectNote).toContain('delete the “Pepper bookings” calendar');
    expect(calendarWords(answer(null), NY, NOW).lines.join(' ')).toContain(
      'adds your bookings to a calendar of its own, “Pepper bookings”',
    );
  });

  it('busy times only: says bookings aren’t added and offers to add them', () => {
    const words = calendarWords(answer(connection({ writesBookings: false })), NY, NOW);
    expect(words).toMatchObject({
      badge: 'Connected',
      action: 'Add bookings to Google',
      disconnect: true,
    });
    expect(words.lines[2]).toBe(
      'Your bookings aren’t added to Google Calendar: Google wasn’t given that permission.',
    );
    expect(words.disconnectNote).not.toContain('Pepper bookings');
  });

  it('needs reconnecting: bookings wait for it', () => {
    const words = calendarWords(answer(connection({ status: 'needs_reconnect' })), NY, NOW);
    expect(words.lines[2]).toBe(
      'New and changed bookings reach Google Calendar once you reconnect.',
    );
    const busyOnly = calendarWords(
      answer(connection({ status: 'needs_reconnect', writesBookings: false })),
      NY,
      NOW,
    );
    expect(busyOnly.lines).toHaveLength(2);
  });
});

describe('disconnectedNote (AC-X-172)', () => {
  it('says the bookings calendar went too, when there was one', () => {
    expect(disconnectedNote(true)).toContain('Google was asked to delete “Pepper bookings”');
    expect(disconnectedNote(false)).toBe(
      'Disconnected. Your Google busy times no longer block bookings.',
    );
  });
});

describe('bookingCalendarLine (S71 top-up, AC-X-173)', () => {
  it('says the booking is in Google Calendar, on its way, or nothing', () => {
    expect(bookingCalendarLine('written')).toBe('Also in Google Calendar');
    expect(bookingCalendarLine('pending')).toBe('Adding to Google Calendar…');
    expect(bookingCalendarLine('waiting')).toBe('Waiting for Google Calendar to be reconnected');
    expect(bookingCalendarLine('none')).toBeNull();
    expect(bookingCalendarLine(null)).toBeNull();
    expect(bookingCalendarPath('a/b')).toBe('/v1/calendar/bookings/a%2Fb');
  });
});

describe('calendarSummary', () => {
  it('says each state in a few words', () => {
    expect(calendarSummary(answer(null), NY, NOW)).toBe(
      'Keep your own plans from being booked over',
    );
    expect(calendarSummary(answer(null, false), NY, NOW)).toBe('Not linked to you');
    expect(calendarSummary(answer(connection()), NY, NOW)).toBe('Connected · read 3 min ago');
    expect(calendarSummary(answer(connection({ status: 'needs_reconnect' })), NY, NOW)).toBe(
      'Needs reconnecting',
    );
  });
});

describe('teamCalendarLine (AC-X-164)', () => {
  it('says each staff member’s state, never the email', () => {
    const c = connection();
    const shown = {
      staffMemberId: c.staffMemberId,
      provider: c.provider,
      status: c.status,
      syncedAt: c.syncedAt,
      connectedAt: c.connectedAt,
      writesBookings: c.writesBookings,
    };
    expect(teamCalendarLine(shown, NY, NOW)).toEqual({
      text: 'Google Calendar · read 3 min ago',
      tone: 'quiet',
    });
    expect(teamCalendarLine({ ...shown, syncedAt: null }, NY, NOW).text).toBe(
      'Google Calendar · not read yet',
    );
    expect(teamCalendarLine({ ...shown, status: 'needs_reconnect' }, NY, NOW)).toEqual({
      text: 'Needs reconnecting',
      tone: 'warn',
    });
    expect(teamCalendarLine(undefined, NY, NOW)).toEqual({
      text: 'No calendar connected',
      tone: 'quiet',
    });
  });
});

describe('googleArrival (AC-X-161)', () => {
  const STATE = 's'.repeat(43);

  it('a code and a state', () => {
    expect(googleArrival({ code: '4/abc', state: STATE, scope: 'x' })).toEqual({
      kind: 'code',
      code: '4/abc',
      state: STATE,
    });
  });

  it('the member said no, even with a state', () => {
    expect(googleArrival({ error: 'access_denied', state: STATE })).toEqual({ kind: 'declined' });
  });

  it('another Google error is not the member saying no', () => {
    expect(googleArrival({ error: 'admin_policy_enforced' })).toEqual({ kind: 'failed' });
    expect(googleArrival({ error: 'server_error', state: STATE })).toEqual({ kind: 'failed' });
  });

  it('nothing usable: checked like the api checks it', () => {
    expect(googleArrival({})).toEqual({ kind: 'none' });
    expect(googleArrival({ code: '', state: STATE })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: ['a', 'b'], state: STATE })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: 'a' })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: 'a', state: 'short' })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: 'x'.repeat(2049), state: STATE })).toEqual({ kind: 'none' });
  });
});

describe('needsReconnect (AC-X-163)', () => {
  it('only for the member’s own connection that needs it', () => {
    expect(needsReconnect(null)).toBe(false);
    expect(needsReconnect(answer(null))).toBe(false);
    expect(needsReconnect(answer(connection()))).toBe(false);
    expect(needsReconnect(answer(connection({ status: 'needs_reconnect' })))).toBe(true);
  });
});

describe('outcomeNote and googleOutcomeOf (AC-X-161)', () => {
  it('says how the return ended, with what to do next', () => {
    expect(outcomeNote('connected')).toEqual({
      tone: 'ok',
      text: 'Connected. Pepper won’t book clients over your busy times.',
    });
    expect(outcomeNote('declined')?.text).toBe(
      'Nothing was connected: Google says you didn’t allow it.',
    );
    expect(outcomeNote('failed')?.text).toContain('Google couldn’t finish connecting');
    expect(outcomeNote('calendar_connect_invalid')).toEqual({
      tone: 'error',
      text: 'That Google link was already used or ran out. Tap Connect to try again.',
    });
    expect(outcomeNote(null)).toBeNull();
  });

  it('reads only a known outcome from the address', () => {
    expect(googleOutcomeOf('connected')).toBe('connected');
    expect(googleOutcomeOf('calendar_scope_missing')).toBe('calendar_scope_missing');
    expect(googleOutcomeOf('<script>')).toBeNull();
    expect(googleOutcomeOf(['connected', 'x'])).toBeNull();
    expect(googleOutcomeOf(undefined)).toBeNull();
  });
});

describe('finishGoogleReturn (AC-X-161)', () => {
  const STATE = 's'.repeat(43);
  const CALL = {
    apiBaseUrl: 'http://api:4000',
    origin: 'https://app.pepper.test',
    cookie: 'pepper.session=abc',
    forwardedFor: '203.0.113.9',
  };

  interface Seen {
    url: string;
    method: string | undefined;
    headers: unknown;
    body: string;
  }

  function api(status: number, body: unknown) {
    const seen: Seen[] = [];
    const fetch: typeof globalThis.fetch = (url, init) => {
      seen.push({
        url: url instanceof URL ? url.href : typeof url === 'string' ? url : url.url,
        method: init?.method,
        headers: init?.headers,
        body: typeof init?.body === 'string' ? init.body : '',
      });
      return Promise.resolve(new Response(JSON.stringify(body), { status }));
    };
    return { fetch, seen };
  }

  it('posts the code and state once, as the member, from the app’s origin', async () => {
    const { fetch, seen } = api(200, { canConnect: true, connection: null });
    expect(await finishGoogleReturn({ code: '4/abc', state: STATE }, { ...CALL, fetch })).toBe(
      'connected',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('http://api:4000/v1/calendar/google/callback');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers).toMatchObject({
      origin: 'https://app.pepper.test',
      cookie: 'pepper.session=abc',
      'x-forwarded-for': '203.0.113.9',
    });
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ code: '4/abc', state: STATE });
  });

  it('says the api’s refusal, or "failed" for one it doesn’t know', async () => {
    const refused = api(400, { code: 'calendar_connect_invalid', message: 'x' });
    expect(
      await finishGoogleReturn({ code: 'a', state: STATE }, { ...CALL, fetch: refused.fetch }),
    ).toBe('calendar_connect_invalid');
    const odd = api(500, { code: 'internal' });
    expect(
      await finishGoogleReturn({ code: 'a', state: STATE }, { ...CALL, fetch: odd.fetch }),
    ).toBe('failed');
  });

  it('an api that doesn’t answer is "Google didn’t answer", try again', async () => {
    const fetch: typeof globalThis.fetch = () => Promise.reject(new Error('down'));
    expect(await finishGoogleReturn({ code: 'a', state: STATE }, { ...CALL, fetch })).toBe(
      'calendar_unavailable',
    );
  });

  it('sends nothing for a refusal at Google or an empty address', async () => {
    const { fetch, seen } = api(200, {});
    expect(await finishGoogleReturn({ error: 'access_denied' }, { ...CALL, fetch })).toBe(
      'declined',
    );
    expect(await finishGoogleReturn({ error: 'admin_policy_enforced' }, { ...CALL, fetch })).toBe(
      'failed',
    );
    expect(await finishGoogleReturn({}, { ...CALL, fetch })).toBeNull();
    expect(await finishGoogleReturn({ code: 'a', state: 'bad' }, { ...CALL, fetch })).toBeNull();
    expect(seen).toHaveLength(0);
  });
});
