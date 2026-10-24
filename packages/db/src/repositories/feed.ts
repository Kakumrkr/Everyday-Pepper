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
  aiActionProposals,
  bookings,
  clients,
  feedItems,
  insightRequests,
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
          snoozedUntil: null,
          audienceStaffId: sql`excluded.audience_staff_id`,
          staffMemberId: sql`excluded.staff_member_id`,
          clientId: sql`excluded.client_id`,
          bookingId: sql`excluded.booking_id`,
          serviceId: sql`excluded.service_id`,
          payload: sql`excluded.payload`,
          expiresAt: sql`excluded.expires_at`,
        },
        // Only an open item, or one that expired, follows its reason; a member's choice stays.
        // An open or expired item follows its reason, and a dismissed one comes back once its
        // snooze is over (its key may be the same: a rebooking's due date); done stays done.
        setWhere: sql`(${feedItems.status} IN ('suggestion', 'expired') AND (${feedItems.status} <> 'suggestion' OR ${feedItems.payload} IS DISTINCT FROM excluded.payload OR ${feedItems.expiresAt} IS DISTINCT FROM excluded.expires_at OR ${feedItems.audienceStaffId} IS DISTINCT FROM excluded.audience_staff_id OR ${feedItems.bookingId} IS DISTINCT FROM excluded.booking_id)) OR (${feedItems.status} = 'dismissed' AND ${feedItems.snoozedUntil} <= ${now})`,
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
  options: { excludeKinds?: readonly FeedInsightKind[] } = {},
): Promise<FeedItemWithNames[]> {
  const excluded = (options.excludeKinds ?? []).map((kind) => FeedInsightKindSchema.parse(kind));
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
    .where(
      and(
        eq(feedItems.status, 'suggestion'),
        gt(feedItems.expiresAt, now),
        excluded.length === 0 ? undefined : notInArray(feedItems.kind, excluded),
      ),
    )
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
 * Asks the worker to run the business's insights again soon (after a booking, hours or time-off
 * change). Safe and cheap inside the change's transaction: an insert that never waits on
 * another change.
 */
export async function requestInsightRun(tx: TenantTx): Promise<void> {
  await tx.insert(insightRequests).values({});
}

/**
 * Starts a run of the business's insights: takes the business's run lock for this transaction
 * (an advisory lock: a second worker skips the business) and returns the highest request it
 * covers, or `undefined` when another worker is running it right now. Call it before reading
 * anything the run uses.
 */
