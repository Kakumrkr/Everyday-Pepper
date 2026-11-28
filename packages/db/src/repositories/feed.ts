import {
  CalendarKeptPayloadSchema,
  ClientTextCardOutcomeSchema,
  ClientTextPayloadSchema,
  type ClientTextCardOutcome,
  type CalendarKeptPayload,
  DEFAULT_FEED_SETTINGS,
  FEED_SNOOZE_DAYS,
  FeedInsightKindSchema,
  FeedKindSchema,
  FeedItemIdSchema,
  FeedSettingsSchema,
  DailyBriefingPayloadSchema,
  LocalDateSchema,
  TenantIdSchema,
  type DailyBriefingPayload,
  type FeedInsightKind,
  type FeedKind,
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
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  aiActionProposals,
  bookingPayments,
  bookings,
  clientTexts,
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

/** A client's text card's kind (S80). */
const CLIENT_TEXT = 'client_text';

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
  options: { excludeKinds?: readonly FeedKind[]; onlyKind?: FeedKind } = {},
): Promise<FeedItemWithNames[]> {
  const excluded = (options.excludeKinds ?? []).map((kind) => FeedKindSchema.parse(kind));
  const only = options.onlyKind === undefined ? undefined : FeedKindSchema.parse(options.onlyKind);
  const max = z.number().int().min(1).max(200).parse(limit);
  const rows = await tx
    .select({
      item: feedItems,
      staffName: staffMembers.displayName,
      clientName: clients.name,
      serviceName: services.name,
      textBody: clientTexts.body,
    })
    .from(feedItems)
    .leftJoin(staffMembers, eq(staffMembers.id, feedItems.staffMemberId))
    .leftJoin(clients, eq(clients.id, feedItems.clientId))
    .leftJoin(services, eq(services.id, feedItems.serviceId))
    // A client's text card quotes the text, kept on its own (S80): a card whose text is gone
    // reads without words and is left out.
    .leftJoin(
      clientTexts,
      and(
        eq(feedItems.kind, CLIENT_TEXT),
        sql`${clientTexts.id}::text = ${feedItems.payload}->>'textId'`,
      ),
    )
    .where(
      and(
        eq(feedItems.status, 'suggestion'),
        gt(feedItems.expiresAt, now),
        // The briefing informs; it is read on its own (`readBriefing`), never as a suggestion.
        notInArray(feedItems.kind, [...excluded, BRIEFING]),
        only === undefined ? undefined : eq(feedItems.kind, only),
      ),
    )
    .orderBy(desc(feedItems.createdAt), asc(feedItems.id))
    .limit(max);
  return rows.map((row) => ({
    ...row.item,
    payload: withTextBody(row.item.kind, row.item.payload, row.textBody),
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

/**
 * How many times the business dismissed items of `kind` since `since`: one tap is one
 * dismissal, so the items a grouped card's "Dismiss all" closed together (one `acted_at`, S52)
 * count once.
 */
export async function countDismissals(
  tx: TenantTx,
  kind: FeedInsightKind,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(DISTINCT ${feedItems.actedAt})::int` })
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
  settings: z.input<typeof StoredFeedSettingsSchema>,
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
  /** Where review requests send clients (S55.2); `null`: no review requests are drafted. */
  reviewUrl: string | null;
  /** The cancellation notice in hours (`deposit_refund_hours`): a cancel inside it is late (S77). */
  cancelNoticeHours: number;
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
      reviewUrl: tenants.reviewUrl,
      cancelNoticeHours: tenants.depositRefundHours,
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
    reviewUrl: row.reviewUrl,
    cancelNoticeHours: row.cancelNoticeHours,
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
  /** The price the visit was booked (or imported) at, for "Haven't been back" (S54.2). */
  priceFromCents: number | null;
  // For visit risk (S77, ADR-0071): booking behaviour only.
  source: string;
  createdAt: Date;
  clientConfirmedAt: Date | null;
  /** When the client was last asked to confirm it at its current time (S78). */
  confirmAskedAt: Date | null;
  cancelledAt: Date | null;
  /** Who cancelled it (S78): `client`, `business`, or `null` (not cancelled, or unknown). */
  cancelledBy: string | null;
  /** A deposit or a card was taken for it on the booking page (S66). */
  secured: boolean;
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
      priceFromCents: bookings.priceFromCents,
      source: bookings.source,
      createdAt: bookings.createdAt,
      clientConfirmedAt: bookings.clientConfirmedAt,
      confirmAskedAt: bookings.confirmAskedAt,
      cancelledAt: bookings.cancelledAt,
      cancelledBy: bookings.cancelledBy,
      secured: sql<boolean>`EXISTS (SELECT 1 FROM ${bookingPayments} p WHERE p.booking_id = ${bookings.id})`,
    })
    .from(bookings)
    .where(
      and(
        gte(bookings.startsAt, since),
        // A deleted client's past visits (ADR-0051) suggest nothing: no rebooking, no pattern.
        sql`NOT EXISTS (SELECT 1 FROM ${clients} c WHERE c.id = ${bookings.clientId} AND c.deleted_at IS NOT NULL)`,
      ),
    )
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
        // Offered a freed time as a regular this week (S54): one marketing email a week at most.
        sql`NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.client_id = ${feedItems.clientId} AND o.source = 'regular' AND o.created_at > ${now}::timestamptz - make_interval(days => 7))`,
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

// The morning passes (S36 drafts, S38a briefing): each is due once a day at the business's
// local morning hour, tracked by its own column of `insight_runs`.

/** A once-a-day morning pass and the `insight_runs` column that says when it is due. */
export type MorningPass = 'drafts' | 'briefing';
const dueColumn = (pass: MorningPass) =>
  pass === 'drafts' ? insightRuns.draftsDueAt : insightRuns.briefingDueAt;
const dueSet = (pass: MorningPass, at: Date) =>
  pass === 'drafts' ? { draftsDueAt: at } : { briefingDueAt: at };

/** Records when the business's morning pass is due next. */
export async function setMorningDueAt(tx: TenantTx, pass: MorningPass, at: Date): Promise<void> {
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  await tx.update(insightRuns).set(dueSet(pass, at));
}

/**
 * Claims the business's morning pass when it is due at `now` (never run, or due), by moving its
 * due time to `next`: of two workers, only one gets `true`.
 */
export async function claimMorningRun(
  tx: TenantTx,
  pass: MorningPass,
  now: Date,
  next: Date,
): Promise<boolean> {
  await tx.insert(insightRuns).values({}).onConflictDoNothing({ target: insightRuns.tenantId });
  const column = dueColumn(pass);
  const rows = await tx
    .update(insightRuns)
    .set(dueSet(pass, next))
    .where(or(isNull(column), lte(column, now)))
    .returning({ id: insightRuns.id });
  return rows.length > 0;
}

/** When the business's morning pass is due (`null`: never run). */
export async function readMorningDueAt(tx: TenantTx, pass: MorningPass): Promise<Date | null> {
  const [row] = await tx.select({ at: dueColumn(pass) }).from(insightRuns);
  return row?.at ?? null;
}

/**
 * Up to `limit` businesses whose morning pass is due at `now`, across businesses (ids only):
 * never run, or due. The pass itself decides, in the business's time zone, whether its morning
 * hour has come.
 */
export async function listDueMorningRuns(
  db: Database,
  pass: MorningPass,
  now: Date,
  limit: number,
): Promise<TenantId[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const column = dueColumn(pass);
  const rows = await withJobScan(db, 'insights', (tx) =>
    tx
      .select({ tenantId: insightRuns.tenantId })
      .from(insightRuns)
      .where(or(isNull(column), lte(column, now)))
      .orderBy(sql`${column} ASC NULLS FIRST`, asc(insightRuns.tenantId))
      .limit(max),
  );
  return rows.map((row) => TenantIdSchema.parse(row.tenantId));
}

/** The drafts pass's due time (S36 names, kept for its callers). */
export const setDraftsDueAt = (tx: TenantTx, at: Date) => setMorningDueAt(tx, 'drafts', at);
export const claimDraftsRun = (tx: TenantTx, now: Date, next: Date) =>
  claimMorningRun(tx, 'drafts', now, next);
export const readDraftsDueAt = (tx: TenantTx) => readMorningDueAt(tx, 'drafts');
export const listDueDraftRuns = (db: Database, now: Date, limit: number) =>
  listDueMorningRuns(db, 'drafts', now, limit);

// ---------------------------------------------------------------------------------------------
// The daily briefing (S38a, ADR-0042): one item a local day for the business (owners and
// managers, `business:<tenant>`) and one for each staff member's own day (`staff:<id>`,
// addressed to them alone). Numbers only; the words are `feedLine`'s.

const BRIEFING = 'daily_briefing';

/** A briefing the morning pass wants to exist: the business's or one staff member's. */
export interface BriefingCandidate {
  /** `null`: the business's (owners and managers); else that staff member's own day. */
  staffMemberId: string | null;
  day: string;
  payload: DailyBriefingPayload;
  expiresAt: Date;
}

/**
 * Writes today's briefings: adds them, or brings an unread one up to date (a second run of the
 * same morning). One marked read (`closeFeedItem`, done) stays read. Returns how many were added.
 */
export async function writeBriefings(
  tx: TenantTx,
  candidates: readonly BriefingCandidate[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  const [tenant] = await tx.select({ id: tenants.id }).from(tenants);
  if (tenant === undefined) return 0;
  const values = candidates.map((candidate) => {
    const staffMemberId = nullableId(candidate.staffMemberId);
    const subjectKey =
      staffMemberId === null ? `business:${Id.parse(tenant.id)}` : `staff:${staffMemberId}`;
    const day = LocalDateSchema.parse(candidate.day);
    return {
      kind: BRIEFING,
      subjectKey,
      day,
      dedupeKey: `${BRIEFING}:${subjectKey}:${day}`,
      audienceStaffId: staffMemberId,
      staffMemberId,
      payload: DailyBriefingPayloadSchema.parse(candidate.payload),
      expiresAt: candidate.expiresAt,
    };
  });
  const written = await tx
    .insert(feedItems)
    .values(values)
    .onConflictDoUpdate({
      target: [feedItems.tenantId, feedItems.dedupeKey],
      set: { payload: sql`excluded.payload`, expiresAt: sql`excluded.expires_at` },
      setWhere: sql`${feedItems.status} = 'suggestion'`,
    })
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return written.filter((row) => row.inserted).length;
}

/**
 * Today's unread briefing for the transaction's member: the business's (`business`, owners and
 * managers) or their own day's (`own`, a staff member: the member scope shows them only theirs).
 */
export async function readBriefing(
  tx: TenantTx,
  scope: 'business' | 'own',
  now: Date,
): Promise<FeedItemWithNames | undefined> {
  const [row] = await tx
    .select({ item: feedItems, staffName: staffMembers.displayName })
    .from(feedItems)
    .leftJoin(staffMembers, eq(staffMembers.id, feedItems.staffMemberId))
    .where(
      and(
        eq(feedItems.kind, BRIEFING),
        eq(feedItems.status, 'suggestion'),
        gt(feedItems.expiresAt, now),
        scope === 'business'
          ? sql`${feedItems.subjectKey} LIKE 'business:%'`
          : sql`${feedItems.subjectKey} LIKE 'staff:%'`,
      ),
    )
    .orderBy(desc(feedItems.day), desc(feedItems.createdAt))
    .limit(1);
  return row === undefined
    ? undefined
    : { ...row.item, staffName: row.staffName, clientName: null, serviceName: null };
}

/** The business-wide numbers a briefing carries beside the day's schedule. */
export interface BriefingCounts {
  needsOk: number;
  rebookingDue: number;
}

/** Proposals waiting for an OK, and open "due back" suggestions, in the business now. */
export async function briefingCounts(tx: TenantTx, now: Date): Promise<BriefingCounts> {
  const [proposals] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiActionProposals)
    .where(and(eq(aiActionProposals.status, 'pending'), gt(aiActionProposals.expiresAt, now)));
  const [due] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(feedItems)
    .where(
      and(
        eq(feedItems.kind, 'rebooking_due'),
        inArray(feedItems.status, ['suggestion', 'needs_ok']),
        gt(feedItems.expiresAt, now),
      ),
    );
  return { needsOk: proposals?.count ?? 0, rebookingDue: due?.count ?? 0 };
}

/** A service's price and length, for Home's dollar estimates (S52). */
export interface FeedServicePrice {
  id: string;
  durationMinutes: number;
  priceFromCents: number | null;
  active: boolean;
}

/**
 * What Home's dollar estimates are read from (S52, ADR-0043): every service's "from" price and
 * length, and the "from" price of the bookings named (a no-show risk's visit). Bookings the
 * member may not see are simply missing.
 */
export async function readFeedPrices(
  tx: TenantTx,
  bookingIds: readonly string[],
): Promise<{ services: FeedServicePrice[]; bookingPrices: Map<string, number | null> }> {
  const ids = z
    .array(z.uuid())
    .max(200)
    .parse([...new Set(bookingIds)]);
  const serviceRows = await tx
    .select({
      id: services.id,
      durationMinutes: services.durationMinutes,
      priceFromCents: services.priceFromCents,
      active: services.active,
    })
    .from(services);
  const bookingRows =
    ids.length === 0
      ? []
      : await tx
          .select({ id: bookings.id, priceFromCents: bookings.priceFromCents })
          .from(bookings)
          .where(inArray(bookings.id, ids));
  return {
    services: serviceRows,
    bookingPrices: new Map(bookingRows.map((row) => [row.id, row.priceFromCents])),
  };
}

/**
 * Whether the business has booking history (S52, ADR-0043): a visit that started before `now`
 * and wasn't cancelled (imported history counts). Until then Home's board stays quiet.
 */
export async function hasBookingHistory(tx: TenantTx, now: Date): Promise<boolean> {
  const [row] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(lt(bookings.startsAt, now), ne(bookings.status, 'cancelled')))
    .limit(1);
  return row !== undefined;
}

// ---------------------------------------------------------------------------------------------
// The calendar's note (S71.2, ADR-0069 §11, AC-X-176): a change made in Google to a Pepper
// booking was put back. Addressed to the booking's staff member (owners and managers see it too);
// one per booking and its day: a later change while it is open updates it, a dismissed one stays
// dismissed. Ids and the change only; the names are read with it.

const CALENDAR_KEPT = 'calendar_kept';

export interface CalendarKeptNote {
  bookingId: string;
  staffMemberId: string;
  clientId: string;
  serviceId: string;
  /** The booking's local day. */
  day: string;
  payload: CalendarKeptPayload;
  expiresAt: Date;
}

export async function writeCalendarKeptNote(tx: TenantTx, note: CalendarKeptNote): Promise<void> {
  const bookingId = Id.parse(note.bookingId);
  const day = LocalDateSchema.parse(note.day);
  const subjectKey = `booking:${bookingId}`;
  await tx
    .insert(feedItems)
    .values({
      kind: CALENDAR_KEPT,
      subjectKey,
      day,
      dedupeKey: `${CALENDAR_KEPT}:${subjectKey}:${day}`,
      audienceStaffId: Id.parse(note.staffMemberId),
      staffMemberId: Id.parse(note.staffMemberId),
      clientId: Id.parse(note.clientId),
      serviceId: Id.parse(note.serviceId),
      bookingId,
      payload: CalendarKeptPayloadSchema.parse(note.payload),
      expiresAt: note.expiresAt,
    })
    .onConflictDoUpdate({
      target: [feedItems.tenantId, feedItems.dedupeKey],
      set: { payload: sql`excluded.payload`, expiresAt: sql`excluded.expires_at` },
      setWhere: sql`${feedItems.status} = 'suggestion'`,
    });
}

// ---------------------------------------------------------------------------------------------
// A client's text (S80, ADR-0072, AC-X-232): one card per client and local day, for owners and
// managers (no audience staff member). A later text that day updates it and opens it again, even
// after it was done or dismissed: a new text is new. Ids and counts only; the words stay in
// `client_texts` and are read with the card.

/** The stored payload with the text's words, for a client's text card; others as they are. */
function withTextBody(kind: string, payload: unknown, body: string | null): unknown {
  if (kind !== CLIENT_TEXT || body === null || typeof payload !== 'object' || payload === null) {
    return payload;
  }
  return { ...payload, body };
}

export interface ClientTextCard {
  clientId: string;
  /** The client's local day the text came. */
  day: string;
  textId: string;
  receivedAt: Date;
  /** How many texts the client sent that day. */
  count: number;
  /** The client's next visit, if one is booked. */
  nextVisit: {
    bookingId: string;
    staffMemberId: string;
    serviceId: string;
    startsAt: Date;
  } | null;
  expiresAt: Date;
}

export async function writeClientTextCard(tx: TenantTx, card: ClientTextCard): Promise<void> {
  const clientId = Id.parse(card.clientId);
  const day = LocalDateSchema.parse(card.day);
  const subjectKey = `client:${clientId}`;
  const next = card.nextVisit;
  await tx
    .insert(feedItems)
    .values({
      kind: CLIENT_TEXT,
      subjectKey,
      day,
      dedupeKey: `${CLIENT_TEXT}:${subjectKey}:${day}`,
      audienceStaffId: null,
      clientId,
      bookingId: next === null ? null : Id.parse(next.bookingId),
      staffMemberId: next === null ? null : Id.parse(next.staffMemberId),
      serviceId: next === null ? null : Id.parse(next.serviceId),
      payload: ClientTextPayloadSchema.parse({
        textId: card.textId,
        receivedAt: card.receivedAt.toISOString(),
        count: card.count,
        nextVisitStartsAt: next === null ? null : next.startsAt.toISOString(),
      }),
      expiresAt: card.expiresAt,
    })
    .onConflictDoUpdate({
      target: [feedItems.tenantId, feedItems.dedupeKey],
      set: {
        payload: sql`excluded.payload`,
        expiresAt: sql`excluded.expires_at`,
        bookingId: sql`excluded.booking_id`,
        staffMemberId: sql`excluded.staff_member_id`,
        serviceId: sql`excluded.service_id`,
        status: 'suggestion',
        actedAt: null,
        snoozedUntil: null,
      },
    });
}

/**
 * Says on the card what was done with its text once read (S81a.2, AC-X-247), and moves it to the
 * visit the text was about (`visit`; `undefined`: the one it names stays). Only while the card's
 * latest text is still `textId`: a newer text has a card of its own to say. Whether it changed.
 */
export async function setClientTextCardOutcome(
  tx: TenantTx,
  input: {
    textId: string;
    outcome: ClientTextCardOutcome;
    visit?: { bookingId: string; staffMemberId: string; serviceId: string; startsAt: Date };
  },
): Promise<boolean> {
  const textId = Id.parse(input.textId);
  const [row] = await tx
    .select({ id: feedItems.id, payload: feedItems.payload })
    .from(feedItems)
    .where(and(eq(feedItems.kind, CLIENT_TEXT), sql`${feedItems.payload}->>'textId' = ${textId}`))
    .for('update');
  if (row === undefined) return false;
  const payload = ClientTextPayloadSchema.parse(row.payload);
  const visit = input.visit;
  await tx
    .update(feedItems)
    .set({
      payload: ClientTextPayloadSchema.parse({
        ...payload,
        outcome: ClientTextCardOutcomeSchema.parse(input.outcome),
        ...(visit !== undefined && { nextVisitStartsAt: visit.startsAt.toISOString() }),
      }),
      ...(visit !== undefined && {
        bookingId: Id.parse(visit.bookingId),
        staffMemberId: Id.parse(visit.staffMemberId),
        serviceId: Id.parse(visit.serviceId),
      }),
    })
    .where(eq(feedItems.id, row.id));
  return true;
}

/** Opens a client's text card again (its reply was taken back, S80): `id` only, if it is done. */
export async function reopenClientTextCard(tx: TenantTx, id: string): Promise<void> {
  await tx
    .update(feedItems)
    .set({ status: 'suggestion', actedAt: null })
    .where(
      and(
        eq(feedItems.id, Id.parse(id)),
        eq(feedItems.kind, CLIENT_TEXT),
        eq(feedItems.status, 'done'),
      ),
    );
}
