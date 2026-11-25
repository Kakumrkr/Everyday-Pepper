import {
  BusyQuerySchema,
  CALENDAR_CONNECT_TTL_MS,
  CALENDAR_SYNC_DAYS,
  CALENDAR_SYNC_EVERY_MS,
  CalendarConnectCompleteSchema,
  CalendarConnectionAnswerSchema,
  CalendarConnectStartSchema,
  GOOGLE_FREEBUSY_SCOPE,
  OutsideBusyTimeSchema,
  StaffMemberIdSchema,
  busyBlocksOf,
  type BusyQuery,
  type CalendarConnection,
  type CalendarConnectionAnswer,
  type CalendarConnectComplete,
  type CalendarConnectStart,
  type CalendarSyncError,
  TeamCalendarConnectionsSchema,
  type OutsideBusyTime,
  type TeamCalendarConnections,
  type TenantId,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, type Actor, type Clock } from '@pepper/core';
import {
  appendAuditEntry,
  claimCalendarConnection,
  deleteCalendarConnection,
  findCalendarConnectionOfStaff,
  findMembership,
  findStaffMemberOfMembership,
  listAllBusyBlocksBetween,
  listBusyBlocksBetween,
  listCalendarConnections,
  listDueCalendarConnections,
  newId,
  recordCalendarFailure,
  replaceConnectState,
  saveCalendarConnection,
  storeAccessToken,
  storeCalendarRead,
  takeConnectState,
  withMember,
  withTenant,
  type CalendarConnectionRow,
  type Database,
  type TenantTx,
} from '@pepper/db';
import {
  CalendarConnectRefusedError,
  CalendarNotConnectedError,
  CalendarNotLinkedError,
  CalendarScopeMissingError,
} from './errors.js';
import { CalendarProviderError, type CalendarProvider } from './provider.js';
import {
  codeChallengeOf,
  openToken,
  randomToken,
  SealedTokenError,
  sealToken,
  stateHashOf,
} from './tokens.js';

/** A sealed token opened, or `null` when it can't be (another key): nothing to revoke then. */
function openedOrNull(key: Buffer, rowId: string, purpose: string, sealed: Buffer): string | null {
  try {
    return openToken(key, rowId, purpose, sealed);
  } catch (error) {
    if (error instanceof SealedTokenError) return null;
    throw error;
  }
}

// Google Calendar in (S70, ADR-0069): a member connects their own staff member's calendar,
// Pepper keeps its tokens sealed and its busy times (start and end only), and the worker reads
// it again every five minutes. No database transaction is ever open across a call to Google.

export interface CalendarDeps {
  db: Database;
  provider: CalendarProvider;
  /** `calendarTokenKeyFrom(outboxKey)`: the api and the worker share it. */
  tokenKey: Buffer;
  clock: Clock;
}

const DAY_MS = 86_400_000;
/** How far back busy times are kept: the week view still shows this week's. */
const READ_BACK_MS = 7 * DAY_MS;
/** An access token this close to its expiry is refreshed before the read. */
const EXPIRY_MARGIN_MS = 60_000;
/** Connections read in one pass of the worker, at most. */
const READS_PER_PASS = 200;

interface Linked {
  membershipId: string;
  staffMemberId: string;
}

/** The member's own staff member, or `undefined` when they have none (ADR-0069 §3, D-2). */
async function linkedOf(tx: TenantTx, actor: Actor): Promise<Linked | undefined> {
  const membership = await findMembership(tx, actor.context.userId);
  if (membership === undefined) return undefined;
  const staff = await findStaffMemberOfMembership(tx, membership.id);
  return staff === undefined ? undefined : { membershipId: membership.id, staffMemberId: staff.id };
}

export function toCalendarConnection(row: CalendarConnectionRow): CalendarConnection {
  return {
    staffMemberId: StaffMemberIdSchema.parse(row.staffMemberId),
    provider: row.provider === 'google' ? 'google' : 'sandbox',
    accountEmail: row.accountEmail,
    status: row.status === 'needs_reconnect' ? 'needs_reconnect' : 'connected',
    syncedAt:
      row.syncedAt === null ? null : (row.syncedAt.toISOString() as CalendarConnection['syncedAt']),
    connectedAt: row.connectedAt.toISOString() as CalendarConnection['connectedAt'],
  };
}

