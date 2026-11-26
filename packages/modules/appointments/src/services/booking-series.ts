import {
  BookingIdSchema,
  BookingSeriesIdSchema,
  BookingSeriesInputSchema,
  BookingSeriesPreviewInputSchema,
  BusyQuerySchema,
  CancelFollowingInputSchema,
  TemplateIdSchema,
  UtcDateTimeSchema,
  VISIT_NUMBERS_MAX,
  VisitNumbersResponseSchema,
  seriesStarts,
  visitNumber,
  type AvailableSlot,
  type Booking,
  type BookingId,
  type BookingSeries,
  type BookingSeriesId,
  type BookingSeriesInput,
  type BookingSeriesPreview,
  type BookingSeriesPreviewInput,
  type BookingSeriesResult,
  type BusyQuery,
  type CancelFollowingInput,
  type CancelFollowingResult,
  type ClientId,
  type ServiceId,
  type SkippedVisit,
  type UserId,
  type VisitNumbersResponse,
} from '@pepper/contracts';
import { requirePermission, systemClock, type Actor } from '@pepper/core';
import {
  BookingOverlapError,
  BookingSeriesKeyTakenError,
  findBooking,
  findBookingSeries,
  findBookingSeriesByIdempotencyKey,
  findCurrentTenant,
  findService,
  findStaffMember,
  insertBooking,
  insertBookingSeries,
  listKeptVisitsOfSeries,
  listSeriesBookings,
  listSeriesVisitsStarting,
  listBookingRules,
  setBookingManageTokenHash,
  setBookingSeriesSkipped,
  withMember,
  type BookingRow,
  type BookingSeriesRow,
  type Database,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import { resolveRules } from '../availability/resolve-rules.js';
import {
  BookingNotFoundError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
} from '../errors.js';
import { rowsToRules, staffOwner, toBooking } from '../mapping.js';
import { noteFirstBookingIn } from './activation.js';
import { serviceToBook } from './availability.js';
import {
  changeBookingIn,
  getBookingIn,
  inSavepoint,
  isBookable,
  lockStaff,
  nearestAlternatives,
  recordCreated,
  type BookableSearch,
  type ChangeBookingOptions,
  type CreateBookingOptions,
} from './bookings.js';
import { findClientToBook } from './clients.js';
import { requestInsights } from './insights.js';
import { emailDetailsOf, newManageToken, type BookingEmailDetails } from './notices.js';

// Recurring appointments (S72, ADR-0070): a series is a set of ordinary bookings. A preview
// checks each date with the same check as one booking and writes nothing; booking a series
// checks each date again inside one transaction with the staff member locked, so later visits
// are checked against the ones just booked, and books the free dates (D-2). A visit moves on
// its own; "this and following" cancels each visit through the same cancel as one booking.

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The client's one email about a series (D-4), queued in the change's transaction. */
export type SeriesNotice =
  | {
      kind: 'series_confirmed';
      seriesId: BookingSeriesId;
      email: BookingEmailDetails;
      /** Every booked visit with its own reschedule/cancel link, earliest first. */
      visits: { startsAt: string; manageToken: string }[];
    }
  | {
      kind: 'series_cancelled';
      /** The visit "this and following" was asked from (one email per such cancel). */
      fromBookingId: BookingId;
      email: BookingEmailDetails;
      visits: { startsAt: string }[];
    };

/** Receives a series notice inside the change's transaction. */
export type SeriesNotify = (tx: TenantTx, notice: SeriesNotice) => Promise<void>;

export type PreviewSeriesOptions = Pick<CreateBookingOptions, 'clock' | 'templateRuleDefaults'>;

/**
 * The repeat's dates (AC-X-181), each checked as one booking would be (AC-X-182), with the
 * nearest free times of a date that isn't free. Nothing is booked or held. Staff preview only
 * their own staff member.
 */
export async function previewSeries(
  db: Database,
  actor: Actor,
  input: BookingSeriesPreviewInput,
  options: PreviewSeriesOptions = {},
): Promise<BookingSeriesPreview> {
  requirePermission(actor, 'bookings.manage');
  const request = BookingSeriesPreviewInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now().getTime();
  return withMember(db, actor.context, async (tx) => {
    const staff = await findStaffMember(tx, request.staffMemberId);
    if (staff === undefined) throw new StaffMemberNotFoundError();
    requirePermission(actor, 'bookings.manage', staffOwner(staff));
    const serviceRow = await findService(tx, request.serviceId);
    if (serviceRow === undefined) throw new ServiceNotFoundError();
    const service = serviceToBook(serviceRow);
    const tenant = await currentTenant(tx);
    const rules = resolveRules(
      rowsToRules(await listBookingRules(tx)).rules,
      request.staffMemberId,
      options.templateRuleDefaults?.(TemplateIdSchema.nullable().parse(tenant.templateId)) ?? {},
    );
    const horizon = now + rules.maximumAdvanceDays * DAY_MS;
    const visits = [];
    for (const start of seriesStarts(
      tenant.timeZone,
      Date.parse(request.startsAt),
      request.repeat,
    )) {
      const search: BookableSearch = {
        service,
        staffMemberId: request.staffMemberId,
        start,
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      const free = await isBookable(tx, search);
      visits.push({
        startsAt: iso(start),
        endsAt: iso(start + service.durationMinutes * MINUTE_MS),
        free,
        tooFarAhead: !free && start > horizon,
        alternatives: free ? [] : await alternativesIn(tx, search),
      });
    }
    return { visits, maximumAdvanceDays: rules.maximumAdvanceDays };
  });
}

export interface CreateSeriesOptions extends Omit<CreateBookingOptions, 'notify' | 'source'> {
  /** Told about the booked series inside its transaction, when `notifyClient` (D-4). */
  notify?: SeriesNotify;
}

/**
 * Books a series (AC-X-183): one transaction with the staff member locked; each start time is
 * checked again (also against the visits just booked before it), the free ones are booked and
 * the rest returned as skipped with the nearest free times. `SlotUnavailableError` when none is
 * free (nothing is kept). A retry with the key returns the first series. Staff book only their
 * own staff member; there is no override (AC-X-184).
 */
export async function createSeries(
  db: Database,
  actor: Actor,
  input: BookingSeriesInput,
  options: CreateSeriesOptions = {},
): Promise<BookingSeriesResult> {
  requirePermission(actor, 'bookings.manage');
  const request = BookingSeriesInputSchema.parse(input);
  const now = (options.clock ?? systemClock).now().getTime();
  const key = request.idempotencyKey ?? null;
  const starts = request.startsAts.map((start) => Date.parse(start));
  return withMember(db, actor.context, async (tx) => {
    await lockStaff(tx, actor, request.staffMemberId);
    // After the lock: a first attempt with the key (same staff member) has committed by now.
    const retried = async (): Promise<BookingSeriesResult | undefined> => {
      if (key === null) return undefined;
      const existing = await findBookingSeriesByIdempotencyKey(tx, key);
      if (existing === undefined) return undefined;
      // The same request: the staff member, rule and times asked, and the visits' client and
      // service (a series keeps neither: they are its visits', and a series has one at least).
      const visits = await listSeriesBookings(tx, BookingSeriesIdSchema.parse(existing.id));
      const same =
        existing.staffMemberId === request.staffMemberId &&
        existing.everyWeeks === request.everyWeeks &&
        existing.requestedStarts.length === starts.length &&
        existing.requestedStarts.every((start, index) => start.getTime() === starts[index]) &&
        visits.every(
          (visit) => visit.clientId === request.clientId && visit.serviceId === request.serviceId,
        );
      if (!same) throw new IdempotencyKeyReusedError();
      return resultOf(existing, visits);
    };
    const earlier = await retried();
    if (earlier !== undefined) return earlier;

    const serviceRow = await findService(tx, request.serviceId);
    if (serviceRow === undefined) throw new ServiceNotFoundError();
    const service = serviceToBook(serviceRow);
    await findClientToBook(tx, request.clientId, request.clientContact);

    let series: BookingSeriesRow;
    try {
      series = await inSavepoint(tx, (sp) =>
        insertBookingSeries(sp, {
          staffMemberId: request.staffMemberId,
          everyWeeks: request.everyWeeks,
          requestedStarts: starts.map((start) => new Date(start)),
          idempotencyKey: key,
          createdBy: actor.context.userId,
        }),
      );
    } catch (error) {
      if (!(error instanceof BookingSeriesKeyTakenError)) throw error;
      // A concurrent request with the key (another staff member's lock) won: answer as a retry.
      const winner = await retried();
      if (winner === undefined) throw new IdempotencyKeyReusedError();
      return winner;
    }

    const booked: BookingRow[] = [];
    const skipped: SkippedVisit[] = [];
    for (const start of starts) {
      const search: BookableSearch = {
        service,
        staffMemberId: request.staffMemberId,
        start,
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      const row = (await isBookable(tx, search))
        ? await bookVisit(tx, search, {
            clientId: request.clientId,
            serviceId: request.serviceId,
            priceFromCents: serviceRow.priceFromCents,
            priceToCents: serviceRow.priceToCents,
            seriesId: series.id,
            createdBy: actor.context.userId,
          })
        : undefined;
      if (row === undefined) {
        skipped.push({ startsAt: iso(start), alternatives: await alternativesIn(tx, search) });
      } else {
        booked.push(row);
      }
    }
    if (booked.length === 0) {
      // Rolls the series back with the transaction.
      throw new SlotUnavailableError(skipped[0]?.alternatives ?? []);
    }
    await setBookingSeriesSkipped(
      tx,
      BookingSeriesIdSchema.parse(series.id),
      skipped.map((visit) => new Date(visit.startsAt)),
    );
    await noteFirstBookingIn(tx);
    for (const row of booked) await recordCreated(tx, actor, row, now);
    await requestInsights(tx);
    const seriesId = BookingSeriesIdSchema.parse(series.id);
    if (request.notifyClient && options.notify) {
      await tellSeriesBooked(tx, seriesId, booked, options.notify);
    }
    return {
      seriesId,
      everyWeeks: series.everyWeeks,
      bookings: booked.map(toBooking),
      skipped,
    };
  });
}

/** A series' visits, earliest first (AC-X-186); staff reach only their own (not found else). */
export async function getSeries(
  db: Database,
  actor: Actor,
  seriesId: BookingSeriesId,
): Promise<BookingSeries> {
  requirePermission(actor, 'bookings.read');
  const id = BookingSeriesIdSchema.parse(seriesId);
  return withMember(db, actor.context, async (tx) => {
    const series = await findBookingSeries(tx, id);
    if (series === undefined) throw new BookingNotFoundError();
    const bookings = (await listSeriesBookings(tx, id)).map(toBooking);
    return { id, everyWeeks: series.everyWeeks, bookings };
  });
}

/**
 * "2 of 8" for every series visit starting in the range (S72.2, AC-X-193), in one read for the
 * calendar's blocks: each visit's place among its series' visits that aren't cancelled. Under
 * the member scope (AC-W9-1) staff number only their own visits; a visit of the series moved to a
 * colleague is not theirs to see, so it isn't counted for them.
 */
export async function listVisitNumbers(
  db: Database,
  actor: Actor,
  query: BusyQuery,
): Promise<VisitNumbersResponse> {
  requirePermission(actor, 'bookings.read');
  const { from, to, staffMemberId } = BusyQuerySchema.parse(query);
  return withMember(db, actor.context, async (tx) => {
    const found = await listSeriesVisitsStarting(tx, {
      from: new Date(from),
      to: new Date(to),
      limit: VISIT_NUMBERS_MAX + 1,
      ...(staffMemberId !== undefined && { staffMemberId }),
    });
    const inRange = found.slice(0, VISIT_NUMBERS_MAX);
    const seriesIds = [
      ...new Set(inRange.flatMap((row) => (row.seriesId === null ? [] : [row.seriesId]))),
    ].map((id) => BookingSeriesIdSchema.parse(id));
    const bySeries = new Map<string, { id: string; startsAt: string; status: string }[]>();
    for (const row of await listKeptVisitsOfSeries(tx, seriesIds)) {
      if (row.seriesId === null) continue;
      const visits = bySeries.get(row.seriesId) ?? [];
      visits.push({ id: row.id, startsAt: row.startsAt.toISOString(), status: row.status });
      bySeries.set(row.seriesId, visits);
    }
    const visits = inRange.flatMap((row) => {
      const place =
        row.seriesId === null ? null : visitNumber(bySeries.get(row.seriesId) ?? [], row.id);
      return place === null ? [] : [{ bookingId: row.id, ...place }];
    });
    return VisitNumbersResponseSchema.parse({
      visits,
      truncated: found.length > VISIT_NUMBERS_MAX,
    });
  });
}

export interface CancelFollowingOptions extends Omit<ChangeBookingOptions, 'notify'> {
  /** Told about the cancelled visits inside the transaction, when `notifyClient` (D-4). */
  notify?: SeriesNotify;
}

/**
 * Cancels this visit and the later confirmed visits of its series (D-3, AC-X-186), each through
 * the same cancel as one booking (the waitlist, a deposit's refund, the reminder), in one
 * transaction. A booking outside a series is cancelled alone. Errors as `changeBooking`'s.
 */
export async function cancelFollowing(
  db: Database,
  actor: Actor,
  bookingId: BookingId,
  input: CancelFollowingInput,
  options: CancelFollowingOptions = {},
): Promise<CancelFollowingResult> {
  requirePermission(actor, 'bookings.manage');
  const id = BookingIdSchema.parse(bookingId);
  const { notifyClient } = CancelFollowingInputSchema.parse(input);
  const { notify, ...changeOptions } = options;
  return withMember(db, actor.context, async (tx) => {
    const booking = await getBookingIn(tx, actor, id);
    const later =
      booking.seriesId === null || booking.seriesId === undefined
        ? []
        : (await listSeriesBookings(tx, booking.seriesId)).filter(
            (row) =>
              row.id !== booking.id &&
              row.status === 'confirmed' &&
              row.startsAt.getTime() >= Date.parse(booking.startsAt),
          );
    const cancelled: Booking[] = [];
    // This visit first: it refuses the whole cancel when it can't be cancelled itself.
    for (const visitId of [id, ...later.map((row) => BookingIdSchema.parse(row.id))]) {
      cancelled.push(
        await changeBookingIn(
          tx,
          actor,
          visitId,
          { status: 'cancelled', notifyClient: false },
          changeOptions,
        ),
      );
    }
    if (notifyClient && notify) await tellSeriesCancelled(tx, id, cancelled, notify);
    return { bookings: cancelled };
  });
}

/** Books one visit in a savepoint; `undefined` when an overlap refuses it (a race). */
async function bookVisit(
  tx: TenantTx,
  search: BookableSearch,
  visit: {
    clientId: ClientId;
    serviceId: ServiceId;
    priceFromCents: number | null;
    priceToCents: number | null;
    seriesId: string;
    createdBy: UserId;
  },
): Promise<BookingRow | undefined> {
  try {
    return await inSavepoint(tx, (sp) =>
      insertBooking(sp, {
        clientId: visit.clientId,
        serviceId: visit.serviceId,
        staffMemberId: search.staffMemberId,
        startsAt: new Date(search.start),
        endsAt: new Date(search.start + search.service.durationMinutes * MINUTE_MS),
        bufferBeforeMinutes: search.service.bufferBeforeMinutes,
        bufferAfterMinutes: search.service.bufferAfterMinutes,
        priceFromCents: visit.priceFromCents,
        priceToCents: visit.priceToCents,
        source: 'team',
        overridden: false,
        idempotencyKey: null,
        createdBy: visit.createdBy,
        seriesId: visit.seriesId,
      }),
    );
  } catch (error) {
    if (error instanceof BookingOverlapError) return undefined;
    throw error;
  }
}

/**
 * A retry's answer: the series' visits as they are now, and the dates that weren't free when it
 * was booked (kept on the series; their alternatives are not read again).
 */
function resultOf(series: BookingSeriesRow, visits: BookingRow[]): BookingSeriesResult {
  return {
    seriesId: BookingSeriesIdSchema.parse(series.id),
    everyWeeks: series.everyWeeks,
    bookings: visits.map(toBooking),
    skipped: series.skippedStarts.map((start) => ({
      startsAt: iso(start.getTime()),
      alternatives: [],
    })),
  };
}

/** The client's one email with every booked visit, each with a new reschedule/cancel link. */
async function tellSeriesBooked(
  tx: TenantTx,
  seriesId: BookingSeriesId,
  booked: BookingRow[],
  notify: SeriesNotify,
): Promise<void> {
  const email = await emailOf(tx, booked);
  if (email === undefined) return;
  const visits = [];
  for (const row of booked) {
    const link = newManageToken();
    await setBookingManageTokenHash(tx, BookingIdSchema.parse(row.id), link.hash);
    visits.push({ startsAt: row.startsAt.toISOString(), manageToken: link.token });
  }
  await notify(tx, { kind: 'series_confirmed', seriesId, email, visits });
}

/** The client's one email with every visit just cancelled. */
async function tellSeriesCancelled(
  tx: TenantTx,
  fromBookingId: BookingId,
  cancelled: Booking[],
  notify: SeriesNotify,
): Promise<void> {
  const rows = [];
  for (const booking of cancelled) {
    const row = await findBooking(tx, BookingIdSchema.parse(booking.id));
    if (row !== undefined) rows.push(row);
  }
  const email = await emailOf(tx, rows);
  if (email === undefined) return;
  // The business cancelled, so its policy's costs aren't the client's to read (as one cancel).
  const policy = { sentence: null, note: null };
  await notify(tx, {
    kind: 'series_cancelled',
    fromBookingId,
    email: { ...email, policy },
    visits: rows
      .map((row) => ({ startsAt: row.startsAt.toISOString() }))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)),
  });
}

/** The email details of the first visit; `undefined` without an address on file. */
async function emailOf(tx: TenantTx, rows: BookingRow[]): Promise<BookingEmailDetails | undefined> {
  const first = [...rows].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0];
  if (first === undefined) return undefined;
  const tenant = await findCurrentTenant(tx);
  // The transaction's own business always exists.
  if (tenant === undefined) throw new BookingNotFoundError();
  const email = await emailDetailsOf(tx, tenant, first);
  return email.email === '' ? undefined : email;
}

async function currentTenant(tx: TenantTx): Promise<Tenant> {
  const tenant = await findCurrentTenant(tx);
  // The transaction's own business always exists.
  if (tenant === undefined) throw new BookingNotFoundError();
  return tenant;
}

function alternativesIn(tx: TenantTx, search: BookableSearch): Promise<AvailableSlot[]> {
  return nearestAlternatives((work) => work(tx), search);
}

function iso(instant: number) {
  return UtcDateTimeSchema.parse(new Date(instant).toISOString());
}
