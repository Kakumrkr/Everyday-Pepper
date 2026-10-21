import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { llmBudgetStateOf, llmTokenLimits } from './services/usage.js';

// The token budget's decision (ADR-0030): monotone in usage, soft never above hard.

describe('llmBudgetStateOf', () => {
  it('is ok below soft, soft from soft, exhausted from hard', () => {
    const limits = llmTokenLimits(1_000);
    expect([0, 799, 800, 999, 1_000, 5_000].map((used) => llmBudgetStateOf(used, limits))).toEqual([
      'ok',
      'ok',
      'soft',
      'soft',
      'exhausted',
      'exhausted',
    ]);
  });

  it('never gets better as usage grows, for any limits', () => {
    const rank = { ok: 0, soft: 1, exhausted: 2 } as const;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.double({ min: 0.01, max: 1, noNaN: true }),
        fc.nat(),
        fc.nat(),
        (hard, ratio, a, b) => {
          const limits = llmTokenLimits(hard, ratio);
          expect(limits.soft).toBeLessThanOrEqual(limits.hard);
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(rank[llmBudgetStateOf(low, limits)]).toBeLessThanOrEqual(
            rank[llmBudgetStateOf(high, limits)],
          );
          expect(llmBudgetStateOf(hard, limits)).toBe('exhausted');
        },
      ),
    );
  });

  it('refuses limits that would mean no limit', () => {
    for (const hard of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => llmTokenLimits(hard)).toThrow(RangeError);
    }
    expect(() => llmTokenLimits(1_000, 0)).toThrow(RangeError);
    expect(() => llmTokenLimits(1_000, 1.5)).toThrow(RangeError);
  });
});
