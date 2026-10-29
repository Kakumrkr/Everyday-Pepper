import {
  BookingRulesSchema,
  clockTime,
  LearnedRuleSchema,
  learnedRulePermission,
  minutesOfDay,
  StaffMemberIdSchema,
  WeeklyHoursSchema,
  type BookingRules,
  type LearnedRule,
  type Rule,
  type StaffMemberId,
  type WeeklyHours,
} from '@pepper/contracts';
import { auditActorOf, requirePermission, UndoRefusedError, type Actor } from '@pepper/core';
import {
  appendAuditEntry,
  findStaffMemberIds,
  listBookingRules,
  listWorkingHours,
  lockBookingRules,
  lockStaffMember,
  replaceBookingRules as replaceBookingRuleRows,
  replaceWorkingHours as replaceWorkingHourRows,
  type TenantTx,
} from '@pepper/db';
import { z } from 'zod';
import { StaffMemberNotFoundError } from '../errors.js';
import { noteBookableIn } from './activation.js';
import { listStaffIn } from './staff.js';
import { hoursToMinutes, minutesToHours, rowsToRules, sameValues } from '../mapping.js';

// Learned rules (S31, ADR-0037, playbook principle 9): a preference a member stated becomes a
// deterministic booking rule (ADR-0016) or a limit on one weekday's working hours (ADR-0015),
// through the same rows, checks and audit entries as the Rules and Team screens. The AI's
// `propose_rule` runs this only after an owner or manager approved it (`rule.change`, locked to
// "ask"); its inverse puts back exactly what was there, unless it changed since.

const WEEKDAYS = [
  'Mondays',
  'Tuesdays',
  'Wednesdays',
  'Thursdays',
  'Fridays',
  'Saturdays',
  'Sundays',
];

/** Notice in words: "90 minutes' notice", "1 hour's notice", "2 days' notice". */
function noticeWords(minutes: number): string {
  const [count, unit] =
    minutes % 1440 === 0
      ? [minutes / 1440, 'day']
      : minutes % 60 === 0
        ? [minutes / 60, 'hour']
        : [minutes, 'minute'];
  return `${String(count)} ${unit}${count === 1 ? "'s" : "s'"} notice`;
}

function weekdayWords(weekday: number): string {
  return WEEKDAYS[weekday - 1] ?? 'that day';
}

/** A learned rule in one plain sentence, as the card and the remembered fact say it. */
export function describeLearnedRule(rule: LearnedRule): string {
  switch (rule.kind) {
    case 'minimum_notice':
      return rule.minutes === 0
        ? 'Bookings need no notice'
        : `Bookings need at least ${noticeWords(rule.minutes)}`;
    case 'maximum_advance':
      return `Bookings at most ${String(rule.days)} days ahead`;
    case 'max_bookings_per_day':
      return `At most ${String(rule.count)} booking${rule.count === 1 ? '' : 's'} a day`;
    case 'blackout_window':
      return rule.startDate === rule.endDate
        ? `No bookings on ${rule.startDate}`
        : `No bookings from ${rule.startDate} to ${rule.endDate}`;
    case 'hours_limit': {
      const day = weekdayWords(rule.weekday);
      if (rule.closed) return `No bookings on ${day}`;
      if (rule.notBefore !== null && rule.notAfter !== null) {
        return `${day} only ${rule.notBefore}–${rule.notAfter}`;
      }
      if (rule.notBefore !== null) return `No bookings before ${rule.notBefore} on ${day}`;
      return `No bookings after ${rule.notAfter ?? ''} on ${day}`;
    }
  }
}

/** What the rule set had for the same type and scope, in words (the card's "before"). */
function describeRule(rule: Rule): string {
  switch (rule.type) {
    case 'minimum_notice':
      return describeLearnedRule({
        kind: rule.type,
        staffMemberId: null,
        minutes: rule.params.minutes,
      });
    case 'maximum_advance':
      return describeLearnedRule({ kind: rule.type, staffMemberId: null, days: rule.params.days });
    case 'max_bookings_per_day':
      return describeLearnedRule({
        kind: rule.type,
        staffMemberId: null,
        count: rule.params.count,
      });
    case 'blackout_window':
      return describeLearnedRule({ kind: rule.type, staffMemberId: null, ...rule.params });
    case 'slot_interval':
      return `Start times every ${String(rule.params.minutes)} minutes`;
  }
}

