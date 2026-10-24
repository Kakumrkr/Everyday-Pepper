import { DRAFT_LIMITS } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  costOfUsage,
  DRAFTS_PER_PASS_ESTIMATE,
  estimateRunCost,
  OUTPUT_ALLOWANCE_TOKENS,
  MAX_CASES_PER_RUN,
  refuseRun,
  selectCases,
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

describe('costOfUsage with cache writes (GPT-5.6 and later, S27)', () => {
  const LUNA = {
    inputPerMillionUsd: 0.1,
    cachedInputPerMillionUsd: 0.01,
    cacheWritePerMillionUsd: 0.125,
    outputPerMillionUsd: 0.5,
  };

  it('prices written tokens at the write rate instead of the input rate, not on top of it', () => {
    expect(
      costOfUsage(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 200_000,
          cacheWriteTokens: 700_000,
          outputTokens: 100_000,
        },
        LUNA,
      ),
    ).toBeCloseTo(0.1 * 0.1 + 0.2 * 0.01 + 0.7 * 0.125 + 0.1 * 0.5, 10);
  });

  it('prices writes at the input rate for a model without a write price', () => {
    expect(
      costOfUsage(
        {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 1_000_000,
          outputTokens: 0,
        },
        PRICE,
      ),
    ).toBeCloseTo(0.75, 10);
  });

  it('estimates every input token at the dearer of the input and write rates', () => {
    const cases = [evalCase()];
    const plain = estimateRunCost(cases, 1, { ...LUNA, cacheWritePerMillionUsd: undefined });
    const written = estimateRunCost(cases, 1, LUNA);
    const inputUsd = (plain.usage.inputTokens * 0.1) / 1_000_000;
    expect(written.usd - plain.usd).toBeCloseTo(inputUsd * 0.25, 10);
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

  it('counts a morning drafts pass as its drafts’ whole allowance (S36)', () => {
    const drafts = evalCase({ turns: [{ action: { morningDrafts: true } }], set: 'drafts' });
    expect(estimateRunCost([drafts], 1, PRICE).usage).toEqual({
      inputTokens: DRAFTS_PER_PASS_ESTIMATE * DRAFT_LIMITS.maxTokens,
      cachedInputTokens: 0,
      outputTokens: DRAFTS_PER_PASS_ESTIMATE * DRAFT_LIMITS.maxOutputTokens,
    });
  });

  it('keeps one run of a full chunk of one-turn cases under the $1.50 cap even at every step', () => {
    // 30 fitted with ten tools; the fourteen of S26b put ~$0.05 a case on the worst case, so
    // S27 ran sets in chunks of 25; S30's seventeen tools put ~$0.06 on it: chunks of 20.
    const cases = Array.from({ length: MAX_CASES_PER_RUN }, () => evalCase());
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

describe('selectCases (runs in chunks of at most 20, S27, S30)', () => {
  const cases = Array.from({ length: 60 }, (_, index) =>
    evalCase({ id: `case-${String(index + 1)}`, set: index < 50 ? 'scheduling' : 'safety' }),
  );

  it('filters by set and id, then takes the chunk-th slice of 20', () => {
    expect(MAX_CASES_PER_RUN).toBe(20);
    expect(selectCases(cases, { sets: [], ids: [], chunk: null })).toHaveLength(60);
    expect(selectCases(cases, { sets: ['safety'], ids: [], chunk: null })).toHaveLength(10);
    const second = selectCases(cases, { sets: ['scheduling'], ids: [], chunk: 2 });
    expect(second.map((c) => c.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `case-${String(index + 21)}`),
    );
    expect(selectCases(cases, { sets: ['scheduling'], ids: [], chunk: 4 })).toEqual([]);
    expect(
      selectCases(cases, { sets: [], ids: ['case-3', 'case-55'], chunk: null }).map((c) => c.id),
    ).toEqual(['case-3', 'case-55']);
  });

  it('takes smaller chunks with chunkSize (a dear strong model needs them under the cap)', () => {
    const third = selectCases(cases, { sets: [], ids: [], chunk: 3, chunkSize: 8 });
    expect(third.map((c) => c.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `case-${String(index + 17)}`),
    );
    expect(() => selectCases(cases, { sets: [], ids: [], chunk: 1, chunkSize: 21 })).toThrow(
      /--chunk-size/,
    );
    expect(() => selectCases(cases, { sets: [], ids: [], chunk: 1, chunkSize: 0 })).toThrow(
      /--chunk-size/,
    );
  });

  it('refuses an unknown id or a chunk that is not 1, 2, 3…', () => {
    expect(() => selectCases(cases, { sets: [], ids: ['case-99'], chunk: null })).toThrow(
      'No eval case case-99',
    );
    expect(() => selectCases(cases, { sets: [], ids: [], chunk: 0 })).toThrow(/--chunk/);
  });
});
