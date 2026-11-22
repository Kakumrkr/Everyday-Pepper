import { z } from 'zod';
import { DepositTermsSchema } from './deposits.js';
import { BusinessPhotosSchema } from './photos.js';
import { BusinessProfileSchema } from './account.js';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingStatusSchema } from './bookings.js';
import { ClientEmailSchema, PhoneSchema } from './clients.js';
import { LocalDateSchema } from './rules.js';
import { SmsConsentWordingVersionSchema, SmsPhoneSchema } from './sms.js';
import { BrandColorSchema, TenantSlugSchema, TimeZoneSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// The public booking page (W8, ADR-0022). Anyone may read a business's menu, team and free
// times by its slug. A booking is made only after the client types the code emailed to them
// (AC-W8-2); the confirmation carries a link, scoped to that one booking, to reschedule or
// cancel it. Nothing here names a tenant id: the business comes from the slug in the URL.

/** A booking request waiting for its email code: a lowercased UUID. */
export const BookingRequestIdSchema = z.uuid().toLowerCase().brand<'BookingRequestId'>();
export type BookingRequestId = z.infer<typeof BookingRequestIdSchema>;

/** The code emailed to the client: six digits. */
export const VerificationCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from the email');
export type VerificationCode = z.infer<typeof VerificationCodeSchema>;

/** How long an emailed code works. */
export const VERIFICATION_CODE_TTL_MINUTES = 10;

/** Wrong codes allowed per request; after that the client asks for a new code. */
export const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * The secret in a booking's reschedule/cancel link: 32 random bytes, base64url. Only its hash
 * is stored. It travels in the link's fragment and in POST bodies, never in a URL the server
 * logs.
 */
export const ManageTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid')
  .brand<'ManageToken'>();
export type ManageToken = z.infer<typeof ManageTokenSchema>;

/** A service as the booking page lists it (active services only). */
export const PublicServiceSchema = z.object({
  id: ServiceIdSchema,
  name: z.string(),
  category: z.string().nullable(),
  durationMinutes: z.number().int(),
  priceFromCents: z.number().int().nullable(),
  priceToCents: z.number().int().nullable(),
  /** What booking it asks for now (S66, AC-X-113); `null`: nothing. */
  deposit: DepositTermsSchema.nullable(),
});
export type PublicService = z.infer<typeof PublicServiceSchema>;

/** A staff member as the booking page lists them (active ones, with what they offer). */
export const PublicStaffMemberSchema = z.object({
  id: StaffMemberIdSchema,
  displayName: z.string(),
  color: z.string(),
  serviceIds: z.array(ServiceIdSchema),
});
export type PublicStaffMember = z.infer<typeof PublicStaffMemberSchema>;

/** `GET /v1/public/businesses/:slug`: what the booking page shows. */
export const PublicBusinessSchema = z
  .object({
    name: z.string(),
    slug: TenantSlugSchema,
    timeZone: TimeZoneSchema,
    brandColor: BrandColorSchema.nullable(),
    services: z.array(PublicServiceSchema),
    staff: z.array(PublicStaffMemberSchema),
    /** Its logo, cover and gallery (S47.2, ADR-0048); none until the owner adds them. */
    photos: BusinessPhotosSchema,
    // The phone, public address and cancellation policy the business chose to show (S47).
  })
  .extend(BusinessProfileSchema.shape);
export type PublicBusiness = z.infer<typeof PublicBusinessSchema>;

/** What a ticked SMS box with a number Pepper can't text is told, on the phone field (AC-X-64). */
export const SMS_OPT_IN_PHONE_MESSAGE =
  'Texts go to US and Canadian numbers only. Use one, or untick the box.';
/** What a ticked SMS box without a phone is told, on the phone field (AC-X-64). */
export const SMS_OPT_IN_NO_PHONE_MESSAGE =
  'Add your mobile number to get texts, or untick the box.';

/**
 * `POST /v1/public/businesses/:slug/booking-requests`: the time the client picked and their
 * details. No staff member: anyone who offers the service. The time is not held; it is
 * checked when asking and again when the code is confirmed. `smsConsent` (S61.2, AC-X-64):
 * the wording version of the SMS box the client ticked (the page names the words it showed),
 * `null` when unticked; it needs a number Pepper can text, and is recorded only on confirmation.
 */
export const BookingRequestInputSchema = z
  .object({
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable().default(null),
    startsAt: UtcDateTimeSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).pipe(ClientEmailSchema),
    phone: PhoneSchema.nullable().default(null),
    smsConsent: SmsConsentWordingVersionSchema.nullable().default(null),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.smsConsent === null) return;
    if (request.phone === null) {
      context.addIssue({ code: 'custom', path: ['phone'], message: SMS_OPT_IN_NO_PHONE_MESSAGE });
    } else if (!SmsPhoneSchema.safeParse(request.phone).success) {
      context.addIssue({ code: 'custom', path: ['phone'], message: SMS_OPT_IN_PHONE_MESSAGE });
    }
  });
