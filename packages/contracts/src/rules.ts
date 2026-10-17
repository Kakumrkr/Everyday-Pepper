import { z } from 'zod';
import { StaffMemberIdSchema } from './appointments.js';

// Booking rules (ADR-0016): the limits on when a business can be booked, beyond its staff
// members' weekly hours, time off, the services' buffers and who offers which service (those
// are base data, ADR-0015, and the availability engine reads them from there). Each rule type
// has its own Zod schema and a schema version, so a later version can upgrade stored rules.
// A rule applies to the whole business, or to one staff member (`staffMemberId`), which wins.
// Precedence: a staff member's rule → the business's rule → the industry template's default →
// the platform default below.

/** Rule types, in the order the api lists them. */
export const RuleTypeSchema = z.enum([
  'slot_interval',
  'minimum_notice',
  'maximum_advance',
  'max_bookings_per_day',
  'blackout_window',
]);
export type RuleType = z.infer<typeof RuleTypeSchema>;

/** Limits shared by the schemas and the database checks (migration 0013). */
export const RULE_LIMITS = {
  /** Steps between offered start times; each divides an hour, so the grid survives DST. */
  slotIntervalMinutes: [5, 10, 15, 20, 30, 60] as const,
  /** Up to 30 days' notice. */
  maxMinimumNoticeMinutes: 30 * 24 * 60,
  /** Bookable up to two years ahead. */
  maxAdvanceDays: 730,
  maxBookingsPerDay: 100,
  /** A blackout window covers at most this many days. */
  maxBlackoutDays: 366,
  /** Rules per business, staff members' included. */
  maxRules: 300,
} as const;

/**
 * What applies when neither the business nor its template says otherwise (user, S11): 15-minute
 * steps, 2 hours' notice, up to 90 days ahead, no daily cap.
 */
export const PLATFORM_RULE_DEFAULTS = {
  slotIntervalMinutes: 15,
  minimumNoticeMinutes: 120,
  maximumAdvanceDays: 90,
  maxBookingsPerDay: null,
} as const satisfies RuleDefaults;

/**
 * Defaults for the single-valued rules: what an industry template sets (S13) and the platform
 * defaults above. `maxBookingsPerDay: null` means no cap.
 */
export interface RuleDefaults {
  slotIntervalMinutes: SlotIntervalMinutes;
  minimumNoticeMinutes: number;
  maximumAdvanceDays: number;
  maxBookingsPerDay: number | null;
}

export type SlotIntervalMinutes = (typeof RULE_LIMITS.slotIntervalMinutes)[number];

/** A calendar date `YYYY-MM-DD` that exists, e.g. `2026-12-25`. */
export const LocalDateSchema = z.iso.date();
export type LocalDate = z.infer<typeof LocalDateSchema>;

/** Days from `start` to `end` (both `YYYY-MM-DD`); negative when `end` is earlier. */
export function daysBetween(start: LocalDate, end: LocalDate): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
}

const scope = {
  /** The staff member the rule is for; `null`: the whole business. */
  staffMemberId: StaffMemberIdSchema.nullable().default(null),
};

const SlotIntervalRuleSchema = z
  .object({
    type: z.literal('slot_interval'),
    version: z.literal(1).default(1),
    ...scope,
    params: z
      .object({
        minutes: z.union(RULE_LIMITS.slotIntervalMinutes.map((minutes) => z.literal(minutes))),
      })
      .strict(),
  })
  .strict();

const MinimumNoticeRuleSchema = z
  .object({
    type: z.literal('minimum_notice'),
    version: z.literal(1).default(1),
    ...scope,
    params: z
      .object({ minutes: z.number().int().min(0).max(RULE_LIMITS.maxMinimumNoticeMinutes) })
      .strict(),
  })
  .strict();

const MaximumAdvanceRuleSchema = z
  .object({
    type: z.literal('maximum_advance'),
    version: z.literal(1).default(1),
    ...scope,
    params: z.object({ days: z.number().int().min(1).max(RULE_LIMITS.maxAdvanceDays) }).strict(),
  })
  .strict();

