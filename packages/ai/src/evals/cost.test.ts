import { describe, expect, it } from 'vitest';
import {
  costOfUsage,
  estimateRunCost,
  OUTPUT_ALLOWANCE_TOKENS,
  refuseRun,
  type PriceTable,
} from './cost.js';
import { sampleTools } from './sample-tools.js';
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
  it('counts every call uncached with the full output allowance, times the trials', () => {
    const twoTurns = evalCase({ turns: [{ user: 'First' }, { user: 'Second' }] });
    const tools = sampleTools(twoTurns.tools).definitions;
    const once = estimateRunCost([{ evalCase: twoTurns, tools }], 1, PRICE);
    expect(once.usage.outputTokens).toBe(2 * OUTPUT_ALLOWANCE_TOKENS);
    expect(once.usage.cachedInputTokens).toBe(0);
    // The second call carries the first answer's allowance, so input more than doubles.
    expect(once.usage.inputTokens).toBeGreaterThan(2 * 1_000);
    const thrice = estimateRunCost([{ evalCase: twoTurns, tools }], 3, PRICE);
    expect(thrice.usd).toBeCloseTo(once.usd * 3, 10);
  });

  it('keeps a 120-case run of the reference size well under the $1.50 cap', () => {
    const tools = sampleTools([
      'find_clients',
      'get_day',
      'create_booking',
      'email_clients',
    ]).definitions;
    const cases = Array.from({ length: 120 }, () => ({ evalCase: evalCase(), tools }));
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
