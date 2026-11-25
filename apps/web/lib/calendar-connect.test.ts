import type { CalendarConnection, CalendarConnectionAnswer } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  calendarSummary,
  calendarWords,
  googleArrival,
  needsReconnect,
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
      'Pepper keeps the busy times it read 3 min ago until you reconnect, so nothing gets booked over them.',
    );
  });

  it('never a system word', () => {
    for (const a of [
      answer(null),
      answer(null, false),
      answer(connection()),
      answer(connection({ status: 'needs_reconnect', syncedAt: null })),
    ]) {
      const text = JSON.stringify(calendarWords(a, NY, NOW));
      expect(text).not.toMatch(/token|sync|oauth|invalid_grant|tenant|needs_reconnect/i);
    }
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
  it('a code and a state', () => {
    expect(googleArrival({ code: '4/abc', state: 's'.repeat(43), scope: 'x' })).toEqual({
      kind: 'code',
      code: '4/abc',
      state: 's'.repeat(43),
    });
  });

  it('the member said no, even with a state', () => {
    expect(googleArrival({ error: 'access_denied', state: 's' })).toEqual({ kind: 'declined' });
  });

  it('nothing usable', () => {
    expect(googleArrival({})).toEqual({ kind: 'none' });
    expect(googleArrival({ code: '', state: 's' })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: ['a', 'b'], state: 's' })).toEqual({ kind: 'none' });
    expect(googleArrival({ code: 'a' })).toEqual({ kind: 'none' });
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
