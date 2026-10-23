import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  AutonomyLevelSchema,
  BULK_RECIPIENT_LIMIT,
  RiskTierSchema,
  type AutonomyAction,
  type AutonomyLevel,
  type AutonomyOutcome,
  type AutonomyRequest,
  type BusinessAutonomy,
  type RiskTier,
} from '@pepper/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideAutonomy, resolveAutonomy } from './autonomy.js';

// decideAutonomy is the trust layer's core rule (ADR-0028): property tests over every action ×
// level × tier × context, then the rules pinned one by one.

const ACTIONS = AutonomyActionSchema.options;
const LEVELS = AutonomyLevelSchema.options;
const TIERS = RiskTierSchema.options;

const LEVEL_RANK: Record<AutonomyLevel, number> = { ask: 0, notify: 1, auto: 2 };
const OUTCOME_RANK: Record<AutonomyOutcome, number> = {
  propose: 0,
  execute_and_notify: 1,
  execute: 2,
};
const TIER_RANK: Record<RiskTier, number> = {
  read: 0,
  internal_write: 1,
  external_or_irreversible: 2,
};

/** Any business autonomy the settings could hold (bulk messages never "just do it"). */
const autonomyArb: fc.Arbitrary<BusinessAutonomy> = fc
  .record({
    askFirst: fc.boolean(),
    levels: fc.record(
      Object.fromEntries(
        ACTIONS.map((action) => [
          action,
          fc.constantFrom(
            ...LEVELS.filter((level) => level !== 'auto' || AUTONOMY_ACTIONS[action].allowsAuto),
          ),
        ]),
      ) as Record<AutonomyAction, fc.Arbitrary<AutonomyLevel>>,
    ),
  })
  .map((value) => value);

const requestArb: fc.Arbitrary<AutonomyRequest> = fc.record({
  actions: fc.uniqueArray(fc.constantFrom(...ACTIONS), { maxLength: 3 }),
  tier: fc.constantFrom(...TIERS),
  recipients: fc.nat({ max: 40 }),
  untrustedContext: fc.boolean(),
  changesAutonomy: fc.boolean(),
});

/** The tier the decision must respect: the declared one or the strictest action's. */
function effectiveTier(request: AutonomyRequest): RiskTier {
  return [request.tier, ...request.actions.map((a) => AUTONOMY_ACTIONS[a].riskTier)].reduce(
    (a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a),
  );
}

const rank = (request: AutonomyRequest, autonomy: BusinessAutonomy) =>
  OUTCOME_RANK[decideAutonomy(request, autonomy).outcome];

