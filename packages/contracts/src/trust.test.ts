import { describe, expect, it } from 'vitest';
import { AutonomyLevelSchema, RiskTierSchema } from './trust.js';

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
