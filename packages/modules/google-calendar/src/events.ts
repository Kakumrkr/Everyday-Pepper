import {
  BookingCalendarStateSchema,
  BookingIdSchema,
  CALENDAR_WRITE_LEASE_MS,
  CALENDAR_WRITE_MAX_BACKOFF_MS,
  PEPPER_CALENDAR_NAME,
  StaffMemberIdSchema,
  calendarEventBodyOf,
  calendarEventIdOf,
  calendarWriteBackoffMs,
  type BookingCalendarState,
  type BookingId,
  type CalendarSyncError,
  type TenantId,
} from '@pepper/contracts';
import { requirePermission, type Actor } from '@pepper/core';
import {
  claimCalendarEventSync,
  clearBookingsCalendar,
  findBooking,
  findBookingEventSource,
  findCalendarConnection,
  findCalendarConnectionOfStaff,
  findCalendarEventSyncOfBooking,
  findCurrentTenant,
  listDueCalendarEventSyncs,
  recordCalendarEventFailure,
  recordCalendarEventWritten,
  storeBookingsCalendar,
  withMember,
  withTenant,
  type CalendarConnectionRow,
  type CalendarEventSyncRow,
  type EventPlacement,
} from '@pepper/db';
import { recordConnectionFailure, withAccessToken } from './access.js';
import { CalendarProviderError } from './provider.js';
import type { CalendarDeps } from './services.js';
import { SealedTokenError } from './tokens.js';

// Google Calendar out (S71, ADR-0069 §10): the worker writes each queued booking (the trigger on
// `bookings` queues every write) into its staff member's "Pepper bookings" calendar, moves it when
// the staff member changes and removes it when it is cancelled or removed. The event's id is the
// booking's, so a retry or a write that reached Google before a timeout updates the one event
// (AC-X-169). Pepper is the source of truth: the event is written as the booking is now. No
// database transaction is open across a call to Google.

/** Bookings written in one pass of the worker, at most. */
const WRITES_PER_PASS = 200;

export type CalendarWriteOutcome = 'written' | 'skipped' | 'failed' | 'waiting';

/** The first word of a client's name, for the event (D-3): never the rest, a phone or an email. */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/u)[0] ?? '';
}

/** A write that can't go out until the member reconnects: tried again in an hour, or at once on reconnecting. */
class WaitingForReconnect extends Error {
  constructor() {
    super('The calendar needs reconnecting');
    this.name = 'WaitingForReconnect';
  }
}

/** Where the booking's event belongs: the staff member's calendar that takes bookings, if any. */
interface Plan {
  claimed: CalendarEventSyncRow;
  event: ReturnType<typeof calendarEventBodyOf> | null;
  target: CalendarConnectionRow | undefined;
  previous: CalendarConnectionRow | undefined;
  timeZone: string;
}

/**
 * Writes one queued booking (AC-X-168…170): claims its row, removes its event from where it no
 * longer belongs, writes it where it does (making "Pepper bookings" first when needed), and records
 * where it is now. A failure keeps the row for a retry with backoff.
 */
