import { createHash } from 'node:crypto';
import {
  EMBEDDING_DIMENSIONS,
  LlmEmbeddingRequestSchema,
  LlmEmbeddingResponseSchema,
  type LlmEmbeddingRequest,
  type LlmEmbeddingResponse,
} from '@pepper/contracts';
import { isLlmError, LlmError } from './errors.js';
import type { LlmMeter } from './metering.js';
import type { LlmCallOptions } from './provider.js';

/**
 * Turns texts into embeddings for the memory's semantic recall (Phase 7, ADR-0034): episode
 * summaries when stored, a member's question when searched. A port of its own, next to
 * `LlmProvider`, so the chat fakes and cassettes need not grow an `embed` they never use.
 * Implementations return `EMBEDDING_DIMENSIONS` numbers per input, in order, and map every
 * failure to an `LlmError`.
 */
export interface Embedder {
  /** The model's id, stored with every embedding (a new model means re-embedding). */
  readonly model: string;
  embed(request: LlmEmbeddingRequest, options?: LlmCallOptions): Promise<LlmEmbeddingResponse>;
}

/** A request's texts, or `bad_request` (before anything is called or billed). */
export function embeddingInput(request: LlmEmbeddingRequest): string[] {
  const parsed = LlmEmbeddingRequestSchema.safeParse(request);
  if (!parsed.success) throw new LlmError('bad_request', 'Nothing or too much to embed');
  return parsed.data.input;
}

/** Checks an implementation's answer: one embedding of the stored size per input. */
export function checkedEmbeddings(
  request: LlmEmbeddingRequest,
  response: unknown,
): LlmEmbeddingResponse {
  const parsed = LlmEmbeddingResponseSchema.safeParse(response);
  if (
    !parsed.success ||
    parsed.data.embeddings.length !== request.input.length ||
    parsed.data.embeddings.some((vector) => vector.length !== EMBEDDING_DIMENSIONS)
  ) {
    throw new LlmError('invalid_response', 'The embedding model returned an unexpected answer');
  }
  return parsed.data;
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * A deterministic, free embedder for tests and CI (never the network): each lowercase word is
 * hashed to a dimension and a sign, and the vector normalised, so texts sharing words are
 * similar and identical texts are identical. Not semantic: "hair" and "cut" share nothing.
 */
export function hashEmbedder(model = 'pepper-hash-embedder'): Embedder {
  return {
    model,
    // eslint-disable-next-line @typescript-eslint/require-await -- an embedder answers a promise, and a bad request rejects it
    async embed(request) {
      const input = embeddingInput(request);
      let tokens = 0;
      const embeddings = input.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const words = text.toLowerCase().match(WORD) ?? [];
        tokens += Math.max(1, words.length);
        for (const word of words) {
          const digest = createHash('sha256').update(word).digest();
          const index = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
          vector[index] = (vector[index] ?? 0) + ((digest[4] ?? 0) % 2 === 0 ? 1 : -1);
        }
        const norm = Math.hypot(...vector);
        return norm === 0 ? vector : vector.map((value) => value / norm);
      });
      return checkedEmbeddings(request, {
        embeddings,
        usage: { inputTokens: tokens, cachedInputTokens: 0, outputTokens: 0 },
        model,
      });
    },
  };
}

/** Wraps an embedder so every answer's tokens reach `meter` (the business's `llm_tokens`). */
export function meteredEmbedder(embedder: Embedder, meter: LlmMeter): Embedder {
  return {
    model: embedder.model,
    async embed(request, options) {
      const response = await embedder.embed(request, options).catch(async (error: unknown) => {
        if (isLlmError(error) && error.usage !== undefined)
          await meter(error.usage, embedder.model);
        throw error;
      });
      await meter(response.usage, response.model);
      return response;
    },
  };
}

/** Tokens held for one call and settled with what it used (core's `LlmTokenReservation`). */
export interface EmbeddingReservation {
  settle(usedTokens: number): Promise<void>;
}

/**
 * Wraps an embedder so every call is held against the business's monthly token budget first
 * (S31, `search_memory`): no reservation, no call (`budget_exceeded`); the reservation is
 * settled with the tokens billed, or with none when the call failed.
 */
export function budgetedEmbedder(
  embedder: Embedder,
  reserve: (estimate: number) => Promise<EmbeddingReservation | null>,
): Embedder {
  return {
    model: embedder.model,
    async embed(request, options) {
      const input = embeddingInput(request);
      const estimate = input.reduce((sum, text) => sum + Math.ceil(text.length / 3) + 1, 0);
      const reservation = await reserve(estimate);
      if (reservation === null) {
        throw new LlmError('budget_exceeded', 'The monthly AI allowance is used up');
      }
      try {
        const response = await embedder.embed(request, options);
        await reservation.settle(response.usage.inputTokens);
        return response;
      } catch (error) {
        await reservation.settle(0);
        throw error;
      }
    },
  };
}
