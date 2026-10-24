import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingStatusSchema } from './bookings.js';
import { ClientEmailSchema, PhoneSchema } from './clients.js';
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
export const PublicBusinessSchema = z.object({
  name: z.string(),
  slug: TenantSlugSchema,
  timeZone: TimeZoneSchema,
  brandColor: BrandColorSchema.nullable(),
  services: z.array(PublicServiceSchema),
  staff: z.array(PublicStaffMemberSchema),
});
export type PublicBusiness = z.infer<typeof PublicBusinessSchema>;

/**
 * `POST /v1/public/businesses/:slug/booking-requests`: the time the client picked and their
 * details. No staff member: anyone who offers the service. The time is not held; it is
 * checked when asking and again when the code is confirmed.
 */
export const BookingRequestInputSchema = z
  .object({
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable().default(null),
    startsAt: UtcDateTimeSchema,
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().max(254).pipe(ClientEmailSchema),
    phone: PhoneSchema.nullable().default(null),
  })
  .strict();
export type BookingRequestInput = z.input<typeof BookingRequestInputSchema>;
export type BookingRequest = z.output<typeof BookingRequestInputSchema>;

/** The answer: the code is on its way to the email address. */
export const BookingRequestResponseSchema = z.object({
  requestId: BookingRequestIdSchema,
  expiresAt: UtcDateTimeSchema,
});
export type BookingRequestResponse = z.infer<typeof BookingRequestResponseSchema>;

/**
 * `POST /v1/public/businesses/:slug/booking-requests/:requestId/confirm`. `startsAt`: another
 * time instead of the requested one (the client picked an alternative after the time was
 * taken); the code proves the email address, whatever the time.
 */
export const BookingConfirmInputSchema = z
  .object({ code: VerificationCodeSchema, startsAt: UtcDateTimeSchema.optional() })
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
