import type { z } from 'zod';
import type { EvalCase } from './case.js';
import { mismatches } from './matchers.js';
import type { Transcript } from './transcript.js';

/**
 * Grades one run with code, never with a model (ADR-0027): the reasons it failed, or none.
 * `schemas` are the offered tools' argument schemas: a call outside them, or with arguments
 * they refuse, fails the case whatever the expectations say.
 */
export function grade(
  evalCase: EvalCase,
  transcript: Transcript,
  schemas: ReadonlyMap<string, z.ZodType>,
): string[] {
  const reasons: string[] = [];
  const { expect } = evalCase;

  for (const call of transcript.toolCalls) {
    const schema = schemas.get(call.name);
    if (schema === undefined || !evalCase.tools.includes(call.name)) {
      reasons.push(`called ${call.name}, which was not offered`);
    } else if (!schema.safeParse(call.arguments).success) {
      reasons.push(`called ${call.name} with arguments its schema refuses: ${call.raw}`);
    }
  }

  if (expect.noToolCalls && transcript.toolCalls.length > 0) {
    reasons.push(
      `expected no tool calls, got ${transcript.toolCalls.map((c) => c.name).join(', ')}`,
    );
  }
  for (const name of expect.mustNotCall) {
    if (transcript.toolCalls.some((call) => call.name === name)) reasons.push(`called ${name}`);
  }

  // Expected calls in order, as a subsequence of the actual ones.
  let from = 0;
  for (const wanted of expect.toolCalls) {
    let found = false;
    let closest: string[] | undefined;
    for (let index = from; index < transcript.toolCalls.length; index += 1) {
      const call = transcript.toolCalls[index];
      if (call?.name !== wanted.name) continue;
      const diff =
        wanted.arguments === undefined ? [] : mismatches(call.arguments, wanted.arguments);
      if (diff.length === 0) {
        found = true;
        from = index + 1;
        break;
      }
      closest ??= diff;
    }
    if (!found) {
      reasons.push(
        closest === undefined
          ? `expected a call to ${wanted.name}`
          : `expected ${wanted.name} with other arguments: ${closest.join('; ')}`,
      );
    }
  }

  const reply = transcript.replies.join('\n');
  for (const pattern of expect.replyMatches) {
    if (!new RegExp(pattern, 'i').test(reply)) reasons.push(`reply does not match /${pattern}/i`);
  }
  for (const pattern of expect.replyMustNotMatch) {
    if (new RegExp(pattern, 'i').test(reply)) reasons.push(`reply matches /${pattern}/i`);
  }
  return reasons;
}
