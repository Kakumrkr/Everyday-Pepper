import {
  CalendarProviderSchema,
  CalendarSyncErrorSchema,
  TenantIdSchema,
  type CalendarProvider,
  type CalendarSyncError,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, eq, gt, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  calendarBusyBlocks,
  calendarConnections,
  calendarConnectStates,
  type CalendarBusyBlockRow,
  type CalendarConnectionRow,
  type CalendarConnectStateRow,
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

/** Stores a connect state, replacing the staff member's earlier one (one in flight at a time). */
export async function replaceConnectState(tx: TenantTx, input: NewConnectState): Promise<void> {
  const staffMemberId = Id.parse(input.staffMemberId);
  await tx
    .delete(calendarConnectStates)
    .where(eq(calendarConnectStates.staffMemberId, staffMemberId));
  await tx.insert(calendarConnectStates).values({
    staffMemberId,
    membershipId: Id.parse(input.membershipId),
    stateHash: input.stateHash,
    verifierSealed: input.verifierSealed,
    expiresAt: input.expiresAt,
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
}

/**
 * Stores a new connection, or a reconnection of the staff member's existing one (`id` is then
 * that row's): connected again, the new tokens, the error cleared. A connection made by another
 * request in between fails on the staff member's unique index.
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
    createdBy: Id.parse(input.createdBy),
  };
  const [row] = existing
    ? await tx
        .update(calendarConnections)
        .set(values)
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
      .orderBy(asc(calendarConnections.attemptedAt), asc(calendarConnections.id))
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

/** Keeps a fresh access token (sealed) and when it expires. */
export async function storeAccessToken(
  tx: TenantTx,
  id: string,
  sealed: Buffer,
  expiresAt: Date,
): Promise<void> {
  await tx
    .update(calendarConnections)
    .set({ accessTokenSealed: sealed, accessTokenExpiresAt: expiresAt })
    .where(eq(calendarConnections.id, Id.parse(id)));
}

/**
 * Replaces a connection's busy blocks with one read's (start and end only) and records it worked.
 * Only while still connected: a connection removed or refused meanwhile keeps what it had.
 */
export async function storeCalendarRead(
  tx: TenantTx,
  connection: Pick<CalendarConnectionRow, 'id' | 'staffMemberId'>,
  blocks: readonly { start: number; end: number }[],
  syncedAt: Date,
): Promise<boolean> {
  const id = Id.parse(connection.id);
  const [still] = await tx
    .update(calendarConnections)
    .set({ syncedAt, lastError: null })
    .where(and(eq(calendarConnections.id, id), eq(calendarConnections.status, 'connected')))
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
 * Records a failed read: the error code, and for `invalid_grant` the move to `needs_reconnect`
 * (the access token dropped). Answers the status before, so a change is audited once.
 */
export async function recordCalendarFailure(
  tx: TenantTx,
  id: string,
  error: CalendarSyncError,
): Promise<{ before: string; after: string } | undefined> {
  const code = CalendarSyncErrorSchema.parse(error);
  const [before] = await tx
    .select({ status: calendarConnections.status })
    .from(calendarConnections)
    .where(eq(calendarConnections.id, Id.parse(id)))
    .for('update');
  if (before === undefined) return undefined;
  const refused = code === 'invalid_grant';
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
    .where(eq(calendarConnections.id, Id.parse(id)))
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
