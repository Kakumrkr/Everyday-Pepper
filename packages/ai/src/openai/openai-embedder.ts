import {
  EMBEDDING_DIMENSIONS,
  type LlmEmbeddingRequest,
  type LlmEmbeddingResponse,
} from '@pepper/contracts';
import OpenAI from 'openai';
import { checkedEmbeddings, embeddingInput, type Embedder } from '../embedder.js';
import type { LlmCallOptions } from '../provider.js';
import { toLlmError } from './openai-provider.js';

export interface OpenAiEmbedderOptions {
  apiKey: string;
  /** The embedding model (`OPENAI_MODEL_EMBEDDING`; `text-embedding-3-small`, playbook D-5). */
  model: string;
  baseUrl?: string;
  timeoutMs: number;
  /** Replaces the network (tests answer with fixtures shaped like OpenAI's documented API). */
  fetch?: typeof globalThis.fetch;
}

/**
 * `Embedder` on OpenAI's embeddings endpoint (ADR-0034) with the official SDK: floats at
 * `EMBEDDING_DIMENSIONS`, no retries of its own (the caller decides), every failure mapped to an
 * `LlmError` without the provider's message text.
 */
export class OpenAiEmbedder implements Embedder {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(options: OpenAiEmbedderOptions) {
    this.model = options.model;
    this.client = new OpenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl !== undefined && { baseURL: options.baseUrl }),
      timeout: options.timeoutMs,
      maxRetries: 0,
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
  }

  async embed(
    request: LlmEmbeddingRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmEmbeddingResponse> {
    const input = embeddingInput(request);
    try {
      const response = await this.client.embeddings.create(
        { model: this.model, input, encoding_format: 'float', dimensions: EMBEDDING_DIMENSIONS },
        { ...(options.signal !== undefined && { signal: options.signal }) },
      );
      const ordered = [...response.data].sort((a, b) => a.index - b.index);
      return checkedEmbeddings(request, {
        embeddings: ordered.map((item) => item.embedding),
        usage: {
          inputTokens: response.usage.prompt_tokens,
          cachedInputTokens: 0,
          outputTokens: 0,
        },
        model: response.model,
      });
    } catch (error) {
      throw toLlmError(error);
    }
  }
}
