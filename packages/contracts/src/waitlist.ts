import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingIdSchema } from './bookings.js';
import { ClientIdSchema } from './clients.js';
import { LocalDateSchema } from './rules.js';
import { UtcDateTimeSchema } from './time.js';

// The waitlist (ADR-0017): a client who wants a service at times that are full. S12 stores the
// entries; matching a freed slot to the best entry and sending the offer is the smart waitlist
// (Phase 8, AC-W5-1), through the outbox (Phase 5).

/** A waitlist entry id: a lowercased UUID. */
export const WaitlistEntryIdSchema = z.uuid().toLowerCase().brand<'WaitlistEntryId'>();
export type WaitlistEntryId = z.infer<typeof WaitlistEntryIdSchema>;

/**
 * - `waiting`: on the list.
 * - `offered`: a freed slot was offered and the answer is pending (Phase 8).
 * - `booked`: an offer was taken; `bookingId` is the booking (Phase 8).
 * - `expired`: its last window has passed (shown, not stored: a waiting entry whose `expiresAt`
 *   is past reads as expired).
 * - `cancelled`: taken off the list.
 */
export const WaitlistStatusSchema = z.enum([
  'waiting',
  'offered',
  'booked',
  'expired',
  'cancelled',
]);
export type WaitlistStatus = z.infer<typeof WaitlistStatusSchema>;

/** Statuses an entry can be cancelled from. */
export const CANCELLABLE_WAITLIST_STATUSES: readonly WaitlistStatus[] = ['waiting', 'offered'];

/** The most windows one entry may list. */
export const MAX_WAITLIST_WINDOWS = 10;

const WindowStartSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 09:30');
const WindowEndSchema = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM, e.g. 17:00 (or 24:00)');

/**
 * When the client could come: a local date and wall-clock times in the business's time zone
 * (like working hours and blackout windows).
 */
export const WaitlistWindowSchema = z
  .object({ date: LocalDateSchema, start: WindowStartSchema, end: WindowEndSchema })
  .strict()
  .refine((w) => w.end > w.start, { message: 'The end must be after the start', path: ['end'] });
export type WaitlistWindow = z.infer<typeof WaitlistWindowSchema>;

/** Windows sorted by date and start, with duplicates dropped. */
function sortWindows(windows: WaitlistWindow[]): WaitlistWindow[] {
  const key = (w: WaitlistWindow) => `${w.date} ${w.start} ${w.end}`;
  const unique = new Map(windows.map((w) => [key(w), w]));
  return [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * A waitlist entry as a team member adds it (`POST /v1/waitlist`). Without a staff member the
 * client takes anyone who offers the service. The entry expires when its last window ends.
 */
export const WaitlistEntryInputSchema = z
  .object({
    clientId: ClientIdSchema,
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable().default(null),
    windows: z.array(WaitlistWindowSchema).min(1).max(MAX_WAITLIST_WINDOWS).transform(sortWindows),
  })
  .strict();
export type WaitlistEntryInput = z.input<typeof WaitlistEntryInputSchema>;
export type WaitlistEntryFields = z.output<typeof WaitlistEntryInputSchema>;

/** A waitlist entry as the api returns it. */
export const WaitlistEntrySchema = z.object({
  id: WaitlistEntryIdSchema,
  clientId: ClientIdSchema,
  serviceId: ServiceIdSchema,
  staffMemberId: StaffMemberIdSchema.nullable(),
  windows: z.array(WaitlistWindowSchema),
  status: WaitlistStatusSchema,
  expiresAt: UtcDateTimeSchema,
  bookingId: BookingIdSchema.nullable(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type WaitlistEntry = z.infer<typeof WaitlistEntrySchema>;

/**
 * Query of `GET /v1/waitlist`: by when they joined (longest waiting first). By default only
 * open entries (waiting or offered, not expired); `all` includes the rest.
 */
export const WaitlistQuerySchema = z
  .object({
    serviceId: ServiceIdSchema.optional(),
    // A query string carries "true" or "false"; code may pass a boolean.
    all: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
      .default(false),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type WaitlistQuery = z.input<typeof WaitlistQuerySchema>;

/** `PATCH /v1/waitlist/:id`: take the entry off the list. */
export const WaitlistChangeSchema = z.object({ status: z.literal('cancelled') }).strict();
export type WaitlistChange = z.infer<typeof WaitlistChangeSchema>;

export const WaitlistResponseSchema = z.object({ entries: z.array(WaitlistEntrySchema) });
export type WaitlistResponse = z.infer<typeof WaitlistResponseSchema>;