export async function writeBookingEvent(
  deps: CalendarDeps,
  tenantId: TenantId,
  bookingId: string,
): Promise<CalendarWriteOutcome> {
  const now = deps.clock.now();
  const plan = await withTenant(deps.db, tenantId, async (tx): Promise<Plan | undefined> => {
    const claimed = await claimCalendarEventSync(tx, bookingId, now, CALENDAR_WRITE_LEASE_MS);
    if (claimed === undefined) return undefined;
    const source = await findBookingEventSource(tx, bookingId);
    const connection =
      source === undefined || source.status === 'cancelled'
        ? undefined
        : await findCalendarConnectionOfStaff(tx, StaffMemberIdSchema.parse(source.staffMemberId));
    const target = connection?.writesBookings === true ? connection : undefined;
    const previous =
      claimed.eventConnectionId === null
        ? undefined
        : await findCalendarConnection(tx, claimed.eventConnectionId);
    const tenant = await findCurrentTenant(tx);
    return {
      claimed,
      target,
      previous,
      timeZone: tenant?.timeZone ?? 'UTC',
      event:
        source === undefined || target === undefined
          ? null
          : calendarEventBodyOf({
              bookingId: source.id,
              serviceName: source.serviceName,
              clientFirstName: source.clientDeleted ? '' : firstNameOf(source.clientName),
              startsAt: source.startsAt,
              endsAt: source.endsAt,
            }),
    };
  });
  if (plan === undefined) return 'skipped';
  const { claimed, target, previous } = plan;

  let placement: EventPlacement | null =
    claimed.eventConnectionId === null || claimed.eventCalendarId === null
      ? null
      : { connectionId: claimed.eventConnectionId, calendarId: claimed.eventCalendarId };
  let failing: CalendarConnectionRow | undefined;
  /** The "Pepper bookings" being written to, once known (made in this pass, or stored). */
  let writingTo: string | null = null;
  try {
    // 1. Out of a calendar it no longer belongs in (cancelled, removed, another staff member, or
    //    a calendar that isn't the connection's now).
    if (
      placement !== null &&
      (placement.connectionId !== target?.id ||
        (target.bookingsCalendarId !== null && placement.calendarId !== target.bookingsCalendarId))
    ) {
      if (previous?.id === placement.connectionId) {
        failing = previous;
        if (previous.status === 'connected') {
          const from = placement;
          await withAccessToken(deps, tenantId, previous, (accessToken) =>
            deps.provider
              .deleteEvent({
                accessToken,
                calendarId: from.calendarId,
                eventId: calendarEventIdOf(bookingId),
              })
              .catch((error: unknown) => {
                // This grant can't remove it (a permission taken back): nothing more to try.
                if (error instanceof CalendarProviderError && error.code === 'forbidden') return;
                throw error;
              }),
          );
        } else if (target === undefined) {
          // Removing it waits for that member to reconnect (a cancel shouldn't stay in Google).
          throw new WaitingForReconnect();
        }
        // Else it moved to another staff member's calendar: that write never waits on someone
        // else's reconnect; the old event is left where it is (S71.2's reconciliation).
      }
      // A connection removed meanwhile took its calendar with it (AC-X-172).
      placement = null;
    }

    // 2. Into the staff member's "Pepper bookings".
    if (target !== undefined && plan.event !== null) {
      failing = target;
      if (target.status !== 'connected') throw new WaitingForReconnect();
      const event = plan.event;
      const written = await withAccessToken(deps, tenantId, target, async (accessToken) => {
        const calendarId =
          target.bookingsCalendarId ??
          (await bookingsCalendarOf(deps, tenantId, target, accessToken, plan.timeZone));
        if (calendarId === null) return null;
        writingTo = calendarId;
        try {
          await upsertEvent(deps, { accessToken, calendarId, event }, placement !== null);
        } catch (error) {
          // The calendar is gone in Google: asked to delete it too, in case it was only hidden
          // from this call, so a calendar made again never leaves a second one behind.
          if (error instanceof CalendarProviderError && error.code === 'not_found') {
            await deps.provider.deleteCalendar({ accessToken, calendarId }).catch(() => undefined);
          }
          throw error;
        }
        return calendarId;
      });
      // `null`: reconnected meanwhile, so this grant is the old one; tried again with the new.
      if (written === null) throw new CalendarProviderError('unauthorized');
      placement = { connectionId: target.id, calendarId: written };
    }

    await withTenant(deps.db, tenantId, (tx) => recordCalendarEventWritten(tx, claimed, placement));
    return 'written';
  } catch (error) {
    return failedWrite(deps, tenantId, claimed, failing, placement, writingTo, error);
  }
}

/**
 * Makes "Pepper bookings" in the account (AC-X-167) and keeps its id, unless another worker kept
 * one first (that one is used) or the member reconnected meanwhile (`null`).
 */
async function bookingsCalendarOf(
  deps: CalendarDeps,
  tenantId: TenantId,
  connection: CalendarConnectionRow,
  accessToken: string,
  timeZone: string,
): Promise<string | null> {
  const made = await deps.provider.createCalendar({
    accessToken,
    name: PEPPER_CALENDAR_NAME,
    timeZone,
  });
  const kept = await withTenant(deps.db, tenantId, (tx) =>
    storeBookingsCalendar(tx, connection, made.id),
  );
  // Another worker's calendar won (or none, after a reconnect): this one is removed again.
  if (kept !== made.id) {
    await deps.provider.deleteCalendar({ accessToken, calendarId: made.id }).catch(() => undefined);
  }
  return kept;
}

/**
 * One event per booking (AC-X-169): a patch when it was written there before, else an insert;
 * Google's "already exists" (written before a timeout, or deleted and kept by Google) becomes a
 * patch, and a patch of a missing event an insert. A missing calendar is `not_found`.
 */
async function upsertEvent(
  deps: CalendarDeps,
  input: Parameters<CalendarDeps['provider']['insertEvent']>[0],
  writtenThere: boolean,
): Promise<void> {
  if (writtenThere && (await deps.provider.patchEvent(input)) === 'updated') return;
  if ((await deps.provider.insertEvent(input)) === 'created') return;
  if ((await deps.provider.patchEvent(input)) === 'updated') return;
  // Exists, yet can't be patched: Google contradicts itself; tried again later.
  throw new CalendarProviderError('bad_response');
}

