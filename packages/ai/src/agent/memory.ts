import {
  MemoryEpisodeIdSchema,
  MemoryFactIdSchema,
  type MemoryEpisodeId,
  type MemoryFactId,
} from '@pepper/contracts';
import { episodesShownIn, factsShownIn, listFacts } from '@pepper/core';
import { withMember } from '@pepper/db';
import type { ToolDeps } from '../tools/tool.js';

// Remembered facts in what the model is sent (S30, playbook principles 2, 4 and 7). Tool
// answers are stored with references (`{ "$fact": id }`), never values; every request fills
// them in from the memory tables as the member, so a forgotten fact is gone from every later
// request (also in the same chat), a changed one is current, and a staff member never gets a
// fact they may not read. The business's own facts come as one block of the instructions. Both
// are labelled untrusted data: values came from people's words.

/** A remembered fact as the model gets it. */
export interface RecalledFact {
  factId: string;
  key: string;
  value: string;
  sensitive: boolean;
}

/** A past conversation's summary as the model gets it (S31, `search_memory`). */
export interface RecalledEpisode {
  episodeId: string;
  summary: string;
}

/** Reads remembered facts for the member: the ones gone or hidden are simply absent. */
export interface MemoryReader {
  facts(ids: readonly string[]): Promise<Map<string, RecalledFact>>;
  /** The business's own facts the member may read, for the instructions. */
  businessFacts(): Promise<RecalledFact[]>;
  /** The member's own episodes (S31); a deleted one is absent. */
  episodes?(ids: readonly string[]): Promise<Map<string, RecalledEpisode>>;
}

/** The most characters of remembered values one tool answer or the business block carries. */
export const MEMORY_CHARS_PER_ANSWER = 1_200;
export const BUSINESS_FACTS_CHARS = 1_200;
const BUSINESS_FACTS_MAX = 30;

const REF = /"\$fact":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** The ids of the facts a stored tool answer names. */
export function factIdsIn(content: string): string[] {
  return [...content.matchAll(REF)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

const EPISODE_REF =
  /"\$episode":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

/** The ids of the episodes a stored tool answer names (`search_memory`, S31). */
export function episodeIdsIn(content: string): string[] {
  return [...content.matchAll(EPISODE_REF)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1].toLowerCase()],
  );
}

/** The member's facts, read in their own transaction (RLS: their scope, their business). */
export function memberMemory(tools: ToolDeps): MemoryReader {
  return {
    async facts(ids) {
      const valid = ids.flatMap((id) => {
        const parsed = MemoryFactIdSchema.safeParse(id);
        return parsed.success ? [parsed.data] : [];
      });
      if (valid.length === 0) return new Map();
      const shown = await withMember(tools.db, tools.actor.context, (tx) =>
        factsShownIn(tx, [...new Set<MemoryFactId>(valid)], tools.clock.now()),
      );
      return new Map(
        shown.flatMap((fact) =>
          fact.state === 'known'
            ? [
                [
                  fact.factId,
                  {
                    factId: fact.factId,
                    key: fact.key,
                    value: fact.value,
                    sensitive: fact.sensitive,
                  },
                ],
              ]
            : [],
        ),
      );
    },
    async episodes(ids) {
      const valid = ids.flatMap((id) => {
        const parsed = MemoryEpisodeIdSchema.safeParse(id);
        return parsed.success ? [parsed.data] : [];
      });
      if (valid.length === 0) return new Map();
      const shown = await withMember(tools.db, tools.actor.context, (tx) =>
        episodesShownIn(tx, tools.actor, [...new Set<MemoryEpisodeId>(valid)]),
      );
      return new Map(
        shown.map((episode) => [episode.id, { episodeId: episode.id, summary: episode.summary }]),
      );
    },
    async businessFacts() {
      const facts = await listFacts(tools.db, tools.actor, {
        subjectType: 'business',
        limit: BUSINESS_FACTS_MAX,
      });
      return facts.map((fact) => ({
        factId: fact.id,
        key: fact.key,
        value: fact.value,
        sensitive: fact.sensitive,
      }));
    },
  };
}

/** Facts within a character budget for their values, in order. */
export function withinBudget<T extends { value: string }>(facts: readonly T[], chars: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const fact of facts) {
    if (used + fact.value.length > chars) break;
    kept.push(fact);
    used += fact.value.length;
  }
  return kept;
}

function isRef(value: unknown): value is { $fact: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $fact?: unknown }).$fact === 'string'
  );
}

/**
 * A stored tool answer with its references filled in from `facts`: a fact that is gone, hidden
 * or past the answer's budget is left out (from a list) or becomes `null`. `filled`: the ids
 * sent. An answer that is not JSON or names no fact comes back unchanged.
 */
export function fillFactRefs(
  content: string,
  facts: ReadonlyMap<string, RecalledFact>,
  budgetChars = MEMORY_CHARS_PER_ANSWER,
): { content: string; filled: string[] } {
  if (!content.includes('"$fact"')) return { content, filled: [] };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { content, filled: [] };
  }
  const filled: string[] = [];
  let used = 0;
  const fill = (ref: { $fact: string }): RecalledFact | null => {
    const fact = facts.get(ref.$fact.toLowerCase());
    if (fact === undefined || used + fact.value.length > budgetChars) return null;
    used += fact.value.length;
    filled.push(fact.factId);
    return fact;
  };
  const walk = (value: unknown): unknown => {
    if (isRef(value)) return fill(value);
    if (Array.isArray(value)) {
      return value.flatMap((each) => {
        const next = walk(each);
        return isRef(each) && next === null ? [] : [next];
      });
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
    }
    return value;
  };
  const out = walk(json);
  return { content: JSON.stringify(out), filled };
}

function isEpisodeRef(value: unknown): value is { $episode: string } & Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { $episode?: unknown }).$episode === 'string'
  );
}

/**
 * A stored tool answer with its episode references (`{ "$episode": id, date }`) filled in with
 * the summary, read live as the member (S31): a deleted episode is left out, so a summary that
 * named a forgotten fact never reaches the model again, also in the same chat.
 */
export function fillEpisodeRefs(
  content: string,
  episodes: ReadonlyMap<string, RecalledEpisode>,
): { content: string; filled: string[] } {
  if (!content.includes('"$episode"')) return { content, filled: [] };
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { content, filled: [] };
  }
  const filled: string[] = [];
  const walk = (value: unknown): unknown => {
    if (isEpisodeRef(value)) {
      const { $episode: id, ...rest } = value;
      const episode = episodes.get(id.toLowerCase());
      if (episode === undefined) return null;
      filled.push(episode.episodeId);
      return { ...rest, summary: episode.summary };
    }
    if (Array.isArray(value)) {
      return value.flatMap((each) => {
        const next = walk(each);
        return isEpisodeRef(each) && next === null ? [] : [next];
      });
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, walk(child)]));
    }
    return value;
  };
  return { content: JSON.stringify(walk(json)), filled };
}
