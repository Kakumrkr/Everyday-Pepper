import {
  CALENDAR_EVENT_PAGES_PER_READ,
  CALENDAR_KEPT_NOTE_DAYS,
  CALENDAR_WRITE_LEASE_MS,
  UtcDateTimeSchema,
  bookingIdOfCalendarEvent,
  calendarEventChangeOf,
  formatDate,
  toZoned,
  type GoogleListedEvent,
  type TenantId,
} from '@pepper/contracts';
import {
  clearBookingsCalendar,
  databaseNow,
  eventsReadCursorOf,
  findBookingEventSource,
  findCalendarConnection,
  findCalendarEventSyncsOfBookings,
  findCurrentTenant,
  isSettled,
  leaseEventSyncForStray,
  releaseEventSyncLease,
  requeueSettledEventSync,
  storeEventsReadCursor,
  withTenant,
  writeCalendarKeptNote,
  type CalendarConnectionRow,
  type CalendarEventSyncRow,
  type EventsReadCursor,
  type TenantTx,
} from '@pepper/db';
import { recordConnectionFailure, withAccessToken } from './access.js';
import { eventBodyOf } from './events.js';
import { CalendarProviderError } from './provider.js';
import type { CalendarDeps } from './services.js';
import { SealedTokenError } from './tokens.js';

// Reading "Pepper bookings" back (S71.2, ADR-0069 §11). Pepper is the source of truth: a Pepper
// event moved, deleted or edited in Google is queued to be written again as booked (the write
// pass puts it back) with a note on Home; a Pepper event in a calendar its booking isn't in (left
// behind while a calendar needed reconnecting) is removed. Events Pepper didn't make are left
// alone. The calendar's changes are read with Google's sync token, a page at a time, each page
// handled in its own transaction after Google answered (none open across a call).

const DAY_MS = 86_400_000;

export type CalendarReconcileOutcome = 'read' | 'skipped' | 'failed';

export interface CalendarReconcileResult {
  outcome: CalendarReconcileOutcome;
  /** Bookings queued to be put back over a change made in Google. */
  kept: number;
  /** Stray Pepper events removed. */
  removed: number;
}

/** A stray Pepper event to remove, holding its booking's row when it has one. */
interface Stray {
  eventId: string;
  held: CalendarEventSyncRow | null;
}

/**
 * Reads a connection's "Pepper bookings" back (AC-X-175…177, AC-X-179) after its busy times were
 * read: only what changed since the last read, unless this is the first read since connecting, a
 * reconnect, the calendar was made again, or Google's 410 said the token is too old (then all of
 * it). Stops after `CALENDAR_EVENT_PAGES_PER_READ` pages; the next read goes on from there.
 */
export async function reconcileBookingsCalendar(
  deps: CalendarDeps,
  tenantId: TenantId,
  claimed: Pick<CalendarConnectionRow, 'id' | 'generation'>,
): Promise<CalendarReconcileResult> {
  const result: CalendarReconcileResult = { outcome: 'skipped', kept: 0, removed: 0 };
  // Read again: the busy read may have stored a fresh access token; a reconnect since is skipped.
  const connection = await withTenant(deps.db, tenantId, (tx) =>
    findCalendarConnection(tx, claimed.id),
  );
  const calendarId = connection?.bookingsCalendarId ?? null;
  if (
    connection?.generation !== claimed.generation ||
    !connection.writesBookings ||
    calendarId === null ||
    connection.status !== 'connected'
  ) {
    return result;
  }
  let cursor: EventsReadCursor = eventsReadCursorOf(connection, calendarId);
  let restarted = false;
  try {
    result.outcome = await withAccessToken(deps, tenantId, connection, async (accessToken) => {
      for (let pages = 0; pages < CALENDAR_EVENT_PAGES_PER_READ; pages += 1) {
        // The database's time before Google answers: a row written after it may already be newer
        // than what this page shows, so it isn't judged by this page.
        const askedAt = await withTenant(deps.db, tenantId, databaseNow);
        const page = await deps.provider.listEvents({ accessToken, calendarId, ...cursor });
        if (page === 'sync_expired') {
          // Google forgot where Pepper was: the whole calendar again, once.
          if (restarted) throw new CalendarProviderError('bad_response', 410);
          restarted = true;
          cursor = { syncToken: null, pageToken: null };
          continue;
        }
        const now = deps.clock.now();
        const strays = await withTenant(deps.db, tenantId, async (tx) => {
          const handled = await reconcilePage(tx, connection, calendarId, page.events, {
            now,
            askedAt,
          });
          result.kept += handled.kept;
          return handled.strays;
        });
        try {
          for (const stray of strays) {
            await deps.provider.deleteEvent({ accessToken, calendarId, eventId: stray.eventId });
            result.removed += 1;
          }
        } finally {
          // Every lease this page took is given back, whether or not each delete went through.
          const held = strays.flatMap((stray) => (stray.held === null ? [] : [stray.held]));
          if (held.length > 0) {
            await withTenant(deps.db, tenantId, async (tx) => {
              for (const row of held) await releaseEventSyncLease(tx, row);
            });
          }
        }
        const next: EventsReadCursor =
          page.nextPageToken === null
            ? { syncToken: page.nextSyncToken, pageToken: null }
            : { syncToken: cursor.syncToken, pageToken: page.nextPageToken };
        const stored = await withTenant(deps.db, tenantId, (tx) =>
          storeEventsReadCursor(
            tx,
            connection,
            calendarId,
            next,
            page.nextPageToken === null ? now : null,
          ),
        );
        // Reconnected, or the calendar changed, meanwhile: the next read starts again.
        if (!stored) return 'skipped';
        cursor = next;
        if (page.nextPageToken === null) return 'read';
      }
      return 'read';
    });
    return result;
  } catch (error) {
    if (error instanceof CalendarProviderError && error.code === 'not_found') {
      // "Pepper bookings" deleted in Google (AC-X-179): forgotten and its bookings queued, so the
      // write pass makes it again and writes them, without waiting for a booking to change.
      await withTenant(deps.db, tenantId, (tx) =>
        clearBookingsCalendar(tx, connection.id, calendarId),
      );
    } else if (error instanceof SealedTokenError) {
      await recordConnectionFailure(deps, tenantId, connection, 'token_unreadable');
    } else if (error instanceof CalendarProviderError && error.code === 'invalid_grant') {
      await recordConnectionFailure(deps, tenantId, connection, 'invalid_grant');
    } else if (!(error instanceof CalendarProviderError)) {
      throw error;
    }
    // Anything else (a rate limit, Google unavailable, a bad answer): the next read tries again
    // from where this one stored.
    return { ...result, outcome: 'failed' };
  }
}

