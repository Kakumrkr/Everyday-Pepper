import { describe, expect, it } from 'vitest';
import { buildBriefings, type BriefingContext } from './briefing.js';
import { ANA, at, booking, hours, JESS, snapshot, staffMember } from './fixtures.js';

// The daily briefing's numbers (S38a): today in the business's time zone, the business's
// day for owners and managers, each staff member's own day for them, numbers only.

const context: BriefingContext = {
  ownDayStaff: [JESS, ANA],
  needsOk: 2,
  rebookingDue: 3,
  waitlist: { waiting: 4, offered: 1, claimed: 0 },
};

// Monday 2 November 2026, 7:00 in New York (EST, UTC−5).
const MORNING = at('2026-11-02T12:00:00Z');

describe('buildBriefings', () => {
  it("counts today's bookings, the first start and the gaps, for the business and each staff member", () => {
    const briefings = buildBriefings(
      snapshot({
        now: MORNING,
        staff: [staffMember(JESS), staffMember(ANA)],
        bookings: [
          // Jess 9–12 and 13–17 (one hour open at 12), Ana 10–11 (open 9–10 and 11–17).
          booking('2026-11-02T14:00:00Z', '2026-11-02T17:00:00Z'),
          booking('2026-11-02T18:00:00Z', '2026-11-02T22:00:00Z'),
          booking('2026-11-02T15:00:00Z', '2026-11-02T16:00:00Z', { staffMemberId: ANA }),
          // Tomorrow, cancelled, and yesterday: not today's.
          booking('2026-11-03T14:00:00Z', '2026-11-03T15:00:00Z'),
          booking('2026-11-02T20:00:00Z', '2026-11-02T21:00:00Z', {
            staffMemberId: ANA,
            status: 'cancelled',
          }),
          booking('2026-11-01T14:00:00Z', '2026-11-01T15:00:00Z'),
        ],
      }),
      context,
    );
    expect(briefings).toHaveLength(3);
    const [business, jess, ana] = briefings;
    expect(business).toEqual({
      staffMemberId: null,
      day: '2026-11-02',
      payload: {
        scope: 'business',
        bookingCount: 3,
        firstStartsAt: '2026-11-02T14:00:00.000Z',
        gapCount: 3,
        openMinutes: 60 + 60 + 360,
        needsOkCount: 2,
        rebookingDueCount: 3,
        waitlistWaiting: 4,
        waitlistOffered: 1,
        waitlistClaimed: 0,
      },
      // Local midnight (EST).
      expiresAt: at('2026-11-03T05:00:00Z'),
    });
    expect(jess?.payload).toEqual({
      scope: 'staff',
      bookingCount: 2,
      firstStartsAt: '2026-11-02T14:00:00.000Z',
      gapCount: 1,
      openMinutes: 60,
      needsOkCount: null,
      rebookingDueCount: null,
      waitlistWaiting: null,
      waitlistOffered: null,
      waitlistClaimed: null,
    });
    expect(ana).toMatchObject({ staffMemberId: ANA, payload: { bookingCount: 1, gapCount: 2 } });
  });

  it('writes the business its briefing on a day with nothing booked', () => {
    const [business] = buildBriefings(snapshot({ now: MORNING, staff: [] }), context);
    expect(business?.payload).toMatchObject({
      bookingCount: 0,
      firstStartsAt: null,
      gapCount: 0,
      openMinutes: 0,
    });
  });

  it('skips a staff member on their day off, an inactive one, and one who is not staff', () => {
    const briefings = buildBriefings(
      snapshot({
        now: MORNING,
        staff: [staffMember(JESS, { hours: hours([2, 3], 9, 17) }), staffMember(ANA)],
      }),
      { ...context, ownDayStaff: [JESS] },
    );
    expect(briefings.map((briefing) => briefing.staffMemberId)).toEqual([null]);
    const inactive = buildBriefings(
      snapshot({ now: MORNING, staff: [staffMember(JESS, { active: false })] }),
      context,
    );
    expect(inactive.map((briefing) => briefing.staffMemberId)).toEqual([null]);
  });

  it('skips a staff member on time off all day (code review)', () => {
    const briefings = buildBriefings(
      snapshot({
        now: MORNING,
        staff: [
          staffMember(JESS, {
            timeOff: [{ start: at('2026-11-02T05:00:00Z'), end: at('2026-11-03T05:00:00Z') }],
          }),
        ],
      }),
      context,
    );
    expect(briefings.map((briefing) => briefing.staffMemberId)).toEqual([null]);
  });

  it('still briefs a staff member booked on a day without hours', () => {
    const briefings = buildBriefings(
      snapshot({
        now: MORNING,
        staff: [staffMember(JESS, { hours: [] })],
        bookings: [booking('2026-11-02T14:00:00Z', '2026-11-02T15:00:00Z')],
      }),
      context,
    );
    expect(briefings[1]).toMatchObject({ staffMemberId: JESS, payload: { bookingCount: 1 } });
  });

  it('takes the local day across a DST change (the day the clocks go back is 25 hours)', () => {
    // Sunday 1 November 2026: EDT until 2:00, then EST.
    const [business] = buildBriefings(
      snapshot({
        now: at('2026-11-01T11:00:00Z'),
        staff: [],
        bookings: [booking('2026-11-02T04:30:00Z', '2026-11-02T04:45:00Z')],
      }),
      context,
    );
    expect(business).toMatchObject({
      day: '2026-11-01',
      expiresAt: at('2026-11-02T05:00:00Z'),
      payload: { bookingCount: 1 },
    });
  });
});
