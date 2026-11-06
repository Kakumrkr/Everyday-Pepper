import type * as Ai from '@pepper/ai';
import { templateDrafts, templateInsights, templateRuleDefaults } from '@pepper/templates';
import { describe, expect, it, vi } from 'vitest';
import { morningDraftsJob } from './drafts.js';

// The worker's morning drafts job, with the pass and the provider replaced: the pass gets the
// templates, the links' origin and outbox key, and a metered reservation.

const ai = vi.hoisted(() => ({ runDueMorningDrafts: vi.fn(), OpenAiProvider: vi.fn() }));
vi.mock('@pepper/ai', async (original) => ({
  ...(await original<typeof Ai>()),
  runDueMorningDrafts: ai.runDueMorningDrafts,
  OpenAiProvider: ai.OpenAiProvider,
}));

describe('morningDraftsJob', () => {
  it('runs the pass with the templates, the emails and the clock', async () => {
    ai.runDueMorningDrafts.mockResolvedValue({ businesses: 2, drafted: 5, failed: 0 });
    const clock = { now: () => new Date('2026-11-02T12:30:00Z') };
    const key = Buffer.alloc(32, 1);
    const job = morningDraftsJob(
      { db: true } as never,
      {
        openai: { apiKey: 'sk-test' } as never,
        monthlyTokens: 1000,
        baseUrl: 'https://app.example',
      },
      { outboxKey: key, clock },
    );
    expect(ai.OpenAiProvider).toHaveBeenCalledTimes(1);
    expect(await job()).toEqual({ businesses: 2, drafted: 5, failed: 0 });
    expect(ai.runDueMorningDrafts).toHaveBeenCalledWith(
      { db: true },
      expect.objectContaining({
        clock,
        emails: { baseUrl: 'https://app.example', outboxKey: key },
        draftsOf: templateDrafts,
        insightsOf: templateInsights,
        templateRuleDefaults,
      }),
    );
  });

  it('runs the pass without a model when OpenAI is not configured (S56a)', async () => {
    ai.OpenAiProvider.mockClear();
    ai.runDueMorningDrafts.mockResolvedValue({ businesses: 1, drafted: 0, failed: 0 });
    const job = morningDraftsJob(
      { db: true } as never,
      { openai: null, monthlyTokens: 1000, baseUrl: 'https://app.example' },
      { outboxKey: Buffer.alloc(32, 1), clock: { now: () => new Date() } },
    );
    await job();
    expect(ai.OpenAiProvider).not.toHaveBeenCalled();
    expect(ai.runDueMorningDrafts).toHaveBeenLastCalledWith(
      { db: true },
      expect.objectContaining({ provider: null }),
    );
  });
});
