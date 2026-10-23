import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMORY_LIMITS, MembershipRoleSchema } from '@pepper/contracts';
import { searchEpisodesIn } from '@pepper/core';
import { withMember, type Database } from '@pepper/db';
import { z } from 'zod';
import type { Embedder } from '../embedder.js';
import { seedEvalWorld } from './world.js';

// The `episode_retrieval` set (S31, playbook §2): about 60 past conversations' summaries of
// three members, near-duplicates among them, and questions a member asks later, each with the
// episode that answers it. Recall@5 is the share of questions whose episode is among the five
// `search_memory` returns, searched as that member through the real search (RLS, pgvector),
// on the recorded real embeddings. Its gate is 95%.

export const EPISODE_RECALL_GATE = 0.95;

const Name = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const RetrievalSetSchema = z
  .strictObject({
    now: z.iso.datetime(),
    timeZone: z.string().min(1),
    episodes: z
      .array(
        z.strictObject({
          name: Name,
          member: MembershipRoleSchema,
          daysAgo: z.int().min(0).max(364),
          summary: z.string().min(1).max(MEMORY_LIMITS.episodeSummaryMax),
        }),
      )
      .min(1)
      .max(80),
    queries: z
      .array(
        z.strictObject({
          query: z.string().min(3).max(300),
          member: MembershipRoleSchema,
          expected: Name,
          /** Written before any real run and never tuned against. */
          holdout: z.boolean().default(false),
        }),
      )
      .min(1)
      .max(60),
  })
  .superRefine((set, context) => {
    const owners = new Map(set.episodes.map((episode) => [episode.name, episode.member]));
    if (owners.size !== set.episodes.length) {
      context.addIssue({ code: 'custom', message: 'Episode names are unique' });
    }
    for (const query of set.queries) {
      if (owners.get(query.expected) !== query.member) {
        context.addIssue({
          code: 'custom',
          message: `"${query.query}" expects ${query.expected}, which is not ${query.member}'s`,
        });
      }
    }
  });
export type RetrievalSet = z.infer<typeof RetrievalSetSchema>;

export interface RetrievalResult {
  queries: number;
  found: number;
  recall: number;
  meetsGate: boolean;
  /** The questions whose episode was not in the top five, with what came back. */
  misses: { query: string; expected: string; got: string[] }[];
  /** What every question got, by episode name, best first. */
  answers: { query: string; member: RetrievalSet['queries'][number]['member']; got: string[] }[];
}

export async function loadRetrievalSet(paths: { root: string }): Promise<RetrievalSet> {
  const text = await readFile(join(paths.root, 'retrieval', 'episodes.json'), 'utf8');
  return RetrievalSetSchema.parse(JSON.parse(text));
}

/** The texts the set embeds: every summary and every question. */
export function retrievalTexts(set: RetrievalSet): string[] {
  return [...set.episodes.map((episode) => episode.summary), ...set.queries.map((q) => q.query)];
}

/** Seeds the set's episodes in a fresh world and asks every question as its member. */
export async function runRetrieval(
  db: Database,
  embedder: Embedder,
  set: RetrievalSet,
): Promise<RetrievalResult> {
  const world = await seedEvalWorld(
    db,
    'juniper',
    { now: new Date(set.now), timeZone: set.timeZone },
    {
      facts: [],
      memoryPaused: false,
      episodes: set.episodes.map((episode) => ({ ...episode, facts: [], clients: [] })),
    },
    { embedder },
  );
  const nameOf = new Map(
    set.episodes.map((episode) => [
      world.placeholders.get(`{{episode:${episode.name}}}`),
      episode.name,
    ]),
  );
  const { embeddings } = await embedder.embed({ input: set.queries.map((q) => q.query) });
  const misses: RetrievalResult['misses'] = [];
  const answers: RetrievalResult['answers'] = [];
  for (const [index, query] of set.queries.entries()) {
    const actor = world.actorFor(query.member);
    const found = await withMember(db, actor.context, (tx) =>
      searchEpisodesIn(tx, actor, embeddings[index] ?? [], MEMORY_LIMITS.searchMemoryResults),
    );
    const got = found.map((episode) => nameOf.get(episode.id) ?? episode.id);
    answers.push({ query: query.query, member: query.member, got });
    if (!got.includes(query.expected))
      misses.push({ query: query.query, expected: query.expected, got });
  }
  const recall = (set.queries.length - misses.length) / set.queries.length;
  return {
    queries: set.queries.length,
    found: set.queries.length - misses.length,
    recall,
    meetsGate: recall >= EPISODE_RECALL_GATE,
    misses,
    answers,
  };
}
