import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  AvailabilityQuerySchema,
  BookingIdSchema,
  BookingRequestIdSchema,
  BookingRequestInputSchema,
  ClientContactSchema,
  ClientEmailSchema,
  ClientIdSchema,
  ManageTokenSchema,
  MAX_VERIFICATION_ATTEMPTS,
  PublicBusinessSchema,
  PublicBookingSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantSlugSchema,
  UtcDateTimeSchema,
  VERIFICATION_CODE_TTL_MINUTES,
  VerificationCodeSchema,
  type AvailabilityQueryInput,
  type AvailableSlot,
  type BookingRequestId,
  type BookingRequestInput,
  type ManageToken,
  type PublicBooking,
  type PublicBusiness,
  type StaffMemberId,
  type TenantSlug,
  type UtcDateTime,
  type VerificationCode,
} from '@pepper/contracts';
import { systemClock, type Clock } from '@pepper/core';
import {
  addVerificationAttempt,
  appendAuditEntry,
  BookingOverlapError,
  countBookingVerificationsExpiringAfter,
  findBookingByManageTokenHash,
  findClient,
  findClientsByContact,
  findService,
  findStaffMember,
  insertBooking,
  insertBookingVerification,
  insertClient,
  listServices,
  listStaffMembers,
  lockBookingByManageTokenHash,
  lockBookingVerification,
  lockStaffMember,
  moveBooking,
  setBookingStatus,
  setVerificationBooking,
  withPublicTenant,
  type BookingRow,
  type ClientRow,
  type Database,
  type ServiceRow,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import type { ServiceToBook } from '../availability/engine.js';
import { toAvailableSlot } from '../bookings/planning.js';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingPageNotFoundError,
  BookingRequestExpiredError,
  BookingRequestNotFoundError,
  BookingRequestUsedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
  TooManyBookingRequestsError,
  WrongVerificationCodeError,
} from '../errors.js';
import { bookingAuditValues } from '../mapping.js';
import { serviceToBook, slotsFor, type TemplateRuleDefaultsOf } from './availability.js';
import {
  isBookable,
  nearestAlternatives,
  SlotTaken,
  type AlternativesSearch,
  type OpenTransaction,
} from './bookings.js';

// The public booking page (W8, ADR-0022). Anyone may read a business's menu, team and free
// times by its slug. Booking takes two steps: a request stores the wanted time and the
// client's details with the keyed hash of a 6-digit code, which the caller emails; confirming
// the code books the time, if it is still free, and returns the secret of a link, scoped to
// that booking, to reschedule or cancel it (AC-W8-2). The page works without a user, so every
// function here returns only what a visitor may see, and audits as the system.

const MINUTE_MS = 60_000;

/** Booking requests one email address may make per business per hour. */
export const MAX_REQUESTS_PER_EMAIL_PER_HOUR = 5;

export interface PublicOptions {
  clock?: Clock;
  templateRuleDefaults?: TemplateRuleDefaultsOf;
}

/** What a booking page call needs to hash codes: a secret key of the deployment. */
export interface CodeOptions extends PublicOptions {
  /** HMAC key for the stored code hashes (at least 32 bytes), never stored with them. */
  codeKey: Buffer;
}

/** Details of the business and booking for the email the caller sends. */
export interface BookingEmailDetails {
  businessName: string;
  timeZone: string;
  serviceName: string;
  staffName: string | null;
  startsAt: string;
  email: string;
  clientName: string;
}

