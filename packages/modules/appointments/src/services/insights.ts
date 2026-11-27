import {
  BookingIdSchema,
  BookingOriginSchema,
  BookingStatusSchema,
  ClientIdSchema,
  FeedInsightKindSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TemplateIdSchema,
  type FeedInsightKind,
  type InsightType,
  type TemplateId,
  type TenantId,
} from '@pepper/contracts';
import type { Clock } from '@pepper/core';
import {
  listDueInsightRuns,
  listActiveWaitlistMatches,
  listInsightBookings,
  listServices,
  listStaffMembers,
  listTimeOffBetween,
  listWorkingHoursOf,
  markInsightRun,
  readInsightTenant,
  requestInsightRun,
  startInsightRun,
  syncFeedItems,
  syncVisitRisks,
  withTenant,
  type Database,
  type FeedCandidate,
  type FeedSyncResult,
  type InsightBookingRow,
  type TenantTx,
  type VisitRiskSyncResult,
} from '@pepper/db';
import { findInsights } from '../insights/providers.js';
import {
  INSIGHT_HISTORY_DAYS,
  INSIGHT_HORIZON_DAYS,
  type InsightBooking,
  type InsightCandidate,
  type InsightSnapshot,
} from '../insights/types.js';
import { findVisitRisks } from '../insights/visit-risk.js';

// The insights pass (S35, ADR-0039): the worker runs it every minute. It lists the businesses
// whose insights are due (never run, asked for by a booking change since the last run, or an
// hour old) and, for each one under its own tenant, loads a snapshot, runs the enabled
// providers and brings the feed in line (`syncFeedItems`: dedupe by key, expiry, snooze).
// A `Periodic` pass over Postgres rather than a queue: the work is "recompute this business",
// idempotent and coalescing (ten booking changes in a minute are one run), so a row per
// business is all the state it needs, and a restart loses nothing.

const DAY_MS = 86_400_000;
/** Businesses per scan, and scans per pass (a backlog clears over a few passes). */
export const INSIGHT_BATCH = 50;
export const INSIGHT_BATCHES_PER_PASS = 4;
/** How old a run may get before the business runs again without a request. */
export const INSIGHT_RUN_EVERY_MS = 60 * 60_000;

/** The thresholds a business's template sets (`templateInsights` in the worker). */
export interface InsightSettings {
  enabled: readonly InsightType[];
  minGapMinutes: number;
}

export interface InsightsOptions {
  clock: Clock;
  insightsOf: (templateId: TemplateId | null) => InsightSettings;
}

export type InsightRunResult =
  | ({ outcome: 'ran'; risks: VisitRiskSyncResult } & FeedSyncResult)
  | { outcome: 'paused'; risks: VisitRiskSyncResult }
  | { outcome: 'busy' | 'gone' };

/**
 * Asks for the business's insights to run again soon. Call it in the transaction that changed
 * a booking, so a gap that was just filled or opened shows within about a minute.
 */
export async function requestInsights(tx: TenantTx): Promise<void> {
  await requestInsightRun(tx);
}

/** One pass of the insights job; returns how many businesses ran and the feed changes. */
export async function runDueInsights(
  db: Database,
  options: InsightsOptions,
): Promise<{ businesses: number; created: number; updated: number; expired: number }> {
  const totals = { businesses: 0, created: 0, updated: 0, expired: 0 };
  const seen = new Set<TenantId>();
  for (let batch = 0; batch < INSIGHT_BATCHES_PER_PASS; batch += 1) {
    const listed = await listDueInsightRuns(
      db,
      new Date(options.clock.now()),
      INSIGHT_RUN_EVERY_MS,
      INSIGHT_BATCH,
    );
    for (const { tenantId } of listed) {
      // A business another worker held ("busy") is listed again; it runs on the next pass.
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      const result = await runInsightsFor(db, tenantId, options);
      if (result.outcome !== 'ran') continue;
      totals.businesses += 1;
      totals.created += result.created;
      totals.updated += result.updated;
      totals.expired += result.expired;
    }
    if (listed.length < INSIGHT_BATCH) break;
  }
  return totals;
}

