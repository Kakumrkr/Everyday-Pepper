import { FeedItemIdSchema, type FeedItemId } from '@pepper/contracts';
import { and, desc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aiActionProposals, clients, feedItems, waitlistOffers } from '../schema.js';
import { NUDGE_ACTION, nudgeTargetKey } from './feed.js';
import type { TenantTx } from '../tenant.js';

// "Haven't been back" (S54.2, ADR-0057): what the list and its one-tap draft read about the
// clients the win-back rule found. The rule itself is pure (`findWinBack` in appointments);
// here are only the clients' reach and their recent marketing email.

const Id = z.uuid();
/** The idempotency keys of win-back drafts: `winback.<clientId>.<local day>`. */
export const WIN_BACK_KEY_PREFIX = 'winback.';

export interface WinBackClientRow {
  id: string;
  name: string;
  hasEmail: boolean;
  optedOut: boolean;
  /** A nudge waiting for an OK (the win-back's or the morning pass's). */
  pendingProposalId: string | null;
  /** The latest nudge (not superseded) or regular's offer since `quietSince`. */
  emailedAt: Date | null;
}

/**
 * The clients among `clientIds` who are not deleted, with whether they can be emailed, a
 * pending nudge, and their latest nudge (any status but superseded: one waiting, sent, turned
 * down or expired all count, as for the morning pass) since `nudgeQuietSince` or regular's
 * offer since `offerQuietSince`.
 */
export async function readWinBackClients(
  tx: TenantTx,
  clientIds: readonly string[],
  quiet: { nudgeSince: Date; offerSince: Date },
): Promise<WinBackClientRow[]> {
  const ids = z
    .array(Id)
    .max(5_000)
    .parse([...new Set(clientIds)]);
  if (ids.length === 0) return [];
  const target = sql`'nudge:client:' || ${clients.id}::text`;
  const rows = await tx
    .select({
      id: clients.id,
      name: clients.name,
      hasEmail: sql<boolean>`${clients.email} IS NOT NULL`,
      optedOut: sql<boolean>`${clients.emailOptOutAt} IS NOT NULL`,
      pendingProposalId: sql<
        string | null
      >`(SELECT p.id FROM ${aiActionProposals} p WHERE p.action = ${NUDGE_ACTION} AND p.target_key = ${target} AND p.status = 'pending' LIMIT 1)`,
      nudgedAt: sql<
        string | null
      >`(SELECT max(p.created_at) FROM ${aiActionProposals} p WHERE p.action = ${NUDGE_ACTION} AND p.target_key = ${target} AND p.status <> 'superseded' AND p.created_at > ${quiet.nudgeSince.toISOString()}::timestamptz)`,
      offeredAt: sql<
        string | null
      >`(SELECT max(o.created_at) FROM ${waitlistOffers} o WHERE o.client_id = ${clients.id} AND o.source = 'regular' AND o.created_at > ${quiet.offerSince.toISOString()}::timestamptz)`,
    })
    .from(clients)
    .where(and(inArray(clients.id, ids), isNull(clients.deletedAt)));
  return rows.map((row) => {
    const times = [row.nudgedAt, row.offeredAt]
      .filter((each): each is string => each !== null)
      .map((each) => new Date(each).getTime());
    return {
      id: row.id,
      name: row.name,
      hasEmail: row.hasEmail,
      optedOut: row.optedOut,
      pendingProposalId: row.pendingProposalId,
      emailedAt: times.length === 0 ? null : new Date(Math.max(...times)),
    };
  });
}

/** How many win-back drafts the business made since `since` (its local midnight). */
export async function countWinBackDraftsSince(tx: TenantTx, since: Date): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(aiActionProposals)
    .where(
      and(
        like(aiActionProposals.idempotencyKey, `${WIN_BACK_KEY_PREFIX}%`),
        gt(aiActionProposals.createdAt, since),
      ),
    );
  return row?.count ?? 0;
}

/** The client's open `rebooking_due` suggestion, if the feed has one (linked to the draft). */
export async function findOpenRebookingItemOf(
  tx: TenantTx,
  clientId: string,
  now: Date,
): Promise<FeedItemId | undefined> {
  const [row] = await tx
    .select({ id: feedItems.id })
    .from(feedItems)
    .where(
      and(
        eq(feedItems.kind, 'rebooking_due'),
        eq(feedItems.status, 'suggestion'),
        eq(feedItems.clientId, Id.parse(clientId)),
        gt(feedItems.expiresAt, now),
      ),
    )
    .orderBy(desc(feedItems.day))
    .limit(1);
  return row === undefined ? undefined : FeedItemIdSchema.parse(row.id);
}

/** The target key a win-back draft shares with the rebooking nudge (one pending per client). */
export const winBackTargetKey = nudgeTargetKey;