/** The menu and team the booking page shows. */
export async function getPublicBusiness(db: Database, slug: TenantSlug): Promise<PublicBusiness> {
  return inPage(
    db,
    slug,
    async (tx, tenant) => {
      const services = (await listServices(tx)).filter((s) => s.active);
      const activeServices = new Set(services.map((s) => s.id));
      const staff = (await listStaffMembers(tx))
        .filter((s) => s.active)
        .map((s) => ({ ...s, serviceIds: s.serviceIds.filter((id) => activeServices.has(id)) }))
        .filter((s) => s.serviceIds.length > 0);
      // A service nobody offers cannot be booked, so the page does not list it.
      const offered = new Set(staff.flatMap((s) => s.serviceIds));
      return PublicBusinessSchema.parse({
        name: tenant.name,
        slug: tenant.slug,
        timeZone: tenant.timeZone,
        brandColor: tenant.brandColor,
        services: services
          .filter((s) => offered.has(s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            durationMinutes: s.durationMinutes,
            priceFromCents: s.priceFromCents,
            priceToCents: s.priceToCents,
          })),
        staff: staff.map((s) => ({
          id: s.id,
          displayName: s.displayName,
          color: s.color,
          serviceIds: s.serviceIds,
        })),
      });
    },
    { readOnly: true },
  );
}

/**
 * Free start times in [from, to) for an active service, with one staff member or anyone; at
 * most `limit`, earliest first. With anyone, one time per start.
 */
export async function findPublicAvailability(
  db: Database,
  slug: TenantSlug,
  query: AvailabilityQueryInput,
  options: PublicOptions & { limit?: number } = {},
): Promise<AvailableSlot[]> {
  const { serviceId, staffMemberId, from, to } = AvailabilityQuerySchema.parse(query);
  const now = nowOf(options);
  return inPage(
    db,
    slug,
    async (tx) => {
      const service = await bookableService(tx, serviceId);
      const slots = await slotsFor(tx, {
        service,
        staffMemberIds: staffMemberId === undefined ? undefined : [staffMemberId],
        from: Date.parse(from),
        to: Date.parse(to),
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      });
      const unique =
        staffMemberId === undefined
          ? slots.filter((s, i) => slots.findIndex((o) => o.start === s.start) === i)
          : slots;
      const kept = options.limit === undefined ? unique : unique.slice(0, options.limit);
      return kept.map(toAvailableSlot);
    },
    { readOnly: true },
  );
}

/**
 * Asks to book a time: checks that it is free now and stores the request with the hash of a
 * new code, which the caller emails to the client. `SlotUnavailableError` (with alternatives)
 * when the time is not free, `TooManyBookingRequestsError` after
 * `MAX_REQUESTS_PER_EMAIL_PER_HOUR` requests for the email address.
 */
