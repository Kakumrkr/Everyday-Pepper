import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import type { PriceTable } from './cost.js';
import {
  BudgetStopError,
  CUMULATIVE_STOP_USD,
  budgetMarkdown,
  emptyLedger,
  guardedProvider,
  LedgerSchema,
  priceOf,
  refuseCumulative,
  spentUsd,
  SpendTracker,
  type LedgerEntry,
} from './ledger.js';

const PRICES: PriceTable = {
  checkedOn: '2026-10-22',
  source: 'test',
  models: {
    'model-mini': {
      inputPerMillionUsd: 0.75,
      cachedInputPerMillionUsd: 0.075,
      outputPerMillionUsd: 4.5,
    },
    'model-nano': {
      inputPerMillionUsd: 0.2,
      cachedInputPerMillionUsd: 0.02,
      outputPerMillionUsd: 1.25,
    },
  },
};

const entry = (actualUsd: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  id: 1,
  at: '2026-10-22T10:00:00.000Z',
  label: 'smoke',
  status: 'completed',
  cases: 5,
  trials: 1,
  estimateUsd: 0.2,
  actualUsd,
  byModel: {},
  charsPerToken: null,
  ...overrides,
});

const request = {
  route: 'routine' as const,
  instructions: 'x'.repeat(300),
  messages: [{ role: 'user' as const, content: 'hello' }],
  tools: [],
  toolChoice: 'auto' as const,
  maxOutputTokens: 100,
};

const usage = { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 };

describe('the budget ledger (playbook §4)', () => {
  it('sums every entry, stopped and failed runs included (they were billed too)', () => {
    const ledger = LedgerSchema.parse({
      ...emptyLedger(),
      entries: [
        entry(0.4),
        entry(1.1, { id: 2, status: 'stopped' }),
        entry(0.05, { id: 3, status: 'failed' }),
      ],
    });
    expect(spentUsd(ledger)).toBeCloseTo(1.55, 10);
    expect(spentUsd(emptyLedger())).toBe(0);
  });

  it('refuses a ledger whose ids are not 1, 2, 3… (entries are only ever appended)', () => {
    expect(
      LedgerSchema.safeParse({ ...emptyLedger(), entries: [entry(0.1, { id: 2 })] }).success,
    ).toBe(false);
  });

  it('refuses a run whose estimate would take the total past $4.50', () => {
    expect(CUMULATIVE_STOP_USD).toBe(4.5);
    expect(refuseCumulative({ spentUsd: 3.5, estimateUsd: 1 })).toBeNull();
    expect(refuseCumulative({ spentUsd: 3.5, estimateUsd: 1.01 })).toBe(
      'Spent $3.50 so far; this run could take the total to $4.51, past the $4.50 stop.',
    );
    expect(refuseCumulative({ spentUsd: 4.5, estimateUsd: 0 })).toMatch(/past the \$4\.50 stop/);
  });

  it('renders the ledger as the Markdown table of docs/plan/ai-budget.md', () => {
    const ledger = LedgerSchema.parse({
      ...emptyLedger(),
      entries: [
        entry(0.0123, {
          byModel: {
            'model-mini': {
              calls: 9,
              inputTokens: 50_000,
              cachedInputTokens: 30_000,
              cacheWriteTokens: 5_000,
              outputTokens: 1_200,
              usd: 0.0123,
              latencyMsP50: 900,
              latencyMsP95: 2_100,
            },
          },
          charsPerToken: 3.9,
        }),
      ],
    });
    const md = budgetMarkdown(ledger);
    expect(md).toContain(
      '| 1 | 2026-10-22 | smoke | completed | 5 × 1 | $0.20 | $0.0123 | $0.0123 |',
    );
    expect(md).toContain(
      'model-mini: 9 calls, 50000 in (30000 cached, 5000 written), 1200 out, p50 900 ms, p95 2100 ms',
    );
    expect(md).toContain('Total spent: **$0.0123** of $5.00');
  });
});

describe('priceOf', () => {
  it('finds a dated snapshot by its alias and prices an unknown model as the dearest', () => {
    expect(priceOf(PRICES, 'model-nano-2026-08-01')).toBe(PRICES.models['model-nano']);
    expect(priceOf(PRICES, 'model-mini')).toBe(PRICES.models['model-mini']);
    expect(priceOf(PRICES, 'something-else')).toBe(PRICES.models['model-mini']);
  });
});

describe('guardedProvider (the stop while a run is going)', () => {
  it('counts what every call cost, by the model that answered, failed billed calls included', async () => {
    const tracker = new SpendTracker({ prices: PRICES, spentBeforeUsd: 0, capUsd: 1.5 });
    const provider = guardedProvider(
      new ScriptedProvider([
        scriptedResponse({ text: 'one', usage, model: 'model-nano' }),
        new LlmError('unavailable', 'failed after starting', usage),
      ]),
      tracker,
    );
    await provider.respond(request);
    await expect(provider.respond(request)).rejects.toBeInstanceOf(LlmError);
    expect(tracker.runUsd).toBeCloseTo(0.2 + 0.75, 10);
    const summary = tracker.byModel();
    expect(summary['model-nano']?.calls).toBe(1);
    expect(summary['model-nano']?.usd).toBeCloseTo(0.2, 10);
    // The failed call has no answering model: it is priced as the dearest.
    expect(summary['unknown']?.usd).toBeCloseTo(0.75, 10);
    // 300 instructions + "hello" + the rest of the request, over a million tokens: tiny.
    expect(tracker.charsPerToken()).toBeGreaterThan(0);
  });

  it('refuses the next call once the run reaches its cap or the total its $4.50 stop', async () => {
    const capped = new SpendTracker({ prices: PRICES, spentBeforeUsd: 0, capUsd: 0.5 });
    const provider = guardedProvider(
      new ScriptedProvider([
        scriptedResponse({ text: 'one', usage, model: 'model-mini' }),
        scriptedResponse({ text: 'two', usage, model: 'model-mini' }),
      ]),
      capped,
    );
    await provider.respond(request);
    await expect(provider.respond(request)).rejects.toBeInstanceOf(BudgetStopError);
    expect(capped.stopReason()).toMatch(/this run's \$0\.50 cap/);

    const total = new SpendTracker({ prices: PRICES, spentBeforeUsd: 4.5, capUsd: 1.5 });
    await expect(
      guardedProvider(new ScriptedProvider([]), total).respond(request),
    ).rejects.toBeInstanceOf(BudgetStopError);
    expect(total.stopReason()).toMatch(/\$4\.50 stop/);
  });

  it('stops a stream before it starts, and counts the streamed answer', async () => {
    const tracker = new SpendTracker({ prices: PRICES, spentBeforeUsd: 0, capUsd: 1.5 });
    const provider = guardedProvider(
      new ScriptedProvider([scriptedResponse({ text: 'hi', usage, model: 'model-nano' })]),
      tracker,
    );
    const events = [];
    for await (const event of provider.stream(request)) events.push(event.type);
    expect(events).toEqual(['text_delta', 'done']);
    expect(tracker.runUsd).toBeCloseTo(0.2, 10);
    expect(tracker.byModel()['model-nano']?.latencyMsP50).toBeGreaterThanOrEqual(0);
  });
});
