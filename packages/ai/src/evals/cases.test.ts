import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolEvalCases } from '../tools/eval-cases.js';
import { findTool, SYSTEM_TOOLS } from '../tools/registry.js';
import { CLASSIFIER_SETS, EvalSetSchema } from './case.js';
import { loadCases } from './files.js';
import { loadRetrievalSet, RetrievalSetSchema } from './retrieval.js';
import { FEED_WORLD_PLACEHOLDERS, MEMORY_WORLD_PLACEHOLDERS, WORLD_PLACEHOLDERS } from './world.js';

// The eval cases themselves (S27): written before any real run, about 120 across every set,
// a fifth held out (never tuned against, playbook §7 "S27"), and naming only tools and seeded
// records that exist, so no paid run is wasted on a broken case.

const paths = { root: fileURLToPath(new URL('../../evals/', import.meta.url)) };

describe('the eval cases', () => {
  it('cover every set with about 120 cases, a fifth of them held out', async () => {
    const cases = [...(await loadCases(paths)), ...toolEvalCases()];
    expect(cases.length).toBeGreaterThanOrEqual(110);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const set of EvalSetSchema.options) {
      expect(cases.filter((c) => c.set === set).length, set).toBeGreaterThanOrEqual(5);
    }
    const held = cases.filter((c) => c.holdout).length;
    expect(held / cases.length).toBeGreaterThanOrEqual(0.2);
  });

  it('name only real tools and seeded records', async () => {
    for (const evalCase of await loadCases(paths)) {
      const known = new Set<string>([
        ...WORLD_PLACEHOLDERS,
        ...(evalCase.world === 'juniper_memory' ? MEMORY_WORLD_PLACEHOLDERS : []),
        ...(evalCase.world === 'juniper_feed' ? FEED_WORLD_PLACEHOLDERS : []),
        ...evalCase.seed.facts.map((fact) => `{{fact:${fact.name}}}`),
        ...evalCase.seed.episodes.map((episode) => `{{episode:${episode.name}}}`),
      ]);
      for (const ref of [
        ...evalCase.seed.facts.map((fact) => fact.subject),
        ...evalCase.seed.episodes.flatMap((episode) => [...episode.facts, ...episode.clients]),
        ...(evalCase.seed.feed?.optedOut ?? []),
        ...Object.keys(evalCase.seed.feed?.clientNames ?? {}),
        ...(JSON.stringify(evalCase.turns).match(/\{\{[^}]+\}\}/g) ?? []),
      ]) {
        if (ref !== 'business') expect(known.has(ref), `${evalCase.id}: ${ref}`).toBe(true);
      }
      const { expect: wanted } = evalCase;
      const tools = [
        ...wanted.toolCalls.flatMap((call) => [call.name, ...call.alsoAccept]),
        ...wanted.mustNotCall,
        ...wanted.actions.done,
        ...wanted.actions.proposed,
      ];
      for (const name of tools) {
        // email_clients does not exist on purpose: a model inventing it must still fail.
        // The business's own passes' tools (S36) are approved on screens, never by the model.
        const system = SYSTEM_TOOLS.some((tool) => tool.name === name);
        if (name !== 'email_clients' && !system)
          expect(findTool(name), `${evalCase.id}: ${name}`).toBeDefined();
      }
      for (const placeholder of JSON.stringify(wanted).match(/\{\{[^}]+\}\}/g) ?? []) {
        expect(known.has(placeholder), `${evalCase.id}: ${placeholder}`).toBe(true);
      }
    }
  });
});

describe('the classifier sets (S81a, AC-X-240)', () => {
  it('read one client text each, judged on its reading, and no other case is', async () => {
    const cases = await loadCases(paths);
    for (const evalCase of cases) {
      const texts = evalCase.turns.filter(
        (turn) => 'action' in turn && 'clientText' in turn.action,
      );
      if (CLASSIFIER_SETS.includes(evalCase.set)) {
        expect(evalCase.turns, evalCase.id).toHaveLength(1);
        expect(texts, evalCase.id).toHaveLength(1);
        expect(evalCase.expect.reading, evalCase.id).toBeDefined();
      } else {
        expect(texts, evalCase.id).toHaveLength(0);
        expect(evalCase.expect.reading, evalCase.id).toBeUndefined();
      }
    }
  });

  it('hold about 80 texts of every label, a fifth held out, and no "no" expected as a yes', async () => {
    const cases = (await loadCases(paths)).filter((c) => CLASSIFIER_SETS.includes(c.set));
    expect(cases.length).toBeGreaterThanOrEqual(80);
    for (const label of ['confirm', 'cancel', 'reschedule', 'running_late', 'question', 'other']) {
      expect(
        cases.filter((c) => c.set === 'client_replies' && c.expect.reading?.intent === label)
          .length,
        label,
      ).toBeGreaterThanOrEqual(8);
    }
    expect(cases.filter((c) => c.holdout).length / cases.length).toBeGreaterThanOrEqual(0.2);
    // The safety set never accepts a confirm, whatever its text says.
    for (const c of cases.filter((each) => each.set === 'client_replies_safety')) {
      expect(
        [c.expect.reading?.intent, ...(c.expect.reading?.alsoAccept ?? [])],
        c.id,
      ).not.toContain('confirm');
    }
  });
});

describe('the episode_retrieval set (S31)', () => {
  it('has about 60 summaries of three members and 25 questions, a fifth held out', async () => {
    const set = await loadRetrievalSet(paths);
    expect(set.episodes.length).toBeGreaterThanOrEqual(60);
    expect(new Set(set.episodes.map((episode) => episode.member)).size).toBe(3);
    expect(set.queries.length).toBeGreaterThanOrEqual(25);
    expect(set.queries.filter((q) => q.holdout).length / set.queries.length).toBeGreaterThanOrEqual(
      0.2,
    );
  });

  it("refuses a question whose expected episode is another member's", async () => {
    const set = await loadRetrievalSet(paths);
    const [first] = set.queries;
    if (first === undefined) throw new Error('no queries');
    const other = set.episodes.find((episode) => episode.member !== first.member);
    expect(
      RetrievalSetSchema.safeParse({ ...set, queries: [{ ...first, expected: other?.name }] })
        .success,
    ).toBe(false);
  });
});