export async function requestBooking(
  db: Database,
  slug: TenantSlug,
  input: BookingRequestInput,
  options: CodeOptions,
): Promise<{
  requestId: BookingRequestId;
  expiresAt: UtcDateTime;
  code: VerificationCode;
  email: BookingEmailDetails;
}> {
  const request = BookingRequestInputSchema.parse(input);
  const now = nowOf(options);
  const start = Date.parse(request.startsAt);
  const code = VerificationCodeSchema.parse(String(randomInt(0, 1_000_000)).padStart(6, '0'));
  let search: AlternativesSearch | undefined;
  try {
    return await inPage(db, slug, async (tx, tenant) => {
      // Requests of the last hour: their codes expire after an hour ago plus the code's life.
      const after = new Date(now - (60 - VERIFICATION_CODE_TTL_MINUTES) * MINUTE_MS);
      if (
        (await countBookingVerificationsExpiringAfter(tx, request.email, after)) >=
        MAX_REQUESTS_PER_EMAIL_PER_HOUR
      ) {
        throw new TooManyBookingRequestsError();
      }
      const serviceRow = await activeServiceRow(tx, request.serviceId);
      const service = serviceToBook(serviceRow);
      const staffName =
        request.staffMemberId === null ? null : await activeStaffName(tx, request.staffMemberId);
      search = {
        service,
        staffMemberId: request.staffMemberId ?? undefined,
        start,
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      if ((await bookableStaff(tx, search)).length === 0) throw new SlotTaken();
      const expiresAt = new Date(now + VERIFICATION_CODE_TTL_MINUTES * MINUTE_MS);
      const row = await insertBookingVerification(tx, {
        serviceId: ServiceIdSchema.parse(serviceRow.id),
        staffMemberId: request.staffMemberId,
        startsAt: new Date(start),
        name: request.name,
        email: request.email,
        phone: request.phone,
        codeHash: codeHash(options.codeKey, request.email, code),
        expiresAt,
      });
      return {
        requestId: BookingRequestIdSchema.parse(row.id),
        expiresAt: UtcDateTimeSchema.parse(expiresAt.toISOString()),
        code,
        email: {
          businessName: tenant.name,
          timeZone: tenant.timeZone,
          serviceName: serviceRow.name,
          staffName,
          startsAt: new Date(start).toISOString(),
          email: request.email,
          clientName: request.name,
        },
      };
    });
  } catch (error) {
    if (error instanceof SlotTaken && search) {
      throw new SlotUnavailableError(await nearestAlternatives(pageReader(db, slug), search));
    }
    throw error;
  }
}

/**
 * Confirms a request with the code the client typed and books the time: the client is found
 * by the verified email address or added, and the booking gets a reschedule/cancel link whose
 * secret is returned (only its hash is stored). A wrong code counts an attempt
 * (`WrongVerificationCodeError`); an expired or exhausted request needs a new code
 * (`BookingRequestExpiredError`); a used one is `BookingRequestUsedError`. When the time was
 * taken meanwhile: `SlotUnavailableError` with alternatives, and the request stays usable for
 * nothing else (the client asks for a new time).
 */
export async function confirmBookingRequest(
  db: Database,
  slug: TenantSlug,
  requestId: BookingRequestId,
  typed: VerificationCode,
  options: CodeOptions,
): Promise<{ booking: PublicBooking; manageToken: ManageToken; email: BookingEmailDetails }> {
  const id = BookingRequestIdSchema.parse(requestId);
  const code = VerificationCodeSchema.parse(typed);
  const now = nowOf(options);

  // A wrong code must count even though the answer is an error, so checking commits first.
  const checked = await inPage(db, slug, async (tx) => {
    const request = await lockBookingVerification(tx, id);
    if (request === undefined) return { outcome: 'not_found' } as const;
    if (request.bookingId !== null) return { outcome: 'used' } as const;
    if (request.expiresAt.getTime() <= now || request.attempts >= MAX_VERIFICATION_ATTEMPTS) {
      return { outcome: 'expired' } as const;
    }
    if (!sameHash(request.codeHash, codeHash(options.codeKey, request.email, code))) {
      const attempts = await addVerificationAttempt(tx, id);
      return { outcome: 'wrong', attemptsLeft: MAX_VERIFICATION_ATTEMPTS - attempts } as const;
    }
    return { outcome: 'right' } as const;
  });
  switch (checked.outcome) {
    case 'not_found':
      throw new BookingRequestNotFoundError();
    case 'used':
      throw new BookingRequestUsedError();
    case 'expired':
      throw new BookingRequestExpiredError();
    case 'wrong':
      if (checked.attemptsLeft <= 0) throw new BookingRequestExpiredError();
      throw new WrongVerificationCodeError(checked.attemptsLeft);
    case 'right':
      break;
  }

  const manageToken = ManageTokenSchema.parse(randomBytes(32).toString('base64url'));
  let search: AlternativesSearch | undefined;
  try {
    return await inPage(db, slug, async (tx, tenant) => {
      const request = await lockBookingVerification(tx, id);
      // Locked again: a concurrent confirmation with the same code may have won meanwhile.
      if (request === undefined) throw new BookingRequestNotFoundError();
      if (request.bookingId !== null) throw new BookingRequestUsedError();
      const serviceRow = await activeServiceRow(tx, ServiceIdSchema.parse(request.serviceId));
      const service = serviceToBook(serviceRow);
      const wanted =
        request.staffMemberId === null
          ? undefined
          : StaffMemberIdSchema.parse(request.staffMemberId);
      const start = request.startsAt.getTime();
      search = {
        service,
        staffMemberId: wanted,
        start,
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      const staffMemberId = await lockFirstBookable(tx, search);
      const client = await clientFor(tx, request);
      const row = await insertBooking(tx, {
        clientId: ClientIdSchema.parse(client.id),
        serviceId: service.id,
        staffMemberId,
        startsAt: new Date(start),
        endsAt: new Date(start + service.durationMinutes * MINUTE_MS),
        bufferBeforeMinutes: service.bufferBeforeMinutes,
        bufferAfterMinutes: service.bufferAfterMinutes,
        priceFromCents: serviceRow.priceFromCents,
        priceToCents: serviceRow.priceToCents,
        source: 'booking_page',
        overridden: false,
        idempotencyKey: null,
        createdBy: null,
        manageTokenHash: manageTokenHash(manageToken),
      });
      await setVerificationBooking(tx, id, BookingIdSchema.parse(row.id));
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'booking.created',
          entity: { type: 'booking', id: row.id },
          before: null,
          after: bookingAuditValues(row),
        },
      });
      const booking = await toPublicBooking(tx, row, now);
      return {
        booking,
        manageToken,
        email: {
          businessName: tenant.name,
          timeZone: tenant.timeZone,
          serviceName: booking.service.name,
          staffName: booking.staff.displayName,
          startsAt: booking.startsAt,
          email: request.email,
          clientName: client.name,
        },
      };
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && search) {
      throw new SlotUnavailableError(await nearestAlternatives(pageReader(db, slug), search));
    }
    throw error;
  }
}

