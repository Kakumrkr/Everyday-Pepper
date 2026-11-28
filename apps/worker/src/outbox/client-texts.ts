import { actOnClientText, OpenAiProvider, type OpenAiConfig } from '@pepper/ai';
import { llmTokenLimits, reserveLlmTokens, systemClock, type ClientTextRunner } from '@pepper/core';
import { Logger } from '@nestjs/common';

// The worker's client text reader (S81a.2, ADR-0073): the outbox's `client_text` messages, read by
// the routine model against each business's monthly token budget (the reservation is the meter)
// and acted on only when sure. Logged by error name only: never a text, a name or a number.

const logger = new Logger('ClientTexts');

export function clientTextRunnerFor(config: {
  openai: OpenAiConfig;
  monthlyTokens: number;
  /** For the client email an approved cancel or move queues (`AUTH_BASE_URL`). */
  baseUrl: string;
  outboxKey: Buffer;
}): ClientTextRunner {
  const provider = new OpenAiProvider(config.openai);
  const limits = llmTokenLimits(config.monthlyTokens);
  return async (db, tenantId, job) =>
    actOnClientText(
      {
        db,
        provider,
        clock: systemClock,
        emails: { baseUrl: config.baseUrl, outboxKey: config.outboxKey },
        reserve: (tenant, estimate) =>
          reserveLlmTokens(db, tenant, { estimate, limits }, systemClock),
        onUnexpected: (error) => {
          logger.warn(
            `A client text's proposal was not made: ${error instanceof Error ? error.name : 'unknown'}`,
          );
        },
      },
      tenantId,
      job,
    );
}
