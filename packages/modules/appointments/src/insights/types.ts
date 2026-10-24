import type {
  BookingId,
  BookingStatus,
  ClientId,
  FeedInsight,
  FeedInsightKind,
  FeedSubjects,
  ServiceId,
  StaffMemberId,
} from '@pepper/contracts';
import type { Interval, WorkingWindow } from '../availability/engine.js';

// The insight providers (S35, ADR-0039): pure, deterministic functions from one business's
// snapshot to the feed items it should have now. No clock and no database, like the
// availability engine: the worker's insights pass loads the snapshot under the business's
// tenant and writes the candidates through the feed repository, which dedupes by key.

/** How far ahead gaps, overload and no-show visits are looked for, in local days from today. */
export const INSIGHT_HORIZON_DAYS = 7;
/** A no-show pattern: at least this many no-shows within the window. */
export const NO_SHOW_PATTERN = { minCount: 2, windowDays: 180 } as const;
/** Overload: booked at least this share of working time on at least `minDays` of the horizon. */
export const STAFF_OVERLOAD = { share: 0.9, minDays: 3 } as const;
/** The client's own interval counts from this many visits; it is clamped to these days. */
export const CLIENT_MEDIAN = { minVisits: 3, minDays: 7, maxDays: 365 } as const;
/** How far back the snapshot's bookings must reach (the longest rebooking window is 2 × 365). */
export const INSIGHT_HISTORY_DAYS = 730;

export interface InsightStaff {
  id: StaffMemberId;
  active: boolean;
  hours: readonly WorkingWindow[];
  timeOff: readonly Interval[];
}

export interface InsightBooking extends Interval {
  id: BookingId;
  clientId: ClientId;
  serviceId: ServiceId;
  staffMemberId: StaffMemberId;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  status: BookingStatus;
}

export interface InsightService {
  id: ServiceId;
  /** The service's own rebooking interval; `null`: none set. */
  rebookAfterDays: number | null;
}

/**
 * One business at one instant. `bookings` holds every booking (any status) that starts from
 * `INSIGHT_HISTORY_DAYS` before `now` onwards, future ones included.
 */
export interface InsightSnapshot {
  now: number;
  timeZone: string;
  /** The template's (or business's) shortest gap worth suggesting. */
  minGapMinutes: number;
  staff: readonly InsightStaff[];
  bookings: readonly InsightBooking[];
  services: readonly InsightService[];
}

/** A feed item a provider wants to exist now. */
export type InsightCandidate = FeedInsight & {
  /** The thing it is about, for the dedupe key and the 30-day snooze: `staff:<id>`, `client:<id>`. */
  subjectKey: string;
  /** The local day it is about (`YYYY-MM-DD`): part of the dedupe key. */
  day: string;
  /** `null`: owners and managers only; a staff member: them, and owners and managers. */
  audienceStaffId: StaffMemberId | null;
  subjects: FeedSubjects;
  /** When its reason is gone at the latest (epoch ms). */
  expiresAt: number;
};

export interface InsightProvider {
  kind: FeedInsightKind;
  find(snapshot: InsightSnapshot): InsightCandidate[];
}

/** The dedupe key: one item per (kind, subject, day); the business comes from the row. */
export function dedupeKey(
  candidate: Pick<InsightCandidate, 'kind' | 'subjectKey' | 'day'>,
): string {
  return `${candidate.kind}:${candidate.subjectKey}:${candidate.day}`;
}
