import {
  VISIT_RISK_SIGNALS,
  type BookingId,
  type ClientId,
  type VisitRisk,
  type VisitRiskBand,
  type VisitRiskReason,
} from '@pepper/contracts';
import type { InsightBooking } from './types.js';

// Visit risk (S77, ADR-0071): how likely each upcoming visit is to be lost, as named points
// from booking behaviour only, summed into a band. Pure: no clock and no database, like the
// other insight providers. The model never decides this; S86 may later replace the points
// with a learned model where it wins on the shop's own data.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Visits scored: every confirmed visit from now for this many days. */
export const VISIT_RISK_HORIZON_DAYS = 14;

/** The rules' named constants. */
export const VISIT_RISK_RULES = {
  /** The client's miss rate is pulled toward the shop's as if they had this many more visits. */
  priorVisits: 5,
  /** The shop's rate until it has this many finished or missed visits. */
  shopMinVisits: 20,
  /** The shop's rate before it has enough history of its own. */
  defaultShopRate: 0.1,
  /** A pulled miss rate at or above these scores `missedSome` or `missedOften`. */
  missRateSome: 0.15,
  missRateOften: 0.3,
  /** Booked at least this many days before the visit. */
  farAheadDays: 14,
  /** Not confirmed by the client this close to the visit. */
  confirmWithinHours: 48,
} as const;

export const VISIT_RISK_POINTS = {
  missedSome: 2,
  missedOften: 3,
  firstVisit: 1,
  bookedFarAhead: 1,
  onlineNoDeposit: 1,
  notConfirmed: 1,
} as const;

/** The least points for each band above low. */
export const VISIT_RISK_BAND_FROM = { medium: 2, high: 4 } as const;

/** What the rules read: one business's bookings and its cancellation notice, at one instant. */
export interface VisitRiskInput {
  now: number;
  /** Every booking (any status) from the history window on, future ones included. */
  bookings: readonly InsightBooking[];
  /** A cancel within this many hours of the visit counts as a miss (`deposit_refund_hours`). */
  cancelNoticeHours: number;
}

export interface ScoredVisit extends VisitRisk {
  bookingId: BookingId;
  clientId: ClientId;
  start: number;
}

interface History {
  /** Finished or missed visits: completed, no-show, late cancels and past confirmed ones. */
  visits: number;
  /** No-shows and late cancels. */
  misses: number;
}

/**
 * A client's cancel inside the notice window (made before the visit started). A business's
 * cancel is never the client's miss (S78, AC-X-200); one from before S78, with nobody recorded,
 * still counts as it did.
 */
function isLateCancel(booking: InsightBooking, noticeMs: number): boolean {
  if (booking.status !== 'cancelled' || booking.cancelledAt === null) return false;
  if (booking.cancelledBy === 'business') return false;
  const ahead = booking.start - booking.cancelledAt;
  return ahead >= 0 && ahead < noticeMs;
}

function historyOf(input: VisitRiskInput): { byClient: Map<ClientId, History>; shop: History } {
  const noticeMs = input.cancelNoticeHours * HOUR_MS;
  const byClient = new Map<ClientId, History>();
  const shop: History = { visits: 0, misses: 0 };
  for (const booking of input.bookings) {
    if (booking.start >= input.now) continue;
    const missed =
      booking.status === 'no_show' || isLateCancel(booking, noticeMs)
        ? true
        : booking.status === 'completed' || booking.status === 'confirmed'
          ? false
          : null;
    if (missed === null) continue;
    const own = byClient.get(booking.clientId) ?? { visits: 0, misses: 0 };
    own.visits += 1;
    shop.visits += 1;
    if (missed) {
      own.misses += 1;
      shop.misses += 1;
    }
    byClient.set(booking.clientId, own);
  }
  return { byClient, shop };
}

function bandOf(points: number): VisitRiskBand {
  if (points >= VISIT_RISK_BAND_FROM.high) return 'high';
  if (points >= VISIT_RISK_BAND_FROM.medium) return 'medium';
  return 'low';
}

const SIGNAL_ORDER = new Map(VISIT_RISK_SIGNALS.map((signal, i) => [signal, i]));

/** Most points first; ties in the signal list's order. */
function byWeight(a: VisitRiskReason, b: VisitRiskReason): number {
  return (
    b.points - a.points || (SIGNAL_ORDER.get(a.signal) ?? 0) - (SIGNAL_ORDER.get(b.signal) ?? 0)
  );
}

/**
 * The risk of every confirmed visit in the next `VISIT_RISK_HORIZON_DAYS`, earliest first.
 * Reads only booking behaviour: statuses, times, how and when it was booked, whether the client
 * confirmed and whether a deposit or card was taken.
 */
export function findVisitRisks(input: VisitRiskInput): ScoredVisit[] {
  const { now } = input;
  const until = now + VISIT_RISK_HORIZON_DAYS * DAY_MS;
  const { byClient, shop } = historyOf(input);
  const shopRate =
    shop.visits >= VISIT_RISK_RULES.shopMinVisits
      ? shop.misses / shop.visits
      : VISIT_RISK_RULES.defaultShopRate;

  const upcoming = input.bookings
    .filter(
      (booking) => booking.status === 'confirmed' && booking.start >= now && booking.start < until,
    )
    .toSorted((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const seen = new Set<ClientId>();

  return upcoming.map((visit) => {
    const own = byClient.get(visit.clientId) ?? { visits: 0, misses: 0 };
    const reasons: VisitRiskReason[] = [];

    if (own.misses > 0) {
      const pulled =
        (own.misses + VISIT_RISK_RULES.priorVisits * shopRate) /
        (own.visits + VISIT_RISK_RULES.priorVisits);
      const points =
        pulled >= VISIT_RISK_RULES.missRateOften
          ? VISIT_RISK_POINTS.missedOften
          : pulled >= VISIT_RISK_RULES.missRateSome
            ? VISIT_RISK_POINTS.missedSome
            : 0;
      if (points > 0) {
        reasons.push({ signal: 'missed_before', points, misses: own.misses, visits: own.visits });
      }
    }
    // Only their earliest upcoming visit is the first one.
    if (own.visits === 0 && !seen.has(visit.clientId)) {
      reasons.push({ signal: 'first_visit', points: VISIT_RISK_POINTS.firstVisit });
    }
    seen.add(visit.clientId);
    // An imported visit's booking date is the import's, so it says nothing about how far ahead.
    if (visit.source !== 'import') {
      const days = Math.floor((visit.start - visit.createdAt) / DAY_MS);
      if (days >= VISIT_RISK_RULES.farAheadDays) {
        reasons.push({
          signal: 'booked_far_ahead',
          points: VISIT_RISK_POINTS.bookedFarAhead,
          days,
        });
      }
    }
    if (visit.source === 'booking_page' && !visit.secured) {
      reasons.push({ signal: 'online_no_deposit', points: VISIT_RISK_POINTS.onlineNoDeposit });
    }
    // Only a client who was asked and hasn't answered (S78, AC-X-201): one nobody asked
    // couldn't confirm.
    if (
      visit.clientConfirmedAt === null &&
      visit.confirmAskedAt !== null &&
      visit.start - now <= VISIT_RISK_RULES.confirmWithinHours * HOUR_MS
    ) {
      reasons.push({ signal: 'not_confirmed', points: VISIT_RISK_POINTS.notConfirmed });
    }

    const points = reasons.reduce((sum, reason) => sum + reason.points, 0);
    return {
      bookingId: visit.id,
      clientId: visit.clientId,
      start: visit.start,
      band: bandOf(points),
      points,
      reasons: reasons.toSorted(byWeight),
    };
  });
}
