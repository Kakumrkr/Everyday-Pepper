import { describe, expect, it } from 'vitest';
import { ANA, COLOR, CUT, JESS, KOLKATA, MARIA, SAM, at, booking } from './fixtures.js';
import { WIN_BACK, findWinBack, type WinBackInput } from './win-back.js';

// "Haven't been back" (S54.2, AC-W4-6). Expected days are written out, not recomputed.

const now = at('2026-11-02T15:00:00Z'); // Monday, 10:00 in New York
const services = [
  { id: COLOR, rebookAfterDays: 42 },
  { id: CUT, rebookAfterDays: null },
];
const input = (bookings: WinBackInput['bookings'], overrides: Partial<WinBackInput> = {}) => ({
  now,
  timeZone: 'America/New_York',
  bookings,
  services,
  ...overrides,
});
const visit = (day: string, overrides: Parameters<typeof booking>[2] = {}) =>
  booking(`${day}T14:00:00Z`, `${day}T15:00:00Z`, { status: 'completed', ...overrides });

describe('findWinBack', () => {
  it("uses the last service's interval: due 42 days after the last colour", () => {
    const last = visit('2026-08-01', { serviceId: COLOR, staffMemberId: ANA });
    const [client, ...rest] = findWinBack(input([visit('2026-06-01'), last]));
    expect(rest).toEqual([]);
    expect(client).toMatchObject({
      clientId: MARIA,
      lastBookingId: last.id,
      serviceId: COLOR,
      staffMemberId: ANA,
      visits: 2,
      intervalDays: 42,
      basis: 'service',
      dueOn: '2026-09-12',
      daysOverdue: 51,
    });
  });

  it('uses the one gap of two visits when the service names no interval', () => {
    const [client] = findWinBack(input([visit('2026-08-01'), visit('2026-08-29')]));
    expect(client).toMatchObject({ intervalDays: 28, basis: 'client_median', dueOn: '2026-09-26' });
  });

  it(`needs ${String(WIN_BACK.minVisits)} visits; a no-show or a cancellation is not one`, () => {
    expect(findWinBack(input([visit('2026-08-01', { serviceId: COLOR })]))).toEqual([]);
    const bookings = [
      visit('2026-07-01', { serviceId: COLOR, status: 'no_show' }),
      visit('2026-07-15', { serviceId: COLOR, status: 'cancelled' }),
      visit('2026-08-01', { serviceId: COLOR }),
    ];
    expect(findWinBack(input(bookings))).toEqual([]);
  });

  it('counts a past confirmed booking as a visit (imported history is confirmed or completed)', () => {
    const bookings = [visit('2026-08-01', { status: 'confirmed' }), visit('2026-08-29')];
    expect(findWinBack(input(bookings))).toHaveLength(1);
  });

  it('leaves out a client booked ahead, but not one whose next booking was cancelled', () => {
    const history = [visit('2026-08-01'), visit('2026-08-29')];
    const ahead = visit('2026-11-10', { status: 'confirmed' });
    expect(findWinBack(input([...history, ahead]))).toEqual([]);
    const cancelled = visit('2026-11-10', { status: 'cancelled' });
    expect(findWinBack(input([...history, cancelled]))).toHaveLength(1);
  });

  it('shows a client from the due day itself, not the day before', () => {
    const history = [
      visit('2026-09-07', { serviceId: COLOR }),
      visit('2026-09-21', { serviceId: COLOR }),
    ];
    // Due 2026-11-02 (42 days after 2026-09-21): today in New York.
    expect(findWinBack(input(history))).toMatchObject([{ dueOn: '2026-11-02', daysOverdue: 0 }]);
    expect(findWinBack(input(history, { now: at('2026-11-02T04:59:00Z') }))).toEqual([]);
  });

  it("counts days in the business's time zone", () => {
    // 2026-11-02 15:00 UTC is 20:30 in Kolkata; the visits' local days are the same days.
    const [client] = findWinBack(
      input([visit('2026-08-01'), visit('2026-08-29')], { timeZone: KOLKATA }),
    );
    expect(client).toMatchObject({ dueOn: '2026-09-26', daysOverdue: 37 });
  });

  it('keeps a client gone for months (no twice-the-interval cut-off), the most recently due first', () => {
    const maria = [visit('2026-08-01'), visit('2026-08-29')];
    const sam = [
      visit('2026-01-05', { clientId: SAM, staffMemberId: JESS }),
      visit('2026-02-02', { clientId: SAM, staffMemberId: JESS }),
    ];
    const found = findWinBack(input([...sam, ...maria]));
    expect(found.map((each) => [each.clientId, each.dueOn])).toEqual([
      [MARIA, '2026-09-26'],
      [SAM, '2026-03-02'],
    ]);
  });
});
