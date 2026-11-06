import {
  FEED_ASK_TO_TURN_OFF,
  FeedCloseManySchema,
  FeedCloseSchema,
  FeedInsightKindSchema,
  FeedItemIdSchema,
  FeedItemSchema,
  FeedSettingsChangeSchema,
  type FeedBoardItem,
  fromZoned,
  PLATFORM_DRAFTS,
  TemplateIdSchema,
  toZoned,
  type FeedClose,
  type FeedCloseMany,
  type FeedInsightKind,
  type FeedItem,
  type FeedItemId,
  type FeedResponse,
  type FeedSettings,
  type FeedSettingsChange,
  type TemplateId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  closeFeedItem as closeFeedItemRow,
  countDismissals,
  findCurrentTenant,
  hasBookingHistory,
  listOpenFeedItems,
  listWaitingFeedItems,
  readBriefing,
  readFeedPrices,
  readFeedSettings,
  readMorningDueAt,
  setMorningDueAt,
  requestInsightRun,
  updateCurrentTenantMailingAddress,
  updateCurrentTenantReviewUrl,
  withMember,
  withTenant,
  writeFeedSettings,
  type Database,
  type FeedItemWithNames,
  type StoredFeedSettings,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import { FeedItemNotFoundError } from '../errors.js';
import { can } from '../permissions.js';
import { feedValueCents, pricePerMinute } from './feed-value.js';

// The operator feed for a member (Phase 8, ADR-0039): the open suggestions the insights pass
// wrote, with names added (the database's member scope shows staff only the items addressed
// to them, and only the client names they may see), dismiss and done, and the business's
// switches. "Needs your OK" and "Done for you" stay the trust layer's proposals and receipts
// (`/v1/ai/proposals`, `/v1/ai/actions`); the home screen shows the three together.

const DAY_MS = 86_400_000;

export interface FeedOptions {
  clock?: Clock;
  /** The template's morning hour (the api passes `templateDrafts`; L1 never imports L3). */
  morningHourOf?: (templateId: TemplateId | null) => number;
}

/** The member's feed: suggestions (none while paused), switches and the ask-once question. */
export async function getFeed(
  db: Database,
  actor: Actor,
  options: FeedOptions = {},
): Promise<FeedResponse> {
  requirePermission(actor, 'feed.read');
  const now = new Date((options.clock ?? systemClock).now());
  const canChangeSettings = can(actor.context, 'settings.manage');
  // The board stays quiet until the business has booking history (S52, ADR-0043): a new
  // business's whole open week isn't news. The business's, not only what a staff member's
  // scope shows: a yes or no that names nothing.
  // Read beside the member's transaction, not before it (Home is the hottest screen).
  const historyRead = withTenant(db, actor.context.tenantId, (tx) => hasBookingHistory(tx, now));
  // Handled here too, so a failure while the member's transaction fails first isn't unhandled.
  historyRead.catch(() => undefined);
  return withMember(db, actor.context, async (tx) => {
    const stored = await readFeedSettings(tx);
    const history = await historyRead;
    // Kinds turned off are left out by the query, so they never take the feed's places.
    const rows =
      stored.suggestionsPaused || !history
        ? []
        : await listOpenFeedItems(tx, now, 50, { excludeKinds: stored.disabledKinds });
    const suggestions = await priced(
      tx,
      rows.flatMap((row) => toFeedItem(row) ?? []),
    );
    const tenant = await findCurrentTenant(tx);
    const briefing = await readBriefing(tx, canChangeSettings ? 'business' : 'own', now);
    const templateId = TemplateIdSchema.nullable()
      .catch(null)
      .parse(tenant?.templateId ?? null);
    return {
      suggestions,
      hasBookingHistory: history,
      briefing: briefing === undefined ? null : (toFeedItem(briefing) ?? null),
      settings: publicSettings(stored),
      templateMorningHour: (options.morningHourOf ?? (() => PLATFORM_DRAFTS.morningHour))(
        templateId,
      ),
      canChangeSettings,
      askToTurnOff: canChangeSettings ? await kindToAskAbout(tx, stored, now) : null,
      mailingAddress: canChangeSettings ? (tenant?.mailingAddress ?? null) : null,
      reviewUrl: canChangeSettings ? (tenant?.reviewUrl ?? null) : null,
    };
  });
}

/**
 * The feed as the AI reads it for the member (S36, `get_feed`), in the tool's transaction: the
 * open suggestions and the items waiting on a proposal ("Needs your OK"), each limited by the
 * database's member scope, none while suggestions are paused, kinds turned off left out.
 */
export async function feedForAiIn(
  tx: TenantTx,
  actor: Actor,
  now: Date,
  options: { kind?: FeedInsightKind; limit?: number } = {},
): Promise<{
  paused: boolean;
  briefing: FeedItem | null;
  suggestions: FeedItem[];
  waiting: FeedItem[];
}> {
  requirePermission(actor, 'feed.read');
  const stored = await readFeedSettings(tx);
  // Today's briefing, also while paused (it only informs): the business's for owners and
  // managers, the member's own day for staff.
  const read = await readBriefing(
    tx,
    can(actor.context, 'settings.manage') ? 'business' : 'own',
    now,
  );
  const briefing = read === undefined ? null : (toFeedItem(read) ?? null);
  if (stored.suggestionsPaused) return { paused: true, briefing, suggestions: [], waiting: [] };
  const limit = options.limit ?? 20;
  const wanted = (row: FeedItemWithNames) =>
    !(stored.disabledKinds as readonly string[]).includes(row.kind) &&
    (options.kind === undefined || row.kind === options.kind);
  const [open, waiting] = [
    await listOpenFeedItems(tx, now, 50, { excludeKinds: stored.disabledKinds }),
    await listWaitingFeedItems(tx, 50),
  ];
  const items = (rows: FeedItemWithNames[]) =>
    rows
      .filter(wanted)
      .slice(0, limit)
      .flatMap((row) => toFeedItem(row) ?? []);
  return { paused: false, briefing, suggestions: items(open), waiting: items(waiting) };
}

/** Dismisses (snoozing that kind for that subject for 30 days) or marks done an open item. */
export async function closeFeedItem(
  db: Database,
  actor: Actor,
  id: FeedItemId,
  close: FeedClose,
  options: FeedOptions = {},
): Promise<void> {
  requirePermission(actor, 'feed.read');
  const itemId = FeedItemIdSchema.parse(id);
  const { outcome } = FeedCloseSchema.parse(close);
  const now = new Date((options.clock ?? systemClock).now());
  await withMember(db, actor.context, async (tx) => {
    const closed = await closeFeedItemRow(tx, itemId, outcome, now);
    if (closed === undefined) throw new FeedItemNotFoundError();
  });
}

/**
 * Closes a grouped card's open items together (S52): in one transaction at one moment, so
 * "Dismiss all" is one dismissal. Items already closed or not the member's are skipped; none
 * left to close is `FeedItemNotFoundError`.
 */
export async function closeFeedItems(
  db: Database,
  actor: Actor,
  close: FeedCloseMany,
  options: FeedOptions = {},
): Promise<number> {
  requirePermission(actor, 'feed.read');
  const { ids, outcome } = FeedCloseManySchema.parse(close);
  const now = new Date((options.clock ?? systemClock).now());
  return withMember(db, actor.context, async (tx) => {
    let closed = 0;
    for (const id of ids) {
      if ((await closeFeedItemRow(tx, id, outcome, now)) !== undefined) closed += 1;
    }
    if (closed === 0) throw new FeedItemNotFoundError();
    return closed;
  });
}

/**
 * Changes the business's feed switches, the mailing address its rebooking emails carry and the
 * link its review requests give (owners and managers), with an audit entry (the address and the
 * link only as set or not: the address may be a home).
 */
export async function changeFeedSettings(
  db: Database,
  actor: Actor,
  change: FeedSettingsChange,
  options: Pick<FeedOptions, 'morningHourOf' | 'clock'> = {},
): Promise<FeedSettings> {
  requirePermission(actor, 'settings.manage');
  const parsed = FeedSettingsChangeSchema.parse(change);
  return withMember(db, actor.context, async (tx) => {
    // The address or the review link set for the first time (S56a): today's drafts pass is due
    // again, so this morning's thank-yous and nudges come now rather than tomorrow. Its own
    // checks (the 90 days, one nudge per regular a day) keep a second run from repeating one.
    let rearm = false;
    if (parsed.mailingAddress !== undefined) {
      const tenant = await findCurrentTenant(tx);
      const before = tenant?.mailingAddress ?? null;
      if (before !== parsed.mailingAddress) {
        if (before === null) rearm = true;
        await updateCurrentTenantMailingAddress(tx, parsed.mailingAddress);
        await appendAuditEntry(tx, {
          actor: auditActorOf(actor),
          change: {
            action: 'tenant.updated',
            entity: { type: 'tenant', id: actor.context.tenantId },
            before: { mailingAddressSet: before !== null },
            after: { mailingAddressSet: parsed.mailingAddress !== null },
          },
          requestId: actor.requestId,
        });
      }
    }
    if (parsed.reviewUrl !== undefined) {
      const tenant = await findCurrentTenant(tx);
      const before = tenant?.reviewUrl ?? null;
      if (before !== parsed.reviewUrl) {
        if (before === null) rearm = true;
        await updateCurrentTenantReviewUrl(tx, parsed.reviewUrl);
        await appendAuditEntry(tx, {
          actor: auditActorOf(actor),
          change: {
            action: 'tenant.updated',
            entity: { type: 'tenant', id: actor.context.tenantId },
            before: { reviewUrlSet: before !== null },
            after: { reviewUrlSet: parsed.reviewUrl !== null },
          },
          requestId: actor.requestId,
        });
      }
    }
    if (rearm) {
      await setMorningDueAt(tx, 'drafts', new Date((options.clock ?? systemClock).now()));
    }
    const before = await readFeedSettings(tx);
    const after: StoredFeedSettings = {
      suggestionsPaused: parsed.suggestionsPaused ?? before.suggestionsPaused,
      disabledKinds: parsed.disabledKinds ?? before.disabledKinds,
      morningHour: parsed.morningHour === undefined ? before.morningHour : parsed.morningHour,
      answeredKinds:
        parsed.askAnswered === undefined || before.answeredKinds.includes(parsed.askAnswered)
          ? before.answeredKinds
          : [...before.answeredKinds, parsed.askAnswered],
    };
    await writeFeedSettings(tx, after);
    if (after.morningHour !== before.morningHour) {
      await moveMorningRuns(tx, after.morningHour, options.morningHourOf);
    }
    const [was, is] = [publicSettings(before), publicSettings(after)];
    if (JSON.stringify(was) !== JSON.stringify(is)) {
      // On again, or a kind back on: the feed is computed again at once, not within the hour.
      await requestInsightRun(tx);
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'feed.settings_updated',
          entity: { type: 'tenant', id: actor.context.tenantId },
          before: was,
          after: is,
        },
        requestId: actor.requestId,
      });
    }
    return is;
  });
}

