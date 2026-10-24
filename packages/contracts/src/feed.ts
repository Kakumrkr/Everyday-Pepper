import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingIdSchema } from './bookings.js';
import { ClientIdSchema } from './clients.js';
import { LocalDateSchema } from './rules.js';
import { InsightTypeSchema } from './templates.js';
import { UtcDateTimeSchema } from './time.js';
import { ActionProposalIdSchema } from './trust.js';

// The operator feed (Phase 8, ADR-0039): the home screen's "Suggestions", filled by rule-based
// insight providers that run in the worker every hour and again after booking changes. An item
// holds ids and numbers only (playbook §6, LLM02); the api adds the names when it reads them.
// The dedupe key is (business, kind, subject, day): a re-run updates the item instead of adding
// a second one, and an item expires when its reason does. Dismissing an item snoozes that kind
// for that subject for 30 days.

/** A feed item id: a lowercased UUID. */
export const FeedItemIdSchema = z.uuid().toLowerCase().brand<'FeedItemId'>();
export type FeedItemId = z.infer<typeof FeedItemIdSchema>;

/** The kinds the rule-based providers write in S35 (`waitlist_match` arrives with S37). */
export const FeedInsightKindSchema = InsightTypeSchema.extract([
  'schedule_gaps',
  'rebooking_due',
  'no_show_pattern',
  'staff_overload',
]);
export type FeedInsightKind = z.infer<typeof FeedInsightKindSchema>;

/**
 * Where an item stands. `needs_ok` and `done` are for items that carry a proposal (S36's
 * drafts); S35's insights are `suggestion` until acted on, dismissed or expired.
 */
export const FeedItemStatusSchema = z.enum([
  'needs_ok',
  'suggestion',
  'done',
  'dismissed',
  'expired',
]);
export type FeedItemStatus = z.infer<typeof FeedItemStatusSchema>;

/** How long a dismissal keeps the same kind for the same subject away. */
export const FEED_SNOOZE_DAYS = 30;
/** Dismissals of one kind within this many days before the owner is asked once to turn it off. */
export const FEED_ASK_TO_TURN_OFF = { dismissals: 3, withinDays: 14 } as const;

/** Open gaps in one staff member's working day, at least the template's `minGapMinutes` each. */
export const ScheduleGapsPayloadSchema = z
  .object({
    gapCount: z.number().int().min(1),
    openMinutes: z.number().int().min(1),
    longestStartsAt: UtcDateTimeSchema,
    longestEndsAt: UtcDateTimeSchema,
  })
  .strict();

/** A regular past their usual return date with nothing booked. */
export const RebookingDuePayloadSchema = z
  .object({
    lastVisitAt: UtcDateTimeSchema,
    intervalDays: z.number().int().min(1),
    /** `service`: the service's own interval; `client_median`: the client's habit (≥ 3 visits). */
    basis: z.enum(['service', 'client_median']),
    dueOn: LocalDateSchema,
  })
  .strict();

/** A client who has missed visits lately and is booked again soon. */
export const NoShowPatternPayloadSchema = z
  .object({
    noShowCount: z.number().int().min(1),
    windowDays: z.number().int().min(1),
    bookingStartsAt: UtcDateTimeSchema,
  })
  .strict();

/** A staff member booked nearly full on several of the coming days. */
export const StaffOverloadPayloadSchema = z
  .object({
    busyDays: z.array(LocalDateSchema).min(1),
    horizonDays: z.number().int().min(1),
    /** The fullest of those days, as a whole percent of working time. */
    peakPercent: z.number().int().min(0).max(100),
  })
  .strict();

/** What an insight says, by kind. */
export const FeedInsightSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule_gaps'), payload: ScheduleGapsPayloadSchema }),
  z.object({ kind: z.literal('rebooking_due'), payload: RebookingDuePayloadSchema }),
  z.object({ kind: z.literal('no_show_pattern'), payload: NoShowPatternPayloadSchema }),
  z.object({ kind: z.literal('staff_overload'), payload: StaffOverloadPayloadSchema }),
]);
export type FeedInsight = z.infer<typeof FeedInsightSchema>;

/** The records an item is about, by id. */
export const FeedSubjectsSchema = z
  .object({
    staffMemberId: StaffMemberIdSchema.nullable(),
    clientId: ClientIdSchema.nullable(),
    bookingId: BookingIdSchema.nullable(),
    serviceId: ServiceIdSchema.nullable(),
  })
  .strict();
export type FeedSubjects = z.infer<typeof FeedSubjectsSchema>;

/** The names the api adds when it reads an item (never stored with it). */
export const FeedNamesSchema = z
  .object({
    staff: z.string().nullable(),
    client: z.string().nullable(),
    service: z.string().nullable(),
  })
  .strict();

/** A suggestion as `GET /v1/feed` returns it. */
export const FeedItemSchema = z
  .object({
    id: FeedItemIdSchema,
    status: FeedItemStatusSchema,
    /** The local day the item is about (the gap's day, the due date, the booking's day). */
    day: LocalDateSchema,
    subjects: FeedSubjectsSchema,
    names: FeedNamesSchema,
    proposalId: ActionProposalIdSchema.nullable(),
    expiresAt: UtcDateTimeSchema,
    createdAt: UtcDateTimeSchema,
  })
  .and(FeedInsightSchema);
export type FeedItem = z.infer<typeof FeedItemSchema>;

/** The business's feed switches: owners and managers change them. */
export const FeedSettingsSchema = z
  .object({
    /** "Pause suggestions": no new insights or drafts; what waits for an OK stays. */
    suggestionsPaused: z.boolean(),
    /** Kinds the business turned off, over the template's `insights.enabled`. */
    disabledKinds: z.array(FeedInsightKindSchema),
  })
  .strict();
export type FeedSettings = z.infer<typeof FeedSettingsSchema>;

export const DEFAULT_FEED_SETTINGS: FeedSettings = { suggestionsPaused: false, disabledKinds: [] };

/** `PATCH /v1/feed/settings`: either switch; `askAnswered` records the once-only question. */
export const FeedSettingsChangeSchema = z
  .object({
    suggestionsPaused: z.boolean().optional(),
    disabledKinds: z
      .array(FeedInsightKindSchema)
      .max(FeedInsightKindSchema.options.length)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'Each kind once')
      .optional(),
    askAnswered: FeedInsightKindSchema.optional(),
  })
  .strict()
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'Change at least one setting',
  });
export type FeedSettingsChange = z.input<typeof FeedSettingsChangeSchema>;
