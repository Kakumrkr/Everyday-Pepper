import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PermissionSchema } from './permissions.js';
import {
  redactContacts,
  AUTONOMY_ACTIONS,
  ActionExplanationSchema,
  AutonomyActionSchema,
  AutonomyChangeSchema,
  AutonomyLevelSchema,
  AutonomySettingsSchema,
  BULK_RECIPIENT_LIMIT,
  AutonomyPresetSchema,
  AutonomyTrackRecordSchema,
  levelAllowed,
  presetLevels,
  presetOf,
  RiskTierSchema,
  StateFingerprintSchema,
  TRUST_JSON_MAX_BYTES,
  TrustJsonSchema,
  looksLikeContact,
  type AutonomyAction,
  type AutonomyLevel,
} from './trust.js';

describe('RiskTierSchema', () => {
  it.each(['read', 'internal_write', 'external_or_irreversible'])('accepts %s', (tier) => {
    expect(RiskTierSchema.parse(tier)).toBe(tier);
  });

  it.each(['', 'write', 'READ', null, undefined, 1])('rejects %s', (value) => {
    expect(RiskTierSchema.safeParse(value).success).toBe(false);
  });
});

describe('AutonomyLevelSchema', () => {
  it.each(['ask', 'notify', 'auto'])('accepts %s', (level) => {
    expect(AutonomyLevelSchema.parse(level)).toBe(level);
  });

  it.each(['just_do_it', 'Ask', '', null])('rejects %s', (value) => {
    expect(AutonomyLevelSchema.safeParse(value).success).toBe(false);
  });
});

describe('AUTONOMY_ACTIONS', () => {
  it('describes every action on the dial', () => {
    expect(Object.keys(AUTONOMY_ACTIONS).sort()).toEqual([...AutonomyActionSchema.options].sort());
  });

  it('has the approved defaults (S2)', () => {
    const defaults = Object.fromEntries(
      Object.entries(AUTONOMY_ACTIONS).map(([action, { defaultLevel }]) => [action, defaultLevel]),
    );
    expect(defaults).toEqual({
      'booking.create': 'ask',
      'booking.move': 'ask',
      'booking.cancel': 'ask',
      'booking_request.accept': 'notify',
      'time.block': 'notify',
      'client_note.save': 'notify',
      'rule.change': 'ask',
      'task.create': 'notify',
      'waitlist.change': 'notify',
      'message.confirmation': 'auto',
      'message.rebooking_nudge': 'ask',
      'message.waitlist_offer': 'ask',
      'message.bulk': 'ask',
      'message.review_request': 'ask',
    });
  });

  it('allows "just do it" for everything but learned rules and bulk messages', () => {
    const locked = Object.entries(AUTONOMY_ACTIONS)
      .filter(([, { allowsAuto }]) => !allowsAuto)
      .map(([action]) => action);
    expect(locked).toEqual(['rule.change', 'message.bulk']);
  });

  it('locks learned rules to "ask" (S31, playbook D-10)', () => {
    expect(AutonomyActionSchema.options.filter((a) => levelAllowed(a, 'notify'))).not.toContain(
      'rule.change',
    );
    expect(levelAllowed('rule.change', 'ask')).toBe(true);
    expect(levelAllowed('rule.change', 'notify')).toBe(false);
    expect(levelAllowed('rule.change', 'auto')).toBe(false);
    expect(levelAllowed('message.bulk', 'notify')).toBe(true);
    expect(levelAllowed('message.bulk', 'auto')).toBe(false);
    expect(levelAllowed('booking.create', 'auto')).toBe(true);
    expect(AUTONOMY_ACTIONS['rule.change'].permission).toBe('rules.manage');
  });

  it('gives every action a known permission and an undo window', () => {
    for (const { permission, undo } of Object.values(AUTONOMY_ACTIONS)) {
      expect(PermissionSchema.safeParse(permission).success).toBe(true);
      if (undo.kind === 'for') expect(undo.minutes).toBeGreaterThan(0);
    }
  });

  it('lets messages be undone only until they are sent, and every write for a while', () => {
    for (const { riskTier, undo } of Object.values(AUTONOMY_ACTIONS)) {
      expect(undo.kind).toBe(riskTier === 'external_or_irreversible' ? 'until_sent' : 'for');
    }
    expect(AUTONOMY_ACTIONS['booking.create'].undo).toEqual({
      kind: 'for',
      minutes: 24 * 60,
      notAfterAppointmentStart: true,
    });
  });

  it('locks bulk at more than ten recipients (AC-W7-3)', () => {
    expect(BULK_RECIPIENT_LIMIT).toBe(10);
  });

  it('never defaults to a level that is not allowed', () => {
    for (const action of AutonomyActionSchema.options) {
      expect(levelAllowed(action, AUTONOMY_ACTIONS[action].defaultLevel)).toBe(true);
    }
  });
});