/** The signed-in member's own connection (AC-X-152): whether they can connect, and its status. */
export async function readOwnCalendar(
  deps: CalendarDeps,
  actor: Actor,
): Promise<CalendarConnectionAnswer> {
  requirePermission(actor, 'calendar.read');
  return withMember(deps.db, actor.context, async (tx) => {
    const linked = await linkedOf(tx, actor);
    if (linked === undefined)
      return CalendarConnectionAnswerSchema.parse({ canConnect: false, connection: null });
    const row = await findCalendarConnectionOfStaff(
      tx,
      StaffMemberIdSchema.parse(linked.staffMemberId),
    );
    return CalendarConnectionAnswerSchema.parse({
      canConnect: true,
      connection: row === undefined ? null : toCalendarConnection(row),
    });
  });
}

/**
 * The business's calendars for the Team list (S70.2, AC-X-164, AC-X-165): each staff member's
 * state and last read, never the account's email. Needs `staff.read`, like the list it sits on.
 */
export async function readTeamCalendars(
  deps: Pick<CalendarDeps, 'db'>,
  actor: Actor,
  limit: number,
): Promise<TeamCalendarConnections> {
  requirePermission(actor, 'staff.read');
  const rows = await withMember(deps.db, actor.context, (tx) => listCalendarConnections(tx, limit));
  // The schema has no `accountEmail`: parsing strips it.
  return TeamCalendarConnectionsSchema.parse({ connections: rows.map(toCalendarConnection) });
}

/**
 * Starts "Connect Google Calendar" (AC-X-152): a one-time state (only its hash stored, 10
 * minutes) and a PKCE verifier (sealed), and Google's consent page to send the member to.
 */
export async function startCalendarConnect(
  deps: CalendarDeps,
  actor: Actor,
): Promise<CalendarConnectStart> {
  requirePermission(actor, 'calendar.read');
  const state = randomToken();
  const verifier = randomToken();
  const stateHash = stateHashOf(state);
  const loginHint = await withMember(deps.db, actor.context, async (tx) => {
    const linked = await linkedOf(tx, actor);
    if (linked === undefined) throw new CalendarNotLinkedError();
    await replaceConnectState(
      tx,
      {
        ...linked,
        stateHash,
        verifierSealed: sealToken(deps.tokenKey, stateHash.toString('hex'), 'verifier', verifier),
        expiresAt: new Date(deps.clock.now().getTime() + CALENDAR_CONNECT_TTL_MS),
      },
      deps.clock.now(),
    );
    const existing = await findCalendarConnectionOfStaff(
      tx,
      StaffMemberIdSchema.parse(linked.staffMemberId),
    );
    return existing?.accountEmail;
  });
  return CalendarConnectStartSchema.parse({
    url: deps.provider.consentUrl({ state, codeChallenge: codeChallengeOf(verifier), loginHint }),
  });
}

/**
 * Finishes a connect with what Google gave the return page (AC-X-152, AC-X-153): the state is
 * taken once, then must be unexpired and the same member's and staff member's; the code is
 * exchanged; free/busy must have been granted. The tokens are stored sealed and the calendar is
 * read at once (AC-X-155: a reconnect reads again).
 */
