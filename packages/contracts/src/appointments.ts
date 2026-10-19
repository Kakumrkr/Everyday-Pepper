import { z } from 'zod';
import { UserIdSchema } from './tenancy.js';
import { UtcDateTimeSchema } from './time.js';

// The appointments module's base data (ADR-0015): the services a business offers, the staff
// members who can be booked, their weekly working hours and their time off. Bookings, rules
// and availability build on these in later sessions.

/** A service id: a lowercased UUID. */
export const ServiceIdSchema = z.uuid().toLowerCase().brand<'ServiceId'>();
export type ServiceId = z.infer<typeof ServiceIdSchema>;

/** A staff member (bookable person) id: a lowercased UUID. */
export const StaffMemberIdSchema = z.uuid().toLowerCase().brand<'StaffMemberId'>();
export type StaffMemberId = z.infer<typeof StaffMemberIdSchema>;

/** A time-off entry id: a lowercased UUID. */
export const TimeOffIdSchema = z.uuid().toLowerCase().brand<'TimeOffId'>();
export type TimeOffId = z.infer<typeof TimeOffIdSchema>;

/** Limits shared by the schemas and the database checks (migration 0012). */
export const SERVICE_LIMITS = {
  /** How long a service takes, in minutes. */
  minDurationMinutes: 5,
  maxDurationMinutes: 720,
  /** Preparation before or clean-up after, in minutes. */
  maxBufferMinutes: 240,
  /** Prices in cents (integer minor units, CLAUDE.md): up to $100,000.00. */
  maxPriceCents: 10_000_000,
} as const;

/** An amount of money in US cents (integer minor units). */
export const PriceCentsSchema = z.number().int().min(0).max(SERVICE_LIMITS.maxPriceCents);

/**
 * A service as an owner or manager enters it (`POST /v1/services`, `PUT /v1/services/:id`).
 * The price shown is "from" `priceFromCents`, or the range up to `priceToCents`; with no price
 * the booking page shows none. The name is unique within the business (case-insensitive).
 */
export const ServiceInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(60).nullable().default(null),
    durationMinutes: z
      .number()
      .int()
      .min(SERVICE_LIMITS.minDurationMinutes)
      .max(SERVICE_LIMITS.maxDurationMinutes),
    bufferBeforeMinutes: z.number().int().min(0).max(SERVICE_LIMITS.maxBufferMinutes).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(SERVICE_LIMITS.maxBufferMinutes).default(0),
    priceFromCents: PriceCentsSchema.nullable().default(null),
    priceToCents: PriceCentsSchema.nullable().default(null),
    active: z.boolean().default(true),
  })
  .strict()
  .refine((s) => s.priceToCents === null || s.priceFromCents !== null, {
    message: 'A price range needs a "from" price',
    path: ['priceToCents'],
  })
  .refine(
    (s) =>
      s.priceToCents === null || s.priceFromCents === null || s.priceToCents > s.priceFromCents,
    { message: 'The "to" price must be more than the "from" price', path: ['priceToCents'] },
  );
export type ServiceInput = z.input<typeof ServiceInputSchema>;
export type ServiceFields = z.output<typeof ServiceInputSchema>;

/** A service as the api returns it. */
export const ServiceSchema = z.object({
  id: ServiceIdSchema,
  name: z.string(),
  category: z.string().nullable(),
  durationMinutes: z.number().int(),
  bufferBeforeMinutes: z.number().int(),
  bufferAfterMinutes: z.number().int(),
  priceFromCents: z.number().int().nullable(),
  priceToCents: z.number().int().nullable(),
  active: z.boolean(),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type Service = z.infer<typeof ServiceSchema>;

/** `GET /v1/services`: the business's services, by name. */
export const ServicesResponseSchema = z.object({ services: z.array(ServiceSchema) });
export type ServicesResponse = z.infer<typeof ServicesResponseSchema>;

/** A colour for the calendar, `#rrggbb` (stored lowercase). */
export const StaffColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2a7230')
  .toLowerCase();

/**
 * A staff member (someone who can be booked) as an owner or manager enters them. `userId`
 * links them to a member's app login, so that member's "own" records are this staff member's
 * (one staff member per member); `null` for someone who never signs in. `serviceIds` are the
 * services they offer (the whole set; it replaces the previous one).
 */
export const StaffMemberInputSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    color: StaffColorSchema.default('#2a7230'),
    active: z.boolean().default(true),
    userId: UserIdSchema.nullable().default(null),
    serviceIds: z
      .array(ServiceIdSchema)
      .max(200)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length, 'Each service may be listed once'),
  })
  .strict();
export type StaffMemberInput = z.input<typeof StaffMemberInputSchema>;
export type StaffMemberFields = z.output<typeof StaffMemberInputSchema>;

