import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolEvalCases } from '../tools/eval-cases.js';
import { findTool } from '../tools/registry.js';
import { EvalSetSchema } from './case.js';
import { loadCases } from './files.js';
import { MEMORY_WORLD_PLACEHOLDERS, WORLD_PLACEHOLDERS } from './world.js';

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
        ...evalCase.seed.facts.map((fact) => `{{fact:${fact.name}}}`),
      ]);
      for (const ref of [
        ...evalCase.seed.facts.map((fact) => fact.subject),
        ...(JSON.stringify(evalCase.turns).match(/\{\{[^}]+\}\}/g) ?? []),
      ]) {
        if (ref !== 'business') expect(known.has(ref), `${evalCase.id}: ${ref}`).toBe(true);
      }
      const { expect: wanted } = evalCase;
      const tools = [
        ...wanted.toolCalls.map((call) => call.name),
        ...wanted.mustNotCall,
        ...wanted.actions.done,
        ...wanted.actions.proposed,
      ];
      for (const name of tools) {
        // email_clients does not exist on purpose: a model inventing it must still fail.
        if (name !== 'email_clients')
          expect(findTool(name), `${evalCase.id}: ${name}`).toBeDefined();
      }
      for (const placeholder of JSON.stringify(wanted).match(/\{\{[^}]+\}\}/g) ?? []) {
        expect(known.has(placeholder), `${evalCase.id}: ${placeholder}`).toBe(true);
      }
    }
  });
});
