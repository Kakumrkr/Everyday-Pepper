import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import {
  AvailabilityQuerySchema,
  BookingConfirmInputSchema,
  BookingIdSchema,
  BookingRequestIdSchema,
  BookingRequestInputSchema,
  depositTermsOf,
  SmsConsentWordingVersionSchema,
  ClientContactSchema,
  ClientEmailSchema,
  ClientIdSchema,
  ManageTokenSchema,
  MAX_VERIFICATION_ATTEMPTS,
  OfferTokenSchema,
  PublicOfferSchema,
  PublicBusinessSchema,
  PublicBookingSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  TenantSlugSchema,
  UtcDateTimeSchema,
  VERIFICATION_CODE_TTL_MINUTES,
  VerificationCodeSchema,
  WaitlistConfirmInputSchema,
  WaitlistEntryIdSchema,
  WaitlistEntryInputSchema,
  WaitlistMatchIdSchema,
  WaitlistRequestInputSchema,
  PublicWaitlistEntrySchema,
  WaitlistOfferIdSchema,
  type AvailabilityQueryInput,
  type AvailableSlot,
  type BookingConfirmInput,
  type BookingRequestId,
  type BookingRequestInput,
  type DepositTerms,
  type DeviceToken,
  type PublicBookingDeposit,
  type ManageToken,
  type OfferToken,
  type PublicBooking,
  type PublicOffer,
  type PublicBusiness,
  type StaffMemberId,
  type TenantId,
  type TenantSlug,
  type UtcDateTime,
  type VerificationCode,
  type PublicWaitlistEntry,
  type WaitlistConfirmInput,
  type WaitlistRequestInput,
  type WaitlistWindow,
} from '@pepper/contracts';
import { recordSmsConsent, systemClock, type Clock } from '@pepper/core';
import {
  addVerificationAttempt,
  appendAuditEntry,
  BookingOverlapError,
  countBookingVerificationsExpiringAfter,
  depositRuleOf,
  findBookingByManageTokenHash,
  findClient,
  findClientsByContact,
  findWaitlistOfferByTokenHash,
  findService,
  findStaffMember,
  insertBooking,
  insertBookingVerification,
  insertClient,
  insertWaitlistEntry,
  listOffersOfMatch,
  listWaitlistEntries,
  listServices,
  listStaffMembers,
  listWorkingHoursOf,
  lockBookingByManageTokenHash,
  extendBookingVerification,
  lockBookingVerification,
  lockStaffMember,
  lockWaitlistEntry,
  lockWaitlistMatch,
  markOfferClaimed,
  moveBooking,
  setBookingStatus,
  setVerificationBooking,
  setVerificationWaitlistEntry,
  settleOpenOffers,
  withPublicTenant,
  type BookingRow,
  type ClientRow,
  type Database,
  type ServiceRow,
  type Tenant,
  type TenantTx,
  type WaitlistOfferRow,
} from '@pepper/db';
import type { ServiceToBook } from '../availability/engine.js';
import { businessPhotosIn } from './business-photos.js';
import { addDays, formatDate, fromZoned, parseDate, toZoned } from '../availability/zoned-time.js';
import { toAvailableSlot, waitlistExpiry } from '../bookings/planning.js';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingPageNotFoundError,
  BookingRequestExpiredError,
  BookingRequestNotFoundError,
  BookingRequestUsedError,
  DepositsClosedError,
  PaymentNotNeededError,
  PaymentRequiredError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
  TooManyBookingRequestsError,
  WaitlistDayTooFarError,
  WaitlistExpiredError,
  WaitlistOfferExpiredError,
  WaitlistOfferNotFoundError,
  WaitlistOfferTakenError,
  WaitlistOfferUsedError,
  WrongVerificationCodeError,
} from '../errors.js';
import type { WaitlistTakenNotify } from './booking-emails.js';
import {
  changeEntryStatus,
  offerTokenHash,
  releaseEntry,
  requestWaitlistMatch,
  takeBackWaitlistOffersIn,
} from './smart-waitlist.js';
import { bookingAuditValues, waitlistAuditValues } from '../mapping.js';
import { noteFirstBookingIn } from './activation.js';
import { serviceToBook, slotsFor, type TemplateRuleDefaultsOf } from './availability.js';
import {
  changeOf,
  emailDetailsOf,
  manageTokenHash,
  newManageToken,
  type BookingEmailDetails,
  type BookingNotify,
} from './notices.js';
import { requestInsights } from './insights.js';
import { recognizeDeviceIn, rememberDeviceIn } from './remembered-devices.js';
import { keepReminderInStep } from './reminders.js';
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

/** How many local days ahead (today counting) the booking page's waitlist takes (S38a). */
export const PUBLIC_WAITLIST_DAYS = 62;

/** Booking requests one email address may make per business per hour. */
export const MAX_REQUESTS_PER_EMAIL_PER_HOUR = 5;

