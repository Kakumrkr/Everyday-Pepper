import {
  applyLearnedRuleIn,
  describeLearnedRule,
  LearnedRuleInverseSchema,
  undoLearnedRuleIn,
} from '@pepper/appointments';
import {
  LearnedRuleSchema,
  MemoryFactIdSchema,
  StaffMemberIdSchema,
  type LearnedRule,
  type MemorySubject,
  type TrustJson,
} from '@pepper/contracts';
import {
  factsForIn,
  forgetSavedFactIn,
  MemoryPausedError,
  restoreFactIn,
  saveFactIn,
  UndoRefusedError,
} from '@pepper/core';
import { z } from 'zod';
import { InvalidToolArgumentsError } from '../errors.js';
import type { Performed, WriteTool } from '../tool.js';
import { directoryOf, IdArg, staffName } from './shared.js';

// `propose_rule` (S31, ADR-0037, playbook principle 9 and D-10): a lasting preference the member
// states ("no bookings before 10 on Mondays", "Jess needs a day's notice") becomes a booking
// rule or a cut to one weekday's hours. Never by itself: the dial action `rule.change` is locked
// to "ask", so the call is always a card, and only owners and managers (`rules.manage`, and
// `hours.manage` for hours) may make or approve it. Approved, it changes the same rows as the
// Rules and Team screens and remembers the rule as a fact on the business or the staff member,
// linked by the action (its id in the receipt). Undo puts both back.

