import { describe, expect, it } from 'vitest';
import {
  busyBlocksOf,
  calendarEventBodyOf,
  calendarEventIdOf,
  calendarWriteBackoffMs,
  GOOGLE_CALENDAR_SCOPES,
  GoogleEventResourceSchema,
  CalendarConnectCompleteSchema,
  GoogleFreeBusyResponseSchema,
  GoogleIdTokenClaimsSchema,
  GoogleTokenResponseSchema,
} from './calendar-sync.js';

const at = (iso: string) => Date.parse(iso);
const window = { from: at('2026-12-01T00:00:00Z'), to: at('2026-12-03T00:00:00Z') };

describe('busyBlocksOf', () => {
  it('keeps busy times inside the window, by start', () => {
    expect(
      busyBlocksOf(
        [
          { start: '2026-12-02T15:00:00Z', end: '2026-12-02T16:00:00Z' },
          { start: '2026-12-01T09:00:00-05:00', end: '2026-12-01T10:00:00-05:00' },
        ],
        window,
      ),
    ).toEqual([
      { start: at('2026-12-01T14:00:00Z'), end: at('2026-12-01T15:00:00Z') },
      { start: at('2026-12-02T15:00:00Z'), end: at('2026-12-02T16:00:00Z') },
    ]);
  });

  it('clips to the window and drops what lies outside it', () => {
    expect(
      busyBlocksOf(
        [
          { start: '2026-11-30T22:00:00Z', end: '2026-12-01T02:00:00Z' },
          { start: '2026-12-02T23:00:00Z', end: '2026-12-04T00:00:00Z' },
          { start: '2026-11-20T00:00:00Z', end: '2026-11-21T00:00:00Z' },
        ],
        window,
      ),
    ).toEqual([
      { start: window.from, end: at('2026-12-01T02:00:00Z') },
      { start: at('2026-12-02T23:00:00Z'), end: window.to },
    ]);
  });

  it('merges overlapping and touching times, and drops empty ones', () => {
    expect(
      busyBlocksOf(
        [
          { start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' },
          { start: '2026-12-01T10:30:00Z', end: '2026-12-01T12:00:00Z' },
          { start: '2026-12-01T12:00:00Z', end: '2026-12-01T12:30:00Z' },
          { start: '2026-12-01T13:00:00Z', end: '2026-12-01T13:00:00Z' },
        ],
        window,
      ),
    ).toEqual([{ start: at('2026-12-01T10:00:00Z'), end: at('2026-12-01T12:30:00Z') }]);
  });
});

describe('busyBlocksOf: many busy times', () => {
  it('keeps the soonest 6000 of a very busy calendar, instead of failing the read', () => {
    const start = Date.parse('2026-12-01T00:00:00Z');
    const busy = Array.from({ length: 7000 }, (_, i) => ({
      start: new Date(start + i * 20 * 60_000).toISOString(),
      end: new Date(start + i * 20 * 60_000 + 10 * 60_000).toISOString(),
    }));
    const parsed = GoogleFreeBusyResponseSchema.parse({
      timeMin: '2026-12-01T00:00:00Z',
      timeMax: '2027-04-01T00:00:00Z',
      calendars: { primary: { busy } },
    });
    const kept = busyBlocksOf(parsed.calendars['primary']?.busy ?? [], {
      from: start,
      to: Date.parse('2027-04-01T00:00:00Z'),
    });
    expect(kept).toHaveLength(6000);
    expect(kept[0]?.start).toBe(start);
  });
});

describe("Google's answers", () => {
  it('reads a freeBusy answer with offsets and an empty calendar', () => {
    const parsed = GoogleFreeBusyResponseSchema.parse({
      kind: 'calendar#freeBusy',
      timeMin: '2026-12-01T00:00:00.000Z',
      timeMax: '2026-12-03T00:00:00.000Z',
      calendars: { primary: {} },
    });
    expect(parsed.calendars['primary']?.busy).toEqual([]);
  });

  it('refuses a token answer that is not a bearer token', () => {
    expect(
      GoogleTokenResponseSchema.safeParse({
        access_token: 'a',
        expires_in: 3599,
        scope: '',
        token_type: 'mac',
      }).success,
    ).toBe(false);
  });

  it('refuses an ID token from another issuer', () => {
    expect(
      GoogleIdTokenClaimsSchema.safeParse({
        iss: 'https://evil.example',
        aud: 'x',
        sub: '1',
        exp: 1,
        email: 'a@b.co',
      }).success,
    ).toBe(false);
  });

  it('takes only a state Pepper could have made', () => {
    expect(CalendarConnectCompleteSchema.safeParse({ code: 'c', state: 'short' }).success).toBe(
      false,
    );
    expect(
      CalendarConnectCompleteSchema.safeParse({ code: 'c', state: 'A'.repeat(43), extra: 1 })
        .success,
    ).toBe(false);
    expect(
      CalendarConnectCompleteSchema.parse({ code: 'c', state: 'A'.repeat(43) }).state,
    ).toHaveLength(43);
  });
});

describe('Google Calendar out (S71)', () => {
  const bookingId = '0193A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B';

  it('names one event per booking, in base32hex, the same every time (AC-X-169)', () => {
    const id = calendarEventIdOf(bookingId);
    expect(id).toBe('pepper0193a1b2c3d47e5f8a9b0c1d2e3f4a5b');
    expect(id).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(calendarEventIdOf(bookingId.toLowerCase())).toBe(id);
    expect(() => calendarEventIdOf('not-a-uuid')).toThrow();
  });

  it('writes the service and the first name only, private (AC-X-168, D-3)', () => {
    const body = calendarEventBodyOf({
      bookingId,
      serviceName: ' Skin\nfade ',
      clientFirstName: 'Ana',
      startsAt: new Date('2026-12-01T15:00:00Z'),
      endsAt: new Date('2026-12-01T15:45:00Z'),
    });
    expect(body).toMatchObject({
      id: calendarEventIdOf(bookingId),
      status: 'confirmed',
      summary: 'Skin fade · Ana',
      start: { dateTime: '2026-12-01T15:00:00.000Z' },
      end: { dateTime: '2026-12-01T15:45:00.000Z' },
      visibility: 'private',
      transparency: 'opaque',
    });
    expect(Object.keys(body).sort()).toEqual(
      [
        'description',
        'end',
        'extendedProperties',
        'id',
        'start',
        'status',
        'summary',
        'transparency',
        'visibility',
      ].sort(),
    );
    expect(
      calendarEventBodyOf({
        bookingId,
        serviceName: '',
        clientFirstName: '  ',
        startsAt: new Date(0),
        endsAt: new Date(1),
      }).summary,
    ).toBe('Appointment');
  });

  it('asks for the bookings calendar alongside free/busy (AC-X-167)', () => {
    expect(GOOGLE_CALENDAR_SCOPES).toContain(
      'https://www.googleapis.com/auth/calendar.app.created',
    );
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain('https://www.googleapis.com/auth/calendar');
    expect(GOOGLE_CALENDAR_SCOPES).not.toContain(
      'https://www.googleapis.com/auth/calendar.events',
    );
  });

  it('backs off 1, 2, 4… minutes up to an hour', () => {
    expect([1, 2, 3, 7, 8, 50].map(calendarWriteBackoffMs)).toEqual([
      60_000, 120_000, 240_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    expect(calendarWriteBackoffMs(0)).toBe(60_000);
  });

  it('parses an event answer and refuses a bad one', () => {
    expect(GoogleEventResourceSchema.parse({ id: 'pepperabc', status: 'confirmed', x: 1 })).toEqual({
      id: 'pepperabc',
      status: 'confirmed',
    });
    expect(GoogleEventResourceSchema.safeParse({ status: 'confirmed' }).success).toBe(false);
  });
});
