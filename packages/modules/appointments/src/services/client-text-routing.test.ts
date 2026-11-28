import { BookingIdSchema, type ClientTextReading } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { routeClientText, type RoutableVisit } from './client-text-routing.js';

// 9:00 am on Mon, Nov 2 2026 in New York.
const NOW = new Date('2026-11-02T14:00:00.000Z');
const TZ = 'America/New_York';
const HOUR = 3_600_000;

function visit(id: string, startsAt: Date): RoutableVisit {
  return {
    bookingId: `00000000-0000-4000-8000-00000000000${id}`,
    staffMemberId: '00000000-0000-4000-8000-0000000000aa',
    serviceId: '00000000-0000-4000-8000-0000000000bb',
    startsAt,
  };
}

const TODAY = visit('1', new Date(NOW.getTime() + 2 * HOUR));
const TOMORROW = visit('2', new Date(NOW.getTime() + 26 * HOUR));
const NEXT_WEEK = visit('3', new Date(NOW.getTime() + 7 * 24 * HOUR));
const STARTED = visit('4', new Date(NOW.getTime() - 10 * 60_000));

function reading(overrides: Partial<ClientTextReading>): ClientTextReading {
  return {
    intent: 'confirm',
    visitId: null,
    askedFor: null,
    minutesLate: null,
    confidence: 'sure',
    ...overrides,
  };
}

const id = (visit: RoutableVisit) => BookingIdSchema.parse(visit.bookingId);

const route = (r: ClientTextReading | null, visits: RoutableVisit[]) =>
  routeClientText({ reading: r, visits, now: NOW, timeZone: TZ });

describe('routeClientText (AC-X-243…246)', () => {
  it('acts only on a sure reading', () => {
    expect(route(reading({ confidence: 'unsure' }), [TODAY])).toEqual({
      kind: 'card',
      reason: 'not_sure',
    });
    // Refused or no budget.
    expect(route(null, [TODAY])).toEqual({ kind: 'card', reason: 'not_sure' });
  });

  it('leaves a question or anything else to the owner', () => {
    expect(route(reading({ intent: 'question' }), [TODAY])).toEqual({
      kind: 'card',
      reason: 'no_action',
    });
    expect(route(reading({ intent: 'other' }), [TODAY])).toEqual({
      kind: 'card',
      reason: 'no_action',
    });
  });

  it('confirms the visit named, or the only one', () => {
    expect(route(reading({ visitId: id(TOMORROW) }), [TODAY, TOMORROW])).toEqual({
      kind: 'confirm',
      visit: TOMORROW,
    });
    expect(route(reading({}), [NEXT_WEEK])).toEqual({ kind: 'confirm', visit: NEXT_WEEK });
  });

  it('never acts on a visit that is not in the list', () => {
    expect(
      route(reading({ visitId: BookingIdSchema.parse('00000000-0000-4000-8000-0000000000ff') }), [
        TODAY,
        TOMORROW,
      ]),
    ).toEqual({ kind: 'card', reason: 'no_visit' });
    expect(route(reading({}), [])).toEqual({ kind: 'card', reason: 'no_visit' });
  });

  it('asks which when two visits fit and none is named, unless only one is today', () => {
    expect(route(reading({}), [TOMORROW, NEXT_WEEK])).toEqual({
      kind: 'card',
      reason: 'which_visit',
    });
    expect(route(reading({ intent: 'cancel' }), [TODAY, TOMORROW])).toEqual({
      kind: 'cancel',
      visit: TODAY,
    });
  });

  it('never confirms, cancels or moves a visit that started', () => {
    expect(route(reading({ visitId: id(STARTED) }), [STARTED, TOMORROW])).toEqual({
      kind: 'card',
      reason: 'no_visit',
    });
    // "Can't make it" with none named, just after one started: it may be about that one, so
    // nothing lands on tomorrow's (the started one is today's, and too late to cancel).
    expect(route(reading({ intent: 'cancel' }), [STARTED, TOMORROW])).toEqual({
      kind: 'card',
      reason: 'no_visit',
    });
    expect(route(reading({ intent: 'confirm' }), [STARTED, TODAY, TOMORROW])).toEqual({
      kind: 'card',
      reason: 'which_visit',
    });
  });

  it('tells the staff of today’s visit about a client running late, even one just started', () => {
    expect(route(reading({ intent: 'running_late', minutesLate: 10 }), [TODAY, TOMORROW])).toEqual({
      kind: 'late',
      visit: TODAY,
      minutesLate: 10,
    });
    expect(route(reading({ intent: 'running_late', minutesLate: null }), [STARTED])).toEqual({
      kind: 'late',
      visit: STARTED,
      minutesLate: null,
    });
    // Late for tomorrow is not a thing to act on.
    expect(route(reading({ intent: 'running_late', minutesLate: 10 }), [TOMORROW])).toEqual({
      kind: 'card',
      reason: 'no_visit',
    });
    expect(
      route(reading({ intent: 'running_late', visitId: id(TOMORROW) }), [TODAY, TOMORROW]),
    ).toEqual({ kind: 'card', reason: 'no_visit' });
  });

  it('passes the time a move asks for', () => {
    const askedFor = { date: '2026-11-05', time: '15:00' };
    expect(route(reading({ intent: 'reschedule', askedFor }), [TOMORROW])).toEqual({
      kind: 'move',
      visit: TOMORROW,
      askedFor,
    });
  });
});
