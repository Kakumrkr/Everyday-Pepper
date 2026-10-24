import {
  FEED_ASK_TO_TURN_OFF,
  FeedCloseSchema,
  FeedInsightKindSchema,
  FeedItemIdSchema,
  FeedItemSchema,
  FeedSettingsChangeSchema,
  type FeedClose,
  type FeedInsightKind,
  type FeedItem,
  type FeedItemId,
  type FeedResponse,
  type FeedSettings,
  type FeedSettingsChange,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  closeFeedItem as closeFeedItemRow,
  countDismissals,
  findCurrentTenant,
  listOpenFeedItems,
  readFeedSettings,
  requestInsightRun,
  updateCurrentTenantMailingAddress,
  withMember,
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

// The operator feed for a member (Phase 8, ADR-0039): the open suggestions the insights pass
// wrote, with names added (the database's member scope shows staff only the items addressed
// to them, and only the client names they may see), dismiss and done, and the business's
// switches. "Needs your OK" and "Done for you" stay the trust layer's proposals and receipts
// (`/v1/ai/proposals`, `/v1/ai/actions`); the home screen shows the three together.

const DAY_MS = 86_400_000;

export interface FeedOptions {
  clock?: Clock;
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
  return withMember(db, actor.context, async (tx) => {
    const stored = await readFeedSettings(tx);
    // Kinds turned off are left out by the query, so they never take the feed's places.
    const rows = stored.suggestionsPaused
      ? []
      : await listOpenFeedItems(tx, now, 50, { excludeKinds: stored.disabledKinds });
    return {
      suggestions: rows.flatMap((row) => toFeedItem(row) ?? []),
      settings: publicSettings(stored),
      canChangeSettings,
      askToTurnOff: canChangeSettings ? await kindToAskAbout(tx, stored, now) : null,
      mailingAddress: canChangeSettings
        ? ((await findCurrentTenant(tx))?.mailingAddress ?? null)
        : null,
    };
  });
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
 * Changes the business's feed switches and the mailing address its rebooking emails carry
 * (owners and managers), with an audit entry (the address only as set or not: it may be a
 * home address).
 */
export async function changeFeedSettings(
  db: Database,
  actor: Actor,
  change: FeedSettingsChange,
): Promise<FeedSettings> {
  requirePermission(actor, 'settings.manage');
  const parsed = FeedSettingsChangeSchema.parse(change);
  return withMember(db, actor.context, async (tx) => {
    if (parsed.mailingAddress !== undefined) {
      const tenant = await findCurrentTenant(tx);
      const before = tenant?.mailingAddress ?? null;
      if (before !== parsed.mailingAddress) {
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
    const before = await readFeedSettings(tx);
    const after: StoredFeedSettings = {
      suggestionsPaused: parsed.suggestionsPaused ?? before.suggestionsPaused,
      disabledKinds: parsed.disabledKinds ?? before.disabledKinds,
      answeredKinds:
        parsed.askAnswered === undefined || before.answeredKinds.includes(parsed.askAnswered)
          ? before.answeredKinds
          : [...before.answeredKinds, parsed.askAnswered],
    };
    await writeFeedSettings(tx, after);
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

function publicSettings(stored: StoredFeedSettings): FeedSettings {
  return {
    suggestionsPaused: stored.suggestionsPaused,
    disabledKinds: [...stored.disabledKinds].sort(),
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