/** What applying it did, for the action's card, its fingerprint and its Undo. */
export interface LearnedRuleApplied {
  /** In words: what applied before for this type and scope (`null`: the default), and now. */
  before: string | null;
  after: string;
  /** Whether anything changed (the same rule again changes nothing). */
  changed: boolean;
  /** Exactly what was there and what is there now, for Undo. */
  inverse: LearnedRuleInverse;
}

const RulesSideSchema = z.array(z.unknown());
const HoursSideSchema = z.strictObject({
  staffMemberId: StaffMemberIdSchema,
  before: z.unknown(),
  after: z.unknown(),
});

/** The inverse of a learned rule: the whole rule set, or the weeks it cut, before and after. */
export const LearnedRuleInverseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('rules'), before: RulesSideSchema, after: RulesSideSchema }),
  z.strictObject({ kind: z.literal('hours'), weeks: z.array(HoursSideSchema).max(200) }),
]);
export type LearnedRuleInverse = z.output<typeof LearnedRuleInverseSchema>;

function ruleOf(rule: Exclude<LearnedRule, { kind: 'hours_limit' }>): Rule {
  const scope = { staffMemberId: rule.staffMemberId, version: 1 as const };
  switch (rule.kind) {
    case 'minimum_notice':
      return { type: rule.kind, ...scope, params: { minutes: rule.minutes } };
    case 'maximum_advance':
      return { type: rule.kind, ...scope, params: { days: rule.days } };
    case 'max_bookings_per_day':
      return { type: rule.kind, ...scope, params: { count: rule.count } };
    case 'blackout_window':
      return {
        type: rule.kind,
        ...scope,
        params: { startDate: rule.startDate, endDate: rule.endDate },
      };
  }
}

async function auditRules(tx: TenantTx, actor: Actor, before: BookingRules, after: BookingRules) {
  if (sameValues(before, after)) return;
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'booking_rules.replaced',
      entity: { type: 'tenant', id: actor.context.tenantId },
      before,
      after,
    },
    requestId: actor.requestId,
  });
}

async function auditHours(
  tx: TenantTx,
  actor: Actor,
  staffMemberId: StaffMemberId,
  before: WeeklyHours,
  after: WeeklyHours,
) {
  if (sameValues(before, after)) return;
  await appendAuditEntry(tx, {
    actor: auditActorOf(actor),
    change: {
      action: 'working_hours.replaced',
      entity: { type: 'staff_member', id: staffMemberId },
      before,
      after,
    },
    requestId: actor.requestId,
  });
}

/** A week with one weekday cut to the limit (never extended). */
function cutWeek(week: WeeklyHours, rule: Extract<LearnedRule, { kind: 'hours_limit' }>) {
  const from = rule.notBefore === null ? 0 : minutesOfDay(rule.notBefore);
  const to = rule.notAfter === null ? 1440 : minutesOfDay(rule.notAfter);
  const intervals = week.intervals.flatMap((interval) => {
    if (interval.weekday !== rule.weekday) return [interval];
    if (rule.closed) return [];
    const start = Math.max(minutesOfDay(interval.start), from);
    const end = Math.min(minutesOfDay(interval.end), to);
    return end > start
      ? [{ weekday: interval.weekday, start: clockTime(start), end: clockTime(end) }]
      : [];
  });
  return WeeklyHoursSchema.parse({ intervals });
}

/** One staff member's hours on the rule's weekday, in words ("09:00–17:00", "off"). */
function dayWords(week: WeeklyHours, weekday: number): string {
  const day = week.intervals.filter((interval) => interval.weekday === weekday);
  return day.length === 0
    ? 'off'
    : day.map((interval) => `${interval.start}–${interval.end}`).join(', ');
}

/**
 * Applies a learned rule in the open transaction, as `actor` (an owner or manager approving it,
 * or the dry run of the proposal they will see): `rules.manage` for a booking rule,
 * `hours.manage` for hours. A single-valued rule replaces the one of its type for the same
 * scope; a blackout window is added. An hours limit cuts the weekday's hours of the staff
 * member, or of every active staff member for the whole business.
 */
