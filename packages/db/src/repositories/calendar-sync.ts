import {
  CalendarProviderSchema,
  CalendarSyncErrorSchema,
  TenantIdSchema,
  type CalendarProvider,
  type CalendarSyncError,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  calendarBusyBlocks,
  calendarConnections,
  calendarConnectStates,
  type CalendarBusyBlockRow,
  type CalendarConnectionRow,
  type CalendarConnectStateRow,
  staffMembers,
  type StaffMemberRow,
} from '../schema.js';
import type { Database } from '../client.js';
import { withJobScan, type TenantTx } from '../tenant.js';

// Google Calendar in (S70, ADR-0069): connections, one-time connect states and busy blocks.
// Every function but the scan runs in the business's transaction (RLS keeps it to its rows).
// Tokens arrive and leave sealed: this file never sees one in the clear.

const Id = z.uuid();

export interface NewConnectState {
  staffMemberId: string;
  membershipId: string;
  stateHash: Buffer;
  verifierSealed: Buffer;
  expiresAt: Date;
}

/**
 * Stores a connect state, replacing the staff member's earlier one (one in flight at a time; two
 * taps at once leave the later), and removes the business's expired ones.
 */
export async function replaceConnectState(
  tx: TenantTx,
  input: NewConnectState,
  now: Date,
): Promise<void> {
  const values = {
    staffMemberId: Id.parse(input.staffMemberId),
    membershipId: Id.parse(input.membershipId),
    stateHash: input.stateHash,
    verifierSealed: input.verifierSealed,
    expiresAt: input.expiresAt,
  };
  await tx.delete(calendarConnectStates).where(lt(calendarConnectStates.expiresAt, now));
  await tx
    .insert(calendarConnectStates)
    .values(values)
    .onConflictDoUpdate({
      target: [calendarConnectStates.tenantId, calendarConnectStates.staffMemberId],
      set: {
        membershipId: values.membershipId,
        stateHash: values.stateHash,
        verifierSealed: values.verifierSealed,
        expiresAt: values.expiresAt,
        createdAt: sql`now()`,
      },
    });
}

/** Takes a connect state by its hash, once: it is deleted whether or not it is still valid. */
export async function takeConnectState(
  tx: TenantTx,
  stateHash: Buffer,
): Promise<CalendarConnectStateRow | undefined> {
  const [row] = await tx
    .delete(calendarConnectStates)
    .where(eq(calendarConnectStates.stateHash, stateHash))
    .returning();
  return row;
}

/** The staff member a membership is linked to, if any (who may connect a calendar). */
export async function findStaffMemberOfMembership(
  tx: TenantTx,
  membershipId: string,
): Promise<StaffMemberRow | undefined> {
  const [row] = await tx
    .select()
    .from(staffMembers)
    .where(eq(staffMembers.membershipId, Id.parse(membershipId)));
  return row;
}

export async function findCalendarConnectionOfStaff(
  tx: TenantTx,
  staffMemberId: StaffMemberId,
): Promise<CalendarConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.staffMemberId, Id.parse(staffMemberId)));
  return row;
}

export async function findCalendarConnection(
  tx: TenantTx,
  id: string,
): Promise<CalendarConnectionRow | undefined> {
  const [row] = await tx
    .select()
    .from(calendarConnections)
    .where(eq(calendarConnections.id, Id.parse(id)));
  return row;
}

/** The connections of these staff members (the team page's status), by staff member. */
export async function listCalendarConnectionsOf(
  tx: TenantTx,
  staffMemberIds: readonly StaffMemberId[],
): Promise<CalendarConnectionRow[]> {
  if (staffMemberIds.length === 0) return [];
  return tx
    .select()
    .from(calendarConnections)
    .where(
      inArray(
        calendarConnections.staffMemberId,
        staffMemberIds.map((id) => Id.parse(id)),
      ),
    )
    .orderBy(asc(calendarConnections.staffMemberId));
}

export interface ConnectionTokens {
  /** The row's id, chosen before sealing: the tokens are bound to it. */
  id: string;
  staffMemberId: string;
  membershipId: string;
  provider: CalendarProvider;
  accountEmail: string;
  refreshTokenSealed: Buffer;
  accessTokenSealed: Buffer;
  accessTokenExpiresAt: Date;
  createdBy: string;
  /** Now: when it was connected (a reconnect moves it). */
  connectedAt: Date;
}