describe('decideAutonomy: properties', () => {
  it('never acts more freely than the setting of any action involved', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        const decision = decideAutonomy(request, autonomy);
        for (const action of request.actions) {
          expect(OUTCOME_RANK[decision.outcome]).toBeLessThanOrEqual(
            LEVEL_RANK[autonomy.levels[action]],
          );
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('a riskier context never gives a freer decision (monotonic)', () => {
    fc.assert(
      fc.property(
        requestArb,
        autonomyArb,
        fc.nat({ max: 40 }),
        fc.constantFrom(...ACTIONS),
        fc.constantFrom(...TIERS),
        (request, autonomy, moreRecipients, extraAction, higherTier) => {
          const base = rank(request, autonomy);
          expect(rank({ ...request, untrustedContext: true }, autonomy)).toBeLessThanOrEqual(base);
          expect(rank({ ...request, changesAutonomy: true }, autonomy)).toBeLessThanOrEqual(base);
          expect(
            rank({ ...request, recipients: request.recipients + moreRecipients }, autonomy),
          ).toBeLessThanOrEqual(base);
          if (TIER_RANK[higherTier] >= TIER_RANK[request.tier]) {
            expect(rank({ ...request, tier: higherTier }, autonomy)).toBeLessThanOrEqual(base);
          }
          if (request.actions.length > 0 && !request.actions.includes(extraAction)) {
            expect(
              rank({ ...request, actions: [...request.actions, extraAction] }, autonomy),
            ).toBeLessThanOrEqual(base);
          }
          expect(rank(request, { ...autonomy, askFirst: true })).toBeLessThanOrEqual(base);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('lowering any level never gives a freer decision (monotonic in the settings)', () => {
    fc.assert(
      fc.property(
        requestArb,
        autonomyArb,
        fc.constantFrom(...ACTIONS),
        (request, autonomy, action) => {
          const lowered: BusinessAutonomy = {
            ...autonomy,
            levels: { ...autonomy.levels, [action]: 'ask' },
          };
          expect(rank(request, lowered)).toBeLessThanOrEqual(rank(request, autonomy));
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('every write asks first while "Ask me first for everything" is on', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        fc.pre(effectiveTier(request) !== 'read' || request.changesAutonomy === true);
        expect(decideAutonomy(request, { ...autonomy, askFirst: true }).outcome).toBe('propose');
      }),
    );
  });

  it('an external action to more than ten clients always asks (AC-W7-3)', () => {
    fc.assert(
      fc.property(
        requestArb,
        autonomyArb,
        fc.integer({ min: BULK_RECIPIENT_LIMIT + 1, max: 10_000 }),
        (request, autonomy, recipients) => {
          fc.pre(effectiveTier(request) === 'external_or_irreversible');
          expect(decideAutonomy({ ...request, recipients }, autonomy).outcome).toBe('propose');
        },
      ),
    );
  });

  it('untrusted text before an external action always asks, and never runs a write quietly', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        const decision = decideAutonomy({ ...request, untrustedContext: true }, autonomy);
        const tier = effectiveTier(request);
        if (tier === 'external_or_irreversible') expect(decision.outcome).toBe('propose');
        if (tier !== 'read' || request.changesAutonomy === true) {
          expect(decision.outcome).not.toBe('execute');
        }
      }),
    );
  });

  it('saving to memory after untrusted text always asks, whatever the dial (S30)', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        fc.pre(request.changesAutonomy !== true);
        const decision = decideAutonomy(
          {
            ...request,
            actions: ['client_note.save', ...request.actions],
            tier: request.tier === 'read' ? 'internal_write' : request.tier,
            untrustedContext: true,
          },
          autonomy,
        );
        expect(decision.outcome).toBe('propose');
      }),
    );
  });

  it('saving to memory in a trusted turn follows the dial (S30)', () => {
    const save = {
      actions: ['client_note.save' as const],
      tier: 'internal_write' as const,
      recipients: 0,
      untrustedContext: false,
    };
    const levels = {
      ...resolveAutonomy(undefined, {}).levels,
      'client_note.save': 'auto' as const,
    };
    expect(decideAutonomy(save, { askFirst: false, levels })).toEqual({
      outcome: 'execute',
      reason: 'setting',
    });
    expect(
      decideAutonomy({ ...save, untrustedContext: true }, { askFirst: false, levels }),
    ).toEqual({
      outcome: 'propose',
      reason: 'untrusted_context',
    });
    // Untrusted only because of what the business remembers: the dial decides, never quietly.
    expect(
      decideAutonomy(
        { ...save, untrustedContext: true, outsideText: false },
        { askFirst: false, levels },
      ),
    ).toEqual({ outcome: 'execute_and_notify', reason: 'untrusted_context' });
  });

  it('changing autonomy always asks', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        expect(decideAutonomy({ ...request, changesAutonomy: true }, autonomy)).toEqual({
          outcome: 'propose',
          reason: 'autonomy_change',
        });
      }),
    );
  });

  it('a write that names no action on the dial is proposed, never run', () => {
    fc.assert(
      fc.property(requestArb, autonomyArb, (request, autonomy) => {
        fc.pre(request.changesAutonomy !== true);
        const decision = decideAutonomy(
          {
            ...request,
            actions: [],
            tier: request.tier === 'read' ? 'internal_write' : request.tier,
          },
          autonomy,
        );
        expect(decision.outcome).toBe('propose');
      }),
    );
  });
});

describe('decideAutonomy: every action × level × tier × context', () => {
  const everyCase = ACTIONS.flatMap((action) =>
    LEVELS.filter((level) => level !== 'auto' || AUTONOMY_ACTIONS[action].allowsAuto).flatMap(
      (level) =>
        TIERS.flatMap((tier) =>
          [false, true].flatMap((untrustedContext) =>
            [1, BULK_RECIPIENT_LIMIT, BULK_RECIPIENT_LIMIT + 1].map((recipients) => ({
              action,
              level,
              tier,
              untrustedContext,
              recipients,
            })),
          ),
        ),
    ),
  );

  it.each(everyCase)(
    '$action at $level, declared $tier, untrusted $untrustedContext, $recipients recipient(s)',
    ({ action, level, tier, untrustedContext, recipients }) => {
      const autonomy = resolveAutonomy(undefined, { [action]: level });
      const decision = decideAutonomy(
        { actions: [action], tier, recipients, untrustedContext },
        autonomy,
      );
      const external =
        tier === 'external_or_irreversible' ||
        AUTONOMY_ACTIONS[action].riskTier === 'external_or_irreversible';
      const remembers = 'asksAfterUntrusted' in AUTONOMY_ACTIONS[action];
      const expected: AutonomyOutcome =
        level === 'ask' ||
        (external && (recipients > BULK_RECIPIENT_LIMIT || untrustedContext)) ||
        (remembers && untrustedContext)
          ? 'propose'
          : level === 'notify' || untrustedContext
            ? 'execute_and_notify'
            : 'execute';
      expect(decision.outcome).toBe(expected);
    },
  );
});

