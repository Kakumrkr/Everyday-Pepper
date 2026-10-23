import { z } from 'zod';
import { minutesOfDay, StaffMemberIdSchema, WeekdaySchema } from './appointments.js';
import { daysBetween, LocalDateSchema, RULE_LIMITS } from './rules.js';

// Learned rules (S31, ADR-0037, playbook principle 9 and D-10): a preference a member states
// ("no bookings before 10 on Mondays") becomes a deterministic booking rule or a change to
// working hours, only after an owner or manager approves it (`rule.change`, locked to "ask").
// No free-form rules: each kind maps onto a rule type (ADR-0016) or the weekly hours (ADR-0015).

const ClockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM in the business time zone, e.g. 10:00');

const scope = {
  /** The staff member it is for; `null`: the whole business (every staff member's hours). */
  staffMemberId: StaffMemberIdSchema.nullable(),
};

/**
 * One learned rule: a booking rule (minimum notice, how far ahead, a daily cap, days off for
 * the business or one staff member) or a limit on one weekday's working hours (`hours_limit`:
 * not before / not after a time, or closed that day). Applying it replaces the same rule type
 * for the same scope; the hours are cut to the limit, never extended.
 */
export const LearnedRuleSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('minimum_notice'),
    ...scope,
    minutes: z.number().int().min(0).max(RULE_LIMITS.maxMinimumNoticeMinutes),
  }),
  z.strictObject({
    kind: z.literal('maximum_advance'),
    ...scope,
    days: z.number().int().min(1).max(RULE_LIMITS.maxAdvanceDays),
  }),
  z.strictObject({
    kind: z.literal('max_bookings_per_day'),
    ...scope,
    count: z.number().int().min(1).max(RULE_LIMITS.maxBookingsPerDay),
  }),
  z
    .strictObject({
      kind: z.literal('blackout_window'),
      ...scope,
      startDate: LocalDateSchema,
      endDate: LocalDateSchema,
    })
    .refine(
      (r) =>
        daysBetween(r.startDate, r.endDate) >= 0 &&
        daysBetween(r.startDate, r.endDate) < RULE_LIMITS.maxBlackoutDays,
      {
        message: 'The last day must not be before the first, nor a year after it',
        path: ['endDate'],
      },
    ),
  z
    .strictObject({
      kind: z.literal('hours_limit'),
      ...scope,
      weekday: WeekdaySchema,
      /** No work before this time that day; `null`: no limit. */
      notBefore: ClockTimeSchema.nullable(),
      /** No work after this time that day; `null`: no limit. */
      notAfter: ClockTimeSchema.nullable(),
      /** No work at all that day (both times `null`). */
      closed: z.boolean(),
    })
    .refine((r) => r.closed === (r.notBefore === null && r.notAfter === null), {
      message: 'Closed takes no times; otherwise give notBefore, notAfter or both',
      path: ['closed'],
    })
    .refine(
      (r) =>
        r.notBefore === null ||
        r.notAfter === null ||
        minutesOfDay(r.notAfter) > minutesOfDay(r.notBefore),
      { message: 'notAfter must be after notBefore', path: ['notAfter'] },
    ),
]);
export type LearnedRule = z.output<typeof LearnedRuleSchema>;
export type LearnedRuleKind = LearnedRule['kind'];

/** The permission approving a learned rule needs, by kind, on top of `rule.change`'s. */
export function learnedRulePermission(
  rule: Pick<LearnedRule, 'kind'>,
): 'rules.manage' | 'hours.manage' {
  return rule.kind === 'hours_limit' ? 'hours.manage' : 'rules.manage';
}