export async function completeCalendarConnect(
  deps: CalendarDeps,
  actor: Actor,
  input: CalendarConnectComplete,
): Promise<CalendarConnectionAnswer> {
  requirePermission(actor, 'calendar.read');
  const { code, state } = CalendarConnectCompleteSchema.parse(input);
  const stateHash = stateHashOf(state);
  const now = deps.clock.now();
  // Taken in its own transaction, so a refused state is gone whatever happens next.
  const taken = await withMember(deps.db, actor.context, async (tx) => ({
    row: await takeConnectState(tx, stateHash),
    linked: await linkedOf(tx, actor),
  }));
  const { row, linked } = taken;
  if (
    row === undefined ||
    linked === undefined ||
    row.expiresAt.getTime() <= now.getTime() ||
    row.membershipId !== linked.membershipId ||
    row.staffMemberId !== linked.staffMemberId
  ) {
    throw new CalendarConnectRefusedError();
  }
  const verifier = openToken(
    deps.tokenKey,
    stateHash.toString('hex'),
    'verifier',
    row.verifierSealed,
  );

  let granted;
  try {
    granted = await deps.provider.exchangeCode({ code, codeVerifier: verifier });
  } catch (error) {
    if (error instanceof CalendarProviderError && error.code === 'invalid_grant') {
      throw new CalendarConnectRefusedError();
    }
    throw error;
  }
  if (!granted.scopes.includes(GOOGLE_FREEBUSY_SCOPE)) {
    await deps.provider.revoke(granted.refreshToken).catch(() => undefined);
    throw new CalendarScopeMissingError();
  }

  const { saved, replaced } = await withMember(deps.db, actor.context, async (tx) => {
    const staffMemberId = StaffMemberIdSchema.parse(linked.staffMemberId);
    const existing = await findCalendarConnectionOfStaff(tx, staffMemberId);
    const id = existing?.id ?? newId();
    // A grant whose token can't be opened (the key changed) has nothing left to revoke.
    const previous =
      existing === undefined
        ? null
        : openedOrNull(deps.tokenKey, existing.id, 'refresh', existing.refreshTokenSealed);
    const stored = await saveCalendarConnection(
      tx,
      {
        id,
        staffMemberId,
        membershipId: linked.membershipId,
        provider: deps.provider.name,
        accountEmail: granted.accountEmail,
        refreshTokenSealed: sealToken(deps.tokenKey, id, 'refresh', granted.refreshToken),
        accessTokenSealed: sealToken(deps.tokenKey, id, 'access', granted.accessToken),
        accessTokenExpiresAt: granted.expiresAt,
        createdBy: actor.context.userId,
        connectedAt: deps.clock.now(),
      },
      existing !== undefined,
    );
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      requestId: actor.requestId,
      change: {
        action: 'calendar.connected',
        entity: { type: 'calendar_connection', id },
        before: null,
        after: { provider: deps.provider.name, staffMemberId, reconnected: existing !== undefined },
      },
    });
    return { saved: stored, replaced: previous === granted.refreshToken ? null : previous };
  });
  // The grant this one replaced is no use to anyone now.
  if (replaced !== null) await deps.provider.revoke(replaced).catch(() => undefined);
  // The first read now, so the busy times block bookings from the start; a failure waits for
  // the worker's next pass.
  await readCalendar(deps, actor.context.tenantId, saved.id, { force: true }).catch(
    () => undefined,
  );
  return readOwnCalendar(deps, actor);
}

/**
 * Disconnects the member's own calendar (AC-X-157): the connection and its busy times go in one
 * transaction, then Google is asked to revoke the grant (a failure there changes nothing).
 */
export async function disconnectCalendar(deps: CalendarDeps, actor: Actor): Promise<void> {
  requirePermission(actor, 'calendar.read');
  const refreshToken = await withMember(deps.db, actor.context, async (tx) => {
    const linked = await linkedOf(tx, actor);
    if (linked === undefined) throw new CalendarNotLinkedError();
    const row = await findCalendarConnectionOfStaff(
      tx,
      StaffMemberIdSchema.parse(linked.staffMemberId),
    );
    if (row === undefined) throw new CalendarNotConnectedError();
    // An unreadable token (the key changed) never keeps a member from disconnecting.
    const token = openedOrNull(deps.tokenKey, row.id, 'refresh', row.refreshTokenSealed);
    await deleteCalendarConnection(tx, row.id);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      requestId: actor.requestId,
      change: {
        action: 'calendar.disconnected',
        entity: { type: 'calendar_connection', id: row.id },
        before: {
          provider: row.provider === 'google' ? 'google' : 'sandbox',
          staffMemberId: row.staffMemberId,
        },
        after: null,
      },
    });
    return token;
  });
  if (refreshToken !== null) await deps.provider.revoke(refreshToken).catch(() => undefined);
}

export type CalendarReadOutcome = 'read' | 'skipped' | 'failed' | 'needs_reconnect';

/**
 * Reads one connected calendar's busy times (AC-X-154, AC-X-155): claims it, refreshes an
 * expired access token (and once more on a 401), asks Google, and replaces the busy times.
 * `invalid_grant` makes it "needs reconnecting" and keeps its busy times; any other failure keeps
 * everything for the next pass.
 */
