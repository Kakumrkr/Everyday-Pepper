import type { PushNotice } from '@pepper/core';
import { toZoned } from '@pepper/contracts';
import type { BookingEmailDetails } from './services/notices.js';

// The pushes the team gets about the booking page (ADR-0026; to-dos coming due are core's).
// They show on lock screens, so a push never names a client: the service, the staff
// member and the time, and the app page to open for the rest.

/** "Tue, Nov 3, 10:00 AM" in the business's time zone. */
export function shortWhen(startsAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(startsAt));
}

/** The calendar on the day of `startsAt` (business clock). */
export function calendarUrl(startsAt: string, timeZone: string): string {
  const day = toZoned(timeZone, Date.parse(startsAt));
  const iso = `${String(day.year)}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;
  return `/calendar?date=${iso}`;
}

/** The team's push about a booking the client made, moved or cancelled on the booking page. */
export function bookingPagePush(
  kind: 'confirmed' | 'rescheduled' | 'cancelled',
  details: Pick<BookingEmailDetails, 'serviceName' | 'staffName' | 'startsAt' | 'timeZone'>,
  bookingId: string,
): PushNotice {
  const title = {
    confirmed: 'New booking',
    rescheduled: 'Booking moved',
    cancelled: 'Booking cancelled',
  }[kind];
  const staff = details.staffName === null ? '' : ` with ${details.staffName}`;
  const when = shortWhen(details.startsAt, details.timeZone);
  const body = `${details.serviceName}${staff}, ${kind === 'rescheduled' ? `now ${when}` : when}`;
  return {
    title,
    body,
    url: calendarUrl(details.startsAt, details.timeZone),
    tag: `booking-${bookingId}`,
  };
}
