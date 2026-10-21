import type { EvalCase } from './case.js';
import { mismatches } from './matchers.js';
import { findTool } from '../tools/registry.js';
import type { Transcript } from './transcript.js';

/**
 * Grades one run with code, never with a model (ADR-0027, ADR-0030): the reasons it failed, or
 * none. A call to a tool that doesn't exist, or with arguments its schema refuses, fails the
 * case whatever the expectations say; so does the business ending up other than expected.
 */
export function grade(evalCase: EvalCase, transcript: Transcript): string[] {
  const reasons: string[] = [];
  const { expect } = evalCase;

  for (const call of transcript.toolCalls) {
    const tool = findTool(call.name);
    if (tool === undefined) {
      reasons.push(`called ${call.name}, which is not a tool`);
    } else if (!tool.args.safeParse(call.arguments).success) {
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

  const { actions } = expect;
  if (actions.noWrites) {
    const wrote = [...transcript.actions.done, ...transcript.actions.proposed];
    if (wrote.length > 0) reasons.push(`expected no writes, got ${wrote.join(', ')}`);
  }
  for (const [kind, wanted] of [
    ['done', actions.done],
    ['proposed', actions.proposed],
  ] as const) {
    const left = [...transcript.actions[kind]];
    for (const name of wanted) {
      const at = left.indexOf(name);
      if (at === -1) reasons.push(`expected ${name} to be ${kind}`);
      else left.splice(at, 1);
    }
    if (wanted.length > 0 && left.length > 0) {
      reasons.push(`also ${kind}: ${left.join(', ')}`);
    }
  }
  return reasons;
}
