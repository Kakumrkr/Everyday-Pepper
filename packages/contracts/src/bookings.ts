import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { ClientContactSchema, ClientIdSchema, RecordSourceSchema } from './clients.js';
import { UtcDateTimeSchema } from './time.js';

// Bookings (ADR-0017). A booking is one client's appointment for one service with one staff
// member. It keeps a copy of the service's duration, buffers and price from when it was made,
// so editing the service never moves or reprices existing bookings. The database refuses two
// active bookings of one staff member whose occupied times (appointment plus buffers) overlap.

/** A booking id: a lowercased UUID. */
export const BookingIdSchema = z.uuid().toLowerCase().brand<'BookingId'>();
export type BookingId = z.infer<typeof BookingIdSchema>;

/**
 * - `confirmed`: booked (every booking starts here; AI bookings wait as proposals, and the
 *   booking page verifies the email before creating one, so there is no "pending").
 * - `completed` / `no_show`: what happened, once it has started.
 * - `cancelled`: final; the only status that frees the time.
 */
export const BookingStatusSchema = z.enum(['confirmed', 'completed', 'no_show', 'cancelled']);
export type BookingStatus = z.infer<typeof BookingStatusSchema>;

/** Where a booking came from (`team`: made in the app by a member). */
export const BookingSourceSchema = RecordSourceSchema.exclude(['import']);
export type BookingSource = z.infer<typeof BookingSourceSchema>;

/**
 * A booking's status can move from the first to the second. `cancelled` is final. What
 * happened (`completed`, `no_show`) is final for staff; owners and managers
 * (`correctsOutcomes`) may still correct it, before payments and commissions depend on it.
 */
export function canChangeStatus(
  from: BookingStatus,
  to: BookingStatus,
  correctsOutcomes: boolean,
): boolean {
  if (from === 'cancelled' || from === to) return false;
  return correctsOutcomes || !statusNeedsStart(from);
}

/** Whether `status` needs the appointment to have started (it records what happened). */
export function statusNeedsStart(status: BookingStatus): boolean {
  return status === 'completed' || status === 'no_show';
}

/**
 * A key a caller picks so that retrying a create (a lost response, a double tap, an AI tool run
 * twice) returns the first booking instead of making a second one.
 */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,100}$/, 'Use 8–100 letters, digits, "-" or "_"');

/**
 * A booking as a team member makes it (`POST /v1/bookings`). `override` (owners and managers
 * only) books outside working hours, time off and the booking rules; it never allows two
 * bookings of a staff member to overlap. `clientContact`: the exact email or phone staff found
 * the client by (ADR-0020), so they may book a client they have no booking with yet.
 */