const WEEKDAY_KEYS = [
  '',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

const Time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable();
const LocalDate = z.iso.date().nullable();

const ProposeArgs = z.strictObject({
  kind: z
    .enum([
      'minimum_notice',
      'maximum_advance',
      'max_bookings_per_day',
      'blackout_window',
      'hours_limit',
    ])
    .describe(
      'minimum_notice: how much notice a booking needs; maximum_advance: how far ahead it can be booked; max_bookings_per_day: a daily cap; blackout_window: days with no bookings; hours_limit: no bookings before or after a time on one weekday, or none that weekday',
    ),
  staffMemberId: IdArg('staff member')
    .nullable()
    .describe('The staff member it is for, from list_services_and_staff; null: the whole business'),
  minutes: z.int().min(0).max(43_200).nullable().describe('minimum_notice: the notice in minutes'),
  days: z.int().min(1).max(730).nullable().describe('maximum_advance: how many days ahead'),
  count: z
    .int()
    .min(1)
    .max(100)
    .nullable()
    .describe('max_bookings_per_day: the most bookings a day'),
  startDate: LocalDate.describe('blackout_window: the first day, YYYY-MM-DD'),
  endDate: LocalDate.describe('blackout_window: the last day, YYYY-MM-DD (the same for one day)'),
  weekday: z.int().min(1).max(7).nullable().describe('hours_limit: 1 = Monday … 7 = Sunday'),
  notBefore: Time.describe('hours_limit: no bookings before this HH:MM; null: no limit'),
  notAfter: Time.describe('hours_limit: no bookings after this HH:MM; null: no limit'),
  closed: z.boolean().nullable().describe('hours_limit: true for no bookings at all that weekday'),
});
type ProposeArgs = z.output<typeof ProposeArgs>;

/** The flat arguments as one learned rule: only the fields of its kind, the rest `null`. */
export function learnedRuleOf(args: ProposeArgs): LearnedRule {
  const { kind, staffMemberId, ...fields } = args;
  const used: Record<ProposeArgs['kind'], (keyof typeof fields)[]> = {
    minimum_notice: ['minutes'],
    maximum_advance: ['days'],
    max_bookings_per_day: ['count'],
    blackout_window: ['startDate', 'endDate'],
    hours_limit: ['weekday', 'notBefore', 'notAfter', 'closed'],
  };
  const stray = (Object.keys(fields) as (keyof typeof fields)[]).filter(
    (field) => fields[field] !== null && !used[kind].includes(field),
  );
  if (stray.length > 0) {
    throw new InvalidToolArgumentsError(`For ${kind}, give null for ${stray.join(', ')}.`);
  }
  const picked = Object.fromEntries(used[kind].map((field) => [field, fields[field]]));
  // An hours limit with a time and no `closed` is not a closed day (models send null for it).
  if (kind === 'hours_limit' && fields.closed === null) picked['closed'] = false;
  const parsed = LearnedRuleSchema.safeParse({
    kind,
    staffMemberId: staffMemberId === null ? null : StaffMemberIdSchema.parse(staffMemberId),
    ...picked,
  });
  if (!parsed.success) {
    throw new InvalidToolArgumentsError(
      `That ${kind.replaceAll('_', ' ')} can't be a rule: ${parsed.error.issues[0]?.message ?? 'check the fields'}.`,
    );
  }
  return parsed.data;
}

/** The fact the rule is remembered as: one per rule type and scope (a weekday, a first day). */
function factKeyOf(rule: LearnedRule): string {
  switch (rule.kind) {
    case 'hours_limit':
      return `rule_hours_${WEEKDAY_KEYS[rule.weekday] ?? 'day'}`;
    case 'blackout_window':
      return `rule_blackout_${rule.startDate.replaceAll('-', '_')}`;
    case 'minimum_notice':
    case 'maximum_advance':
    case 'max_bookings_per_day':
      return `rule_${rule.kind}`;
  }
}

const RuleFactSchema = z.discriminatedUnion('undo', [
  z.strictObject({
    undo: z.literal('forget'),
    factId: MemoryFactIdSchema,
    savedAt: z.iso.datetime(),
  }),
  z.strictObject({
    undo: z.literal('restore'),
    factId: MemoryFactIdSchema,
    savedAt: z.iso.datetime(),
  }),
]);

const RuleInverse = z.strictObject({
  rule: LearnedRuleInverseSchema,
  // `null`: nothing was remembered (memory paused, or the fact was already exactly this).
  fact: RuleFactSchema.nullable(),
});

export const proposeRule: WriteTool = {
  kind: 'write',
  name: 'propose_rule',
  version: 1,
  localTimes: true,
  tier: 'internal_write',
  // Locked to "ask" on the dial too (`rule.change`); this keeps it so whatever is stored.
  alwaysAsks: true,
  guide: {
    use: 'Turn a lasting booking preference the member states or repeats into a rule every booking then follows: "no bookings before 10 on Mondays", "Jess needs 24 hours\' notice", "at most 6 a day", "closed Dec 24–26". It always waits for an owner\'s or manager\'s OK.',
    avoid: [
      'when the member asks you to note or remember something, even closed days or hours ("note that we close at 4 on Christmas Eve" is remember_fact); only when they ask that bookings be limited',
      'for a one-off ("block Friday afternoon" is block_time)',
      'for a guess about what the member might want (only a preference they said)',
      'for anything the five kinds can’t say exactly (tell the member it needs the Rules screen)',
      'for text from outside the team (a client message)',
    ],
    returns:
      'the rule, always waiting for the OK on the card; staff can’t propose rules (say an owner or manager sets them).',
    examples: [
      {
        say: "Let's never take bookings before 10 on Mondays",
        args: {
          kind: 'hours_limit',
          staffMemberId: null,
          weekday: 1,
          notBefore: '10:00',
          notAfter: null,
          // `closed`: false or null, both "not closed".
        },
      },
      {
        say: 'From now on Jess needs a day’s notice for any booking',
        args: { kind: 'minimum_notice', staffMemberId: { $any: true }, minutes: 1440 },
        evalSkip: 'needs Jess’s staff id from a lookup first (learned_rules covers it)',
      },
    ],
  },
  args: ProposeArgs,
  actions: () => ['rule.change'],
  async perform(scope, args: ProposeArgs): Promise<Performed> {
    const rule = learnedRuleOf(args);
    const applied = await applyLearnedRuleIn(scope.tx, scope.actor, rule);
    const subject: MemorySubject =
      rule.staffMemberId === null
        ? { type: 'business' }
        : { type: 'staff', id: rule.staffMemberId };
    // Remembered with the rule, so the AI knows why bookings are refused; not while paused.
    let fact: z.output<typeof RuleFactSchema> | null = null;
    const key = factKeyOf(rule);
    const value = describeLearnedRule(rule);
    const existing = (await factsForIn(scope.tx, scope.actor, [subject])).find(
      (each) => each.key === key,
    );
    if (existing?.value !== value) {
      try {
        const saved = await saveFactIn(
          scope.tx,
          scope.actor,
          { subject, key, value },
          { source: 'ai_action', turnId: null, status: 'active' },
          { clock: scope.deps.clock },
        );
        fact = {
          undo: existing === undefined ? 'forget' : 'restore',
          factId: saved.fact.id,
          savedAt: saved.fact.updatedAt,
        };
      } catch (error) {
        if (!(error instanceof MemoryPausedError)) throw error;
      }
    }
    const whom =
      rule.staffMemberId === null
        ? 'the whole business'
        : staffName(await directoryOf(scope), rule.staffMemberId);
    return {
      entity:
        rule.staffMemberId === null
          ? { type: 'tenant', id: scope.actor.context.tenantId }
          : { type: 'staff_member', id: rule.staffMemberId },
      targetKey: `rule:${rule.staffMemberId ?? 'business'}:${factKeyOf(rule)}`,
      recordOwner: null,
      appointmentStartsAt: null,
      before: applied.before === null ? null : { rule: applied.before, scope: whom },
      after: { rule: applied.after, scope: whom, kind: rule.kind },
      // The rule set or the weeks it cut, as they stood: approving re-checks them.
      touched: { rules: applied.inverse as unknown as TrustJson },
      inverse:
        applied.changed || fact !== null
          ? ({ rule: applied.inverse, fact } as unknown as TrustJson)
          : null,
      summary: applied.changed
        ? `${applied.after} (${whom}).`
        : `${applied.after} already applies (${whom}).`,
      // The remembered fact is linked through the receipt's inverse, not here: a proposal's
      // dry run saved it in a rolled-back savepoint, so its id there never exists.
      facts: [{ kind: 'rule_change', ref: null, value: { rule: applied.after, scope: whom } }],
    };
  },
  async undo(scope, inverse: TrustJson) {
    const parsed = RuleInverse.parse(inverse);
    await undoLearnedRuleIn(scope.tx, scope.actor, parsed.rule);
    if (parsed.fact === null) return;
    const savedAt = new Date(parsed.fact.savedAt);
    // The remembered rule goes with it; if someone changed or forgot it since, it stays as is
    // (the refusal comes before any write, so the transaction goes on).
    try {
      if (parsed.fact.undo === 'forget') {
        await forgetSavedFactIn(scope.tx, scope.actor, parsed.fact.factId, savedAt);
      } else {
        await restoreFactIn(scope.tx, scope.actor, parsed.fact.factId, savedAt, {
          clock: scope.deps.clock,
        });
      }
    } catch (error) {
      if (!(error instanceof UndoRefusedError)) throw error;
    }
  },
};