/**
 * One page of events (AC-X-176, AC-X-177): each Pepper event compared with its booking. Answers
 * the strays to remove (their rows held) and how many bookings were queued to be put back.
 */
async function reconcilePage(
  tx: TenantTx,
  connection: CalendarConnectionRow,
  calendarId: string,
  events: readonly GoogleListedEvent[],
  at: { now: Date; askedAt: Date },
): Promise<{ strays: Stray[]; kept: number }> {
  const { now, askedAt } = at;
  const ours = events.flatMap((event) => {
    const bookingId = bookingIdOfCalendarEvent(event.id);
    // Not a Pepper id: the member's own event in this calendar, left alone (D-3).
    return bookingId === null ? [] : [{ event, bookingId }];
  });
  const rows = await findCalendarEventSyncsOfBookings(
    tx,
    ours.map((o) => o.bookingId),
  );
  const strays: Stray[] = [];
  let kept = 0;
  let timeZone: string | undefined;
  for (const { event, bookingId } of ours) {
    const live = event.status !== 'cancelled';
    const row = rows.get(bookingId);
    if (row === undefined) {
      // A Pepper id no booking of this business is written under: nothing will keep it.
      if (live) strays.push({ eventId: event.id, held: null });
      continue;
    }
    // Written after Google answered: this page may show it as it was before; the next read judges.
    if (row.updatedAt.getTime() >= askedAt.getTime()) continue;
    if (row.eventConnectionId !== connection.id || row.eventCalendarId !== calendarId) {
      // Its booking's event is elsewhere (or nowhere): this copy is a leftover, unless a write
      // still on its way belongs here (an insert whose answer was lost left no placement).
      // Held while it is removed, so no write puts the booking here meanwhile.
      if (live && !(await writeOnItsWayHere(tx, row, connection, now))) {
        const held = await leaseEventSyncForStray(tx, row.id, now, CALENDAR_WRITE_LEASE_MS);
        if (held !== undefined) strays.push({ eventId: event.id, held });
      }
      continue;
    }
    // A write is on its way (or failing and due again): it will put Pepper's version there.
    if (!isSettled(row, now)) continue;
    const source = await findBookingEventSource(tx, bookingId);
    if (
      source === undefined ||
      source.status === 'cancelled' ||
      source.staffMemberId !== connection.staffMemberId
    ) {
      // Shouldn't be here at all: the write pass removes it (no note, nothing was booked).
      if (live) await requeueSettledEventSync(tx, row, now, false);
      continue;
    }
    // A visit that has ended keeps its event as it was (renames don't rewrite it either).
    if (source.endsAt.getTime() <= now.getTime()) continue;
    const change = calendarEventChangeOf(eventBodyOf(source), event);
    if (change === null) continue;
    if (!(await requeueSettledEventSync(tx, row, now, true))) continue;
    kept += 1;
    timeZone ??= (await findCurrentTenant(tx))?.timeZone ?? 'UTC';
    await writeCalendarKeptNote(tx, {
      bookingId,
      staffMemberId: source.staffMemberId,
      clientId: source.clientId,
      serviceId: source.serviceId,
      day: formatDate(toZoned(timeZone, source.startsAt.getTime())),
      payload: { change, startsAt: UtcDateTimeSchema.parse(source.startsAt.toISOString()) },
      expiresAt: new Date(now.getTime() + CALENDAR_KEPT_NOTE_DAYS * DAY_MS),
    });
  }
  return { strays, kept };
}

/**
 * A write not yet settled whose booking belongs to this connection's staff member: it will put
 * the event here (AC-X-177: the read-back never removes what a write is putting there).
 */
async function writeOnItsWayHere(
  tx: TenantTx,
  row: CalendarEventSyncRow,
  connection: CalendarConnectionRow,
  now: Date,
): Promise<boolean> {
  if (isSettled(row, now)) return false;
  const source = await findBookingEventSource(tx, row.bookingId);
  return (
    source !== undefined &&
    source.status !== 'cancelled' &&
    source.staffMemberId === connection.staffMemberId
  );
}
