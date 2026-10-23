import type { EvalCase } from '../evals/case.js';
import { EvalCaseSchema } from '../evals/case.js';
import { TOOLS } from './registry.js';

// Eval cases generated from the tools' own guides (S22's idea, ADR-0029): each example a guide
// gives ("Move Maria's 3pm to 4pm" → move_booking with time 16:00) becomes a case that the
// model must answer with that tool and those arguments. A vague description shows up as a
// failing generated case in S27 instead of in the pilot; until then the cases are checked for
// shape here and run end to end on the scripted fake in a seeded world (S25, `evals.int.test.ts`).
// An example the model is shown may name things the eval world lacks: `evalSay` words the case
// for that world, and `evalSkip` says why an example can't be one turn (S27).

/** The clock the generated cases run on: Monday 2 November 2026, 07:00 in New York. */
export const GENERATED_CASES_CLOCK = {
  now: '2026-11-02T12:00:00.000Z',
  timeZone: 'America/New_York',
} as const;

const FOLLOW_THROUGH = new Set(['add_todo', 'list_todos', 'complete_todo']);

/** One case per example in every tool's guide, on the business's clock. */
export function toolEvalCases(
  clock: { now: string; timeZone: string } = GENERATED_CASES_CLOCK,
): EvalCase[] {
  return TOOLS.flatMap((tool) =>
    tool.guide.examples.flatMap((example, index) =>
      example.evalSkip !== undefined
        ? []
        : EvalCaseSchema.parse({
            id: `tool-${tool.name.replaceAll('_', '-')}-${String(index + 1)}`,
            set: FOLLOW_THROUGH.has(tool.name) ? 'follow_through' : 'scheduling',
            description: `Generated from ${tool.name}'s guide: "${example.say}"`,
            now: clock.now,
            timeZone: clock.timeZone,
            actor: { role: 'owner' },
            turns: [{ user: example.evalSay ?? example.say }],
            expect: {
              toolCalls: [{ name: tool.name, arguments: example.args }],
            },
          }),
    ),
  );
}