describe('AutonomySettingsSchema', () => {
  it('accepts some actions and leaves the others out', () => {
    expect(AutonomySettingsSchema.parse({ 'booking.create': 'notify' })).toEqual({
      'booking.create': 'notify',
    });
    expect(AutonomySettingsSchema.parse({})).toEqual({});
  });

  it('refuses "just do it" for bulk messages, and anything but "ask" for learned rules', () => {
    expect(AutonomySettingsSchema.safeParse({ 'message.bulk': 'auto' }).success).toBe(false);
    expect(AutonomySettingsSchema.safeParse({ 'rule.change': 'notify' }).success).toBe(false);
    expect(AutonomySettingsSchema.safeParse({ 'rule.change': 'ask' }).success).toBe(true);
  });

  it('rejects unknown actions and levels', () => {
    expect(AutonomySettingsSchema.safeParse({ 'booking.delete': 'ask' }).success).toBe(false);
    expect(AutonomySettingsSchema.safeParse({ 'booking.create': 'always' }).success).toBe(false);
  });
});

describe('AutonomyChangeSchema', () => {
  it('takes the switch and levels, null going back to the default', () => {
    expect(
      AutonomyChangeSchema.parse({ askFirst: true, levels: { 'booking.create': null } }),
    ).toEqual({ askFirst: true, levels: { 'booking.create': null } });
    expect(AutonomyChangeSchema.parse({})).toEqual({});
  });

  it('refuses "just do it" for bulk messages and unknown fields', () => {
    expect(AutonomyChangeSchema.safeParse({ levels: { 'message.bulk': 'auto' } }).success).toBe(
      false,
    );
    expect(AutonomyChangeSchema.safeParse({ levels: { 'rule.change': 'notify' } }).success).toBe(
      false,
    );
    expect(AutonomyChangeSchema.safeParse({ levels: { 'rule.change': null } }).success).toBe(true);
    expect(AutonomyChangeSchema.safeParse({ tenantId: 'x' }).success).toBe(false);
  });
});

const DEFAULTS = Object.fromEntries(
  AutonomyActionSchema.options.map((action) => [action, AUTONOMY_ACTIONS[action].defaultLevel]),
) as Record<AutonomyAction, AutonomyLevel>;