export async function startInsightRun(tx: TenantTx): Promise<number | undefined> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended('insights:' || current_tenant_id()::text, 0)) AS locked`,
  );
  if (rows[0]?.locked !== true) return undefined;
  // A business without its row (it missed the backfill) gets one now.
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  const [row] = await tx
    // node-postgres reads a bigint as a string.
    .select({ seen: sql<string>`coalesce(max(${insightRequests.seq}), 0)::text` })
    .from(insightRequests);
  return Number(row?.seen ?? '0');
}

/**
 * Records a finished run that started at `startedAt`: the requests up to `seen` are done; one
 * committed since (a higher id, or one not visible when the run began) stays.
 */
export async function markInsightRun(tx: TenantTx, startedAt: Date, seen: number): Promise<void> {
  await tx.update(insightRuns).set({ lastRunAt: startedAt });
  await tx
    .delete(insightRequests)
    .where(lte(insightRequests.seq, z.number().int().min(0).parse(seen)));
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
          sql`${insightRuns.tenantId} IN (SELECT ${insightRequests.tenantId} FROM ${insightRequests})`,
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
  name: string;
  slug: string;
  timeZone: string;
  templateId: string | null;
  settings: StoredFeedSettings;
  /** Where commercial mail says the business is (S36); `null`: no nudges are drafted. */
  mailingAddress: string | null;
}

export async function readInsightTenant(tx: TenantTx): Promise<InsightTenant | undefined> {
  const [row] = await tx
    .select({
      name: tenants.name,
      slug: tenants.slug,
      timeZone: tenants.timeZone,
      templateId: tenants.templateId,
      settings: tenants.feedSettings,
      mailingAddress: tenants.mailingAddress,
    })
    .from(tenants);
  if (row === undefined) return undefined;
  const parsed = StoredFeedSettingsSchema.safeParse(row.settings);
  return {
    name: row.name,
    slug: row.slug,
    timeZone: row.timeZone,
    templateId: row.templateId,
    settings: parsed.success ? parsed.data : STORED_DEFAULT,
    mailingAddress: row.mailingAddress,
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

// ---------------------------------------------------------------------------------------------
// Rebooking nudges (S36, ADR-0040): the morning drafts pass turns open `rebooking_due` items
// into proposals; the item then waits as `needs_ok`, linked to its proposal, until a person
// decides (the trust layer settles it through `settleFeedItemsOf`).

/** The dial action and target of a client's nudge: one pending nudge per client. */
export const NUDGE_ACTION = 'message.rebooking_nudge';
export const nudgeTargetKey = (clientId: string) => `nudge:client:${Id.parse(clientId)}`;

/** An open `rebooking_due` item of a client who can be emailed, as the morning pass reads it. */
export interface DraftableRebooking {
  itemId: FeedItemId;
  clientId: string;
  serviceId: string | null;
  staffMemberId: string | null;
  day: string;
  payload: unknown;
}

/**
 * Up to `limit` open rebooking suggestions whose client has an email address, has not opted out
 * of marketing email, and got no nudge proposal within their interval (a pending, sent, turned
 * down or expired one all count: at most one nudge per client per interval, playbook D-9).
 * Most overdue first.
 */
export async function listDraftableRebookings(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<DraftableRebooking[]> {
  const max = z.number().int().min(1).max(200).parse(limit);
  const rows = await tx
    .select({
      itemId: feedItems.id,
      clientId: feedItems.clientId,
      serviceId: feedItems.serviceId,
      staffMemberId: feedItems.staffMemberId,
      day: feedItems.day,
      payload: feedItems.payload,
    })
    .from(feedItems)
    .innerJoin(clients, eq(clients.id, feedItems.clientId))
    .where(
      and(
        eq(feedItems.kind, 'rebooking_due'),
        eq(feedItems.status, 'suggestion'),
        gt(feedItems.expiresAt, now),
        sql`${clients.email} IS NOT NULL`,
        isNull(clients.emailOptOutAt),
        // A superseded nudge reached no one: its replacement (an edit, a refresh) counts on its
        // own, and one refused at approval (the time was booked meanwhile) blocks nothing.
        sql`NOT EXISTS (SELECT 1 FROM ${aiActionProposals} WHERE ${aiActionProposals.action} = ${NUDGE_ACTION} AND ${aiActionProposals.targetKey} = 'nudge:client:' || ${feedItems.clientId}::text AND ${aiActionProposals.status} <> 'superseded' AND ${aiActionProposals.createdAt} > ${now}::timestamptz - make_interval(days => coalesce((${feedItems.payload}->>'intervalDays')::int, 28)))`,
      ),
    )
    .orderBy(asc(feedItems.day), asc(feedItems.id))
    .limit(max);
  return rows.flatMap((row) =>
    row.clientId === null
      ? []
      : [{ ...row, itemId: FeedItemIdSchema.parse(row.itemId), clientId: row.clientId }],
  );
}

/** One item the transaction may see, any status. */
export async function findFeedItem(tx: TenantTx, id: FeedItemId): Promise<FeedItemRow | undefined> {
  const [row] = await tx
    .select()
    .from(feedItems)
    .where(eq(feedItems.id, FeedItemIdSchema.parse(id)));
  return row;
}

/** Links an open suggestion to the proposal that carries it out: it now needs an OK. */
export async function linkFeedItemToProposal(
  tx: TenantTx,
  itemId: FeedItemId,
  proposalId: string,
): Promise<boolean> {
  const rows = await tx
    .update(feedItems)
    .set({ status: 'needs_ok', actionProposalId: Id.parse(proposalId) })
    .where(
      and(eq(feedItems.id, FeedItemIdSchema.parse(itemId)), eq(feedItems.status, 'suggestion')),
    )
    .returning({ id: feedItems.id });
  return rows.length > 0;
}

/** A proposal was replaced (an edit, or a fresh preview): its items wait for the new one. */
export async function repointFeedItems(tx: TenantTx, from: string, to: string): Promise<number> {
  const rows = await tx
    .update(feedItems)
    .set({ actionProposalId: Id.parse(to) })
    .where(and(eq(feedItems.actionProposalId, Id.parse(from)), eq(feedItems.status, 'needs_ok')))
    .returning({ id: feedItems.id });
  return rows.length;
}

/**
 * Closes the items waiting on a decided proposal: approved → `done`; turned down → `dismissed`
 * (snoozed 30 days, as a dismissal); expired or refused → `expired` (the next pass opens it
 * again while the client is still due; the interval keeps a second nudge away).
 */
export async function settleFeedItemsOf(
  tx: TenantTx,
  proposalId: string,
  outcome: 'done' | 'dismissed' | 'expired',
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(feedItems)
    .set({
      status: outcome,
      actedAt: now,
      snoozedUntil:
        outcome === 'dismissed' ? new Date(now.getTime() + FEED_SNOOZE_DAYS * DAY_MS) : null,
    })
    .where(
      and(eq(feedItems.actionProposalId, Id.parse(proposalId)), eq(feedItems.status, 'needs_ok')),
    )
    .returning({ id: feedItems.id });
  return rows.length;
}

/** The items the transaction's member may see that wait on a proposal (`get_feed`). */
export async function listWaitingFeedItems(tx: TenantTx, limit = 50): Promise<FeedItemWithNames[]> {
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
    .where(eq(feedItems.status, 'needs_ok'))
    .orderBy(desc(feedItems.updatedAt), asc(feedItems.id))
    .limit(max);
  return rows.map((row) => ({
    ...row.item,
    staffName: row.staffName,
    clientName: row.clientName,
    serviceName: row.serviceName,
  }));
}

/** Records when the business's morning drafts pass is due next. */
export async function setDraftsDueAt(tx: TenantTx, at: Date): Promise<void> {
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  await tx.update(insightRuns).set({ draftsDueAt: at });
}

/**
 * Claims the business's morning drafts pass when it is due at `now` (never run, or due), by
 * moving its due time to `next`: of two workers, only one gets `true`.
 */
export async function claimDraftsRun(tx: TenantTx, now: Date, next: Date): Promise<boolean> {
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  const rows = await tx
    .update(insightRuns)
    .set({ draftsDueAt: next })
    .where(or(isNull(insightRuns.draftsDueAt), lte(insightRuns.draftsDueAt, now)))
    .returning({ id: insightRuns.id });
  return rows.length > 0;
}

/** When the business's morning drafts pass is due (`null`: never run). */
export async function readDraftsDueAt(tx: TenantTx): Promise<Date | null> {
  const [row] = await tx.select({ at: insightRuns.draftsDueAt }).from(insightRuns);
  return row?.at ?? null;
}

/**
 * Up to `limit` businesses whose morning drafts pass is due at `now`, across businesses (ids
 * only): never run, or due. The pass itself decides, in the business's time zone, whether its
 * morning hour has come.
 */
export async function listDueDraftRuns(
  db: Database,
  now: Date,
  limit: number,
): Promise<TenantId[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const rows = await withJobScan(db, 'insights', (tx) =>
    tx
      .select({ tenantId: insightRuns.tenantId })
      .from(insightRuns)
      .where(or(isNull(insightRuns.draftsDueAt), lte(insightRuns.draftsDueAt, now)))
      .orderBy(sql`${insightRuns.draftsDueAt} ASC NULLS FIRST`, asc(insightRuns.tenantId))
      .limit(max),
  );
  return rows.map((row) => TenantIdSchema.parse(row.tenantId));
}