export async function readCalendar(
  deps: CalendarDeps,
  tenantId: TenantId,
  connectionId: string,
  options: { force?: boolean } = {},
): Promise<CalendarReadOutcome> {
  const now = deps.clock.now();
  const claimed = await withTenant(deps.db, tenantId, (tx) =>
    claimCalendarConnection(tx, connectionId, now, CALENDAR_SYNC_EVERY_MS, options.force ?? false),
  );
  if (claimed === undefined) return 'skipped';
  let fresh: { accessToken: string; expiresAt: Date } | null = null;
  const window = {
    from: new Date(now.getTime() - READ_BACK_MS),
    to: new Date(now.getTime() + CALENDAR_SYNC_DAYS * DAY_MS),
  };

  try {
    const refreshToken = openToken(
      deps.tokenKey,
      claimed.id,
      'refresh',
      claimed.refreshTokenSealed,
    );
    let access =
      claimed.accessTokenSealed !== null &&
      claimed.accessTokenExpiresAt !== null &&
      claimed.accessTokenExpiresAt.getTime() - EXPIRY_MARGIN_MS > now.getTime()
        ? openToken(deps.tokenKey, claimed.id, 'access', claimed.accessTokenSealed)
        : null;
    if (access === null) {
      fresh = await deps.provider.refresh(refreshToken);
      access = fresh.accessToken;
    }
    let busy;
    try {
      busy = await deps.provider.freeBusy({ accessToken: access, ...window });
    } catch (error) {
      // A stored token Google no longer takes: refresh once and ask again.
      if (
        !(error instanceof CalendarProviderError) ||
        error.code !== 'unauthorized' ||
        fresh !== null
      ) {
        throw error;
      }
      fresh = await deps.provider.refresh(refreshToken);
      busy = await deps.provider.freeBusy({ accessToken: fresh.accessToken, ...window });
    }
    const blocks = busyBlocksOf(busy, { from: window.from.getTime(), to: window.to.getTime() });
    const stored = await withTenant(deps.db, tenantId, async (tx) => {
      if (fresh !== null) {
        await storeAccessToken(
          tx,
          claimed,
          sealToken(deps.tokenKey, claimed.id, 'access', fresh.accessToken),
          fresh.expiresAt,
        );
      }
      return storeCalendarRead(tx, claimed, blocks, now);
    });
    return stored ? 'read' : 'skipped';
  } catch (error) {
    if (error instanceof SealedTokenError) {
      // The key changed: no token of this connection opens again; only a reconnect helps.
      return failed(deps, tenantId, claimed, 'token_unreadable');
    }
    if (!(error instanceof CalendarProviderError)) {
      // Not Google's answer: a bug or the database. Recorded, then raised for the job's log.
      await failed(deps, tenantId, claimed, 'bad_response');
      throw error;
    }
    return failed(deps, tenantId, claimed, error.code);
  }
}

async function failed(
  deps: CalendarDeps,
  tenantId: TenantId,
  claimed: { id: string; generation: number },
  code: CalendarSyncError,
): Promise<CalendarReadOutcome> {
  const { id } = claimed;
  return withTenant(deps.db, tenantId, async (tx) => {
    const moved = await recordCalendarFailure(tx, claimed, code);
    if (moved !== undefined && moved.before !== moved.after) {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'calendar.connection_changed',
          entity: { type: 'calendar_connection', id },
          before: { status: moved.before === 'needs_reconnect' ? 'needs_reconnect' : 'connected' },
          after: { status: moved.after === 'needs_reconnect' ? 'needs_reconnect' : 'connected' },
        },
      });
    }
    return moved?.after === 'needs_reconnect' ? 'needs_reconnect' : 'failed';
  });
}

export interface CalendarPassResult {
  read: number;
  failed: number;
  needsReconnect: number;
}

/** The worker's pass (AC-X-154): every connected calendar due a read, the longest waiting first. */
export async function runDueCalendarReads(deps: CalendarDeps): Promise<CalendarPassResult> {
  const totals: CalendarPassResult = { read: 0, failed: 0, needsReconnect: 0 };
  const due = await listDueCalendarConnections(
    deps.db,
    deps.clock.now(),
    CALENDAR_SYNC_EVERY_MS,
    READS_PER_PASS,
  );
  for (const { tenantId, connectionId } of due) {
    let outcome: CalendarReadOutcome;
    try {
      outcome = await readCalendar(deps, tenantId, connectionId);
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'read') totals.read += 1;
    else if (outcome === 'failed') totals.failed += 1;
    else if (outcome === 'needs_reconnect') totals.needsReconnect += 1;
  }
  return totals;
}

/**
 * Busy times from outside calendars overlapping [from, to) (AC-X-159): when, never what, to
 * everyone who may see the calendar (like booked times).
 */
export async function listOutsideBusy(
  db: Database,
  actor: Actor,
  query: BusyQuery,
  limit: number,
): Promise<OutsideBusyTime[]> {
  requirePermission(actor, 'calendar.read');
  const { from, to, staffMemberId } = BusyQuerySchema.parse(query);
  const range = { from: new Date(from), to: new Date(to) };
  const rows = await withMember(db, actor.context, (tx) =>
    staffMemberId === undefined
      ? listAllBusyBlocksBetween(tx, range, limit)
      : listBusyBlocksBetween(tx, [staffMemberId], range, limit),
  );
  return rows.map((row) =>
    OutsideBusyTimeSchema.parse({
      staffMemberId: row.staffMemberId,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      source: 'google',
    }),
  );
}