/**
 * Stores a new connection, or a reconnection of the staff member's existing one (`id` is then
 * that row's): connected again, the new tokens, the error cleared, the generation raised (so a
 * read still holding the old grant writes nothing). A connection made by another request in
 * between fails on the staff member's unique index.
 */
export async function saveCalendarConnection(
  tx: TenantTx,
  input: ConnectionTokens,
  existing: boolean,
): Promise<CalendarConnectionRow> {
  const values = {
    membershipId: Id.parse(input.membershipId),
    provider: CalendarProviderSchema.parse(input.provider),
    accountEmail: input.accountEmail,
    status: 'connected',
    refreshTokenSealed: input.refreshTokenSealed,
    accessTokenSealed: input.accessTokenSealed,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    lastError: null,
    attemptedAt: null,
    connectedAt: input.connectedAt,
    createdBy: Id.parse(input.createdBy),
  };
  const [row] = existing
    ? await tx
        .update(calendarConnections)
        .set({ ...values, generation: sql`${calendarConnections.generation} + 1` })
        .where(
          and(
            eq(calendarConnections.id, Id.parse(input.id)),
            eq(calendarConnections.staffMemberId, Id.parse(input.staffMemberId)),
          ),
        )
        .returning()
    : await tx
        .insert(calendarConnections)
        .values({ ...values, id: Id.parse(input.id), staffMemberId: Id.parse(input.staffMemberId) })
        .returning();
  if (row === undefined) throw new Error('The calendar connection was not stored');
  return row;
}

/** Removes a connection; its busy blocks go with it (cascade). */
export async function deleteCalendarConnection(
  tx: TenantTx,
  id: string,
): Promise<CalendarConnectionRow | undefined> {
  const [row] = await tx
    .delete(calendarConnections)
    .where(eq(calendarConnections.id, Id.parse(id)))
    .returning();
  return row;
}

export interface DueCalendarConnection {
  tenantId: TenantId;
  connectionId: string;
}

/**
 * Connected calendars whose last try is older than `everyMs`, the longest waiting first
 * (`job_scan('calendar')`: ids only). One that needs reconnecting waits for its member.
 */
export async function listDueCalendarConnections(
  db: Database,
  now: Date,
  everyMs: number,
  limit: number,
): Promise<DueCalendarConnection[]> {
  const max = z.number().int().min(1).max(1000).parse(limit);
  const before = new Date(now.getTime() - z.number().int().min(1).parse(everyMs));
  const rows = await withJobScan(db, 'calendar', (tx) =>
    tx
      .select({ id: calendarConnections.id, tenantId: calendarConnections.tenantId })
      .from(calendarConnections)
      .where(
        and(
          eq(calendarConnections.status, 'connected'),
          or(isNull(calendarConnections.attemptedAt), lte(calendarConnections.attemptedAt, before)),
        ),
      )
      .orderBy(sql`${calendarConnections.attemptedAt} ASC NULLS FIRST`, asc(calendarConnections.id))
      .limit(max),
  );
  return rows.map((row) => ({
    tenantId: TenantIdSchema.parse(row.tenantId),
    connectionId: row.id,
  }));
}

/**
 * Claims a connected calendar for one read: marks the try, so another worker skips it.
 * `undefined` when it isn't due (another worker took it), or isn't connected. `force` claims a
 * connected one whatever its last try (the first read right after connecting).
 */
export async function claimCalendarConnection(
  tx: TenantTx,
  id: string,
  now: Date,
  everyMs: number,
  force = false,
): Promise<CalendarConnectionRow | undefined> {
  const before = new Date(now.getTime() - everyMs);
  const [row] = await tx
    .update(calendarConnections)
    .set({ attemptedAt: now })
    .where(
      and(
        eq(calendarConnections.id, Id.parse(id)),
        eq(calendarConnections.status, 'connected'),
        force
          ? undefined
          : or(
              isNull(calendarConnections.attemptedAt),
              lte(calendarConnections.attemptedAt, before),
            ),
      ),
    )
    .returning();
  return row;
}

/** Which connection a read claimed: its id and the generation it read the tokens of. */
export interface ClaimedConnection {
  id: string;
  generation: number;
}

function sameGrant(claimed: ClaimedConnection) {
  return and(
    eq(calendarConnections.id, Id.parse(claimed.id)),
    eq(calendarConnections.generation, z.number().int().min(1).parse(claimed.generation)),
  );
}

