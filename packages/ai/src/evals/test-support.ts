// Test-only (not built into dist).
import { EvalCaseSchema, type EvalCase, type EvalCaseInput } from './case.js';
import type { Transcript } from './transcript.js';

export function evalCase(overrides: Partial<EvalCaseInput> = {}): EvalCase {
  return EvalCaseSchema.parse({
    id: 'sample-case',
    set: 'scheduling',
    description: 'A sample case.',
    now: '2026-10-20T15:00:00Z',
    timeZone: 'America/New_York',
    actor: { role: 'owner' },
    turns: [{ user: 'Book Maria for a haircut on Friday at 4pm' }],
    expect: {},
    ...overrides,
  });
}

export function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    toolCalls: [],
    replies: [],
    actions: { done: [], proposed: [] },
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    models: [],
    ...overrides,
  };
}

export const call = (name: string, args: unknown) => ({
  name,
  arguments: args,
  raw: JSON.stringify(args),
});
