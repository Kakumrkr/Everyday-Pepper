import { describe, expect, it } from 'vitest';
import { bookingPagePush, calendarUrl, shortWhen } from './pushes.js';

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