export interface PublicOptions {
  clock?: Clock;
  templateRuleDefaults?: TemplateRuleDefaultsOf;
  /**
   * Called inside a change's transaction with what the client is told about, so an email the
   * caller queues there (the outbox, ADR-0024) commits with the change, or not at all.
   */
  notify?: BookingNotify;
  /** Deposits and cards on file (S66, ADR-0068): absent, deposit services can't be booked. */
  deposits?: PublicDeposits | undefined;
}

/**
 * What the booking page asks of payments (S66, ADR-0068 §3–4), given by the caller so that
 * appointments never depends on the payments module.
 */
export interface PublicDeposits {
  /** Whether the business can take a deposit now (its account, in this deployment). */
  open(tx: TenantTx): Promise<boolean>;
  /** Outside any transaction: Stripe says the request's payment is authorized, else it throws. */
  ready(tenantId: TenantId, requestId: string): Promise<void>;
  /** In the booking's transaction: ties the payment to it; `false` when none is waiting. */
  attach(
    tx: TenantTx,
    input: { requestId: string; bookingId: string; startsAt: Date; now: Date },
  ): Promise<boolean>;
  /** In a client's move's transaction: the refund's end follows only while it hasn't passed. */
  rescheduled(tx: TenantTx, input: { bookingId: string; startsAt: Date; now: Date }): Promise<void>;
  /** In a cancel's transaction: keeps or refunds the deposit. */
  cancelled(
    tx: TenantTx,
    input: { bookingId: string; startsAt: Date; by: 'client' | 'business'; now: Date },
  ): Promise<void>;
  /** In the booking's read: its deposit as the client is told about it (S66.2, AC-X-123). */
  describe(
    tx: TenantTx,
    input: { bookingId: string; startsAt: Date; now: Date },
  ): Promise<PublicBookingDeposit | null>;
}

/** A service's terms at the business's window (AC-X-113); `null`: nothing asked. */
export function depositTermsFor(
  service: Pick<ServiceRow, 'depositKind' | 'depositValue' | 'priceFromCents'>,
  tenant: Pick<Tenant, 'depositRefundHours'>,
): DepositTerms | null {
  return depositTermsOf(depositRuleOf(service), service.priceFromCents, tenant.depositRefundHours);
}

/** What the booking page call needs to hash codes: a secret key of the deployment. */
export interface CodeOptions extends PublicOptions {
  /** HMAC key for the stored code hashes (at least 32 bytes), never stored with them. */
  codeKey: Buffer;
}

/** A booking request's options: the browser's remembered-device token, if it sent one. */
export interface RequestOptions extends CodeOptions {
  /** From the device cookie (S47, ADR-0047); unchecked, so anything may come. */
  deviceToken?: string | undefined;
}