export type BookingRequestInput = z.input<typeof BookingRequestInputSchema>;
export type BookingRequest = z.output<typeof BookingRequestInputSchema>;

/**
 * The secret of a remembered device (S47, ADR-0047): 256 random bits, base64url, kept only in
 * an httpOnly cookie on the client and as a hash in the database.
 */
export const DeviceTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/)
  .brand<'DeviceToken'>();
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;

/** Answer of `POST …/device/forget`: whether this browser was remembered (S47). */
export const DeviceForgetResponseSchema = z.object({ forgotten: z.boolean() });
export type DeviceForgetResponse = z.infer<typeof DeviceForgetResponseSchema>;

/** How long a remembered device skips the code after it was last used (days). */
export const REMEMBERED_DEVICE_DAYS = 90;

/**
 * Answer of `POST …/booking-requests`: the code's request; or, from a device remembered for
 * that email (S47, AC-W8-8), the booking itself, made without a code (`confirmed`).
 */
export const BookingRequestResponseSchema = z.object({
  requestId: BookingRequestIdSchema,
  expiresAt: UtcDateTimeSchema,
  confirmed: z.lazy(() => BookingConfirmResponseSchema).optional(),
});
export type BookingRequestResponse = z.infer<typeof BookingRequestResponseSchema>;

/**
 * `POST /v1/public/businesses/:slug/booking-requests/:requestId/confirm`. `startsAt`: another
 * time instead of the requested one (the client picked an alternative after the time was
 * taken); the code proves the email address, whatever the time.
 */
export const BookingConfirmInputSchema = z
  .object({
    code: VerificationCodeSchema,
    startsAt: UtcDateTimeSchema.optional(),
    // "Remember me on this phone" (S47, AC-W8-8): the next booking from it skips the code.
    remember: z.boolean().optional(),
  })
  .strict();
export type BookingConfirmInput = z.input<typeof BookingConfirmInputSchema>;

/** Body of the 422 `wrong_code` answer: how many more codes may be tried. */
export const WrongCodeSchema = z.object({
  code: z.literal('wrong_code'),
  message: z.string(),
  attemptsLeft: z.number().int().min(1),
});
export type WrongCode = z.infer<typeof WrongCodeSchema>;

/** A booking as its client sees it on the booking page and behind their link. */
export const PublicBookingSchema = z.object({
  status: BookingStatusSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  service: z.object({ id: ServiceIdSchema, name: z.string() }),
  staff: z.object({ id: StaffMemberIdSchema, displayName: z.string() }),
  /** Still `confirmed` and not started: the client may reschedule or cancel it. */
  changeable: z.boolean(),
});
export type PublicBooking = z.infer<typeof PublicBookingSchema>;

/** The confirmed booking and the secret of its reschedule/cancel link. */
export const BookingConfirmResponseSchema = z.object({
  booking: PublicBookingSchema,
  manageToken: ManageTokenSchema,
});
export type BookingConfirmResponse = z.infer<typeof BookingConfirmResponseSchema>;

/** `POST /v1/public/businesses/:slug/booking/lookup` and `/cancel`: the link's secret. */
export const ManageBookingInputSchema = z.object({ token: ManageTokenSchema }).strict();
export type ManageBookingInput = z.input<typeof ManageBookingInputSchema>;

/** `POST /v1/public/businesses/:slug/booking/reschedule`: same service and staff member. */
export const PublicRescheduleInputSchema = z
  .object({ token: ManageTokenSchema, startsAt: UtcDateTimeSchema })
  .strict();
export type PublicRescheduleInput = z.input<typeof PublicRescheduleInputSchema>;

/** The answer of the manage endpoints: the booking as it is now. */
export const PublicBookingResponseSchema = z.object({ booking: PublicBookingSchema });
export type PublicBookingResponse = z.infer<typeof PublicBookingResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Waitlist offers (S37, ADR-0041): a freed slot offered to a client who was waiting for it. The
// offer email links to the booking page's offer page with the claim secret in the fragment;
// the page posts it like a reschedule/cancel link's. Only the secret's hash is stored, and the
// first client to claim books the slot.