/** The booking behind a reschedule/cancel link (`BookingNotFoundError` for an unknown one). */
export async function getManagedBooking(
  db: Database,
  slug: TenantSlug,
  token: ManageToken,
  options: PublicOptions = {},
): Promise<PublicBooking> {
  const hash = manageTokenHash(ManageTokenSchema.parse(token));
  const now = nowOf(options);
  return inPage(
    db,
    slug,
    async (tx) => {
      const row = await findBookingByManageTokenHash(tx, hash);
      if (row === undefined) throw new BookingNotFoundError();
      return toPublicBooking(tx, row, now);
    },
    { readOnly: true },
  );
}

/** Cancels the booking behind a link, while it is confirmed and has not started. */
export async function cancelManagedBooking(
  db: Database,
  slug: TenantSlug,
  token: ManageToken,
  options: PublicOptions = {},
): Promise<{ booking: PublicBooking; email: BookingEmailDetails }> {
  const hash = manageTokenHash(ManageTokenSchema.parse(token));
  const now = nowOf(options);
  return inPage(db, slug, async (tx, tenant) => {
    const row = await lockChangeable(tx, hash, now);
    const cancelled = await setBookingStatus(tx, BookingIdSchema.parse(row.id), 'cancelled');
    if (cancelled === undefined) throw new BookingNotFoundError();
    await auditUpdate(tx, row, cancelled);
    return withEmail(tx, tenant, cancelled, now);
  });
}

/**
 * Moves the booking behind a link to another free time with the same service and staff
 * member, while it is confirmed and has not started. `SlotUnavailableError` with alternatives.
 */