export const BookingInputSchema = z
  .object({
    clientId: ClientIdSchema,
    clientContact: ClientContactSchema.optional(),
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema,
    startsAt: UtcDateTimeSchema,
    override: z.boolean().default(false),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type BookingInput = z.input<typeof BookingInputSchema>;

/** `PATCH /v1/bookings/:id`: move it (same service and client), or change its status. */
export const BookingChangeSchema = z.union([
  z
    .object({
      startsAt: UtcDateTimeSchema,
      /** Another staff member who offers the service; default: the same one. */
      staffMemberId: StaffMemberIdSchema.optional(),
      override: z.boolean().default(false),
    })
    .strict(),
  z.object({ status: BookingStatusSchema.exclude(['confirmed']) }).strict(),
]);
export type BookingChange = z.input<typeof BookingChangeSchema>;

/** A booking as the api returns it. */
export const BookingSchema = z.object({
  id: BookingIdSchema,
  clientId: ClientIdSchema,
  serviceId: ServiceIdSchema,
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  bufferBeforeMinutes: z.number().int(),
  bufferAfterMinutes: z.number().int(),
  priceFromCents: z.number().int().nullable(),
  priceToCents: z.number().int().nullable(),
  status: BookingStatusSchema,
  source: BookingSourceSchema,
  /** Booked outside hours or rules by an owner or manager. */
  overridden: z.boolean(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type Booking = z.infer<typeof BookingSchema>;

/** The longest range one bookings, busy-time or availability query may cover. */
export const MAX_QUERY_RANGE_DAYS = 62;

/**
 * The most bookings, busy times or start times one answer carries, earliest first. A longer
 * answer is cut there and says `truncated: true`: ask again from the last one's start.
 */
export const MAX_LIST_ITEMS = 500;

const RangeShape = { from: UtcDateTimeSchema, to: UtcDateTimeSchema };

/** Checks a query's `from`–`to`: `to` after `from`, at most `MAX_QUERY_RANGE_DAYS` apart. */
function checkRange(q: { from: string; to: string }, ctx: z.RefinementCtx): void {
  const length = Date.parse(q.to) - Date.parse(q.from);
  if (length <= 0) {
    ctx.addIssue({ code: 'custom', message: 'The end must be after the start', path: ['to'] });
  } else if (length > MAX_QUERY_RANGE_DAYS * 86_400_000) {
    ctx.addIssue({
      code: 'custom',
      message: `Ask about at most ${String(MAX_QUERY_RANGE_DAYS)} days at once`,
      path: ['to'],
    });
  }
}

/**
 * Query of `GET /v1/bookings`: bookings whose appointment overlaps [from, to), by start.
 * Staff see only their own (AC-W9-1).
 */
export const BookingsQuerySchema = z
  .object({
    ...RangeShape,
    staffMemberId: StaffMemberIdSchema.optional(),
    status: BookingStatusSchema.optional(),
  })
  .strict()
  .superRefine(checkRange);
export type BookingsQuery = z.input<typeof BookingsQuerySchema>;

export const BookingsResponseSchema = z.object({
  bookings: z.array(BookingSchema).max(MAX_LIST_ITEMS),
  /** More bookings exist in the range after the last one (see `MAX_LIST_ITEMS`). */
  truncated: z.boolean(),
});
export type BookingsResponse = z.infer<typeof BookingsResponseSchema>;

/**
 * One busy time of the team calendar: when a staff member is booked, with no booking details
 * (everyone may see the calendar; only a booking's staff member, owners and managers its
 * details).
 */
export const BusyTimeSchema = z.object({
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  /** The occupied time, buffers included. */
  occupiedFrom: UtcDateTimeSchema,
  occupiedTo: UtcDateTimeSchema,
});
export type BusyTime = z.infer<typeof BusyTimeSchema>;

/** Query of `GET /v1/calendar/busy`: busy times whose occupied time overlaps [from, to). */
export const BusyQuerySchema = z
  .object({ ...RangeShape, staffMemberId: StaffMemberIdSchema.optional() })
  .strict()
  .superRefine(checkRange);
export type BusyQuery = z.input<typeof BusyQuerySchema>;

export const BusyResponseSchema = z.object({
  busy: z.array(BusyTimeSchema).max(MAX_LIST_ITEMS),
  /** More busy times exist in the range after the last one (see `MAX_LIST_ITEMS`). */
  truncated: z.boolean(),
});
export type BusyResponse = z.infer<typeof BusyResponseSchema>;

/** A start time the service can be booked at, with one staff member. */
export const AvailableSlotSchema = z.object({
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
});
export type AvailableSlot = z.infer<typeof AvailableSlotSchema>;

/**
 * Query of `GET /v1/availability`: start times in [from, to) for the service, with one staff
 * member or with everyone who offers it.
 */
export const AvailabilityQuerySchema = z
  .object({
    ...RangeShape,
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.optional(),
  })
  .strict()
  .superRefine(checkRange);
export type AvailabilityQueryInput = z.input<typeof AvailabilityQuerySchema>;

export const AvailabilityResponseSchema = z.object({
  slots: z.array(AvailableSlotSchema).max(MAX_LIST_ITEMS),
  /** More start times exist in the range after the last one (see `MAX_LIST_ITEMS`). */
  truncated: z.boolean(),
});
export type AvailabilityResponse = z.infer<typeof AvailabilityResponseSchema>;

/** How many nearby start times a refused booking offers instead (AC-W2-1). */
export const ALTERNATIVE_SLOT_COUNT = 3;

/**
 * Body of the 409 `slot_unavailable` answer: the time cannot be booked, and the nearest times
 * that can (same service and staff member), nearest first.
 */
export const SlotUnavailableSchema = z.object({
  code: z.literal('slot_unavailable'),
  message: z.string(),
  alternatives: z.array(AvailableSlotSchema),
});
export type SlotUnavailable = z.infer<typeof SlotUnavailableSchema>;
