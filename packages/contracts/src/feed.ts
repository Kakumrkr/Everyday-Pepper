import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import { BookingIdSchema } from './bookings.js';
import { ClientIdSchema } from './clients.js';
import { MailingAddressSchema } from './drafts.js';
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

/**
 * The kinds the insights pass writes (S35; `waitlist_match` from S38a): a kind the pass did not
 * return in a run has no reason left. A business may turn each of them off.
 */
export const FeedInsightKindSchema = InsightTypeSchema.extract([
  'schedule_gaps',
  'rebooking_due',
  'no_show_pattern',
  'staff_overload',
  'waitlist_match',
]);
export type FeedInsightKind = z.infer<typeof FeedInsightKindSchema>;

/**
 * Every kind a feed item can be: the insights pass's, and the daily briefing (S38a, ADR-0042),
 * which the morning pass writes once a day and which only informs.
 */
export const FeedKindSchema = z.enum([...FeedInsightKindSchema.options, 'daily_briefing']);
export type FeedKind = z.infer<typeof FeedKindSchema>;

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

/**
 * How far ahead the insights pass looks for gaps, overload and no-show visits, in local days
 * from today (S35); Home's grouped card says it ("on 5 of the next 7 days", S52).
 */
export const FEED_HORIZON_DAYS = 7;

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

/**
 * A freed time the smart waitlist worked on (S37, ADR-0041), shown to owners and managers and
 * to the staff member whose time it is: `needs_ok` while its offers wait for an OK, `offered`
 * once they went out, `claimed` once a client booked it.
 */
export const WaitlistMatchPayloadSchema = z
  .object({
    startsAt: UtcDateTimeSchema,
    endsAt: UtcDateTimeSchema,
    state: z.enum(['needs_ok', 'offered', 'claimed']),
    /** How many clients were offered it (0 while the offers wait for an OK). */
    offered: z.number().int().min(0).max(10),
  })
  .strict();

const count = z.number().int().min(0);

/**
 * The daily briefing (S38a, ADR-0042): the local day ahead in numbers, written by the morning
 * pass and put into words by a template (`feedLine`), never by the model. `business` is for
 * owners and managers (the business-only counts set); `staff` is one staff member's own day
 * (those counts `null`).
 */
export const DailyBriefingPayloadSchema = z
  .object({
    scope: z.enum(['business', 'staff']),
    bookingCount: count,
    /** The first booking's start today; `null`: nothing booked. */
    firstStartsAt: UtcDateTimeSchema.nullable(),
    /** Open gaps today worth filling (the template's shortest gap), and their minutes. */
    gapCount: count,
    openMinutes: count,
    /** Proposals waiting for an owner's or manager's OK. */
    needsOkCount: count.nullable(),
    /** Regulars past their usual return date (open `rebooking_due` items). */
    rebookingDueCount: count.nullable(),
    /** Clients on the waitlist now, and the last day's offers made and claimed. */
    waitlistWaiting: count.nullable(),
    waitlistOffered: count.nullable(),
    waitlistClaimed: count.nullable(),
  })
  .strict();
export type DailyBriefingPayload = z.infer<typeof DailyBriefingPayloadSchema>;

/** What an item says, by kind. */
export const FeedInsightSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule_gaps'), payload: ScheduleGapsPayloadSchema }),
  z.object({ kind: z.literal('rebooking_due'), payload: RebookingDuePayloadSchema }),
  z.object({ kind: z.literal('no_show_pattern'), payload: NoShowPatternPayloadSchema }),
  z.object({ kind: z.literal('staff_overload'), payload: StaffOverloadPayloadSchema }),
  z.object({ kind: z.literal('waitlist_match'), payload: WaitlistMatchPayloadSchema }),
  z.object({ kind: z.literal('daily_briefing'), payload: DailyBriefingPayloadSchema }),
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

/**
 * A suggestion on Home's card board (S52, ADR-0043): the item and the dollars at stake, an
 * estimate from the business's service prices (`null`: nothing to price, such as a busy week
 * or a business without prices). Home ranks and groups by it; the AI's `get_feed` doesn't read it.
 */
