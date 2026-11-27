import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingIdSchema } from './bookings.js';
import { ClientContactSchema, ClientIdSchema } from './clients.js';
import { LocalDateSchema } from './rules.js';
import { SmsPhoneSchema, smsConsentVersionFor } from './sms.js';
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
 * `clientContact`: as for bookings, the exact email or phone staff found the client by.
 * `smsConsent` (S79, AC-X-223): the client told the team they agree to texts about openings
 * at this number (the words shown, `sms-consent-v3`); recorded as `staff_recorded`. Never from
 * the AI: its `add_to_waitlist` has no such argument, and the domain refuses one.
 */
export const WaitlistEntryInputSchema = z
  .object({
    clientId: ClientIdSchema,
    clientContact: ClientContactSchema.optional(),
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema.nullable().default(null),
    windows: z.array(WaitlistWindowSchema).min(1).max(MAX_WAITLIST_WINDOWS).transform(sortWindows),
    smsConsent: z
      .object({
        phone: SmsPhoneSchema,
        wordingVersion: smsConsentVersionFor('staff_recorded'),
      })
      .strict()
      .nullable()
      .default(null),
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
    /** One client's entries (S37b: what the AI reads about a client). */
    clientId: ClientIdSchema.optional(),
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

// ---------------------------------------------------------------------------------------------
// The smart waitlist (S37, ADR-0041, AC-W5-1): a cancelled or moved booking frees a slot; the
// worker ranks who is waiting for it and offers it to the best few at once, per the dial for
// `message.waitlist_offer`. The first client to claim books it; the others are told it's taken.

/**
 * - `offered`: the email went (or waits for its Undo grace); the client may claim it.
 * - `claimed`: this client booked it.
 * - `taken`: another client claimed it first, or the time was booked meanwhile.
 * - `expired`: not claimed in time, or taken back (Undo) before it left.
 */
export const WaitlistOfferStatusSchema = z.enum(['offered', 'claimed', 'taken', 'expired']);
export type WaitlistOfferStatus = z.infer<typeof WaitlistOfferStatusSchema>;

export const WaitlistOfferIdSchema = z.uuid().toLowerCase().brand<'WaitlistOfferId'>();
export type WaitlistOfferId = z.infer<typeof WaitlistOfferIdSchema>;

export const WaitlistMatchIdSchema = z.uuid().toLowerCase().brand<'WaitlistMatchId'>();
export type WaitlistMatchId = z.infer<typeof WaitlistMatchIdSchema>;

/**
 * The offer rules (playbook principle 10): an offer may be claimed for 2 hours, and never later
 * than an hour before the slot; a slot whose offers would close within 15 minutes is not
 * offered (no one could reasonably answer in time). The fan-out is the template's (1–5).
 */
export const WAITLIST_OFFER_LIMITS = {
  claimWindowMinutes: 120,
  closesBeforeStartMinutes: 60,
  minClaimMinutes: 15,
  defaultFanOut: 3,
  maxFanOut: 5,
  /** Open entries the matcher ranks per freed slot (longest waiting first). */
  maxCandidates: 200,
} as const;

/** When the offers of a slot close: 2 hours from now, at the latest an hour before it starts. */
export function offerExpiry(now: number, slotStart: number): number {
  const { claimWindowMinutes, closesBeforeStartMinutes } = WAITLIST_OFFER_LIMITS;
  return Math.min(now + claimWindowMinutes * 60_000, slotStart - closesBeforeStartMinutes * 60_000);
}

/** A waitlist offer as the team sees it on the waitlist screen. */
export const WaitlistOfferSchema = z.object({
  id: WaitlistOfferIdSchema,
  /** The waitlist entry offered; `null` for an overdue regular (S54, ADR-0056). */
  entryId: WaitlistEntryIdSchema.nullable(),
  /** Someone on the waitlist, or an overdue regular Pepper offered the time to (S54). */
  source: z.enum(['waitlist', 'regular']),
  clientId: ClientIdSchema,
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  status: WaitlistOfferStatusSchema,
  expiresAt: UtcDateTimeSchema,
  /** 1 for the best match; the order the ranking gave. */
  rank: z.number().int().min(1).max(WAITLIST_OFFER_LIMITS.maxFanOut),
  createdAt: UtcDateTimeSchema,
});
export type WaitlistOffer = z.infer<typeof WaitlistOfferSchema>;

export const WaitlistOffersResponseSchema = z.object({ offers: z.array(WaitlistOfferSchema) });
export type WaitlistOffersResponse = z.infer<typeof WaitlistOffersResponseSchema>;