async function failedWrite(
  deps: CalendarDeps,
  tenantId: TenantId,
  claimed: CalendarEventSyncRow,
  connection: CalendarConnectionRow | undefined,
  placement: EventPlacement | null,
  writingTo: string | null,
  error: unknown,
): Promise<CalendarWriteOutcome> {
  const now = deps.clock.now();
  const code: CalendarSyncError =
    error instanceof WaitingForReconnect
      ? 'invalid_grant'
      : error instanceof SealedTokenError
        ? 'token_unreadable'
        : error instanceof CalendarProviderError
          ? error.code
          : 'bad_response';
  // Waiting for a reconnect, or refused for a permission: no use trying again soon.
  const stuck =
    error instanceof WaitingForReconnect ||
    code === 'forbidden' ||
    code === 'invalid_grant' ||
    code === 'token_unreadable';
  let retryAt = new Date(
    now.getTime() +
      (stuck ? CALENDAR_WRITE_MAX_BACKOFF_MS : calendarWriteBackoffMs(claimed.attempts + 1)),
  );
  if (connection !== undefined && !(error instanceof WaitingForReconnect)) {
    if (code === 'not_found' && writingTo !== null) {
      // "Pepper bookings" deleted in Google (AC-X-170): forgotten, made again at once the first
      // time; after that with the backoff, so a Google that keeps answering 404 can't make one
      // calendar after another.
      const calendarId = writingTo;
      await withTenant(deps.db, tenantId, (tx) =>
        clearBookingsCalendar(tx, connection.id, calendarId),
      );
      if (placement?.calendarId === calendarId) placement = null;
      if (claimed.attempts === 0) retryAt = now;
    } else if (code === 'invalid_grant' || code === 'token_unreadable') {
      // The connection needs reconnecting (audited once); the write waits for it (AC-X-170).
      await recordConnectionFailure(deps, tenantId, connection, code);
    }
  }
  await withTenant(deps.db, tenantId, (tx) =>
    recordCalendarEventFailure(tx, claimed, code, retryAt, placement),
  );
  // Not Google's answer: a bug or the database, raised for the job's log once recorded.
  if (
    !(error instanceof CalendarProviderError) &&
    !(error instanceof WaitingForReconnect) &&
    !(error instanceof SealedTokenError)
  ) {
    throw error;
  }
  return code === 'invalid_grant' || code === 'token_unreadable' ? 'waiting' : 'failed';
}

export interface CalendarWritePassResult {
  written: number;
  failed: number;
  waiting: number;
}

/** The worker's pass (AC-X-168): every booking due a write, the longest waiting first. */
export async function runDueCalendarWrites(deps: CalendarDeps): Promise<CalendarWritePassResult> {
  const totals: CalendarWritePassResult = { written: 0, failed: 0, waiting: 0 };
  const due = await listDueCalendarEventSyncs(deps.db, deps.clock.now(), WRITES_PER_PASS);
  for (const { tenantId, bookingId } of due) {
    let outcome: CalendarWriteOutcome;
    try {
      outcome = await writeBookingEvent(deps, tenantId, bookingId);
    } catch {
      outcome = 'failed';
    }
    if (outcome === 'written') totals.written += 1;
    else if (outcome === 'failed') totals.failed += 1;
    else if (outcome === 'waiting') totals.waiting += 1;
  }
  return totals;
}

/**
 * Whether a booking is in Google Calendar, for its sheet (S71 top-up, AC-X-173): only for a
 * booking the member may see (RLS: staff see their own), else `undefined` (404).
 */
export async function readBookingCalendarState(
  deps: Pick<CalendarDeps, 'db'>,
  actor: Actor,
  bookingId: BookingId,
): Promise<BookingCalendarState | undefined> {
  requirePermission(actor, 'calendar.read');
  return withMember(deps.db, actor.context, async (tx) => {
    const id = BookingIdSchema.parse(bookingId);
    const booking = await findBooking(tx, id);
    if (booking === undefined) return undefined;
    const sync = await findCalendarEventSyncOfBooking(tx, id);
    if (sync === undefined) return BookingCalendarStateSchema.parse({ state: 'none' });
    if (sync.syncedVersion === sync.version) {
      return BookingCalendarStateSchema.parse({
        state: sync.eventConnectionId === null ? 'none' : 'written',
      });
    }
    // Waiting: only while the staff member's calendar takes bookings (else it is being removed).
    const connection =
      booking.status === 'cancelled'
        ? undefined
        : await findCalendarConnectionOfStaff(tx, StaffMemberIdSchema.parse(booking.staffMemberId));
    if (connection?.writesBookings !== true)
      return BookingCalendarStateSchema.parse({ state: 'none' });
    return BookingCalendarStateSchema.parse({
      state: connection.status === 'connected' ? 'pending' : 'waiting',
    });
  });
}
