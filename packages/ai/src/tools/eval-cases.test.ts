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

  it('gives every example a case with a unique id, unless it says why it cannot be one', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const tool of TOOLS) {
      const skipped = tool.guide.examples.filter((example) => example.evalSkip !== undefined);
      for (const example of skipped) expect(example.evalSkip?.length).toBeGreaterThan(20);
      expect(cases.filter((c) => c.expect.toolCalls[0]?.name === tool.name)).toHaveLength(
        tool.guide.examples.length - skipped.length,
      );
    }
    // Skipping is the exception: a tool that needs earlier context (get_booking) only.
    expect(cases.length).toBeGreaterThanOrEqual(TOOLS.length * 2 - 2);
  });

  it("asks in the eval world's words when the shown example names things that world lacks", () => {
    const cancel = cases.find((c) => c.id === 'tool-cancel-booking-1');
    expect(cancel?.turns[0]?.user).toBe("Cancel Maria's appointment tomorrow");
    expect(cases.some((c) => c.id.startsWith('tool-get-booking-'))).toBe(false);
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
