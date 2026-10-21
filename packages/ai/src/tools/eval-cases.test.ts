import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type { ArgMatcher } from '../evals/case.js';
import { toolEvalCases } from './eval-cases.js';
import { TOOLS } from './registry.js';

const isMatcher = (value: ArgMatcher) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  ('$any' in value || '$regex' in value);

describe('eval cases generated from the tool guides', () => {
  const cases = toolEvalCases({ now: '2026-11-02T12:00:00.000Z', timeZone: 'America/New_York' });

  it('gives every tool at least two cases with unique ids', () => {
    expect(cases.length).toBeGreaterThanOrEqual(TOOLS.length * 2);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const tool of TOOLS) {
      expect(
        cases.filter((c) => c.expect.toolCalls[0]?.name === tool.name).length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("uses only literal values the tool's own schema accepts (an example can't contradict it)", () => {
    for (const tool of TOOLS) {
      const shape = (tool.args as z.ZodObject).shape as Record<string, z.ZodType>;
      for (const example of tool.guide.examples) {
        for (const [name, value] of Object.entries(example.args)) {
          if (isMatcher(value)) continue;
          const field = shape[name];
          expect(field, `${tool.name}.${name}`).toBeDefined();
          expect(
            field?.safeParse(value).success,
            `${tool.name}.${name} = ${JSON.stringify(value)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('names only tools that exist wherever a guide points elsewhere', () => {
    const names = new Set(TOOLS.map((tool) => tool.name));
    for (const tool of TOOLS) {
      const text = [tool.guide.use, ...tool.guide.avoid, tool.guide.returns].join(' ');
      for (const [mention] of text.matchAll(/\b[a-z]+_[a-z_]+\b/g)) {
        expect(names.has(mention), `${tool.name} mentions ${mention}`).toBe(true);
      }
    }
  });

  it('gives no two tools the same example', () => {
    const says = TOOLS.flatMap((tool) => tool.guide.examples.map((example) => example.say));
    expect(new Set(says).size).toBe(says.length);
  });
});