/**
 * A new morning hour takes effect at once (S38a code review): each pass's next due time keeps
 * its local day and takes the new hour, so a pass not yet run today runs at the new hour, and
 * one already run today still waits for tomorrow.
 */
async function moveMorningRuns(
  tx: TenantTx,
  own: number | null,
  morningHourOf: FeedOptions['morningHourOf'],
): Promise<void> {
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) return;
  const templateId = TemplateIdSchema.nullable().catch(null).parse(tenant.templateId);
  const hour = own ?? (morningHourOf ?? (() => PLATFORM_DRAFTS.morningHour))(templateId);
  for (const pass of ['drafts', 'briefing'] as const) {
    const due = await readMorningDueAt(tx, pass);
    if (due === null) continue;
    const day = toZoned(tenant.timeZone, due.getTime());
    await setMorningDueAt(tx, pass, new Date(fromZoned(tenant.timeZone, day, hour * 60)));
  }
}

function publicSettings(stored: StoredFeedSettings): FeedSettings {
  return {
    suggestionsPaused: stored.suggestionsPaused,
    disabledKinds: [...stored.disabledKinds].sort(),
    morningHour: stored.morningHour,
  };
}

/** The first kind still on and not yet asked about that was dismissed often lately. */
async function kindToAskAbout(
  tx: TenantTx,
  stored: StoredFeedSettings,
  now: Date,
): Promise<FeedInsightKind | null> {
  const since = new Date(now.getTime() - FEED_ASK_TO_TURN_OFF.withinDays * DAY_MS);
  for (const kind of FeedInsightKindSchema.options) {
    if (stored.disabledKinds.includes(kind) || stored.answeredKinds.includes(kind)) continue;
    if ((await countDismissals(tx, kind, since)) >= FEED_ASK_TO_TURN_OFF.dismissals) return kind;
  }
  return null;
}

/** The items with their dollars at stake, from the business's prices (S52). */
async function priced(tx: TenantTx, items: FeedItem[]): Promise<FeedBoardItem[]> {
  if (items.length === 0) return [];
  const prices = await readFeedPrices(
    tx,
    items.flatMap((item) => (item.subjects.bookingId === null ? [] : [item.subjects.bookingId])),
  );
  const rate = pricePerMinute(prices.services);
  return items.map((item) => ({ ...item, valueCents: feedValueCents(item, prices, rate) }));
}

/** The row as the api returns it; `undefined` for a row whose payload no longer parses. */
function toFeedItem(row: FeedItemWithNames): FeedItem | undefined {
  const parsed = FeedItemSchema.safeParse({
    id: row.id,
    status: row.status,
    day: row.day,
    kind: row.kind,
    payload: row.payload,
    subjects: {
      staffMemberId: row.staffMemberId,
      clientId: row.clientId,
      bookingId: row.bookingId,
      serviceId: row.serviceId,
    },
    names: { staff: row.staffName, client: row.clientName, service: row.serviceName },
    proposalId: row.actionProposalId,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}