/** The menu and team the booking page shows. */
export async function getPublicBusiness(
  db: Database,
  slug: TenantSlug,
  options: Pick<PublicOptions, 'deposits'> = {},
): Promise<PublicBusiness> {
  return inPage(
    db,
    slug,
    async (tx, tenant) => {
      // A service asking for a deposit the business can't take now isn't bookable online (S66).
      const depositsOpen = (await options.deposits?.open(tx)) ?? false;
      const services = (await listServices(tx)).filter(
        (s) => s.active && (depositsOpen || depositTermsFor(s, tenant) === null),
      );
      const activeServices = new Set(services.map((s) => s.id));
      const active = (await listStaffMembers(tx)).filter((s) => s.active);
      // Someone without working hours can never be booked, so the page leaves them out (S46,
      // AC-W8-3). Time off and full days are not read here: those people stay listed.
      const withHours = new Set(
        (
          await listWorkingHoursOf(
            tx,
            active.map((s) => StaffMemberIdSchema.parse(s.id)),
          )
        ).map((row) => row.staffMemberId),
      );
      const staff = active
        .filter((s) => withHours.has(s.id))
        .map((s) => ({ ...s, serviceIds: s.serviceIds.filter((id) => activeServices.has(id)) }))
        .filter((s) => s.serviceIds.length > 0);
      // A service nobody (with hours) offers cannot be booked, so the page does not list it.
      const offered = new Set(staff.flatMap((s) => s.serviceIds));
      return PublicBusinessSchema.parse({
        name: tenant.name,
        slug: tenant.slug,
        timeZone: tenant.timeZone,
        brandColor: tenant.brandColor,
        // What the business chose to show (S47); never the mailing address.
        phone: tenant.phone,
        publicAddress: tenant.publicAddress,
        cancellationPolicy: tenant.cancellationPolicy,
        photos: await businessPhotosIn(tx),
        services: services
          .filter((s) => offered.has(s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            category: s.category,
            durationMinutes: s.durationMinutes,
            priceFromCents: s.priceFromCents,
            priceToCents: s.priceToCents,
            deposit: depositTermsFor(s, tenant),
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
 * `MAX_REQUESTS_PER_EMAIL_PER_HOUR` requests for the email address. `remembered` (S47,
 * AC-W8-8): the browser's device token is one this business remembers for this email, so the
 * caller confirms with the code at once instead of emailing it.
 */
export async function requestBooking(
  db: Database,
  slug: TenantSlug,
  input: BookingRequestInput,
  options: RequestOptions,
): Promise<{
  requestId: BookingRequestId;
  expiresAt: UtcDateTime;
  code: VerificationCode;
  email: BookingEmailDetails;
  remembered: boolean;
  /** S66: the service asks for a deposit or a card, so the request is paid before it's booked. */
  paymentNeeded: boolean;
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
      const paymentNeeded = depositTermsFor(serviceRow, tenant) !== null;
      if (paymentNeeded && !((await options.deposits?.open(tx)) ?? false)) {
        throw new DepositsClosedError();
      }
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
        smsConsentVersion: request.smsConsent,
      });
      const remembered = await recognizeDeviceIn(
        tx,
        options.deviceToken,
        request.email,
        new Date(now),
      );
      return {
        remembered,
        paymentNeeded,
        requestId: BookingRequestIdSchema.parse(row.id),
        expiresAt: UtcDateTimeSchema.parse(expiresAt.toISOString()),
        code,
        email: {
          businessName: tenant.name,
          slug: tenant.slug,
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

/** A booking request whose code was just checked, with what paying for it needs (S66). */
export interface PaymentRequest {
  tenantId: TenantId;
  requestId: BookingRequestId;
  startsAt: Date;
  terms: DepositTerms;
  /** On the client's statement: "<business>: <service>". */
  description: string;
}

/** How long a request stays open once its payment starts (S66). */
export const PAYMENT_WINDOW_MINUTES = 30;

/**
 * Before paying (S66, AC-X-114): checks the request's code (a wrong one counts an attempt) and
 * answers what its payment is for, with the service's terms read now. `PaymentNotNeededError`
 * for a service that asks for nothing; `DepositsClosedError` while the business can't take one.
 */
export async function verifyPaymentRequest(
  db: Database,
  slug: TenantSlug,
  requestId: BookingRequestId,
  code: VerificationCode,
  options: CodeOptions,
): Promise<PaymentRequest> {
  const id = BookingRequestIdSchema.parse(requestId);
  const now = nowOf(options);
  await checkCode(db, slug, id, VerificationCodeSchema.parse(code), {
    now,
    codeKey: options.codeKey,
    purpose: 'booking',
  });
  return inPage(db, slug, async (tx, tenant) => {
    const request = await lockBookingVerification(tx, id);
    if (request?.purpose !== 'booking') throw new BookingRequestNotFoundError();
    const serviceRow = await activeServiceRow(tx, ServiceIdSchema.parse(request.serviceId));
    const terms = depositTermsFor(serviceRow, tenant);
    if (terms === null) throw new PaymentNotNeededError();
    if (!((await options.deposits?.open(tx)) ?? false)) throw new DepositsClosedError();
    // Typing a card can outlast the code's ten minutes: the request stays open for the payment
    // (shorter than the hour after which the sweep lets an unused one go).
    await extendBookingVerification(tx, id, new Date(now + PAYMENT_WINDOW_MINUTES * MINUTE_MS));
    return {
      tenantId: TenantIdSchema.parse(tenant.id),
      requestId: id,
      startsAt: request.startsAt,
      terms,
      description: `${tenant.name}: ${serviceRow.name}`.slice(0, 200),
    };
  });
}

/**
 * Confirms a request with the code the client typed and books the time: the client is found
 * by the verified email address or added, and the booking gets a reschedule/cancel link whose
 * secret is returned (only its hash is stored). A wrong code counts an attempt
 * (`WrongVerificationCodeError`); an expired or exhausted request needs a new code
 * (`BookingRequestExpiredError`); a used one is `BookingRequestUsedError`. When the time was
 * taken meanwhile: `SlotUnavailableError` with alternatives; the request stays open, and the
 * same code may confirm one of them (`input.startsAt`) without another email.
 */
export async function confirmBookingRequest(
  db: Database,
  slug: TenantSlug,
  requestId: BookingRequestId,
  input: BookingConfirmInput,
  options: RequestOptions,
): Promise<{
  booking: PublicBooking;
  manageToken: ManageToken;
  email: BookingEmailDetails;
  /** With `remember` (S47, AC-W8-8): the new device's secret, for the caller's cookie. */
  device?: { token: DeviceToken; expiresAt: Date };
}> {
  const id = BookingRequestIdSchema.parse(requestId);
  const { code, startsAt, remember } = BookingConfirmInputSchema.parse(input);
  const now = nowOf(options);
  await checkCode(db, slug, id, code, { now, codeKey: options.codeKey, purpose: 'booking' });

  // A deposit service is booked only once Stripe says its payment is authorized (S66, AC-X-115):
  // read before the booking's transaction, since no call to Stripe runs inside one.
  const paying = await inPage(db, slug, async (tx, tenant) => {
    const request = await lockBookingVerification(tx, id);
    if (request?.purpose !== 'booking') throw new BookingRequestNotFoundError();
    const serviceRow = await activeServiceRow(tx, ServiceIdSchema.parse(request.serviceId));
    return {
      tenantId: TenantIdSchema.parse(tenant.id),
      needed: depositTermsFor(serviceRow, tenant) !== null,
    };
  });
  if (paying.needed) {
    if (options.deposits === undefined) throw new PaymentRequiredError();
    await options.deposits.ready(paying.tenantId, id);
  }

  const { token: manageToken, hash: newHash } = newManageToken();
  let search: AlternativesSearch | undefined;
  try {
    return await inPage(db, slug, async (tx, tenant) => {
      const request = await lockBookingVerification(tx, id);
      // Locked again: a concurrent confirmation with the same code may have won meanwhile.
      if (request?.purpose !== 'booking') throw new BookingRequestNotFoundError();
      if (request.bookingId !== null) throw new BookingRequestUsedError();
      const serviceRow = await activeServiceRow(tx, ServiceIdSchema.parse(request.serviceId));
      const service = serviceToBook(serviceRow);
      const wanted =
        request.staffMemberId === null
          ? undefined
          : StaffMemberIdSchema.parse(request.staffMemberId);
      const start = startsAt === undefined ? request.startsAt.getTime() : Date.parse(startsAt);
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
        manageTokenHash: newHash,
      });
      await setVerificationBooking(tx, id, BookingIdSchema.parse(row.id));
      // The rule read again with the booking: a deposit added meanwhile needs its payment too.
      if (depositTermsFor(serviceRow, tenant) !== null) {
        const attached =
          paying.needed &&
          options.deposits !== undefined &&
          (await options.deposits.attach(tx, {
            requestId: id,
            bookingId: row.id,
            startsAt: row.startsAt,
            now: new Date(now),
          }));
        if (!attached) throw new PaymentRequiredError();
      }
      await noteFirstBookingIn(tx);
      await keepReminderInStep(tx, row, now);
      await requestInsights(tx);
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'booking.created',
          entity: { type: 'booking', id: row.id },
          before: null,
          after: bookingAuditValues(row),
        },
      });
      // The SMS box the client ticked (S61.2, AC-X-65): a consent only now, with the booking.
      const newSmsConsent = request.smsConsentVersion !== null && request.phone !== null;
      if (request.smsConsentVersion !== null && request.phone !== null) {
        await recordSmsConsent(
          tx,
          {
            phone: request.phone,
            source: 'booking_page',
            clientId: client.id,
            wordingVersion: SmsConsentWordingVersionSchema.parse(request.smsConsentVersion),
            givenAt: new Date(now),
          },
          { actor: { kind: 'system' } },
        );
      }
      const booking = await toPublicBooking(tx, row, now, options.deposits);
      const email: BookingEmailDetails = {
        businessName: tenant.name,
        slug: tenant.slug,
        timeZone: tenant.timeZone,
        serviceName: booking.service.name,
        staffName: booking.staff.displayName,
        startsAt: booking.startsAt,
        email: request.email,
        clientName: client.name,
      };
      await options.notify?.(tx, {
        kind: 'confirmed',
        email,
        manageToken,
        change: changeOf(row),
        ...(newSmsConsent && { newSmsConsent: true as const }),
      });
      // The code just proved the address: the browser may skip it next time (S47).
      // The browser's earlier device (another email, say) ends: its cookie is replaced (S47).
      const device =
        remember === true
          ? await rememberDeviceIn(tx, request.email, new Date(now), options.deviceToken)
          : undefined;
      return { booking, manageToken, email, ...(device === undefined ? {} : { device }) };
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && search) {
      throw new SlotUnavailableError(await nearestAlternatives(pageReader(db, slug), search));
    }
    throw error;
  }
}

/**
 * Asks to join the waitlist for a local day on which nothing fits (S38a, ADR-0042): stores the
 * request with the hash of a new code, which the caller emails, under the same per-address
 * limit as booking requests (they share it). Nothing is added before the code is typed.
 * `WaitlistExpiredError` for a day that is over.
 */
export async function requestWaitlistJoin(
  db: Database,
  slug: TenantSlug,
  input: WaitlistRequestInput,
  options: CodeOptions,
): Promise<{
  requestId: BookingRequestId;
  expiresAt: UtcDateTime;
  code: VerificationCode;
  email: BookingEmailDetails;
}> {
  const request = WaitlistRequestInputSchema.parse(input);
  const now = nowOf(options);
  const code = VerificationCodeSchema.parse(String(randomInt(0, 1_000_000)).padStart(6, '0'));
  return inPage(db, slug, async (tx, tenant) => {
    const after = new Date(now - (60 - VERIFICATION_CODE_TTL_MINUTES) * MINUTE_MS);
    if (
      (await countBookingVerificationsExpiringAfter(tx, request.email, after)) >=
      MAX_REQUESTS_PER_EMAIL_PER_HOUR
    ) {
      throw new TooManyBookingRequestsError();
    }
    const serviceRow = await activeServiceRow(tx, request.serviceId);
    const staffName =
      request.staffMemberId === null ? null : await activeStaffName(tx, request.staffMemberId);
    // As the page shows it: a service only someone active offers, and only with them.
    const offering = (await listStaffMembers(tx)).filter(
      (staff) =>
        staff.active &&
        staff.serviceIds.includes(serviceRow.id) &&
        (request.staffMemberId === null || staff.id === request.staffMemberId),
    );
    if (offering.length === 0) throw new ServiceNotFoundError();
    const window = wholeDay(request.date);
    if (waitlistExpiry([window], tenant.timeZone) <= now) throw new WaitlistExpiredError();
    const last = addDays(toZoned(tenant.timeZone, now), PUBLIC_WAITLIST_DAYS - 1);
    if (request.date > formatDate(last)) throw new WaitlistDayTooFarError();
    const dayStart = fromZoned(tenant.timeZone, parseDate(request.date), 0);
    const expiresAt = new Date(now + VERIFICATION_CODE_TTL_MINUTES * MINUTE_MS);
    const row = await insertBookingVerification(tx, {
      serviceId: ServiceIdSchema.parse(serviceRow.id),
      staffMemberId: request.staffMemberId,
      // The local day asked for, as the instant it begins.
      startsAt: new Date(dayStart),
      name: request.name,
      email: request.email,
      phone: request.phone,
      codeHash: codeHash(options.codeKey, request.email, code),
      expiresAt,
      purpose: 'waitlist',
    });
    return {
      requestId: BookingRequestIdSchema.parse(row.id),
      expiresAt: UtcDateTimeSchema.parse(expiresAt.toISOString()),
      code,
      email: {
        businessName: tenant.name,
        slug: tenant.slug,
        timeZone: tenant.timeZone,
        serviceName: serviceRow.name,
        staffName,
        startsAt: new Date(dayStart).toISOString(),
        email: request.email,
        clientName: request.name,
      },
    };
  });
}

/**
 * Confirms a waitlist request with its code (S38a): the client is found by the verified email
 * address or added, and waits for that day, the whole of it, with the staff member asked for
 * or anyone, audited as the system. Already waiting for that day and service: their entry is
 * kept, not doubled. The code's errors are `confirmBookingRequest`'s.
 */
export async function confirmWaitlistJoin(
  db: Database,
  slug: TenantSlug,
  requestId: BookingRequestId,
  input: WaitlistConfirmInput,
  options: CodeOptions,
): Promise<{ entry: PublicWaitlistEntry }> {
  const id = BookingRequestIdSchema.parse(requestId);
  const { code } = WaitlistConfirmInputSchema.parse(input);
  const now = nowOf(options);
  await checkCode(db, slug, id, code, { now, codeKey: options.codeKey, purpose: 'waitlist' });
  return inPage(db, slug, async (tx, tenant) => {
    const request = await lockBookingVerification(tx, id);
    // Locked again: a concurrent confirmation with the same code may have won meanwhile.
    if (request?.purpose !== 'waitlist') throw new BookingRequestNotFoundError();
    if (request.waitlistEntryId !== null) throw new BookingRequestUsedError();
    const serviceRow = await activeServiceRow(tx, request.serviceId);
    const staffMemberId =
      request.staffMemberId === null ? null : StaffMemberIdSchema.parse(request.staffMemberId);
    const staffName = staffMemberId === null ? null : await activeStaffName(tx, staffMemberId);
    const date = formatDate(toZoned(tenant.timeZone, request.startsAt.getTime()));
    const window = wholeDay(date);
    const expiresAt = waitlistExpiry([window], tenant.timeZone);
    if (expiresAt <= now) throw new WaitlistExpiredError();
    const client = await clientFor(tx, request);
    const clientId = ClientIdSchema.parse(client.id);
    const waiting = (
      await listWaitlistEntries(tx, { now: new Date(now), all: false, clientId, limit: 200 })
    ).find(
      (entry) =>
        entry.serviceId === serviceRow.id &&
        entry.staffMemberId === staffMemberId &&
        // Only an entry already waiting for the whole of that day: a narrower one stays as the
        // team set it, and this one is added beside it.
        WaitlistEntryInputSchema.shape.windows
          .parse(entry.windows)
          .some((each) => each.date === date && each.start === '00:00' && each.end === '24:00'),
    );
    const row =
      waiting ??
      (await insertWaitlistEntry(tx, {
        clientId,
        serviceId: ServiceIdSchema.parse(serviceRow.id),
        staffMemberId,
        windows: [window],
        expiresAt: new Date(expiresAt),
        createdBy: null,
      }));
    await setVerificationWaitlistEntry(tx, id, WaitlistEntryIdSchema.parse(row.id));
    if (waiting === undefined) {
      await appendAuditEntry(tx, {
        actor: { kind: 'system' },
        change: {
          action: 'waitlist_entry.created',
          entity: { type: 'waitlist_entry', id: row.id },
          before: null,
          after: waitlistAuditValues(row),
        },
      });
    }
    return {
      entry: PublicWaitlistEntrySchema.parse({
        service: { id: serviceRow.id, name: serviceRow.name },
        staff:
          staffMemberId === null || staffName === null
            ? null
            : { id: staffMemberId, displayName: staffName },
        date,
        expiresAt: row.expiresAt.toISOString(),
      }),
    };
  });
}

/** A whole local day as a waitlist window. */
function wholeDay(date: string): WaitlistWindow {
  return { date, start: '00:00', end: '24:00' };
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
      return toPublicBooking(tx, row, now, options.deposits);
    },
    { readOnly: true, whileClosing: true },
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
  return inPage(
    db,
    slug,
    async (tx, tenant) => {
      const row = await lockChangeable(tx, hash, now);
      const cancelled = await setBookingStatus(tx, BookingIdSchema.parse(row.id), 'cancelled');
      if (cancelled === undefined) throw new BookingNotFoundError();
      await auditUpdate(tx, row, cancelled);
      // The deposit by the window agreed, until the refund's stored end (S66, AC-X-117).
      await options.deposits?.cancelled(tx, {
        bookingId: row.id,
        startsAt: row.startsAt,
        by: 'client',
        now: new Date(now),
      });
      await keepReminderInStep(tx, cancelled, now);
      await requestInsights(tx);
      await requestWaitlistMatch(tx, row, now);
      const result = await withEmail(tx, tenant, cancelled, now, options.deposits);
      await options.notify?.(tx, {
        kind: 'cancelled',
        email: result.email,
        change: changeOf(cancelled),
      });
      return result;
    },
    { whileClosing: true },
  );
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
      await options.deposits?.rescheduled(tx, {
        bookingId: row.id,
        startsAt: moved.startsAt,
        now: new Date(now),
      });
      await keepReminderInStep(tx, moved, now);
      await requestInsights(tx);
      await requestWaitlistMatch(tx, row, now);
      const result = await withEmail(tx, tenant, moved, now, options.deposits);
      await options.notify?.(tx, {
        kind: 'rescheduled',
        email: result.email,
        manageToken: ManageTokenSchema.parse(token),
        change: changeOf(moved),
      });
      return result;
    });
  } catch (error) {
    if ((error instanceof SlotTaken || error instanceof BookingOverlapError) && search) {
      throw new SlotUnavailableError(await nearestAlternatives(pageReader(db, slug), search));
    }
    throw error;
  }
}

