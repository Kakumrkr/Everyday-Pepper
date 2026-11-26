import { z } from 'zod';
import { ServiceIdSchema, StaffMemberIdSchema } from './appointments.js';
import {
  AvailableSlotSchema,
  BookingSchema,
  BookingIdSchema,
  BookingSeriesIdSchema,
  IdempotencyKeySchema,
} from './bookings.js';
import { ClientContactSchema, ClientIdSchema } from './clients.js';
import { UtcDateTimeSchema } from './time.js';
import { addDays, fromZoned, toZoned } from './zoned-time.js';

// Recurring appointments (S72, ADR-0070): a series is a set of ordinary bookings, one per visit,
// every 1–4 weeks on the first visit's weekday and clock time in the business's time zone. The
// rule is only used to propose the dates; once booked, each visit is a booking like any other.

/** At most every 4 weeks; at least 2 visits, at most 26 (about half a year weekly). */
export const SERIES_MAX_EVERY_WEEKS = 4;
export const SERIES_MIN_VISITS = 2;
export const SERIES_MAX_VISITS = 26;

/** At most this many visits numbered in one read (more than a busy 62 days of one chair). */
export const VISIT_NUMBERS_MAX = 500;

const EveryWeeksSchema = z.number().int().min(1).max(SERIES_MAX_EVERY_WEEKS);

/** "Every `everyWeeks` weeks, `count` visits." */
export const SeriesRepeatSchema = z
  .object({
    everyWeeks: EveryWeeksSchema,
    count: z.number().int().min(SERIES_MIN_VISITS).max(SERIES_MAX_VISITS),
  })
  .strict();
export type SeriesRepeat = z.infer<typeof SeriesRepeatSchema>;

const DAY_MS = 86_400_000;

/**
 * The start instants of a repeat whose first visit starts at `firstStart`: the same weekday and
 * clock time in `timeZone`, every `everyWeeks` weeks, `count` of them, the first one exactly
 * `firstStart`. A daylight-saving change keeps the clock time; a time the change skips becomes
 * the moment of the change, as `fromZoned` does.
 */
export function seriesStarts(timeZone: string, firstStart: number, repeat: SeriesRepeat): number[] {
  const { everyWeeks, count } = SeriesRepeatSchema.parse(repeat);
  const first = toZoned(timeZone, firstStart);
  const starts = [firstStart];
  for (let visit = 1; visit < count; visit += 1) {
    const date = addDays(first, visit * everyWeeks * 7);
    starts.push(fromZoned(timeZone, date, first.minuteOfDay));
  }
  return starts;
}

/** The start times of a series: 2–26, in order, at least a day apart. */
const SeriesStartsSchema = z
  .array(UtcDateTimeSchema)
  .min(SERIES_MIN_VISITS)
  .max(SERIES_MAX_VISITS)
  .superRefine((starts, ctx) => {
    for (let index = 1; index < starts.length; index += 1) {
      const gap = Date.parse(String(starts[index])) - Date.parse(String(starts[index - 1]));
      if (gap < DAY_MS) {
        ctx.addIssue({
          code: 'custom',
          message: 'Visits must be in order and at least a day apart',
          path: [index],
        });
      }
    }
  });

/** `POST /v1/bookings/series/preview`: the repeat's dates, each checked; nothing is booked. */
export const BookingSeriesPreviewInputSchema = z
  .object({
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema,
    /** The first visit. */
    startsAt: UtcDateTimeSchema,
    repeat: SeriesRepeatSchema,
  })
  .strict();
export type BookingSeriesPreviewInput = z.input<typeof BookingSeriesPreviewInputSchema>;

/** One date of a preview: free, or not with the nearest free times (same staff member). */
export const SeriesVisitPreviewSchema = z.object({
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  free: z.boolean(),
  /** Not free because it is further ahead than the business takes bookings. */
  tooFarAhead: z.boolean(),
  alternatives: z.array(AvailableSlotSchema),
});
export type SeriesVisitPreview = z.infer<typeof SeriesVisitPreviewSchema>;

export const BookingSeriesPreviewSchema = z.object({
  visits: z.array(SeriesVisitPreviewSchema).max(SERIES_MAX_VISITS),
  /** How far ahead the staff member takes bookings (the "maximum advance" rule), in days. */
  maximumAdvanceDays: z.number().int().positive(),
});
export type BookingSeriesPreview = z.infer<typeof BookingSeriesPreviewSchema>;

