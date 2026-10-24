import {
  DEFAULT_FEED_SETTINGS,
  FEED_SNOOZE_DAYS,
  FeedInsightKindSchema,
  FeedItemIdSchema,
  FeedSettingsSchema,
  LocalDateSchema,
  TenantIdSchema,
  type FeedInsightKind,
  type FeedItemId,
  type TenantId,
} from '@pepper/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  bookings,
  clients,
  feedItems,
  insightRuns,
  services,
  staffMembers,
  tenants,
  type FeedItemRow,
} from '../schema.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// The operator feed's suggestions and the insights pass's bookkeeping (ADR-0039). Run inside
// `withMember` for a member's request, where the `member_scope` policy limits staff to the
// items addressed to them; the worker's insights pass runs under the business's tenant only.
// Items hold ids and numbers; names are joined in when a member reads them, never stored.

const DAY_MS = 86_400_000;
const Id = z.uuid();
const SubjectKeySchema = z.string().regex(/^(staff|client|booking):[0-9a-f-]{36}$/);

/** The kinds the insights pass owns: a kind it did not return this run has no reason left. */
const PASS_KINDS = FeedInsightKindSchema.options;

/** A suggestion the insights pass wants to exist (a provider's candidate, ids as strings). */
export interface FeedCandidate {
  kind: FeedInsightKind;
  subjectKey: string;
  day: string;
  audienceStaffId: string | null;
  subjects: {
    staffMemberId: string | null;
    clientId: string | null;
    bookingId: string | null;
    serviceId: string | null;
  };
  payload: Record<string, unknown>;
  expiresAt: Date;
}

export interface FeedSyncResult {
  created: number;
  updated: number;
  expired: number;
  /** Candidates left out because the same kind and subject were dismissed lately. */
  snoozed: number;
}

/** The dedupe key: the same expression as the `feed_items_dedupe_key_format` check. */
export const feedDedupeKey = (item: Pick<FeedCandidate, 'kind' | 'subjectKey' | 'day'>) =>
  `${item.kind}:${item.subjectKey}:${item.day}`;

const snoozeKey = (item: { kind: string; subjectKey: string }) => `${item.kind}|${item.subjectKey}`;

/**
 * Brings the business's suggestions in line with this run's candidates: adds the new ones,
 * updates those already there (and opens again one that expired because its reason went away
 * for a while), leaves out kind × subject pairs still snoozed, and expires every open
 * suggestion whose reason is gone or whose time has passed. Dismissed and done items are never
 * touched. Idempotent: running it twice with the same candidates changes nothing the second time.
 */