describe('autonomy presets (S53)', () => {
  it('sets only levels each action allows, for every preset', () => {
    for (const preset of AutonomyPresetSchema.options) {
      const levels = presetLevels(preset, DEFAULTS);
      for (const action of AutonomyActionSchema.options) {
        expect(levelAllowed(action, levels[action])).toBe(true);
      }
    }
  });

  it('careful asks for everything; balanced is the defaults', () => {
    expect(new Set(Object.values(presetLevels('careful', DEFAULTS)))).toEqual(new Set(['ask']));
    expect(presetLevels('balanced', DEFAULTS)).toEqual(DEFAULTS);
  });

  it('hands-off does changes alone, tells about client messages, still asks for bulk and rules', () => {
    const levels = presetLevels('hands_off', DEFAULTS);
    expect(levels['booking.move']).toBe('auto');
    expect(levels['booking.cancel']).toBe('auto');
    expect(levels['message.confirmation']).toBe('auto');
    expect(levels['message.rebooking_nudge']).toBe('notify');
    expect(levels['message.waitlist_offer']).toBe('notify');
    expect(levels['message.bulk']).toBe('ask');
    expect(levels['rule.change']).toBe('ask');
  });

  it('names the preset the levels match, or none for a mix', () => {
    for (const preset of AutonomyPresetSchema.options) {
      expect(presetOf(presetLevels(preset, DEFAULTS), DEFAULTS)).toBe(preset);
    }
    expect(presetOf({ ...DEFAULTS, 'task.create': 'auto' }, DEFAULTS)).toBeNull();
    // A template whose defaults are all "ask me": careful and balanced are the same levels.
    const allAsk = presetLevels('careful', DEFAULTS);
    expect(presetOf(allAsk, allAsk)).toBe('careful');
  });

  it('takes a preset in a change, never with levels too', () => {
    expect(AutonomyChangeSchema.parse({ preset: 'careful' })).toEqual({ preset: 'careful' });
    expect(AutonomyChangeSchema.safeParse({ preset: 'reckless' }).success).toBe(false);
    expect(
      AutonomyChangeSchema.safeParse({ preset: 'careful', levels: { 'task.create': 'auto' } })
        .success,
    ).toBe(false);
  });
});

describe('AutonomyTrackRecordSchema', () => {
  const row = (action: AutonomyAction) => ({
    action,
    doneLast30Days: 3,
    correctInARow: 3,
    offer: null,
  });

  it('holds one row for every action', () => {
    expect(
      AutonomyTrackRecordSchema.safeParse({ actions: AutonomyActionSchema.options.map(row) })
        .success,
    ).toBe(true);
    expect(
      AutonomyTrackRecordSchema.safeParse({
        actions: AutonomyActionSchema.options.slice(1).map(row),
      }).success,
    ).toBe(false);
    expect(
      AutonomyTrackRecordSchema.safeParse({
        actions: AutonomyActionSchema.options.map((a) => ({ ...row(a), doneLast30Days: -1 })),
      }).success,
    ).toBe(false);
  });
});

describe('looksLikeContact', () => {
  it.each([
    'maria@example.com',
    'write to Maria.Lopez+spa@mail.co.uk please',
    '+1 (415) 555-0134',
    '415.555.0134',
    'call 4155550134',
    '07700 900123',
  ])('finds %s', (text) => {
    expect(looksLikeContact(text)).toBe(true);
  });

  it.each([
    '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b',
    '2026-10-21T14:30:00.000Z',
    '2026-10-21',
    '14:30',
    'booking:0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b',
    'from 2026-10-21 09:00 to 2026-10-21 10:30',
    'Balayage, 120 minutes, $180',
    'Call Maria on Friday about her colour',
    'room 12, 3 people',
  ])('leaves %s', (text) => {
    expect(looksLikeContact(text)).toBe(false);
  });
});