/**
 * `POST /v1/bookings/series`: the start times the member settled on (the repeat's dates, a taken
 * one replaced by an alternative they picked). Each is checked again when booked; one no longer
 * free is skipped. Staff book only their own staff member; there is no override.
 */
export const BookingSeriesInputSchema = z
  .object({
    clientId: ClientIdSchema,
    clientContact: ClientContactSchema.optional(),
    serviceId: ServiceIdSchema,
    staffMemberId: StaffMemberIdSchema,
    everyWeeks: EveryWeeksSchema,
    startsAts: SeriesStartsSchema,
    idempotencyKey: IdempotencyKeySchema.optional(),
    /** Email the client one confirmation with every date (D-4). */
    notifyClient: z.boolean().default(true),
  })
  .strict();
export type BookingSeriesInput = z.input<typeof BookingSeriesInputSchema>;

/** A date of a series that wasn't booked, with the nearest free times. */
export const SkippedVisitSchema = z.object({
  startsAt: UtcDateTimeSchema,
  alternatives: z.array(AvailableSlotSchema),
});
export type SkippedVisit = z.infer<typeof SkippedVisitSchema>;

/** The answer of `POST /v1/bookings/series` (201, or the first answer again for a retry). */
export const BookingSeriesResultSchema = z.object({
  seriesId: BookingSeriesIdSchema,
  everyWeeks: EveryWeeksSchema,
  bookings: z.array(BookingSchema).max(SERIES_MAX_VISITS),
  skipped: z.array(SkippedVisitSchema).max(SERIES_MAX_VISITS),
});
export type BookingSeriesResult = z.infer<typeof BookingSeriesResultSchema>;

/** `GET /v1/bookings/series/:seriesId`: the series' visits, earliest first (any status). */
export const BookingSeriesSchema = z.object({
  id: BookingSeriesIdSchema,
  everyWeeks: EveryWeeksSchema,
  bookings: z.array(BookingSchema).max(SERIES_MAX_VISITS),
});
export type BookingSeries = z.infer<typeof BookingSeriesSchema>;

/** `POST /v1/bookings/:id/cancel-following`: this visit and the later ones of its series. */
export const CancelFollowingInputSchema = z
  .object({ notifyClient: z.boolean().default(true) })
  .strict();
export type CancelFollowingInput = z.input<typeof CancelFollowingInputSchema>;

export const CancelFollowingResultSchema = z.object({
  bookings: z.array(BookingSchema).max(SERIES_MAX_VISITS),
});
export type CancelFollowingResult = z.infer<typeof CancelFollowingResultSchema>;

/**
 * "Visit 3 of 8": the visit's place among the series' visits that aren't cancelled, earliest
 * first; `null` when it is cancelled itself or not in the list.
 */
export function visitNumber(
  bookings: readonly { id: string; startsAt: string; status: string }[],
  bookingId: string,
): { number: number; of: number } | null {
  const kept = bookings
    .filter((booking) => booking.status !== 'cancelled')
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const index = kept.findIndex((booking) => booking.id === bookingId);
  return index === -1 ? null : { number: index + 1, of: kept.length };
}

/** One series visit's place in its series ("2 of 8"), for the calendar's blocks (S72.2). */
export const VisitNumberSchema = z.object({
  bookingId: BookingIdSchema,
  number: z.number().int().min(1).max(SERIES_MAX_VISITS),
  of: z.number().int().min(1).max(SERIES_MAX_VISITS),
});
export type VisitNumber = z.infer<typeof VisitNumberSchema>;

/**
 * `GET /v1/calendar/visit-numbers` (S72.2, AC-X-193): every series visit starting in the range,
 * not cancelled, with its place among its series' visits the member may see, in one request.
 */
export const VisitNumbersResponseSchema = z.object({
  visits: z.array(VisitNumberSchema).max(VISIT_NUMBERS_MAX),
  /** More series visits start in the range after the last one (see `VISIT_NUMBERS_MAX`). */
  truncated: z.boolean(),
});
export type VisitNumbersResponse = z.infer<typeof VisitNumbersResponseSchema>;