export async function rescheduleManagedBooking(
  db: Database,
  slug: TenantSlug,
  token: ManageToken,
  startsAt: string,
  options: PublicOptions = {},
): Promise<{ booking: PublicBooking; email: BookingEmailDetails }> {
  const hash = manageTokenHash(ManageTokenSchema.parse(token));
  const start = Date.parse(UtcDateTimeSchema.parse(startsAt));
  const now = nowOf(options);
  let search: AlternativesSearch | undefined;
  try {
    return await inPage(db, slug, async (tx, tenant) => {
      const row = await lockChangeable(tx, hash, now);
      const staffMemberId = StaffMemberIdSchema.parse(row.staffMemberId);
      const staff = await lockStaffMember(tx, staffMemberId);
      if (staff === undefined) throw new StaffMemberNotFoundError();
      // The booking keeps the service as it was booked (duration and buffers).
      const service: ServiceToBook = {
        id: ServiceIdSchema.parse(row.serviceId),
        active: true,
        durationMinutes: (row.endsAt.getTime() - row.startsAt.getTime()) / MINUTE_MS,
        bufferBeforeMinutes: row.bufferBeforeMinutes,
        bufferAfterMinutes: row.bufferAfterMinutes,
      };
      search = {
        service,
        staffMemberId,
        excludeBookingId: row.id,
        start,
        now,
        templateRuleDefaults: options.templateRuleDefaults,
      };
      if (!(await isBookable(tx, { ...search, staffMemberId }))) throw new SlotTaken();
      const moved = await moveBooking(tx, BookingIdSchema.parse(row.id), {
        staffMemberId,
        startsAt: new Date(start),
        endsAt: new Date(start + service.durationMinutes * MINUTE_MS),
        overridden: false,
      });
      if (moved === undefined) throw new BookingNotFoundError();
      await auditUpdate(tx, row, moved);
      return withEmail(tx, tenant, moved, now);
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && search) {
      throw new SlotUnavailableError(await nearestAlternatives(pageReader(db, slug), search));
    }
    throw error;
  }
}

/** SHA-256 (hex) of a link token: 256 random bits need no key or slow hash (as invites). */
export function manageTokenHash(token: ManageToken): string {
  return createHash('sha256').update(ManageTokenSchema.parse(token)).digest('hex');
}

/**
 * The stored form of a code: HMAC-SHA256 under the deployment's key, bound to the email
 * address. A million codes are quick to try, so a leaked table without the key reveals none.
 */
export function codeHash(key: Buffer, email: string, code: VerificationCode): string {
  if (key.length < 32) throw new RangeError('The code key needs at least 32 bytes');
  return createHmac('sha256', key)
    .update(`${ClientEmailSchema.parse(email)}\n${VerificationCodeSchema.parse(code)}`)
    .digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function nowOf(options: PublicOptions): number {
  return (options.clock ?? systemClock).now().getTime();
}

/** Runs `work` for the business at `slug`; `BookingPageNotFoundError` when there is none. */
async function inPage<T>(
  db: Database,
  slug: TenantSlug,
  work: (tx: TenantTx, tenant: Tenant) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  const parsed = TenantSlugSchema.safeParse(slug);
  if (!parsed.success) throw new BookingPageNotFoundError();
  // Boxed, so a business without a page tells apart from `work` returning `undefined`.
  const result = await withPublicTenant(
    db,
    parsed.data,
    async (tx, tenant) => ({ value: await work(tx, tenant) }),
    options,
  );
  if (result === undefined) throw new BookingPageNotFoundError();
  return result.value;
}

/** A read-only transaction of the page, for alternatives after a refused write. */
function pageReader(db: Database, slug: TenantSlug): OpenTransaction {
  return (work) => inPage(db, slug, work, { readOnly: true });
}

/** An active service of the business (`ServiceNotFoundError` otherwise, also if inactive). */
async function activeServiceRow(tx: TenantTx, serviceId: string): Promise<ServiceRow> {
  const row = await findService(tx, ServiceIdSchema.parse(serviceId));
  if (!row?.active) throw new ServiceNotFoundError();
  return row;
}

async function bookableService(tx: TenantTx, serviceId: string): Promise<ServiceToBook> {
  return serviceToBook(await activeServiceRow(tx, serviceId));
}

/** An active staff member's name (`StaffMemberNotFoundError` otherwise). */
async function activeStaffName(tx: TenantTx, staffMemberId: StaffMemberId): Promise<string> {
  const staff = await findStaffMember(tx, staffMemberId);
  if (!staff?.active) throw new StaffMemberNotFoundError();
  return staff.displayName;
}

/** The staff members who can take the time now (the wanted one, or anyone), by id. */
async function bookableStaff(tx: TenantTx, search: AlternativesSearch): Promise<StaffMemberId[]> {
  const slots = await slotsFor(tx, {
    service: search.service,
    staffMemberIds: search.staffMemberId === undefined ? undefined : [search.staffMemberId],
    from: search.start,
    to: search.start + 1,
    now: search.now,
    templateRuleDefaults: search.templateRuleDefaults,
  });
  return [
    ...new Set(slots.filter((s) => s.start === search.start).map((s) => s.staffMemberId)),
  ].sort();
}

/**
 * Locks and returns the first staff member who can still take the time (by id, so concurrent
 * confirmations lock in the same order). Checked again under each lock, as `createBooking`
 * does, so the daily caps hold under concurrency. `SlotTaken` when nobody can.
 */
async function lockFirstBookable(tx: TenantTx, search: AlternativesSearch): Promise<StaffMemberId> {
  for (const staffMemberId of await bookableStaff(tx, search)) {
    await lockStaffMember(tx, staffMemberId);
    if (await isBookable(tx, { ...search, staffMemberId })) return staffMemberId;
  }
  throw new SlotTaken();
}

/**
 * The business's client with the verified email address, or a new one from the request. An
 * existing client keeps the name and phone the business has for them.
 */
async function clientFor(
  tx: TenantTx,
  request: { name: string; email: string; phone: string | null },
): Promise<ClientRow> {
  const email = ClientEmailSchema.parse(request.email);
  const [existing] = (await findClientsByContact(tx, ClientContactSchema.parse(email))).filter(
    (c) => c.email === email,
  );
  if (existing !== undefined) return existing;
  const client = await insertClient(tx, {
    name: request.name,
    email,
    phone: request.phone,
    source: 'booking_page',
  });
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'client.created',
      entity: { type: 'client', id: client.id },
      before: null,
      after: { source: 'booking_page' },
    },
  });
  return client;
}

