import { fileURLToPath } from 'node:url';
import type { Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashEmbedder } from '../embedder.js';
import { startTestDatabase, type TestDatabase } from '../tools/test-support.js';
import { loadEmbeddingStore, storeEmbedder } from './embeddings.js';
import { EPISODE_RECALL_GATE, loadRetrievalSet, runRetrieval } from './retrieval.js';

// The episode_retrieval set (S31, playbook §2) through the real search: each member's
// questions against about 60 summaries of three members, recall@5 on the recorded
// text-embedding-3-small vectors, replayed for free (recorded with `--retrieval --record`).

const paths = { root: fileURLToPath(new URL('../../evals/', import.meta.url)) };

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

describe('episode_retrieval', () => {
  it('finds the episode that answers each question in the top 5, on the recorded embeddings', async () => {
    const set = await loadRetrievalSet(paths);
    const store = await loadEmbeddingStore(paths, 'text-embedding-3-small');
    const result = await runRetrieval(db, storeEmbedder(store), set);
    expect(result.misses).toEqual([]);
    expect(result.recall).toBeGreaterThanOrEqual(EPISODE_RECALL_GATE);
  });

  it("searches as the member: no answer is ever another member's episode", async () => {
    const set = await loadRetrievalSet(paths);
    const result = await runRetrieval(db, hashEmbedder(), set);
    const memberOf = new Map(set.episodes.map((episode) => [episode.name, episode.member]));
    expect(result.answers).toHaveLength(set.queries.length);
    for (const answer of result.answers) {
      expect(answer.got).toHaveLength(5);
      for (const name of answer.got) expect(memberOf.get(name), answer.query).toBe(answer.member);
    }
  });
});