export const FeedBoardItemSchema = FeedItemSchema.and(
  z.object({ valueCents: z.number().int().min(0).max(1_000_000_000).nullable() }),
);
export type FeedBoardItem = z.infer<typeof FeedBoardItemSchema>;

/** A morning pass hour, local: the same range as a template's `drafts.morningHour`. */
export const MorningHourSchema = z.number().int().min(5).max(11);

/** The business's feed switches: owners and managers change them. */
export const FeedSettingsSchema = z
  .object({
    /** "Pause suggestions": no new insights or drafts; what waits for an OK stays. */
    suggestionsPaused: z.boolean(),
    /** Kinds the business turned off, over the template's `insights.enabled`. */
    disabledKinds: z.array(FeedInsightKindSchema),
    /**
     * The local hour of the morning pass (the briefing and the drafts, S38a); `null`: the
     * template's `drafts.morningHour`. Missing in settings stored before S38a.
     */
    morningHour: MorningHourSchema.nullable().default(null),
  })
  .strict();
export type FeedSettings = z.infer<typeof FeedSettingsSchema>;

export const DEFAULT_FEED_SETTINGS: FeedSettings = {
  suggestionsPaused: false,
  disabledKinds: [],
  morningHour: null,
};

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
    /** The morning pass's hour; `null` goes back to the template's. */
    morningHour: MorningHourSchema.nullable().optional(),
    /** The postal address rebooking emails carry (S36); `null` takes it away. */
    mailingAddress: MailingAddressSchema.nullable().optional(),
  })
  .strict()
  .refine((change) => Object.values(change).some((value) => value !== undefined), {
    message: 'Change at least one setting',
  });
export type FeedSettingsChange = z.input<typeof FeedSettingsChangeSchema>;

/** `GET /v1/feed`: the open suggestions the member may see, and the business's switches. */
export const FeedResponseSchema = z
  .object({
    /**
     * Empty while suggestions are paused, and while the business has no booking history (the
     * board's quiet start). Never a briefing.
     */
    suggestions: z.array(FeedBoardItemSchema),
    /**
     * Whether the business has had a visit yet (S52): until then Home's board stays quiet, with
     * one line saying what will come.
     */
    hasBookingHistory: z.boolean(),
    /**
     * Today's briefing for this member (S38a): the business's for owners and managers, their
     * own day for staff; `null` before the morning pass or once marked read. Shown while
     * suggestions are paused too: it only informs.
     */
    briefing: FeedItemSchema.nullable(),
    /** The template's morning hour, for the setting's "default" choice. */
    templateMorningHour: MorningHourSchema,
    settings: FeedSettingsSchema,
    /** Whether this member may change the switches (owners and managers). */
    canChangeSettings: z.boolean(),
    /**
     * A kind dismissed 3 times in 14 days whose "turn this off?" was not answered yet: asked
     * once, of owners and managers only.
     */
    askToTurnOff: FeedInsightKindSchema.nullable(),
    /**
     * The business's postal address for rebooking emails (S36, CAN-SPAM); `null` until set, and
     * no nudge is drafted until then. Shown only to owners and managers (`null` for staff).
     */
    mailingAddress: z.string().max(300).nullable(),
  })
  .strict();
export type FeedResponse = z.infer<typeof FeedResponseSchema>;

/** `POST /v1/feed/:id/close`: dismiss (snoozed 30 days) or done (acted on). */
export const FeedCloseSchema = z.object({ outcome: z.enum(['dismissed', 'done']) }).strict();
export type FeedClose = z.infer<typeof FeedCloseSchema>;

/**
 * `POST /v1/feed/close`: a grouped card's items closed together (S52, "Dismiss all"), at one
 * moment, so they count as one dismissal for the "turn this off?" question.
 */
export const FeedCloseManySchema = z
  .object({
    ids: z
      .array(FeedItemIdSchema)
      .min(1)
      .max(50)
      .refine((ids) => new Set(ids).size === ids.length, 'Each item once'),
    outcome: FeedCloseSchema.shape.outcome,
  })
  .strict();
export type FeedCloseMany = z.infer<typeof FeedCloseManySchema>;
