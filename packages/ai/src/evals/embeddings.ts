import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMBEDDING_DIMENSIONS } from '@pepper/contracts';
import { z } from 'zod';
import { checkedEmbeddings, embeddingInput, type Embedder } from '../embedder.js';
import { CassetteError } from './cassette.js';

// Recorded embeddings for the evals (S31): a real run embeds episode summaries and the model's
// search questions with the real embedding model once, and every later run (CI included)
// replays them by the text's hash, at no cost, so `search_memory` finds the same episodes in
// the same order and the recorded requests keep their fingerprints. Stored as int8 with one
// scale per vector (a quarter of float32's size); every run uses the stored vector, so the
// search ranks the same everywhere.

const StoreSchema = z.strictObject({
  version: z.literal(1),
  model: z.string().min(1),
  /** sha256 of the text → base64 of 4 bytes (float32 scale) + one int8 per dimension. */
  vectors: z.record(z.string().regex(/^[0-9a-f]{64}$/), z.string()),
});
export type EmbeddingStore = z.infer<typeof StoreSchema>;

const keyOf = (text: string) => createHash('sha256').update(text).digest('hex');

function packed(vector: readonly number[]): string {
  const max = Math.max(...vector.map((value) => Math.abs(value)), Number.MIN_VALUE);
  const bytes = Buffer.alloc(4 + vector.length);
  bytes.writeFloatLE(max / 127, 0);
  vector.forEach((value, index) => {
    bytes.writeInt8(Math.round((value / max) * 127), 4 + index);
  });
  return bytes.toString('base64');
}

function unpacked(text: string): number[] {
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length !== 4 + EMBEDDING_DIMENSIONS) throw new Error('A stored embedding is damaged');
  const scale = bytes.readFloatLE(0);
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, index) => {
    return bytes.readInt8(4 + index) * scale;
  });
}

/** `evals/embeddings/<model>.json`, or an empty store. */
export async function loadEmbeddingStore(
  paths: { root: string },
  model: string,
): Promise<EmbeddingStore> {
  try {
    const text = await readFile(join(paths.root, 'embeddings', `${model}.json`), 'utf8');
    return StoreSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, model, vectors: {} };
    }
    throw error;
  }
}

export async function saveEmbeddingStore(
  paths: { root: string },
  store: EmbeddingStore,
): Promise<void> {
  const dir = join(paths.root, 'embeddings');
  await mkdir(dir, { recursive: true });
  // Sorted, so a re-recording changes only the lines it added.
  const vectors = Object.fromEntries(
    Object.entries(store.vectors).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  await writeFile(
    join(dir, `${store.model}.json`),
    `${JSON.stringify({ ...store, vectors }, null, 2)}\n`,
  );
}

/**
 * An embedder answering from `store`. A text it has no vector for is embedded by `recorder`
 * (a real run) and kept in the store, or fails the case as a cassette miss (a replay).
 */
export function storeEmbedder(store: EmbeddingStore, recorder: Embedder | null = null): Embedder {
  return {
    model: store.model,
    async embed(request, options) {
      const input = embeddingInput(request);
      const missing = [
        ...new Set(input.filter((text) => store.vectors[keyOf(text)] === undefined)),
      ];
      let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      if (missing.length > 0) {
        if (recorder === null) {
          throw new CassetteError(
            'miss',
            `no recorded embedding for ${String(missing.length)} text(s)`,
          );
        }
        const recorded = await recorder.embed({ input: missing }, options);
        missing.forEach((text, index) => {
          const vector = recorded.embeddings[index];
          if (vector !== undefined) store.vectors[keyOf(text)] = packed(vector);
        });
        usage = recorded.usage;
      }
      return checkedEmbeddings(request, {
        embeddings: input.map((text) => unpacked(store.vectors[keyOf(text)] ?? '')),
        usage,
        model: store.model,
      });
    },
  };
}