const MaxBookingsPerDayRuleSchema = z
  .object({
    type: z.literal('max_bookings_per_day'),
    version: z.literal(1).default(1),
    ...scope,
    params: z
      .object({ count: z.number().int().min(1).max(RULE_LIMITS.maxBookingsPerDay) })
      .strict(),
  })
  .strict();

/**
 * Days the business (or one staff member) cannot be booked, e.g. holidays: local dates in the
 * business's time zone, both ends included (user, S11).
 */
const BlackoutWindowRuleSchema = z
  .object({
    type: z.literal('blackout_window'),
    version: z.literal(1).default(1),
    ...scope,
    params: z
      .object({ startDate: LocalDateSchema, endDate: LocalDateSchema })
      .strict()
      .refine((p) => daysBetween(p.startDate, p.endDate) >= 0, {
        message: 'The last day must not be before the first',
        path: ['endDate'],
      })
      .refine((p) => daysBetween(p.startDate, p.endDate) < RULE_LIMITS.maxBlackoutDays, {
        message: `A blackout window may cover at most ${String(RULE_LIMITS.maxBlackoutDays)} days`,
        path: ['endDate'],
      }),
  })
  .strict();

/** One booking rule, at its current schema version. */
export const RuleSchema = z.discriminatedUnion('type', [
  SlotIntervalRuleSchema,
  MinimumNoticeRuleSchema,
  MaximumAdvanceRuleSchema,
  MaxBookingsPerDayRuleSchema,
  BlackoutWindowRuleSchema,
]);
export type Rule = z.output<typeof RuleSchema>;
export type RuleInput = z.input<typeof RuleSchema>;

/** Rule types of which a business, and each staff member, has at most one. */
const SINGLE_VALUED: ReadonlySet<RuleType> = new Set([
  'slot_interval',
  'minimum_notice',
  'maximum_advance',
  'max_bookings_per_day',
]);

/**
 * The business's whole rule set (`PUT /v1/rules`), replacing the previous one. At most one rule
 * of each single-valued type per scope; blackout windows may repeat. Returned sorted: business
 * rules first, then by staff member, type and (for blackouts) first day.
 */
export const BookingRulesSchema = z
  .object({ rules: z.array(RuleSchema).max(RULE_LIMITS.maxRules) })
  .strict()
  .transform(({ rules }) => ({ rules: sortRules(rules) }))
  .refine(({ rules }) => !hasDuplicate(rules), {
    message: 'Each rule type may be set once for the business and once per staff member',
    path: ['rules'],
  });
export type BookingRules = z.output<typeof BookingRulesSchema>;
export type BookingRulesInput = z.input<typeof BookingRulesSchema>;

/** `GET /v1/rules` and `PUT /v1/rules`: the business's rules. */
export const BookingRulesResponseSchema = z.object({ rules: z.array(RuleSchema) });
export type BookingRulesResponse = z.infer<typeof BookingRulesResponseSchema>;

function sortKey(rule: Rule): readonly [string, number, string, string] {
  return [
    rule.staffMemberId ?? '',
    RuleTypeSchema.options.indexOf(rule.type),
    rule.type === 'blackout_window' ? rule.params.startDate : '',
    rule.type === 'blackout_window' ? rule.params.endDate : '',
  ];
}

function compareRules(a: Rule, b: Rule): number {
  const keyA = sortKey(a);
  const keyB = sortKey(b);
  for (let i = 0; i < keyA.length; i++) {
    const x = keyA[i] ?? '';
    const y = keyB[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function sortRules(rules: Rule[]): Rule[] {
  return [...rules].sort(compareRules);
}

/** Whether a sorted rule list sets a single-valued type twice for one scope, or repeats a blackout. */
function hasDuplicate(sorted: Rule[]): boolean {
  return sorted.some((rule, index) => {
    const previous = sorted[index - 1];
    if (previous?.type !== rule.type || previous.staffMemberId !== rule.staffMemberId) return false;
    return SINGLE_VALUED.has(rule.type) || compareRules(previous, rule) === 0;
  });
}
