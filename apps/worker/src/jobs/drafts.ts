import { OpenAiProvider, runDueMorningDrafts, type OpenAiConfig } from '@pepper/ai';
import { llmTokenLimits, reserveLlmTokens, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { templateDrafts, templateInsights, templateRuleDefaults } from '@pepper/templates';

// The worker's morning drafts pass (S36, ADR-0040): each business's rebooking emails, written
// by the routine model at the template's morning hour and metered against its monthly token
// budget (the reservation is the meter, as for the chat and the episodes), and its review
// requests (S55.2), which need no model: without OpenAI only those run (S56a).

export interface DraftsJobConfig {
  openai: OpenAiConfig | null;
  monthlyTokens: number;
  baseUrl: string;
}

/** One pass over the businesses whose morning has come; returns the counts. */
export function morningDraftsJob(
  db: Database,
  config: DraftsJobConfig,
  options: { outboxKey: Buffer; clock: Clock },
): () => Promise<{ businesses: number; drafted: number; reviewRequests: number; failed: number }> {
  const provider = config.openai === null ? null : new OpenAiProvider(config.openai);
  const limits = llmTokenLimits(config.monthlyTokens);
  return () =>
    runDueMorningDrafts(db, {
      provider,
      clock: options.clock,
      reserve: (tenant, estimate) =>
        reserveLlmTokens(db, tenant, { estimate, limits }, options.clock),
      emails: { baseUrl: config.baseUrl, outboxKey: options.outboxKey },
      draftsOf: templateDrafts,
      insightsOf: templateInsights,
      templateRuleDefaults,
    });
}