export async function applyLearnedRuleIn(
  tx: TenantTx,
  actor: Actor,
  input: LearnedRule,
): Promise<LearnedRuleApplied> {
  const rule = LearnedRuleSchema.parse(input);
  requirePermission(actor, learnedRulePermission(rule));
  const after = describeLearnedRule(rule);
  if (rule.kind === 'hours_limit') {
    const targets =
      rule.staffMemberId === null
        ? (await listStaffIn(tx, actor)).filter((staff) => staff.active).map((staff) => staff.id)
        : [rule.staffMemberId];
    const weeks: LearnedRuleInverse & { kind: 'hours' } = { kind: 'hours', weeks: [] };
    const days: string[] = [];
    for (const staffMemberId of targets) {
      if ((await lockStaffMember(tx, staffMemberId)) === undefined) {
        throw new StaffMemberNotFoundError();
      }
      const before = minutesToHours(await listWorkingHours(tx, staffMemberId));
      const cut = cutWeek(before, rule);
      days.push(dayWords(before, rule.weekday));
      if (sameValues(before, cut)) continue;
      await replaceWorkingHourRows(tx, staffMemberId, hoursToMinutes(cut));
      const stored = minutesToHours(await listWorkingHours(tx, staffMemberId));
      await auditHours(tx, actor, staffMemberId, before, stored);
      weeks.weeks.push({ staffMemberId, before, after: stored });
    }
    const day = weekdayWords(rule.weekday);
    return {
      before:
        rule.staffMemberId === null
          ? `${day}: each person's own hours`
          : `${day}: ${days[0] ?? 'off'}`,
      after,
      changed: weeks.weeks.length > 0,
      inverse: weeks,
    };
  }

  await lockBookingRules(tx);
  if (
    rule.staffMemberId !== null &&
    (await findStaffMemberIds(tx, [rule.staffMemberId])).length !== 1
  ) {
    throw new StaffMemberNotFoundError();
  }
  const current = rowsToRules(await listBookingRules(tx));
  const next = ruleOf(rule);
  const sameSlot = (each: Rule) =>
    each.type === next.type &&
    each.staffMemberId === next.staffMemberId &&
    (next.type !== 'blackout_window' || sameValues(each.params, next.params));
  const replaced = current.rules.find(sameSlot);
  const { rules } = BookingRulesSchema.parse({
    rules: [...current.rules.filter((each) => !sameSlot(each)), next],
  });
  await replaceBookingRuleRows(tx, rules);
  const stored = rowsToRules(await listBookingRules(tx));
  await auditRules(tx, actor, current, stored);
  return {
    before: replaced === undefined ? null : describeRule(replaced),
    after,
    changed: !sameValues(current, stored),
    inverse: { kind: 'rules', before: current.rules, after: stored.rules },
  };
}

/**
 * Undoes a learned rule as `actor`: puts back the rule set or the weeks as they were, only if
 * they are still exactly as the rule left them (`UndoRefusedError('changed_since')` otherwise:
 * someone changed them on a screen since, and their change wins).
 */
export async function undoLearnedRuleIn(
  tx: TenantTx,
  actor: Actor,
  input: LearnedRuleInverse,
): Promise<void> {
  const inverse = LearnedRuleInverseSchema.parse(input);
  if (inverse.kind === 'rules') {
    requirePermission(actor, 'rules.manage');
    await lockBookingRules(tx);
    const current = rowsToRules(await listBookingRules(tx));
    const expected = BookingRulesSchema.parse({ rules: inverse.after });
    if (!sameValues(current, expected)) throw new UndoRefusedError('changed_since');
    const { rules } = BookingRulesSchema.parse({ rules: inverse.before });
    await replaceBookingRuleRows(tx, rules);
    await auditRules(tx, actor, current, rowsToRules(await listBookingRules(tx)));
    return;
  }
  requirePermission(actor, 'hours.manage');
  const checked: { staffMemberId: StaffMemberId; current: WeeklyHours; before: WeeklyHours }[] = [];
  for (const week of inverse.weeks) {
    if ((await lockStaffMember(tx, week.staffMemberId)) === undefined) {
      throw new UndoRefusedError('changed_since');
    }
    const current = minutesToHours(await listWorkingHours(tx, week.staffMemberId));
    if (!sameValues(current, WeeklyHoursSchema.parse(week.after))) {
      throw new UndoRefusedError('changed_since');
    }
    checked.push({
      staffMemberId: week.staffMemberId,
      current,
      before: WeeklyHoursSchema.parse(week.before),
    });
  }
  // All or nothing: every week is checked before any is put back.
  for (const { staffMemberId, current, before } of checked) {
    await replaceWorkingHourRows(tx, staffMemberId, hoursToMinutes(before));
    await auditHours(tx, actor, staffMemberId, current, before);
  }
  // Hours back can make the business bookable (S45, ADR-0046).
  await noteBookableIn(tx);
}
