import type { LlmRequest, LlmStreamEvent, LlmUsage } from '@pepper/contracts';
import { isLlmError } from './errors.js';
import type { LlmCallOptions, LlmProvider } from './provider.js';

/**
 * Records one answer's tokens. The apps bind it to core's `recordUsage` with the session's
 * business (`llm_tokens`, ADR-0013). If it throws, the call fails: an AI answer that cannot
 * be metered is not given, so budgets (S25) can be trusted.
 */
export type LlmMeter = (usage: LlmUsage, model: string) => Promise<void>;

/**
 * Wraps a provider so every answer's usage reaches `meter`: complete answers, streamed answers
 * (at `done`) and failures the provider may still bill (`LlmError.usage`).
 */
export function meteredProvider(provider: LlmProvider, meter: LlmMeter): LlmProvider {
  const meterFailure = async (error: unknown): Promise<never> => {
    if (isLlmError(error) && error.usage !== undefined) await meter(error.usage, 'unknown');
    throw error;
  };
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions) {
      const response = await provider.respond(request, options).catch(meterFailure);
      await meter(response.usage, response.model);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
      try {
        for await (const event of provider.stream(request, options)) {
          if (event.type === 'done') await meter(event.response.usage, event.response.model);
          yield event;
        }
      } catch (error) {
        await meterFailure(error);
      }
    },
  };
}