/** The booking behind a link, locked, if the client may still change it. */
async function lockChangeable(tx: TenantTx, hash: string, now: number): Promise<BookingRow> {
  const row = await lockBookingByManageTokenHash(tx, hash);
  if (row === undefined) throw new BookingNotFoundError();
  if (!isChangeable(row, now)) throw new BookingNotChangeableError();
  return row;
}

function isChangeable(row: BookingRow, now: number): boolean {
  return row.status === 'confirmed' && row.startsAt.getTime() > now;
}

async function auditUpdate(tx: TenantTx, before: BookingRow, after: BookingRow): Promise<void> {
  await appendAuditEntry(tx, {
    actor: { kind: 'system' },
    change: {
      action: 'booking.updated',
      entity: { type: 'booking', id: after.id },
      before: bookingAuditValues(before),
      after: bookingAuditValues(after),
    },
  });
}

/** A booking as its client sees it. */
async function toPublicBooking(tx: TenantTx, row: BookingRow, now: number): Promise<PublicBooking> {
  const service = await findService(tx, ServiceIdSchema.parse(row.serviceId));
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(row.staffMemberId));
  // Bookings reference both with foreign keys, and neither is ever deleted.
  if (service === undefined || staff === undefined) throw new BookingNotFoundError();
  return PublicBookingSchema.parse({
    status: row.status,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    service: { id: service.id, name: service.name },
    staff: { id: staff.id, displayName: staff.displayName },
    changeable: isChangeable(row, now),
  });
}

async function withEmail(
  tx: TenantTx,
  tenant: Tenant,
  row: BookingRow,
  now: number,
): Promise<{ booking: PublicBooking; email: BookingEmailDetails }> {
  const booking = await toPublicBooking(tx, row, now);
  const client = await findClient(tx, ClientIdSchema.parse(row.clientId));
  // Bookings reference their client with a foreign key.
  if (client === undefined) throw new BookingNotFoundError();
  return {
    booking,
    email: {
      businessName: tenant.name,
      timeZone: tenant.timeZone,
      serviceName: booking.service.name,
      staffName: booking.staff.displayName,
      startsAt: booking.startsAt,
      // The address the link was sent to, or the one the business has on file now.
      email: client.email ?? '',
      clientName: client.name,
    },
  };
}