/** The secret of a waitlist offer's claim link: 256 random bits, base64url (as `ManageToken`). */
export const OfferTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'This link is not valid')
  .brand<'OfferToken'>();
export type OfferToken = z.infer<typeof OfferTokenSchema>;

/** `POST /v1/public/businesses/:slug/waitlist-offer/lookup` and `/claim`: the link's secret. */
export const OfferTokenInputSchema = z.object({ token: OfferTokenSchema }).strict();
export type OfferTokenInput = z.input<typeof OfferTokenInputSchema>;

/**
 * A waitlist offer as its client sees it behind their link. `open`: it may be claimed now;
 * `claimed`: this client booked it; `taken`: someone else did, or the time is gone; `expired`:
 * it was not claimed in time. A used or expired link never says who holds the slot now.
 */
export const PublicOfferSchema = z.object({
  status: z.enum(['open', 'claimed', 'taken', 'expired']),
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  service: z.object({ id: ServiceIdSchema, name: z.string() }),
  staff: z.object({ id: StaffMemberIdSchema, displayName: z.string() }),
  /** Until when it may be claimed. */
  expiresAt: UtcDateTimeSchema,
});
export type PublicOffer = z.infer<typeof PublicOfferSchema>;

export const PublicOfferResponseSchema = z.object({ offer: PublicOfferSchema });
export type PublicOfferResponse = z.infer<typeof PublicOfferResponseSchema>;

/**
 * `POST /v1/public/businesses/:slug/waitlist-requests` (S38a, ADR-0042): "Join the waitlist"
 * when nothing fits on a day. Like a booking, it waits for the code emailed to the client;
 * the code adds them to the waitlist for that local day, with the staff member or anyone.
 */
export const WaitlistRequestInputSchema = z
  .object({
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable().default(null),
    date: LocalDateSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).pipe(ClientEmailSchema),
    phone: PhoneSchema.nullable().default(null),
  })
  .strict();
export type WaitlistRequestInput = z.input<typeof WaitlistRequestInputSchema>;
export type WaitlistRequest = z.output<typeof WaitlistRequestInputSchema>;

/** `POST …/waitlist-requests/:requestId/confirm`: the code from the email. */
export const WaitlistConfirmInputSchema = z.object({ code: VerificationCodeSchema }).strict();
export type WaitlistConfirmInput = z.input<typeof WaitlistConfirmInputSchema>;

/** The client's place on the waitlist, as the booking page shows it. */
export const PublicWaitlistEntrySchema = z.object({
  service: z.object({ id: ServiceIdSchema, name: z.string() }),
  staff: z.object({ id: StaffMemberIdSchema, displayName: z.string() }).nullable(),
  date: LocalDateSchema,
  expiresAt: UtcDateTimeSchema,
});
export type PublicWaitlistEntry = z.infer<typeof PublicWaitlistEntrySchema>;

export const WaitlistConfirmResponseSchema = z.object({ entry: PublicWaitlistEntrySchema });
export type WaitlistConfirmResponse = z.infer<typeof WaitlistConfirmResponseSchema>;

/** The booking page's steps whose entry is counted (S47, ADR-0047, AC-W8-9). */
export const BOOKING_FUNNEL_STEPS = [
  'service',
  'staff',
  'time',
  'details',
  'verify',
  'done',
  'waitlisted',
] as const;
export const BookingFunnelStepSchema = z.enum(BOOKING_FUNNEL_STEPS);
export type BookingFunnelStep = z.infer<typeof BookingFunnelStepSchema>;

/**
 * `POST /v1/public/businesses/:slug/funnel`: a visit entered a step. `visitId` is random, made
 * by the page for this visit and linked to nothing; there is no name, email or phone.
 */
export const BookingFunnelEventInputSchema = z
  .object({ visitId: z.uuid().toLowerCase(), step: BookingFunnelStepSchema })
  .strict();
export type BookingFunnelEventInput = z.infer<typeof BookingFunnelEventInputSchema>;

/** How many visits entered each step over a period (S47; S59's metrics page reads it). */
export const BookingFunnelCountsSchema = z.record(BookingFunnelStepSchema, z.number().int().min(0));
export type BookingFunnelCounts = z.infer<typeof BookingFunnelCountsSchema>;