describe('TrustJsonSchema', () => {
  it('accepts ids, times, codes, numbers and short texts', () => {
    const value = {
      bookingId: '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b',
      startsAt: '2026-10-21T14:30:00.000Z',
      local: { date: '2026-10-21', time: '14:30' },
      minutes: 60,
      notify: true,
      note: null,
      tags: ['colour', 'first visit'],
    };
    expect(TrustJsonSchema.parse(value)).toEqual(value);
  });

  it('refuses a contact anywhere, keys included', () => {
    expect(TrustJsonSchema.safeParse({ a: [{ b: 'maria@example.com' }] }).success).toBe(false);
    expect(TrustJsonSchema.safeParse({ '+1 415 555 0134': true }).success).toBe(false);
  });

  it('refuses what is not plain JSON', () => {
    for (const value of [undefined, Number.NaN, Infinity, new Date(), () => 1, new Map()]) {
      expect(TrustJsonSchema.safeParse(value).success).toBe(false);
    }
  });

  it('refuses deep nesting and anything over the size limit', () => {
    let deep: unknown = 'x';
    for (let i = 0; i < 12; i += 1) deep = [deep];
    expect(TrustJsonSchema.safeParse(deep).success).toBe(false);
    expect(TrustJsonSchema.safeParse({ text: 'x'.repeat(TRUST_JSON_MAX_BYTES) }).success).toBe(
      false,
    );
  });

  it('refuses a huge value quickly, before scanning its text', () => {
    const huge = `${'a'.repeat(2_000_000)}@${'b'.repeat(2_000_000)}`;
    const started = performance.now();
    expect(TrustJsonSchema.safeParse({ text: huge }).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('scans the largest allowed text in linear time', () => {
    const text = `${'a'.repeat(4000)}@${'b'.repeat(4000)}`;
    const started = performance.now();
    expect(looksLikeContact(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('never accepts a value holding an email address (property)', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.emailAddress(), (value, email) => {
        expect(TrustJsonSchema.safeParse({ value, email }).success).toBe(false);
      }),
    );
  });
});

describe('ActionExplanationSchema', () => {
  const explanation = {
    requestMessageId: null,
    steps: [{ tool: 'find_availability', input: { date: '2026-10-23' } }],
    facts: [{ kind: 'rule.min_notice', ref: null, value: { minutes: 120 } }],
    alternatives: [{ startsAt: '2026-10-23T15:00:00.000Z' }],
    untrustedContext: false,
    decision: { outcome: 'propose', reason: 'setting' },
  };

  it('accepts a trace assembled from facts', () => {
    expect(ActionExplanationSchema.parse(explanation)).toEqual(explanation);
  });

  it('refuses contacts in a step and model prose fields', () => {
    expect(
      ActionExplanationSchema.safeParse({
        ...explanation,
        steps: [{ tool: 'find_clients', input: { query: 'maria@example.com' } }],
      }).success,
    ).toBe(false);
    expect(
      ActionExplanationSchema.safeParse({ ...explanation, summary: 'I thought…' }).success,
    ).toBe(false);
  });
});

describe('StateFingerprintSchema', () => {
  it('takes a lowercase SHA-256 hex digest only', () => {
    expect(StateFingerprintSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(StateFingerprintSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(StateFingerprintSchema.safeParse('a'.repeat(63)).success).toBe(false);
  });
});

describe('redactContacts', () => {
  it('takes out emails and phone numbers and keeps ids, dates and times', () => {
    expect(
      redactContacts(
        'Book Maria (maria.lopez@example.test or +1 212 555 0143) on 2026-11-03 at 14:00 for 0199f4b2-7c1e-7a00-8000-0000000000a1',
      ),
    ).toBe(
      'Book Maria ((email removed) or (phone removed)) on 2026-11-03 at 14:00 for 0199f4b2-7c1e-7a00-8000-0000000000a1',
    );
    expect(redactContacts('Move the 3pm to 4pm')).toBe('Move the 3pm to 4pm');
  });

  it('never leaves anything that looks like a contact', () => {
    const pieces = fc.constantFrom(
      ' ',
      '-',
      '.',
      '(',
      ')',
      '+',
      '@',
      'a',
      'Maria',
      'x.y',
      '2026-11-03',
      '14:00',
      '0199f4b2-7c1e-7a00-8000-0000000000a1',
      '5',
      '555',
      '0143',
      'example.test',
    );
    fc.assert(
      fc.property(fc.array(pieces, { maxLength: 30 }), (parts) => {
        expect(looksLikeContact(redactContacts(parts.join('')))).toBe(false);
      }),
      { numRuns: 2_000 },
    );
  });
});
