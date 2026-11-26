import {
  BookingSeriesPreviewSchema,
  BookingSeriesResultSchema,
  BookingSeriesSchema,
  type Booking,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { dateTimeLabel } from './booking';
import {
  bookedLines,
  bookLabel,
  canPick,
  everyLabel,
  laterVisits,
  notFreeLine,
  seriesLine,
  visitsToBook,
  withPick,
} from './booking-series';

// Recurring appointments on screen (S72, AC-X-186, AC-X-187).

const NY = 'America/New_York';
const STAFF = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198';
const SERIES_ID = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f70819d';
const tue = (week: number) =>
  new Date(Date.UTC(2026, 11, 1, 12) + week * 7 * 86_400_000).toISOString();
const slot = (startsAt: string) => ({ staffMemberId: STAFF, startsAt, endsAt: startsAt });

const preview = BookingSeriesPreviewSchema.parse({
  visits: [
    { startsAt: tue(0), endsAt: tue(0), free: true, tooFarAhead: false, alternatives: [] },
    {
      startsAt: tue(1),
      endsAt: tue(1),
      free: false,
      tooFarAhead: false,
      alternatives: [slot('2026-12-08T13:00:00.000Z')],
    },
    { startsAt: tue(2), endsAt: tue(2), free: true, tooFarAhead: false, alternatives: [] },
    { startsAt: tue(3), endsAt: tue(3), free: false, tooFarAhead: true, alternatives: [] },
  ],
  maximumAdvanceDays: 90,
});

function booking(id: string, startsAt: string, status: Booking['status'] = 'confirmed') {
  return {
    id,
    clientId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708190',
    serviceId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708197',
    staffMemberId: STAFF,
    startsAt,
    endsAt: startsAt,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    status,
    source: 'team',
    overridden: false,
    seriesId: SERIES_ID,
    createdAt: startsAt,
    updatedAt: startsAt,
  };
}

const ids = ['a', 'b', 'c', 'd'].map((letter) => `0199f0a4-7c1e-7d2a-9b3c-4d5e6f7081${letter}0`);

/** The item at `index` of a fixture list (a test bug when it isn't there). */
function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`No fixture at ${String(index)}`);
  return item;
}

describe('visitsToBook', () => {
  it('books the free dates, and a taken one only with the time picked for it', () => {
    expect(visitsToBook(preview, {})).toEqual([tue(0), tue(2)]);
    expect(visitsToBook(preview, { 1: '2026-12-08T13:00:00.000Z' })).toEqual([
      tue(0),
      '2026-12-08T13:00:00.000Z',
      tue(2),
    ]);
  });
});

describe('canPick', () => {
  it('refuses a time within a day of another visit to book, a free date or another pick', () => {
    // Taken date 1's alternative an hour after it: a day from both neighbours.
    expect(canPick(preview, {}, 1, '2026-12-08T13:00:00.000Z')).toBe(true);
    // Within a day of the free date after it (tue(2)).
    expect(canPick(preview, {}, 1, '2026-12-14T20:00:00.000Z')).toBe(false);
    // The same time picked for the other taken date already.
    expect(canPick(preview, { 3: '2026-12-08T13:00:00.000Z' }, 1, '2026-12-08T13:00:00.000Z')).toBe(
      false,
    );
    // Its own pick doesn't count against itself.
    expect(canPick(preview, { 1: '2026-12-08T13:00:00.000Z' }, 1, '2026-12-08T13:00:00.000Z')).toBe(
      true,
    );
  });
});

describe('withPick', () => {
  it('chooses a time for a date, changes it, and leaves the date out again', () => {
    const one = withPick({}, 1, 'x');
    expect(one).toEqual({ 1: 'x' });
    expect(withPick({ ...one, 3: 'z' }, 1, 'y')).toEqual({ 1: 'y', 3: 'z' });
    expect(withPick(one, 1, null)).toEqual({});
  });
});

describe('the words', () => {
  it('says every how many weeks, and the button counts the visits', () => {
    expect(everyLabel(1)).toBe('every week');
    expect(everyLabel(3)).toBe('every 3 weeks');
    expect(bookLabel(1)).toBe('Book 1 visit');
    expect(bookLabel(7)).toBe('Book 7 visits');
  });

  it('says why a date is not free', () => {
    expect(notFreeLine(nth(preview.visits, 1), 90)).toBe('Not free. Tap a time nearby instead:');
    expect(notFreeLine(nth(preview.visits, 3), 90)).toBe(
      'Not free: further ahead than you take bookings (90 days)',
    );
    expect(notFreeLine({ ...nth(preview.visits, 1), alternatives: [] }, 90)).toBe(
      'Not free, and nothing free nearby',
    );
  });

  it('says what was booked and what was taken meanwhile', () => {
    const result = BookingSeriesResultSchema.parse({
      seriesId: SERIES_ID,
      everyWeeks: 2,
      bookings: [booking(nth(ids, 0), tue(0)), booking(nth(ids, 1), tue(2))],
      skipped: [{ startsAt: tue(4), alternatives: [] }],
    });
    expect(bookedLines(result, NY)).toEqual([
      '2 visits booked, every 2 weeks.',
      `Not booked, taken just now: ${dateTimeLabel(NY, tue(4))}.`,
    ]);
    expect(
      bookedLines({ ...result, skipped: [], bookings: result.bookings.slice(0, 1) }, NY),
    ).toEqual(['1 visit booked, every 2 weeks.']);
  });
});

describe('the booking sheet (AC-X-186)', () => {
  const series = BookingSeriesSchema.parse({
    id: SERIES_ID,
    everyWeeks: 1,
    bookings: [
      booking(nth(ids, 0), tue(0), 'completed'),
      booking(nth(ids, 1), tue(1), 'cancelled'),
      booking(nth(ids, 2), tue(2)),
      booking(nth(ids, 3), tue(3)),
    ],
  });

  it('counts the visits that aren’t cancelled', () => {
    expect(seriesLine(series, nth(ids, 2))).toBe('Visit 2 of 3 · every week');
    expect(seriesLine(series, nth(ids, 1))).toBeNull();
  });

  it('finds the later confirmed visits "This and following" cancels too', () => {
    expect(laterVisits(series, { id: nth(ids, 2), startsAt: tue(2) }).map((v) => v.id)).toEqual([
      ids[3],
    ]);
    expect(laterVisits(series, { id: nth(ids, 3), startsAt: tue(3) })).toEqual([]);
  });
});
