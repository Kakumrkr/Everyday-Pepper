import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashEmbedder, type Embedder } from '../embedder.js';
import { CassetteError } from './cassette.js';
import { loadEmbeddingStore, saveEmbeddingStore, storeEmbedder } from './embeddings.js';

const cosine = (a: readonly number[], b: readonly number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((value, index) => {
    const other = b[index] ?? 0;
    dot += value * other;
    na += value * value;
    nb += other * other;
  });
  return dot / Math.sqrt(na * nb);
};

/** Counts the texts the real model would have been paid for. */
function counting(embedder: Embedder): Embedder & { texts: string[] } {
  const texts: string[] = [];
  return {
    model: embedder.model,
    texts,
    embed(request, options) {
      texts.push(...request.input);
      return embedder.embed(request, options);
    },
  };
}

describe('the recorded embeddings (S31)', () => {
  it('records each new text once, then replays it without the model, close to the original', async () => {
    const store = { version: 1 as const, model: 'text-embedding-3-small', vectors: {} };
    const real = counting(hashEmbedder());
    const recording = storeEmbedder(store, real);
    const first = await recording.embed({ input: ['Saturdays with Marco', 'the colour line'] });
    await recording.embed({ input: ['Saturdays with Marco', 'gift cards'] });
    expect(real.texts).toEqual(['Saturdays with Marco', 'the colour line', 'gift cards']);
    expect(first.model).toBe('text-embedding-3-small');

    const replay = storeEmbedder(store);
    const again = await replay.embed({ input: ['Saturdays with Marco'] });
    const original = await hashEmbedder().embed({ input: ['Saturdays with Marco'] });
    expect(cosine(again.embeddings[0] ?? [], original.embeddings[0] ?? [])).toBeGreaterThan(0.999);
    // The same stored vector every time: replays rank the same everywhere.
    expect(again.embeddings[0]).toEqual(first.embeddings[0]);
    expect(again.usage.inputTokens).toBe(0);
  });

  it('fails a replay that has no recording as a cassette miss, never as a provider error', async () => {
    const replay = storeEmbedder({ version: 1, model: 'm', vectors: {} });
    await expect(replay.embed({ input: ['never recorded'] })).rejects.toBeInstanceOf(CassetteError);
  });

  it('saves and loads the store, sorted; a missing file is an empty store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-embeddings-'));
    expect(await loadEmbeddingStore({ root }, 'm')).toEqual({
      version: 1,
      model: 'm',
      vectors: {},
    });
    const store = { version: 1 as const, model: 'm', vectors: {} };
    await storeEmbedder(store, hashEmbedder()).embed({ input: ['b text', 'a text'] });
    await saveEmbeddingStore({ root }, store);
    expect(await loadEmbeddingStore({ root }, 'm')).toEqual(store);
    const keys = Object.keys(
      (
        JSON.parse(await readFile(join(root, 'embeddings', 'm.json'), 'utf8')) as {
          vectors: Record<string, string>;
        }
      ).vectors,
    );
    expect(keys).toEqual([...keys].sort());
  });
});
