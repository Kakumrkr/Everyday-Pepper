import { DailyBriefingPayloadSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { bookingPagePush, briefingPush, calendarUrl, shortWhen } from './pushes.js';

const NY = 'America/New_York';
// Tuesday, November 3, 2026, 10:00 AM in New York.
const START = '2026-11-03T15:00:00.000Z';
const details = { serviceName: 'Haircut', staffName: 'Jess', startsAt: START, timeZone: NY };
const ID = '0199f4b2-7c1e-7a00-8000-000000000001';

describe('team pushes (ADR-0026)', () => {
  it('say what happened on the booking page, never who the client is', () => {
    expect(bookingPagePush('confirmed', details, ID)).toEqual({
      title: 'New booking',
      body: 'Haircut with Jess, Tue, Nov 3, 10:00 AM',
      url: '/calendar?date=2026-11-03',
      tag: `booking-${ID}`,
    });
    expect(bookingPagePush('rescheduled', details, ID)).toMatchObject({
      title: 'Booking moved',
      body: 'Haircut with Jess, now Tue, Nov 3, 10:00 AM',
    });
    expect(bookingPagePush('cancelled', { ...details, staffName: null }, ID)).toMatchObject({
      title: 'Booking cancelled',
      body: 'Haircut, Tue, Nov 3, 10:00 AM',
    });
  });

  it('use the business clock for the day and time', () => {
    // 11:30 PM on Tuesday in New York is Wednesday in UTC.
    const late = '2026-11-04T04:30:00.000Z';
    expect(shortWhen(late, NY)).toBe('Tue, Nov 3, 11:30 PM');
    expect(calendarUrl(late, NY)).toBe('/calendar?date=2026-11-03');
  });
});

describe('briefingPush (S38a)', () => {
  const day = DailyBriefingPayloadSchema.parse({
    scope: 'business',
    bookingCount: 8,
    firstStartsAt: '2026-11-03T14:00:00.000Z',
    gapCount: 1,
    openMinutes: 90,
    needsOkCount: 2,
    rebookingDueCount: 3,
    waitlistWaiting: 0,
    waitlistOffered: 0,
    waitlistClaimed: 0,
  });

  it('puts the day in numbers, in the business time zone, and opens the home screen', () => {
    expect(briefingPush(day, NY)).toEqual({
      title: 'Good morning: your day',
      body: '8 bookings, first at 9:00 AM. 1 open gap to fill. 2 things need your OK.',
      url: '/',
      tag: 'daily-briefing',
    });
  });

  it('says so when nothing is booked, and leaves out what is zero', () => {
    expect(
      briefingPush(
        { ...day, bookingCount: 0, firstStartsAt: null, gapCount: 0, needsOkCount: 1 },
        NY,
      ).body,
    ).toBe('Nothing booked yet. 1 thing needs your OK.');
    expect(
      briefingPush({ ...day, scope: 'staff', bookingCount: 1, gapCount: 0, needsOkCount: null }, NY)
        .body,
    ).toBe('1 booking, first at 9:00 AM.');
  });
});
