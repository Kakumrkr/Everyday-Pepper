import { OpenAiEmbedder, OpenAiProvider, writeEpisode, type OpenAiConfig } from '@pepper/ai';
import { llmTokenLimits, reserveLlmTokens, systemClock, type EpisodeWriter } from '@pepper/core';

// The worker's episode writer (S31, ADR-0037): the outbox's `episode` messages, summarised by
// the routine model and embedded, against each business's monthly token budget. The budget's
// reservation is the meter (the api's chat does the same): nothing is called without one.

export function episodeWriterFor(config: {
  openai: OpenAiConfig & { embeddingModel: string };
  monthlyTokens: number;
}): EpisodeWriter {
  const provider = new OpenAiProvider(config.openai);
  const embedder = new OpenAiEmbedder({
    apiKey: config.openai.apiKey,
    model: config.openai.embeddingModel,
    timeoutMs: config.openai.timeoutMs,
    ...(config.openai.baseUrl !== undefined && { baseUrl: config.openai.baseUrl }),
  });
  const limits = llmTokenLimits(config.monthlyTokens);
  return async (db, tenantId, job) =>
    writeEpisode(
      {
        db,
        provider,
        embedder,
        clock: systemClock,
        reserve: (tenant, estimate) =>
          reserveLlmTokens(db, tenant, { estimate, limits }, systemClock),
      },
      tenantId,
      job,
    );
}
