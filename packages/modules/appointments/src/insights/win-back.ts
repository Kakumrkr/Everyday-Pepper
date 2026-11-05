import type { BookingId, ClientId, ServiceId, StaffMemberId } from '@pepper/contracts';
import { addDays, formatDate } from '../availability/zoned-time.js';
import { daysBetween, localDate, medianDays, occupies } from './providers.js';
import type { InsightBooking, InsightService } from './types.js';

// "Haven't been back" (S54.2, ADR-0057): the clients with a few visits who stopped coming.
// A pure rule like the insight providers, but read on demand rather than kept as feed items:
// the feed's `rebooking_due` card lives from the due date to twice the interval, while this
// list keeps a client until they book again (or their last visit leaves the 730-day history),
// so an owner can win back someone who has been gone for months. It counts a client from
// 2 visits (one gap is enough to know their rhythm when the service names none); the feed's
// median needs 3 before it suggests anything unasked.

/** A client shows from this many past visits (the empty state says so). */
export const WIN_BACK = { minVisits: 2 } as const;

export interface WinBackInput {
  now: number;
  timeZone: string;
  /** Every booking from the history window on, future ones included (`listInsightBookings`). */
  bookings: readonly InsightBooking[];
  services: readonly InsightService[];
}

export interface WinBackClient {
  clientId: ClientId;
  /** The last visit: its booking, service and staff member. */
  lastBookingId: BookingId;
  serviceId: ServiceId;
  staffMemberId: StaffMemberId;
  lastVisitAt: number;
  visits: number;
  intervalDays: number;
  basis: 'service' | 'client_median';
  /** The local day they were due back (`YYYY-MM-DD`). */
  dueOn: string;
  /** Whole local days since `dueOn` (0 on the day itself). */
  daysOverdue: number;
}

/** The clients who haven't been back, the most recently due first (then by client id). */
export function findWinBack(input: WinBackInput): WinBackClient[] {
  const { now, timeZone } = input;
  const serviceDays = new Map(input.services.map((s) => [s.id, s.rebookAfterDays]));
  const visits = new Map<ClientId, InsightBooking[]>();
  const bookedAhead = new Set<ClientId>();
  for (const booking of input.bookings) {
    if (booking.start >= now) {
      if (booking.status === 'confirmed') bookedAhead.add(booking.clientId);
    } else if (occupies(booking)) {
      const list = visits.get(booking.clientId) ?? [];
      list.push(booking);
      visits.set(booking.clientId, list);
    }
  }
  const today = localDate(timeZone, now);
  const found: WinBackClient[] = [];
  for (const [clientId, list] of visits) {
    if (bookedAhead.has(clientId) || list.length < WIN_BACK.minVisits) continue;
    list.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    const last = list.at(-1);
    if (last === undefined) continue;
    const days = list.map((visit) => localDate(timeZone, visit.start));
    const ownDays = serviceDays.get(last.serviceId) ?? null;
    const intervalDays =
      ownDays ?? medianDays(days.slice(1).map((day, i) => daysBetween(days[i] ?? day, day)));
    const dueOn = addDays(localDate(timeZone, last.start), intervalDays);
    const daysOverdue = daysBetween(dueOn, today);
    if (daysOverdue < 0) continue;
    found.push({
      clientId,
      lastBookingId: last.id,
      serviceId: last.serviceId,
      staffMemberId: last.staffMemberId,
      lastVisitAt: last.start,
      visits: list.length,
      intervalDays,
      basis: ownDays === null ? 'client_median' : 'service',
      dueOn: formatDate(dueOn),
      daysOverdue,
    });
  }
  return found.sort(
    (a, b) => a.daysOverdue - b.daysOverdue || a.clientId.localeCompare(b.clientId),
  );
}
