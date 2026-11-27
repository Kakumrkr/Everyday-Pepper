import {
  MINUTES_SAVED,
  PROOF_LIMITS,
  type AutonomyAction,
  type BookingId,
  type ClientId,
  type UtcDateTime,
  type VisitRiskReason,
} from '@pepper/contracts';
import { addDays, formatDate, fromZoned, toZoned } from '../availability/zoned-time.js';
import type { InsightBooking } from './types.js';
import { findVisitRisks } from './visit-risk.js';

// Proof of value (S55, ADR-0058; AC-W4-10…12): the week card's numbers and the evening wrap,
// pure functions of the rows the service reads, like the insight providers. No clock, no
// database: the tests feed fixtures and compare the sums.

const utc = (ms: number) => new Date(ms).toISOString() as UtcDateTime;

/** A visit booked in the week, as `listWeekBookings` reads it. */
export interface WeekBooking {
  id: string;
  clientId: string;
  source: string;
  priceCents: number | null;
  filled: boolean;
  nudged: boolean;
}

/** The week's numbers, before the window is added. */
export interface WeekNumbers {
  visitsBooked: number;
  gapsFilled: number;
  regularsBack: number;
  regularsBackCents: number;
  valueCents: number;
  minutesSaved: number;
}

/** The sources where Pepper made the booking: the booking page, or the AI. */
const PEPPER_SOURCES: ReadonlySet<string> = new Set(['booking_page', 'ai']);
/** The actions whose minutes are the message's (an email written and sent). */
const MESSAGE_ACTIONS: ReadonlySet<string> = new Set<AutonomyAction>([
  'message.confirmation',
  'message.rebooking_nudge',
  'message.waitlist_offer',
  'message.bulk',
  'message.review_request',
]);
/** Counted as a visit already (`MINUTES_SAVED.booking`), so not again as an action. */
const VISIT_ACTION: AutonomyAction = 'booking.create';

/**
 * The week card: a visit counts when Pepper had a hand in it (booked online or by the AI, a
 * claimed offer, or a client's first booking within 14 days after a nudge), each visit once
 * in the dollars. A regular is counted once, by their first such booking.
 */
export function buildWeekValue(
  bookings: readonly WeekBooking[],
  actions: ReadonlyMap<string, number>,
): WeekNumbers {
  const back = new Set<string>();
  let visitsBooked = 0;
  let gapsFilled = 0;
  let regularsBackCents = 0;
  let valueCents = 0;
  let minutesSaved = 0;
  for (const booking of bookings) {
    const pepperMade = PEPPER_SOURCES.has(booking.source);
    const regularBack = booking.nudged && !back.has(booking.clientId);
    if (!pepperMade && !booking.filled && !regularBack) continue;
    visitsBooked += 1;
    const price = booking.priceCents ?? 0;
    valueCents += price;
    if (pepperMade) minutesSaved += MINUTES_SAVED.booking;
    if (booking.filled) {
      gapsFilled += 1;
      minutesSaved += MINUTES_SAVED.fill;
    }
    if (regularBack) {
      back.add(booking.clientId);
      regularsBackCents += price;
    }
  }
  for (const [action, count] of actions) {
    if (action === VISIT_ACTION) continue;
    minutesSaved +=
      count * (MESSAGE_ACTIONS.has(action) ? MINUTES_SAVED.message : MINUTES_SAVED.action);
  }
  return {
    visitsBooked,
    gapsFilled,
    regularsBack: back.size,
    regularsBackCents,
    valueCents,
    minutesSaved,
  };
}

/** The evening wrap before the names are added: tomorrow's visits, and those at risk. */
export interface WrapNumbers {
  day: string;
  visitCount: number;
  firstStartsAt: UtcDateTime | null;
  atRisk: {
    bookingId: BookingId;
    clientId: ClientId;
    startsAt: UtcDateTime;
    topReason: VisitRiskReason;
  }[];
}

/** It is the business's evening: from `PROOF_LIMITS.eveningHour` until midnight, local. */
export function isEvening(timeZone: string, now: number): boolean {
  return toZoned(timeZone, now).minuteOfDay >= PROOF_LIMITS.eveningHour * 60;
}

/**
 * Tomorrow in the business's time zone, from its evening hour (`PROOF_LIMITS.eveningHour`)
 * until midnight; `null` before. `bookings` must reach back the history window
 * (`INSIGHT_HISTORY_DAYS`) and cover tomorrow. A visit is at risk when its risk band is high
 * (S77, ADR-0071), earliest first, each with its top reason.
 */
export function buildEveningWrap(
  bookings: readonly InsightBooking[],
  timeZone: string,
  now: number,
  cancelNoticeHours: number,
): WrapNumbers | null {
  if (!isEvening(timeZone, now)) return null;
  const local = toZoned(timeZone, now);
  const tomorrow = addDays(local, 1);
  const from = fromZoned(timeZone, tomorrow, 0);
  const to = fromZoned(timeZone, addDays(tomorrow, 1), 0);

  const visits = bookings
    .filter(
      (booking) =>
        (booking.status === 'confirmed' || booking.status === 'completed') &&
        booking.start >= from &&
        booking.start < to,
    )
    .toSorted((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const first = visits[0];
  return {
    day: formatDate(tomorrow),
    visitCount: visits.length,
    firstStartsAt: first === undefined ? null : utc(first.start),
    atRisk: findVisitRisks({ now, bookings, cancelNoticeHours }).flatMap((risk) => {
      const top = risk.reasons[0];
      return risk.band === 'high' && top !== undefined && risk.start >= from && risk.start < to
        ? [
            {
              bookingId: risk.bookingId,
              clientId: risk.clientId,
              startsAt: utc(risk.start),
              topReason: top,
            },
          ]
        : [];
    }),
  };
}
