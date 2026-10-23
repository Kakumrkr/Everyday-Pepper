// Test-only (not built into dist): the behaviour every `Embedder` must show, run against the
// hash fake and the OpenAI adapter alike (ADR-0034), so the fake can stand in for the real
// model in every other test.
import { EMBEDDING_DIMENSIONS } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import type { Embedder } from './embedder.js';

export interface EmbedderHarness {
  /** An embedder that answers `texts` (the OpenAI adapter: from fixtures). */
  embedder(texts: string[]): Embedder;
}

const TEXTS = ['Decided Jess keeps Saturdays free.', 'Maria wants a gloss next time.'];

export function embedderContract(name: string, harness: EmbedderHarness): void {
  describe(`${name} meets the embedder contract`, () => {
    it('answers one embedding of the stored size per input, in order', async () => {
      const response = await harness.embedder(TEXTS).embed({ input: TEXTS });
      expect(response.embeddings).toHaveLength(TEXTS.length);
      for (const vector of response.embeddings) {
        expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
        expect(vector.every(Number.isFinite)).toBe(true);
      }
      expect(response.embeddings[0]).not.toEqual(response.embeddings[1]);
    });

    it('reports the input tokens it billed, and no output tokens', async () => {
      const { usage } = await harness.embedder(TEXTS).embed({ input: TEXTS });
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBe(0);
    });

    it('names its model', async () => {
      const embedder = harness.embedder(TEXTS);
      expect((await embedder.embed({ input: TEXTS })).model).toMatch(/\S/);
      expect(embedder.model).toMatch(/\S/);
    });

    it('refuses an empty or oversized request before calling anything', async () => {
      const embedder = harness.embedder(TEXTS);
      await expect(embedder.embed({ input: [] })).rejects.toMatchObject({ code: 'bad_request' });
      await expect(embedder.embed({ input: ['x'.repeat(8_001)] })).rejects.toMatchObject({
        code: 'bad_request',
      });
    });
  });
}