describe('decideAutonomy: rules', () => {
  const defaults = resolveAutonomy(undefined, {});

  it('reads run without asking and say why', () => {
    expect(
      decideAutonomy(
        { actions: [], tier: 'read', recipients: 0, untrustedContext: true },
        defaults,
      ),
    ).toEqual({ outcome: 'execute', reason: 'read_only' });
  });

  it('follows the setting, with the reason "setting"', () => {
    expect(
      decideAutonomy(
        {
          actions: ['booking.move'],
          tier: 'internal_write',
          recipients: 0,
          untrustedContext: false,
        },
        defaults,
      ),
    ).toEqual({ outcome: 'execute_and_notify', reason: 'setting' });
    expect(
      decideAutonomy(
        {
          actions: ['booking.create'],
          tier: 'internal_write',
          recipients: 0,
          untrustedContext: false,
        },
        defaults,
      ),
    ).toEqual({ outcome: 'propose', reason: 'setting' });
  });

  it('takes the strictest of a tool call’s actions: a move that emails the client', () => {
    const autonomy = resolveAutonomy(undefined, { 'booking.move': 'auto' });
    expect(
      decideAutonomy(
        {
          actions: ['booking.move', 'message.confirmation'],
          tier: 'internal_write',
          recipients: 1,
          untrustedContext: false,
        },
        resolveAutonomy(
          { askFirst: false, levels: { 'message.confirmation': 'notify' } },
          {
            'booking.move': 'auto',
          },
        ),
      ),
    ).toEqual({ outcome: 'execute_and_notify', reason: 'setting' });
    expect(
      decideAutonomy(
        {
          actions: ['booking.move'],
          tier: 'internal_write',
          recipients: 0,
          untrustedContext: false,
        },
        autonomy,
      ),
    ).toEqual({ outcome: 'execute', reason: 'setting' });
  });

  it('a tool that under-declares its tier is held to its actions’ tier', () => {
    const autonomy = resolveAutonomy(undefined, { 'message.confirmation': 'auto' });
    expect(
      decideAutonomy(
        {
          actions: ['message.confirmation'],
          tier: 'read',
          recipients: 12,
          untrustedContext: false,
        },
        autonomy,
      ),
    ).toEqual({ outcome: 'propose', reason: 'bulk_lock' });
  });

  it('names the reason that made it ask', () => {
    const autonomy = resolveAutonomy(undefined, { 'message.confirmation': 'auto' });
    const external = {
      actions: ['message.confirmation'] as AutonomyAction[],
      tier: 'external_or_irreversible' as const,
      recipients: 1,
      untrustedContext: false,
    };
    expect(decideAutonomy(external, { ...autonomy, askFirst: true }).reason).toBe('ask_first');
    expect(decideAutonomy({ ...external, recipients: 11 }, autonomy).reason).toBe('bulk_lock');
    expect(decideAutonomy({ ...external, untrustedContext: true }, autonomy).reason).toBe(
      'untrusted_context',
    );
    expect(
      decideAutonomy(
        { actions: ['task.create'], tier: 'internal_write', recipients: 0, untrustedContext: true },
        resolveAutonomy(undefined, { 'task.create': 'auto' }),
      ),
    ).toEqual({ outcome: 'execute_and_notify', reason: 'untrusted_context' });
  });

  it('refuses a request that is not well formed', () => {
    expect(() =>
      decideAutonomy(
        {
          actions: ['booking.create'],
          tier: 'internal_write',
          recipients: -1,
          untrustedContext: false,
        },
        defaults,
      ),
    ).toThrow();
    expect(() =>
      decideAutonomy(
        {
          actions: ['booking.delete' as AutonomyAction],
          tier: 'internal_write',
          recipients: 0,
          untrustedContext: false,
        },
        defaults,
      ),
    ).toThrow();
  });
});

describe('resolveAutonomy', () => {
  it('takes the business’s choice, else the template’s, else the platform default', () => {
    const resolved = resolveAutonomy(
      { askFirst: true, levels: { 'booking.create': 'auto' } },
      { 'booking.create': 'notify', 'booking.move': 'ask' },
    );
    expect(resolved.askFirst).toBe(true);
    expect(resolved.levels['booking.create']).toBe('auto');
    expect(resolved.levels['booking.move']).toBe('ask');
    expect(resolved.levels['message.confirmation']).toBe('auto');
    expect(Object.keys(resolved.levels).sort()).toEqual([...ACTIONS].sort());
  });

  it('defaults to asking nothing extra and the platform levels', () => {
    const resolved = resolveAutonomy(undefined, {});
    expect(resolved.askFirst).toBe(false);
    for (const action of ACTIONS) {
      expect(resolved.levels[action]).toBe(AUTONOMY_ACTIONS[action].defaultLevel);
    }
  });

  it('fails closed on stored levels that are not allowed or not known', () => {
    const resolved = resolveAutonomy(
      { askFirst: false, levels: { 'message.bulk': 'auto', 'booking.delete': 'auto' } as never },
      {},
    );
    expect(resolved.levels['message.bulk']).toBe('ask');
    expect(resolved.levels).not.toHaveProperty('booking.delete');
  });
});
