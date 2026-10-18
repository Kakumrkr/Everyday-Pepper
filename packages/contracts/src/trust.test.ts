import { describe, expect, it } from 'vitest';
import {
  AUTONOMY_ACTIONS,
  AutonomyActionSchema,
  AutonomyLevelSchema,
  AutonomySettingsSchema,
  RiskTierSchema,
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
      'booking.move': 'notify',
      'booking_request.accept': 'notify',
      'time.block': 'notify',
      'client_note.save': 'notify',
      'message.confirmation': 'auto',
      'message.rebooking_nudge': 'ask',
      'message.waitlist_offer': 'ask',
      'message.bulk': 'ask',
    });
  });

  it('allows "just do it" for everything but bulk messages', () => {
    const locked = Object.entries(AUTONOMY_ACTIONS)
      .filter(([, { allowsAuto }]) => !allowsAuto)
      .map(([action]) => action);
    expect(locked).toEqual(['message.bulk']);
  });

  it('never defaults to a level that is not allowed', () => {
    for (const { defaultLevel, allowsAuto } of Object.values(AUTONOMY_ACTIONS)) {
      expect(defaultLevel !== 'auto' || allowsAuto).toBe(true);
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

  it('refuses "just do it" for bulk messages', () => {
    expect(AutonomySettingsSchema.safeParse({ 'message.bulk': 'auto' }).success).toBe(false);
  });

  it('rejects unknown actions and levels', () => {
    expect(AutonomySettingsSchema.safeParse({ 'booking.delete': 'ask' }).success).toBe(false);
    expect(AutonomySettingsSchema.safeParse({ 'booking.create': 'always' }).success).toBe(false);
  });
});