/**
 * Checks the code typed for a request of this `purpose` (a booking's code never adds a waitlist
 * entry, nor the other way round). A wrong code counts an attempt, and that count commits even
 * though the answer is an error, so the check is its own transaction. Throws for a request
 * that is unknown, of the other purpose, used, expired or out of attempts, or a wrong code.
 */
async function checkCode(
  db: Database,
  slug: TenantSlug,
  id: BookingRequestId,
  code: VerificationCode,
  options: { now: number; codeKey: Buffer; purpose: 'booking' | 'waitlist' },
): Promise<void> {
  const checked = await inPage(db, slug, async (tx) => {
    const request = await lockBookingVerification(tx, id);
    if (request?.purpose !== options.purpose) return { outcome: 'not_found' } as const;
    if (request.bookingId !== null || request.waitlistEntryId !== null) {
      return { outcome: 'used' } as const;
    }
    if (
      request.expiresAt.getTime() <= options.now ||
      request.attempts >= MAX_VERIFICATION_ATTEMPTS
    ) {
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
      return;
  }
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

/**
 * Runs `work` for the business at `slug`; `BookingPageNotFoundError` when there is none, or
 * when the business is being deleted (S51.2, ADR-0054: its page takes nothing new), unless
 * `whileClosing` (a client may still see and cancel a visit they already have).
 */
async function inPage<T>(
  db: Database,
  slug: TenantSlug,
  work: (tx: TenantTx, tenant: Tenant) => Promise<T>,
  options: { readOnly?: boolean; whileClosing?: boolean } = {},
): Promise<T> {
  const parsed = TenantSlugSchema.safeParse(slug);
  if (!parsed.success) throw new BookingPageNotFoundError();
  // Boxed, so a business without a page tells apart from `work` returning `undefined`.
  const result = await withPublicTenant(
    db,
    parsed.data,
    async (tx, tenant) => {
      if (tenant.deletionDueAt !== null && options.whileClosing !== true) return undefined;
      return { value: await work(tx, tenant) };
    },
    { readOnly: options.readOnly === true },
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
async function toPublicBooking(
  tx: TenantTx,
  row: BookingRow,
  now: number,
  deposits: PublicDeposits | undefined,
): Promise<PublicBooking> {
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
    deposit:
      (await deposits?.describe(tx, {
        bookingId: row.id,
        startsAt: row.startsAt,
        now: new Date(now),
      })) ?? null,
  });
}

async function withEmail(
  tx: TenantTx,
  tenant: Tenant,
  row: BookingRow,
  now: number,
  deposits: PublicDeposits | undefined,
): Promise<{ booking: PublicBooking; email: BookingEmailDetails }> {
  return {
    booking: await toPublicBooking(tx, row, now, deposits),
    // The address the link was sent to, or the one the business has on file now.
    email: await emailDetailsOf(tx, tenant, row),
  };
}

// Waitlist offers (S37, ADR-0041, AC-W5-1) -----------------------------------------------------

export interface ClaimOptions extends PublicOptions {
  /** Told, inside the claim's transaction, about each other client whose offer is now taken. */
  tellTaken?: WaitlistTakenNotify;
}

/**
 * The offer behind a claim link, as its client sees it (`WaitlistOfferNotFoundError` for an
 * unknown one). Reading changes nothing: mail scanners open links.
 */
export async function getWaitlistOffer(
  db: Database,
  slug: TenantSlug,
  token: OfferToken,
  options: PublicOptions = {},
): Promise<PublicOffer> {
  const hash = offerTokenHash(OfferTokenSchema.parse(token));
  const now = nowOf(options);
  return inPage(
    db,
    slug,
    async (tx) => {
      const offer = await findWaitlistOfferByTokenHash(tx, hash);
      if (offer === undefined) throw new WaitlistOfferNotFoundError();
      return toPublicOffer(tx, offer, now);
    },
    { readOnly: true },
  );
}

type ClaimOutcome =
  | { kind: 'not_found' | 'used' | 'taken' | 'expired' }
  | {
      kind: 'booked';
      booking: PublicBooking;
      manageToken: ManageToken;
      email: BookingEmailDetails;
    };

/**
 * Claims the offer behind a link: the first claim of a freed time books it, through the
 * availability engine, in one transaction with closing the time's other offers (`taken`, their
 * clients told and back on the list). Claims of one time take turns on its match row, so N
 * concurrent claims make exactly one booking. A time booked meanwhile, or no longer whole, is
 * "taken" for everyone (`WaitlistOfferTakenError`); a link used already is
 * `WaitlistOfferUsedError`, one past its time `WaitlistOfferExpiredError`. Neither says who
 * holds the time now.
 */
export async function claimWaitlistOffer(
  db: Database,
  slug: TenantSlug,
  token: OfferToken,
  options: ClaimOptions = {},
): Promise<{ booking: PublicBooking; manageToken: ManageToken; email: BookingEmailDetails }> {
  const hash = offerTokenHash(OfferTokenSchema.parse(token));
  const now = nowOf(options);
  const { token: pendingManageToken, hash: pendingManageHash } = newManageToken();
  // The other offers' closing must commit when this claim fails too, so failures are returned
  // from the transaction and thrown after it.
  const outcome = await inPage(db, slug, async (tx, tenant): Promise<ClaimOutcome> => {
    const found = await findWaitlistOfferByTokenHash(tx, hash);
    if (found === undefined) return { kind: 'not_found' };
    const matchId = WaitlistMatchIdSchema.parse(found.matchId);
    // Claims of one freed time take turns here.
    if ((await lockWaitlistMatch(tx, matchId)) === undefined) return { kind: 'not_found' };
    const offers = await listOffersOfMatch(tx, matchId);
    const offer = offers.find((o) => o.id === found.id);
    if (offer === undefined) return { kind: 'not_found' };
    if (offer.status === 'claimed') return { kind: 'used' };
    if (offer.status === 'taken') return { kind: 'taken' };
    if (offer.status === 'expired' || offer.expiresAt.getTime() <= now) return { kind: 'expired' };

    // Taken off the list meanwhile: the link is withdrawn, the others' offers stay open. A
    // regular's offer has no entry (S54, ADR-0056).
    const entry =
      offer.entryId === null
        ? null
        : await lockWaitlistEntry(tx, WaitlistEntryIdSchema.parse(offer.entryId));
    if (entry !== null && entry?.status !== 'offered') {
      await takeBackWaitlistOffersIn(tx, [WaitlistOfferIdSchema.parse(offer.id)]);
      return { kind: 'expired' };
    }

    const others = offers.filter((o) => o.id !== offer.id);
    const staffMemberId = StaffMemberIdSchema.parse(offer.staffMemberId);
    const start = offer.startsAt.getTime();
    let booked: BookingRow | undefined;
    const serviceRow = await findService(tx, ServiceIdSchema.parse(offer.serviceId));
    if (
      serviceRow !== undefined &&
      (await lockStaffMember(tx, staffMemberId)) !== undefined &&
      (await offerFits(tx, offer, options))
    ) {
      const service = serviceToBook(serviceRow);
      try {
        booked = await tx.transaction((sp) =>
          insertBooking(sp, {
            clientId: ClientIdSchema.parse(offer.clientId),
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
            manageTokenHash: pendingManageHash,
          }),
        );
      } catch (error) {
        if (!(error instanceof BookingOverlapError)) throw error;
      }
      if (booked !== undefined) {
        await noteFirstBookingIn(tx);
        await markOfferClaimed(
          tx,
          WaitlistOfferIdSchema.parse(offer.id),
          BookingIdSchema.parse(booked.id),
        );
        if (entry !== null) await changeEntryStatus(tx, entry, 'booked', booked.id);
      }
    }

    if (booked === undefined) {
      // Not this client's: theirs closes, and so does every other offer whose own service no
      // longer fits; a shorter service may still fit the time, so its offer stays open.
      const closing = [offer];
      for (const other of others) {
        if (other.status === 'offered' && !(await offerFits(tx, other, options))) {
          closing.push(other);
        }
      }
      await closeAsTaken(tx, tenant, closing, offer.id, options);
      return { kind: 'taken' };
    }
    // Someone has it now: the time's other open offers close.
    await closeAsTaken(tx, tenant, others, offer.id, options);

    await keepReminderInStep(tx, booked, now);
    await requestInsights(tx);
    await appendAuditEntry(tx, {
      actor: { kind: 'system' },
      change: {
        action: 'booking.created',
        entity: { type: 'booking', id: booked.id },
        before: null,
        after: bookingAuditValues(booked),
      },
    });
    const result = await withEmail(tx, tenant, booked, now, options.deposits);
    await options.notify?.(tx, {
      kind: 'confirmed',
      email: result.email,
      manageToken: pendingManageToken,
      change: changeOf(booked),
    });
    return { kind: 'booked', ...result, manageToken: pendingManageToken };
  });
  switch (outcome.kind) {
    case 'not_found':
      throw new WaitlistOfferNotFoundError();
    case 'used':
      throw new WaitlistOfferUsedError();
    case 'taken':
      throw new WaitlistOfferTakenError();
    case 'expired':
      throw new WaitlistOfferExpiredError();
    case 'booked':
      return { booking: outcome.booking, manageToken: outcome.manageToken, email: outcome.email };
  }
}

/**
 * Whether an offer's service can still be booked at its time, by the availability engine. The
 * minimum notice is judged as when the time was offered: the business offered it until the
 * offer closes, so a claim inside that window isn't refused for coming late.
 */
async function offerFits(
  tx: TenantTx,
  offer: WaitlistOfferRow,
  options: ClaimOptions,
): Promise<boolean> {
  const service = await findService(tx, ServiceIdSchema.parse(offer.serviceId));
  if (service?.active !== true) return false;
  return isBookable(tx, {
    service: serviceToBook(service),
    staffMemberId: StaffMemberIdSchema.parse(offer.staffMemberId),
    start: offer.startsAt.getTime(),
    now: offer.createdAt.getTime(),
    templateRuleDefaults: options.templateRuleDefaults,
  });
}

/**
 * Closes a time's open offers as `taken`: each other client is told (the claimant isn't, they
 * see it on the page) and waits on the list again.
 */
async function closeAsTaken(
  tx: TenantTx,
  tenant: Tenant,
  offers: readonly WaitlistOfferRow[],
  claimantOfferId: string,
  options: ClaimOptions,
): Promise<void> {
  const closed = await settleOpenOffers(
    tx,
    offers.map((o) => WaitlistOfferIdSchema.parse(o.id)),
    'taken',
  );
  for (const offer of closed) {
    await releaseEntry(tx, offer);
    if (offer.id === claimantOfferId || options.tellTaken === undefined) continue;
    // A regular wasn't waiting for it (S54): no second email about a time they didn't ask for.
    if (offer.source === 'regular') continue;
    const details = await offerEmailDetails(tx, tenant, offer);
    if (details !== undefined) {
      await options.tellTaken(tx, {
        email: details,
        offerId: WaitlistOfferIdSchema.parse(offer.id),
      });
    }
  }
}

/** The email details of an offer's client, or `undefined` without an address. */
export async function offerEmailDetails(
  tx: TenantTx,
  tenant: Pick<Tenant, 'name' | 'slug' | 'timeZone'>,
  offer: Pick<WaitlistOfferRow, 'clientId' | 'serviceId' | 'staffMemberId' | 'startsAt'>,
): Promise<BookingEmailDetails | undefined> {
  const client = await findClient(tx, ClientIdSchema.parse(offer.clientId));
  if (client === undefined || client.email === null) return undefined;
  const service = await findService(tx, ServiceIdSchema.parse(offer.serviceId));
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(offer.staffMemberId));
  return {
    businessName: tenant.name,
    slug: tenant.slug,
    timeZone: tenant.timeZone,
    serviceName: service?.name ?? 'Appointment',
    staffName: staff?.displayName ?? null,
    startsAt: offer.startsAt.toISOString(),
    email: client.email,
    clientName: client.name,
  };
}

/** An offer as its client sees it; one past its time reads as expired. */
async function toPublicOffer(
  tx: TenantTx,
  offer: WaitlistOfferRow,
  now: number,
): Promise<PublicOffer> {
  const service = await findService(tx, ServiceIdSchema.parse(offer.serviceId));
  const staff = await findStaffMember(tx, StaffMemberIdSchema.parse(offer.staffMemberId));
  // Offers reference both with foreign keys, and neither is ever deleted.
  if (service === undefined || staff === undefined) throw new WaitlistOfferNotFoundError();
  const status =
    offer.status === 'offered'
      ? offer.expiresAt.getTime() <= now
        ? 'expired'
        : 'open'
      : offer.status;
  return PublicOfferSchema.parse({
    status,
    startsAt: offer.startsAt.toISOString(),
    endsAt: new Date(offer.startsAt.getTime() + service.durationMinutes * MINUTE_MS).toISOString(),
    service: { id: service.id, name: service.name },
    staff: { id: staff.id, displayName: staff.displayName },
    expiresAt: offer.expiresAt.toISOString(),
  });
}
