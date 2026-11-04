import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  PLATFORM_RULE_DEFAULTS,
  type AutonomyAction,
  type AutonomyLevel,
  type BusinessAutonomy,
  type Rule,
} from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { durationWords, offerLine, standingRules, trackLine } from './trust-words.js';

const defaults: BusinessAutonomy = {
  askFirst: false,
  levels: Object.fromEntries(
    AutonomyActionSchema.options.map((action) => [action, AUTONOMY_ACTIONS[action].defaultLevel]),
  ) as Record<AutonomyAction, AutonomyLevel>,
};
const record = (overrides: Partial<{ done: number; streak: number; offer: AutonomyLevel | null }>) => ({
  action: 'task.create' as const,
  doneLast30Days: overrides.done ?? 0,
  correctInARow: overrides.streak ?? 0,
  offer: overrides.offer ?? null,
});

describe('standingRules (S53)', () => {
  it('reads the default dial back as sentences, then the booking rules', () => {
    const lines = standingRules(
      defaults,
      { rules: [], defaults: PLATFORM_RULE_DEFAULTS },
      '2026-11-04',
    ).map((line) => line.text);
    expect(lines).toEqual([
      'I ask you before new bookings, moves, cancellations, rebooking nudges and waitlist offers.',
      'Accepting booking-page requests, blocking time, client notes, to-dos and waitlist changes: I do them and tell you, with Undo.',
      'Confirmation emails: I just do them and list them in Activity.',
      'A message to more than 10 clients, and a new booking rule, always wait for your OK.',
      'Clients book at least 2 hours ahead, up to 90 days ahead.',
    ]);
  });

  it('says only the switch while asking first for everything', () => {
    const lines = standingRules({ ...defaults, askFirst: true }, null, '2026-11-04');
    expect(lines.map((line) => line.changedOn)).toEqual(['autonomy', 'autonomy']);
    expect(lines[0]?.text).toMatch(/every change/);
  });

  it('uses the business’s own rules, skips staff rules and past blackouts, and counts the rest', () => {
    const blackout = (startDate: string, endDate: string): Rule => ({
      type: 'blackout_window',
      version: 1,
      staffMemberId: null,
      params: { startDate, endDate },
    });
    const rules: Rule[] = [
      { type: 'minimum_notice', version: 1, staffMemberId: null, params: { minutes: 1500 } },
      { type: 'maximum_advance', version: 1, staffMemberId: null, params: { days: 30 } },
      { type: 'max_bookings_per_day', version: 1, staffMemberId: null, params: { count: 1 } },
      {
        type: 'minimum_notice',
        version: 1,
        staffMemberId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192' as never,
        params: { minutes: 0 },
      },
      blackout('2026-10-01', '2026-10-02'),
      blackout('2026-12-31', '2026-12-31'),
      blackout('2026-12-24', '2026-12-26'),
      blackout('2027-01-10', '2027-01-11'),
      blackout('2027-02-01', '2027-02-01'),
    ];
    const lines = standingRules(defaults, { rules, defaults: PLATFORM_RULE_DEFAULTS }, '2026-11-04')
      .filter((line) => line.changedOn === 'rules')
      .map((line) => line.text);
    expect(lines).toEqual([
      'Clients book at least 1 day 1 hour ahead, up to 30 days ahead.',
      'At most 1 booking a day.',
      'No bookings on Dec 24 – Dec 26, Dec 31, Jan 10 – Jan 11 and 1 more.',
    ]);
  });

  it('says when clients can book right up to the start', () => {
    const lines = standingRules(
      defaults,
      { rules: [], defaults: { ...PLATFORM_RULE_DEFAULTS, minimumNoticeMinutes: 0 } },
      '2026-11-04',
    );
    expect(lines.at(-1)?.text).toBe('Clients can book right up to the start, up to 90 days ahead.');
  });
});

describe('durationWords', () => {
  it.each([
    [0, 'no time'],
    [1, '1 minute'],
    [30, '30 minutes'],
    [60, '1 hour'],
    [120, '2 hours'],
    [1440, '1 day'],
    [2 * 1440 + 90, '2 days 1 hour 30 minutes'],
  ])('%i → %s', (minutes, words) => {
    expect(durationWords(minutes)).toBe(words);
  });
});

describe('trackLine and offerLine (S53)', () => {
  it('counts the last 30 days', () => {
    expect(trackLine(undefined)).toBe('Not done in the last 30 days.');
    expect(trackLine(record({ done: 1 }))).toBe('Done once in the last 30 days.');
    expect(trackLine(record({ done: 12 }))).toBe('Done 12 times in the last 30 days.');
  });

  it('offers one step up only while it is more room than now', () => {
    expect(offerLine(record({ streak: 20 }), 'ask')).toBeNull();
    expect(offerLine(record({ streak: 23, offer: 'notify' }), 'ask')).toEqual({
      text: 'I’ve done this 23 times in a row without a mistake. Want me to do it and tell you, without waiting for your OK?',
      to: 'notify',
    });
    expect(offerLine(record({ streak: 20, offer: 'auto' }), 'notify')?.to).toBe('auto');
    expect(offerLine(record({ streak: 20, offer: 'notify' }), 'notify')).toBeNull();
    expect(offerLine(record({ streak: 20, offer: 'notify' }), 'auto')).toBeNull();
  });
});
