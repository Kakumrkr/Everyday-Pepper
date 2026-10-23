import { EMBEDDING_DIMENSIONS, type LlmUsage } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { embedderContract } from './embedder-contract.js';
import { checkedEmbeddings, hashEmbedder, meteredEmbedder, type Embedder } from './embedder.js';
import { LlmError } from './errors.js';

embedderContract('hashEmbedder', { embedder: () => hashEmbedder() });

const cosine = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe('hashEmbedder', () => {
  it('is deterministic, normalised, and closer for texts sharing words', async () => {
    const embedder = hashEmbedder();
    const { embeddings } = await embedder.embed({
      input: [
        'Jess Saturdays free',
        'jess saturdays FREE!',
        'Jess keeps Saturdays',
        'Color stock order',
      ],
    });
    const [a, b, c, d] = embeddings as [number[], number[], number[], number[]];
    expect(a).toEqual(b);
    expect(cosine(a, a)).toBeCloseTo(1, 10);
    expect(cosine(a, c)).toBeGreaterThan(cosine(a, d));
  });

  it('gives a text without words a zero vector instead of dividing by zero', async () => {
    const { embeddings } = await hashEmbedder().embed({ input: ['…!?'] });
    expect(embeddings[0]?.every((value) => value === 0)).toBe(true);
  });
});

describe('checkedEmbeddings', () => {
  const usage = { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0 };
  const ok = Array<number>(EMBEDDING_DIMENSIONS).fill(0);

  it('refuses the wrong count or size as an invalid answer', () => {
    const request = { input: ['a', 'b'] };
    for (const embeddings of [[ok], [ok, ok.slice(1)], [ok, [...ok.slice(1), Number.NaN]]]) {
      expect(() => checkedEmbeddings(request, { embeddings, usage, model: 'm' })).toThrow(
        expect.objectContaining({ code: 'invalid_response' }),
      );
    }
    expect(checkedEmbeddings(request, { embeddings: [ok, ok], usage, model: 'm' }).model).toBe('m');
  });
});

describe('meteredEmbedder', () => {
  it('meters every answer, and a failure the provider still billed', async () => {
    const metered: [LlmUsage, string][] = [];
    const meter = (usage: LlmUsage, model: string) => {
      metered.push([usage, model]);
      return Promise.resolve();
    };
    const embedder = meteredEmbedder(hashEmbedder('fake-model'), meter);
    expect(embedder.model).toBe('fake-model');
    await embedder.embed({ input: ['one two three'] });
    expect(metered).toEqual([
      [{ inputTokens: 3, cachedInputTokens: 0, outputTokens: 0 }, 'fake-model'],
    ]);

    const billed = { inputTokens: 7, cachedInputTokens: 0, outputTokens: 0 };
    const failing: Embedder = {
      model: 'failing',
      embed: () => Promise.reject(new LlmError('unavailable', 'down', billed)),
    };
    await expect(meteredEmbedder(failing, meter).embed({ input: ['x'] })).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(metered.at(-1)).toEqual([billed, 'failing']);
  });

  it('gives no answer it could not meter', async () => {
    const embedder = meteredEmbedder(hashEmbedder(), () => Promise.reject(new Error('db down')));
    await expect(embedder.embed({ input: ['x'] })).rejects.toThrow('db down');
  });
});