/** Runs one business's insights now, under its tenant. */
export async function runInsightsFor(
  db: Database,
  tenantId: TenantId,
  options: InsightsOptions,
): Promise<InsightRunResult> {
  const startedAt = new Date(options.clock.now());
  return withTenant(db, tenantId, async (tx) => {
    const seen = await startInsightRun(tx);
    if (seen === undefined) return { outcome: 'busy' };
    const tenant = await readInsightTenant(tx);
    if (tenant === undefined) return { outcome: 'gone' };
    // Visit risk is a reading of the book, not a suggestion: it is kept current even while
    // suggestions are paused (S77, ADR-0071).
    const history = (
      await listInsightBookings(tx, new Date(startedAt.getTime() - INSIGHT_HISTORY_DAYS * DAY_MS))
    ).map(toInsightBooking);
    const risks = await syncVisitRisks(
      tx,
      findVisitRisks({
        now: startedAt.getTime(),
        bookings: history,
        cancelNoticeHours: tenant.cancelNoticeHours,
      }),
      startedAt,
    );
    // Paused: nothing new is found and what is there stays as it was (hidden by the api).
    if (tenant.settings.suggestionsPaused) {
      await markInsightRun(tx, startedAt, seen);
      return { outcome: 'paused', risks };
    }
    const template = options.insightsOf(TemplateIdSchema.nullable().parse(tenant.templateId));
    const off = new Set(tenant.settings.disabledKinds);
    const enabled = template.enabled.filter(
      (kind): kind is FeedInsightKind =>
        FeedInsightKindSchema.safeParse(kind).success && !off.has(kind),
    );
    const snapshot = await loadSnapshot(
      tx,
      {
        now: startedAt.getTime(),
        timeZone: tenant.timeZone,
        minGapMinutes: template.minGapMinutes,
      },
      history,
    );
    const candidates = findInsights(snapshot, enabled).map(toFeedCandidate);
    const result = await syncFeedItems(tx, candidates, startedAt);
    await markInsightRun(tx, startedAt, seen);
    return { outcome: 'ran', ...result, risks };
  });
}

/** The business's snapshot for the providers (and the morning briefing). */
export async function loadSnapshot(
  tx: TenantTx,
  base: Pick<InsightSnapshot, 'now' | 'timeZone' | 'minGapMinutes'>,
  /** The history window's bookings, when the caller has read them already. */
  history?: readonly InsightBooking[],
): Promise<InsightSnapshot> {
  const staffRows = await listStaffMembers(tx);
  const staffIds = staffRows.map((row) => StaffMemberIdSchema.parse(row.id));
  // A day either side of the horizon covers every local day whatever the time zone.
  const range = {
    from: new Date(base.now - DAY_MS),
    to: new Date(base.now + (INSIGHT_HORIZON_DAYS + 1) * DAY_MS),
  };
  const [hours, timeOff, services, bookings, matches] = [
    await listWorkingHoursOf(tx, staffIds),
    await listTimeOffBetween(tx, staffIds, range),
    await listServices(tx),
    history ??
      (await listInsightBookings(tx, new Date(base.now - INSIGHT_HISTORY_DAYS * DAY_MS))).map(
        toInsightBooking,
      ),
    await listActiveWaitlistMatches(tx, new Date(base.now)),
  ];
  return {
    ...base,
    staff: staffRows.map((row) => ({
      id: StaffMemberIdSchema.parse(row.id),
      active: row.active,
      hours: hours.filter((window) => window.staffMemberId === row.id),
      timeOff: timeOff
        .filter((off) => off.staffMemberId === row.id)
        .map((off) => ({ start: off.startsAt.getTime(), end: off.endsAt.getTime() })),
    })),
    services: services.map((row) => ({
      id: ServiceIdSchema.parse(row.id),
      rebookAfterDays: row.rebookAfterDays,
    })),
    bookings: [...bookings],
    waitlistMatches: matches.map((match) => ({
      bookingId: BookingIdSchema.parse(match.bookingId),
      staffMemberId: StaffMemberIdSchema.parse(match.staffMemberId),
      start: match.startsAt.getTime(),
      end: match.endsAt.getTime(),
      state: match.state,
      offered: match.offered,
    })),
  };
}

/** A booking row as the insight providers read it. */
export function toInsightBooking(row: InsightBookingRow): InsightBooking {
  return {
    id: BookingIdSchema.parse(row.id),
    clientId: ClientIdSchema.parse(row.clientId),
    serviceId: ServiceIdSchema.parse(row.serviceId),
    staffMemberId: StaffMemberIdSchema.parse(row.staffMemberId),
    start: row.startsAt.getTime(),
    end: row.endsAt.getTime(),
    bufferBeforeMinutes: row.bufferBeforeMinutes,
    bufferAfterMinutes: row.bufferAfterMinutes,
    status: BookingStatusSchema.parse(row.status),
    source: BookingOriginSchema.parse(row.source),
    createdAt: row.createdAt.getTime(),
    clientConfirmedAt: row.clientConfirmedAt?.getTime() ?? null,
    confirmAskedAt: row.confirmAskedAt?.getTime() ?? null,
    cancelledAt: row.cancelledAt?.getTime() ?? null,
    cancelledBy:
      row.cancelledBy === 'client' || row.cancelledBy === 'business' ? row.cancelledBy : null,
    secured: row.secured,
  };
}

function toFeedCandidate(candidate: InsightCandidate): FeedCandidate {
  return {
    kind: candidate.kind,
    subjectKey: candidate.subjectKey,
    day: candidate.day,
    audienceStaffId: candidate.audienceStaffId,
    subjects: candidate.subjects,
    payload: candidate.payload,
    expiresAt: new Date(candidate.expiresAt),
  };
}