/** Keeps a fresh access token (sealed) and when it expires, unless reconnected meanwhile. */
export async function storeAccessToken(
  tx: TenantTx,
  claimed: ClaimedConnection,
  sealed: Buffer,
  expiresAt: Date,
): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ accessTokenSealed: sealed, accessTokenExpiresAt: expiresAt })
    .where(sameGrant(claimed));
}

/**
 * Replaces a connection's busy blocks with one read's (start and end only) and records it worked.
 * Only while still connected with the grant read: a connection removed, refused or reconnected
 * meanwhile keeps what it has.
 */
export async function storeCalendarRead(
  tx: TenantTx,
  connection: Pick<CalendarConnectionRow, 'id' | 'staffMemberId' | 'generation'>,
  blocks: readonly { start: number; end: number }[],
  syncedAt: Date,
): Promise<boolean> {
  const id = Id.parse(connection.id);
  const [still] = await tx
    .update(calendarConnections)
    .set({ syncedAt, lastError: null })
    .where(and(sameGrant(connection), eq(calendarConnections.status, 'connected')))
    .returning({ id: calendarConnections.id });
  if (still === undefined) return false;
  await tx.delete(calendarBusyBlocks).where(eq(calendarBusyBlocks.connectionId, id));
  if (blocks.length > 0) {
    await tx.insert(calendarBusyBlocks).values(
      blocks.map((b) => ({
        connectionId: id,
        staffMemberId: connection.staffMemberId,
        startsAt: new Date(b.start),
        endsAt: new Date(b.end),
      })),
    );
  }
  return true;
}

/**
 * Records a failed read: the error code, and for `invalid_grant` or `token_unreadable` the move
 * to `needs_reconnect` (the access token dropped). Answers the status before, so a change is
 * audited once. Nothing when the member reconnected meanwhile: the failure was the old grant's.
 */
export async function recordCalendarFailure(
  tx: TenantTx,
  claimed: ClaimedConnection,
  error: CalendarSyncError,
): Promise<{ before: string; after: string } | undefined> {
  const code = CalendarSyncErrorSchema.parse(error);
  const [before] = await tx
    .select({ status: calendarConnections.status })
    .from(calendarConnections)
    .where(sameGrant(claimed))
    .for('update');
  if (before === undefined) return undefined;
  const refused = code === 'invalid_grant' || code === 'token_unreadable';
  const [after] = await tx
    .update(calendarConnections)
    .set({
      lastError: code,
      ...(refused && {
        status: 'needs_reconnect',
        accessTokenSealed: null,
        accessTokenExpiresAt: null,
      }),
    })
    .where(sameGrant(claimed))
    .returning({ status: calendarConnections.status });
  return after === undefined ? undefined : { before: before.status, after: after.status };
}

/** Busy blocks of several staff members that overlap [from, to), by start (availability). */
export async function listBusyBlocksBetween(
  tx: TenantTx,
  staffMemberIds: readonly StaffMemberId[],
  range: { from: Date; to: Date },
  limit?: number,
): Promise<CalendarBusyBlockRow[]> {
  if (staffMemberIds.length === 0) return [];
  const query = tx
    .select()
    .from(calendarBusyBlocks)
    .where(
      and(
        inArray(
          calendarBusyBlocks.staffMemberId,
          staffMemberIds.map((id) => Id.parse(id)),
        ),
        lt(calendarBusyBlocks.startsAt, range.to),
        gt(calendarBusyBlocks.endsAt, range.from),
      ),
    )
    .orderBy(asc(calendarBusyBlocks.startsAt), asc(calendarBusyBlocks.id));
  return limit === undefined ? query : query.limit(z.number().int().min(1).parse(limit));
}

/** Busy blocks of the whole business that overlap [from, to), by start (the calendar). */
export async function listAllBusyBlocksBetween(
  tx: TenantTx,
  range: { from: Date; to: Date },
  limit: number,
): Promise<CalendarBusyBlockRow[]> {
  return tx
    .select()
    .from(calendarBusyBlocks)
    .where(
      and(lt(calendarBusyBlocks.startsAt, range.to), gt(calendarBusyBlocks.endsAt, range.from)),
    )
    .orderBy(asc(calendarBusyBlocks.startsAt), asc(calendarBusyBlocks.id))
    .limit(z.number().int().min(1).parse(limit));
}