export async function syncFeedItems(
  tx: TenantTx,
  candidates: readonly FeedCandidate[],
  now: Date,
): Promise<FeedSyncResult> {
  const snoozedRows = await tx
    .select({ kind: feedItems.kind, subjectKey: feedItems.subjectKey })
    .from(feedItems)
    .where(and(eq(feedItems.status, 'dismissed'), gt(feedItems.snoozedUntil, now)));
  const snoozed = new Set(snoozedRows.map(snoozeKey));
  const fresh = candidates.filter((candidate) => !snoozed.has(snoozeKey(candidate)));

  let created = 0;
  let updated = 0;
  const keys: string[] = [];
  for (let i = 0; i < fresh.length; i += 500) {
    const values = fresh.slice(i, i + 500).map((candidate) => {
      const dedupeKey = feedDedupeKey(candidate);
      keys.push(dedupeKey);
      return {
        kind: FeedInsightKindSchema.parse(candidate.kind),
        subjectKey: SubjectKeySchema.parse(candidate.subjectKey),
        day: LocalDateSchema.parse(candidate.day),
        dedupeKey,
        audienceStaffId:
          candidate.audienceStaffId === null ? null : Id.parse(candidate.audienceStaffId),
        staffMemberId: nullableId(candidate.subjects.staffMemberId),
        clientId: nullableId(candidate.subjects.clientId),
        bookingId: nullableId(candidate.subjects.bookingId),
        serviceId: nullableId(candidate.subjects.serviceId),
        payload: candidate.payload,
        expiresAt: candidate.expiresAt,
      };
    });
    const written = await tx
      .insert(feedItems)
      .values(values)
      .onConflictDoUpdate({
        target: [feedItems.tenantId, feedItems.dedupeKey],
        set: {
          status: 'suggestion',
          actedAt: null,
          audienceStaffId: sql`excluded.audience_staff_id`,
          staffMemberId: sql`excluded.staff_member_id`,
          clientId: sql`excluded.client_id`,
          bookingId: sql`excluded.booking_id`,
          serviceId: sql`excluded.service_id`,
          payload: sql`excluded.payload`,
          expiresAt: sql`excluded.expires_at`,
        },
        // Only an open item, or one that expired, follows its reason; a member's choice stays.
        setWhere: sql`${feedItems.status} IN ('suggestion', 'expired') AND (${feedItems.status} <> 'suggestion' OR ${feedItems.payload} IS DISTINCT FROM excluded.payload OR ${feedItems.expiresAt} IS DISTINCT FROM excluded.expires_at OR ${feedItems.audienceStaffId} IS DISTINCT FROM excluded.audience_staff_id OR ${feedItems.bookingId} IS DISTINCT FROM excluded.booking_id)`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const row of written) {
      if (row.inserted) created += 1;
      else updated += 1;
    }
  }

  const reasonGone = keys.length === 0 ? sql`true` : notInArray(feedItems.dedupeKey, keys);
  const expired = await tx
    .update(feedItems)
    .set({ status: 'expired', actedAt: now })
    .where(
      and(
        eq(feedItems.status, 'suggestion'),
        inArray(feedItems.kind, [...PASS_KINDS]),
        or(lte(feedItems.expiresAt, now), reasonGone),
      ),
    )
    .returning({ id: feedItems.id });

  return { created, updated, expired: expired.length, snoozed: candidates.length - fresh.length };
}

function nullableId(value: string | null): string | null {
  return value === null ? null : Id.parse(value);
}

/** An open suggestion with the names a member may see (`null` where they may not). */
export interface FeedItemWithNames extends FeedItemRow {
  staffName: string | null;
  clientName: string | null;
  serviceName: string | null;
}

/** The open suggestions the transaction's member may see, newest first. */
export async function listOpenFeedItems(
  tx: TenantTx,
  now: Date,
  limit = 50,
): Promise<FeedItemWithNames[]> {
  const max = z.number().int().min(1).max(200).parse(limit);
  const rows = await tx
    .select({
      item: feedItems,
      staffName: staffMembers.displayName,
      clientName: clients.name,
      serviceName: services.name,
    })
    .from(feedItems)
    .leftJoin(staffMembers, eq(staffMembers.id, feedItems.staffMemberId))
    .leftJoin(clients, eq(clients.id, feedItems.clientId))
    .leftJoin(services, eq(services.id, feedItems.serviceId))
    .where(and(eq(feedItems.status, 'suggestion'), gt(feedItems.expiresAt, now)))
    .orderBy(desc(feedItems.createdAt), asc(feedItems.id))
    .limit(max);
  return rows.map((row) => ({
    ...row.item,
    staffName: row.staffName,
    clientName: row.clientName,
    serviceName: row.serviceName,
  }));
}

/**
 * Closes an open suggestion the member may see: `dismissed` snoozes the same kind for the
 * same subject for 30 days; `done` records that they acted on it. `undefined` when there is
 * no such open item (already closed, expired, or not theirs).
 */
export async function closeFeedItem(
  tx: TenantTx,
  id: FeedItemId,
  outcome: 'dismissed' | 'done',
  now: Date,
): Promise<FeedItemRow | undefined> {
  const [row] = await tx
    .update(feedItems)
    .set({
      status: outcome,
      actedAt: now,
      snoozedUntil:
        outcome === 'dismissed' ? new Date(now.getTime() + FEED_SNOOZE_DAYS * DAY_MS) : null,
    })
    .where(
      and(
        eq(feedItems.id, FeedItemIdSchema.parse(id)),
        eq(feedItems.status, 'suggestion'),
        gt(feedItems.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

/** How many items of `kind` the business dismissed since `since`. */
export async function countDismissals(
  tx: TenantTx,
  kind: FeedInsightKind,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(feedItems)
    .where(
      and(
        eq(feedItems.kind, FeedInsightKindSchema.parse(kind)),
        eq(feedItems.status, 'dismissed'),
        gte(feedItems.actedAt, since),
      ),
    );
  return row?.count ?? 0;
}

/** Acted-on instrumentation (playbook §2): closed items per kind and outcome since `since`. */
export async function feedOutcomeCounts(
  tx: TenantTx,
  since: Date,
): Promise<{ kind: string; status: string; count: number }[]> {
  return tx
    .select({
      kind: feedItems.kind,
      status: feedItems.status,
      count: sql<number>`count(*)::int`,
    })
    .from(feedItems)
    .where(
      and(
        inArray(feedItems.status, ['done', 'dismissed', 'expired']),
        gte(feedItems.actedAt, since),
      ),
    )
    .groupBy(feedItems.kind, feedItems.status)
    .orderBy(asc(feedItems.kind), asc(feedItems.status));
}

/** The stored switches, plus the kinds whose once-only "turn this off?" was answered. */
export const StoredFeedSettingsSchema = FeedSettingsSchema.extend({
  answeredKinds: z.array(FeedInsightKindSchema),
});
export type StoredFeedSettings = z.infer<typeof StoredFeedSettingsSchema>;

const STORED_DEFAULT: StoredFeedSettings = { ...DEFAULT_FEED_SETTINGS, answeredKinds: [] };

/** The business's feed switches; an unreadable value falls back to the defaults. */
export async function readFeedSettings(tx: TenantTx): Promise<StoredFeedSettings> {
  const [row] = await tx.select({ settings: tenants.feedSettings }).from(tenants);
  const parsed = StoredFeedSettingsSchema.safeParse(row?.settings);
  return parsed.success ? parsed.data : STORED_DEFAULT;
}

/** Replaces the business's feed switches (owners and managers; the service checks). */
export async function writeFeedSettings(
  tx: TenantTx,
  settings: StoredFeedSettings,
): Promise<StoredFeedSettings> {
  const value = StoredFeedSettingsSchema.parse(settings);
  await tx.update(tenants).set({ feedSettings: value });
  return value;
}

/**
 * Asks the worker to run the business's insights again soon (after a booking change). Cheap
 * and safe inside the change's transaction: one row per business, its count raised by one.
 */
export async function requestInsightRun(tx: TenantTx): Promise<void> {
  await tx
    .insert(insightRuns)
    .values({ requestCount: 1 })
    .onConflictDoUpdate({
      target: insightRuns.tenantId,
      set: { requestCount: sql`${insightRuns.requestCount} + 1` },
    });
}

/**
 * Starts a run of the business's insights: takes the business's run lock for this transaction
 * (an advisory lock, so booking changes asking for runs never wait on it) and returns the
 * request count the run covers, or `undefined` when another worker is running it right now.
 * Call it before reading anything the run uses.
 */
export async function startInsightRun(tx: TenantTx): Promise<number | undefined> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('insights:' || current_tenant_id()::text, 0)) AS locked`,
  );
  if (rows[0]?.locked !== true) return undefined;
  // A business without its row (it missed the backfill) gets one now.
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  const [row] = await tx.select({ requestCount: insightRuns.requestCount }).from(insightRuns);
  return row?.requestCount ?? 0;
}

/** Records a finished run that started at `startedAt` and covered requests up to `seen`. */
export async function markInsightRun(tx: TenantTx, startedAt: Date, seen: number): Promise<void> {
  await tx.update(insightRuns).set({
    lastRunAt: startedAt,
    runCount: sql`GREATEST(${insightRuns.runCount}, LEAST(${seen}::bigint, ${insightRuns.requestCount}))`,
  });
}

export interface DueInsightRun {
  runId: string;
  tenantId: TenantId;
}

/**
 * Up to `limit` businesses whose insights are due at `now`, across businesses (the insights
 * pass's scan, ids only): never run, asked for since the last run, or last run `everyMs` ago.
 */
export async function listDueInsightRuns(
  db: Database,
  now: Date,
  everyMs: number,
  limit: number,
): Promise<DueInsightRun[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const staleBefore = new Date(now.getTime() - z.number().int().min(1).parse(everyMs));
  const rows = await withJobScan(db, 'insights', (tx) =>
    tx
      .select({ id: insightRuns.id, tenantId: insightRuns.tenantId })
      .from(insightRuns)
      .where(
        or(
          isNull(insightRuns.lastRunAt),
          gt(insightRuns.requestCount, insightRuns.runCount),
          lte(insightRuns.lastRunAt, staleBefore),
        ),
      )
      .orderBy(sql`${insightRuns.lastRunAt} ASC NULLS FIRST`, asc(insightRuns.tenantId))
      .limit(max),
  );
  return rows.map((row) => ({ runId: row.id, tenantId: TenantIdSchema.parse(row.tenantId) }));
}

/** What the insights pass needs about the business itself. */
export interface InsightTenant {
  timeZone: string;
  templateId: string | null;
  settings: StoredFeedSettings;
}

export async function readInsightTenant(tx: TenantTx): Promise<InsightTenant | undefined> {
  const [row] = await tx
    .select({
      timeZone: tenants.timeZone,
      templateId: tenants.templateId,
      settings: tenants.feedSettings,
    })
    .from(tenants);
  if (row === undefined) return undefined;
  const parsed = StoredFeedSettingsSchema.safeParse(row.settings);
  return {
    timeZone: row.timeZone,
    templateId: row.templateId,
    settings: parsed.success ? parsed.data : STORED_DEFAULT,
  };
}

/** A booking as the insight providers read it. */
export interface InsightBookingRow {
  id: string;
  clientId: string;
  serviceId: string;
  staffMemberId: string;
  startsAt: Date;
  endsAt: Date;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  status: string;
}

/** Every booking of the business (any status) starting at or after `since`, by start. */
export async function listInsightBookings(tx: TenantTx, since: Date): Promise<InsightBookingRow[]> {
  return tx
    .select({
      id: bookings.id,
      clientId: bookings.clientId,
      serviceId: bookings.serviceId,
      staffMemberId: bookings.staffMemberId,
      startsAt: bookings.startsAt,
      endsAt: bookings.endsAt,
      bufferBeforeMinutes: bookings.bufferBeforeMinutes,
      bufferAfterMinutes: bookings.bufferAfterMinutes,
      status: bookings.status,
    })
    .from(bookings)
    .where(gte(bookings.startsAt, since))
    .orderBy(asc(bookings.startsAt), asc(bookings.id));
}