/** A staff member as the api returns them. */
export const StaffMemberSchema = z.object({
  id: StaffMemberIdSchema,
  displayName: z.string(),
  color: z.string(),
  active: z.boolean(),
  userId: UserIdSchema.nullable(),
  serviceIds: z.array(ServiceIdSchema),
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
});
export type StaffMember = z.infer<typeof StaffMemberSchema>;

/** `GET /v1/staff`: the business's staff members, by name. */
export const StaffResponseSchema = z.object({ staff: z.array(StaffMemberSchema) });
export type StaffResponse = z.infer<typeof StaffResponseSchema>;

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const WeekdaySchema = z.number().int().min(1).max(7);
export type Weekday = z.infer<typeof WeekdaySchema>;

/** A wall-clock time `HH:MM`, 00:00–23:59. */
const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, e.g. 09:30');
/** An end time `HH:MM`, 00:01–24:00 (24:00 = midnight at the end of the day). */
const ClockEndTimeSchema = z
  .string()
  .regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use HH:MM, e.g. 17:00 (or 24:00)');

/** Minutes after midnight of an `HH:MM` time. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** The `HH:MM` time `minutes` after midnight (0–1440). */
export function clockTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * One working interval on one weekday, in the business's local time (its time zone): the
 * same wall-clock hours every week, across daylight-saving changes. Overnight shifts are not
 * supported (end after start, same day).
 */
export const WorkingIntervalSchema = z
  .object({ weekday: WeekdaySchema, start: ClockTimeSchema, end: ClockEndTimeSchema })
  .strict()
  .refine((i) => minutesOfDay(i.end) > minutesOfDay(i.start), {
    message: 'The end must be after the start',
    path: ['end'],
  });
export type WorkingInterval = z.infer<typeof WorkingIntervalSchema>;

/**
 * A staff member's weekly working hours (`PUT /v1/staff/:id/hours`): the whole week, replacing
 * the previous one. Intervals on the same day may touch but not overlap; returned sorted by
 * weekday and start. A day without intervals is a day off.
 */
export const WeeklyHoursSchema = z
  .object({ intervals: z.array(WorkingIntervalSchema).max(7 * 6) })
  .strict()
  .transform(({ intervals }) => ({ intervals: sortIntervals(intervals) }))
  .refine(({ intervals }) => !hasOverlap(intervals), {
    message: 'Intervals on the same day must not overlap',
    path: ['intervals'],
  });
export type WeeklyHours = z.output<typeof WeeklyHoursSchema>;
export type WeeklyHoursInput = z.input<typeof WeeklyHoursSchema>;

function sortIntervals(intervals: WorkingInterval[]): WorkingInterval[] {
  return [...intervals].sort(
    (a, b) => a.weekday - b.weekday || minutesOfDay(a.start) - minutesOfDay(b.start),
  );
}

/** Whether any two intervals of a sorted list overlap on the same weekday. */
function hasOverlap(sorted: WorkingInterval[]): boolean {
  return sorted.some((interval, index) => {
    const previous = sorted[index - 1];
    return (
      previous?.weekday === interval.weekday &&
      minutesOfDay(interval.start) < minutesOfDay(previous.end)
    );
  });
}

/** Longest single time-off entry. */
export const MAX_TIME_OFF_DAYS = 366;

/**
 * Time off for a staff member (`POST /v1/staff/:id/time-off`): an exact span in UTC (the UI
 * converts from the business's time zone). No free-text reason: it would be personal data.
 */
export const TimeOffInputSchema = z
  .object({ startsAt: UtcDateTimeSchema, endsAt: UtcDateTimeSchema })
  .strict()
  .refine((t) => Date.parse(t.endsAt) > Date.parse(t.startsAt), {
    message: 'The end must be after the start',
    path: ['endsAt'],
  })
  .refine((t) => Date.parse(t.endsAt) - Date.parse(t.startsAt) <= MAX_TIME_OFF_DAYS * 86_400_000, {
    message: `Time off may last at most ${String(MAX_TIME_OFF_DAYS)} days`,
    path: ['endsAt'],
  });
export type TimeOffInput = z.input<typeof TimeOffInputSchema>;

/** A time-off entry as the api returns it. */
export const TimeOffSchema = z.object({
  id: TimeOffIdSchema,
  staffMemberId: StaffMemberIdSchema,
  startsAt: UtcDateTimeSchema,
  endsAt: UtcDateTimeSchema,
  createdAt: UtcDateTimeSchema,
});
export type TimeOff = z.infer<typeof TimeOffSchema>;

/**
 * Query of `GET /v1/staff/:id/time-off`: entries that end after `from` (default: now), by
 * start, at most `limit`.
 */
export const TimeOffQuerySchema = z
  .object({
    from: UtcDateTimeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();
export type TimeOffQuery = z.input<typeof TimeOffQuerySchema>;

export const TimeOffResponseSchema = z.object({ timeOff: z.array(TimeOffSchema) });
export type TimeOffResponse = z.infer<typeof TimeOffResponseSchema>;
