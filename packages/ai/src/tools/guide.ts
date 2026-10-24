import type { ArgMatcher } from '../evals/case.js';

// Tool descriptions are prompts (playbook principle 3, OpenAI's function-calling guidance): the
// model's only guide to when a tool fits, when it doesn't and what its arguments mean. Each tool
// writes its guide in fixed parts, so every description answers the same questions (could a new
// hire use the tool from this alone?), a lint test holds them to it, and the examples double as
// eval cases (`toolEvalCases`, S22's idea).

/** Something a member says that the tool answers, with the arguments it should get. */
export interface ToolExample {
  say: string;
  /** Matchers for the arguments (`{ "$any": true }` for ids the world decides). */
  args: Record<string, ArgMatcher>;
  /**
   * The same request for the eval world's case, when `say` (shown to the model) names
   * something that world doesn't have (S27).
   */
  evalSay?: string;
  /** Why the example can't be a one-turn eval case (it needs earlier context); none: it is one. */
  evalSkip?: string;
  /** Times the eval world books solid for the case (S37b): the waitlist is for full times. */
  evalFull?: readonly { staff: string; date: string; start: string; end: string }[];
}

export interface ToolGuide {
  /** When to use it: one or two sentences. */
  use: string;
  /** When not to, and what to do instead. */
  avoid: readonly string[];
  /** What it gives back. */
  returns: string;
  /** Requests it answers; the first is shown in the description. */
  examples: readonly [ToolExample, ToolExample, ...ToolExample[]];
}

/** Providers take at most this much description per tool (`LlmToolDefinitionSchema`). */
export const DESCRIPTION_MAX = 1024;

const LOCAL_TIME_NOTE =
  "Dates and times are the business's local time: dates YYYY-MM-DD from the date table, times HH:MM (24-hour).";

/** The description sent to the model. */
export function describeTool(guide: ToolGuide, options: { localTimes: boolean }): string {
  const [first] = guide.examples;
  return [
    guide.use,
    `Don't use it ${guide.avoid.join('; ')}.`,
    `Returns ${guide.returns}`,
    ...(options.localTimes ? [LOCAL_TIME_NOTE] : []),
    `Example: "${first.say}"`,
  ].join('\n');
}

/** What is wrong with a guide (empty: nothing), for the lint test. */
export function guideProblems(
  guide: ToolGuide,
  options: { localTimes: boolean; argNames: readonly string[] },
): string[] {
  const problems: string[] = [];
  const description = describeTool(guide, options);
  if (description.length > DESCRIPTION_MAX) problems.push('the description is too long');
  if (guide.use.length > 300) problems.push('"use" should be one or two sentences');
  if (guide.avoid.length === 0) problems.push('say when not to use it');
  const names = new Set(options.argNames);
  for (const example of guide.examples) {
    for (const key of Object.keys(example.args)) {
      if (!names.has(key)) problems.push(`example "${example.say}" names unknown argument ${key}`);
    }
  }
  return problems;
}
