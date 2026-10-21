import { describe, expect, it } from 'vitest';
import {
  costOfUsage,
  estimateRunCost,
  OUTPUT_ALLOWANCE_TOKENS,
  refuseRun,
  type PriceTable,
} from './cost.js';
import { evalCase } from './test-support.js';

const PRICE = {
  inputPerMillionUsd: 0.75,
  cachedInputPerMillionUsd: 0.075,
  outputPerMillionUsd: 4.5,
};
const PRICES: PriceTable = {
  checkedOn: '2026-12-01',
  source: 'test',
  models: { 'model-a': PRICE },
};

describe('costOfUsage', () => {
  it('prices uncached input, cached input and output separately', () => {
    expect(
      costOfUsage(
        { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
        PRICE,
      ),
    ).toBeCloseTo(0.6 * 0.75 + 0.4 * 0.075 + 0.1 * 4.5, 10);
  });
});

describe('estimateRunCost (the budget guard, playbook §4)', () => {
  it('counts every step of every turn uncached with the full output allowance, times the trials', () => {
    const twoTurns = evalCase({ turns: [{ user: 'First' }, { user: 'Second' }] });
    const once = estimateRunCost([twoTurns], 1, PRICE, 1);
    expect(once.usage.outputTokens).toBe(2 * OUTPUT_ALLOWANCE_TOKENS);
    expect(once.usage.cachedInputTokens).toBe(0);
    // Each call carries the instructions and every tool definition: thousands of tokens.
    expect(once.usage.inputTokens).toBeGreaterThan(2 * 2_000);
    const thrice = estimateRunCost([twoTurns], 3, PRICE, 1);
    expect(thrice.usd).toBeCloseTo(once.usd * 3, 10);
    // By default every turn takes all of the loop's steps (the most a run can cost).
    expect(estimateRunCost([twoTurns], 1, PRICE).usage.outputTokens).toBe(
      2 * 6 * OUTPUT_ALLOWANCE_TOKENS,
    );
  });

  it('keeps one run of 25 one-turn cases under the $1.50 cap even at every step', () => {
    // 30 fitted with ten tools; the fourteen of S26b put ~$0.05 a case on the worst case, so
    // S27 runs a set in chunks of at most 25 cases (or calibrates the estimate first).
    const cases = Array.from({ length: 25 }, () => evalCase());
    expect(estimateRunCost(cases, 1, PRICE).usd).toBeLessThan(1.5);
  });
});

describe('refuseRun', () => {
  it('refuses a model without a price and a run over the cap; allows the rest', () => {
    expect(refuseRun({ model: 'model-b', prices: PRICES, estimateUsd: 0.1, capUsd: 1.5 })).toMatch(
      /No price for model-b/,
    );
    expect(refuseRun({ model: 'model-a', prices: PRICES, estimateUsd: 1.6, capUsd: 1.5 })).toBe(
      'Estimated $1.60 is over the $1.50 cap for one run.',
    );
    expect(
      refuseRun({ model: 'model-a', prices: PRICES, estimateUsd: 1.5, capUsd: 1.5 }),
    ).toBeNull();
  });

  it.each([Number.NaN, 0, -1, 4.51, Number.POSITIVE_INFINITY])(
    'refuses a cap of %s instead of treating it as no cap',
    (capUsd) => {
      expect(refuseRun({ model: 'model-a', prices: PRICES, estimateUsd: 0.1, capUsd })).toMatch(
        /The cap must be/,
      );
    },
  );

  it('refuses a run that could not be estimated', () => {
    expect(
      refuseRun({ model: 'model-a', prices: PRICES, estimateUsd: Number.NaN, capUsd: 1.5 }),
    ).toBe('The run could not be estimated.');
  });
});
