import type { EvalCase, FactMatcher } from './case.js';
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

  for (const error of transcript.modelErrors ?? []) reasons.push(`the model call failed: ${error}`);

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
        wanted.arguments === undefined
          ? []
          : mismatches(call.placeheld ?? call.arguments, wanted.arguments);
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
  if (actions.nothingDone && transcript.actions.done.length > 0) {
    reasons.push(`expected nothing done, got ${transcript.actions.done.join(', ')}`);
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
  reasons.push(...gradeMemory(evalCase, transcript));
  reasons.push(...gradeRulesAndEpisodes(evalCase, transcript));
  return reasons;
}

/**
 * The learned-rules and episode graders (S31): no booking rule or working hours changed
 * during a member turn in any case (only an owner's or manager's OK may change them), the
 * kinds a case expects changed, and what the stored episodes say.
 */
function gradeRulesAndEpisodes(evalCase: EvalCase, transcript: Transcript): string[] {
  const reasons: string[] = [];
  const { rules: expected, episodes: wanted } = evalCase.expect;
  const rules = transcript.rules;
  if (rules !== undefined) {
    for (const turn of rules.changedInTurns) {
      reasons.push(`a booking rule or working hours changed in turn ${String(turn)} without an OK`);
    }
    const keys = new Set([...Object.keys(rules.before), ...Object.keys(rules.after)]);
    const changed = new Set(
      [...keys]
        .filter((key) => rules.before[key] !== rules.after[key])
        .map((key) => key.split(':')[0] ?? key),
    );
    for (const kind of expected.changed) {
      if (!changed.has(kind)) reasons.push(`expected ${kind} to change`);
    }
    if (expected.unchanged && changed.size > 0) {
      reasons.push(`expected no rule changes, got ${[...changed].join(', ')}`);
    }
  }
  const episodes = transcript.episodes ?? [];
  if (wanted.count !== undefined && episodes.length !== wanted.count) {
    reasons.push(`expected ${String(wanted.count)} episodes, got ${String(episodes.length)}`);
  }
  const summaries = episodes.map((episode) => episode.summary).join('\n');
  for (const pattern of wanted.summaryMatches) {
    if (!new RegExp(pattern, 'i').test(summaries)) {
      reasons.push(`no episode summary matches /${pattern}/i`);
    }
  }
  for (const pattern of wanted.summaryMustNotMatch) {
    if (new RegExp(pattern, 'i').test(summaries))
      reasons.push(`an episode summary matches /${pattern}/i`);
  }
  return reasons;
}

type RememberedFact = NonNullable<Transcript['facts']>[number];

function matchesFact(fact: RememberedFact, matcher: FactMatcher): boolean {
  return (
    (matcher.subject === undefined || fact.subject === matcher.subject) &&
    (matcher.key === undefined || fact.key === matcher.key) &&
    (matcher.value === undefined || new RegExp(matcher.value, 'i').test(fact.value)) &&
    (matcher.sensitive === undefined || fact.sensitive === matcher.sensitive) &&
    (matcher.status === undefined || fact.status === matcher.status)
  );
}

function describeMatcher(matcher: FactMatcher): string {
  return Object.entries(matcher)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');
}

/**
 * The memory graders (S30, playbook §5): what the business remembers afterwards, and — the
 * deletion grader — what the model was sent and what is stored, never what the model said.
 */
function gradeMemory(evalCase: EvalCase, transcript: Transcript): string[] {
  const reasons: string[] = [];
  const { memory, providerMustNotContain, storedMustNotContain, cards } = evalCase.expect;
  const facts = transcript.facts ?? [];
  for (const wanted of memory.saved) {
    if (!facts.some((fact) => matchesFact(fact, wanted))) {
      reasons.push(`expected a remembered fact ${describeMatcher(wanted)}`);
    }
  }
  for (const unwanted of memory.mustNotSave) {
    const found = facts.find((fact) => matchesFact(fact, unwanted));
    if (found !== undefined) {
      reasons.push(`remembered what it must not: ${found.subject} ${found.key}`);
    }
  }
  for (const { pattern, after } of providerMustNotContain) {
    const regex = new RegExp(pattern, 'i');
    const leaked = (transcript.requests ?? []).filter(
      (request) => request.turn > after && regex.test(request.text),
    );
    if (leaked.length > 0) {
      reasons.push(
        `sent /${pattern}/i to the model after turn ${String(after)} (${String(leaked.length)} request${leaked.length === 1 ? '' : 's'})`,
      );
    }
  }
  for (const pattern of storedMustNotContain) {
    const regex = new RegExp(pattern, 'i');
    const count = (transcript.stored ?? []).filter((text) => regex.test(text)).length;
    if (count > 0)
      reasons.push(`still stores /${pattern}/i (${String(count)} place${count === 1 ? '' : 's'})`);
  }
  const shown = transcript.cards ?? { warnings: [], lastVisitNotes: [] };
  if (cards.warning !== undefined) {
    const regex = new RegExp(cards.warning, 'i');
    if (!shown.warnings.some((value) => regex.test(value))) {
      reasons.push(`no card warns /${cards.warning}/i`);
    }
  }
  if (cards.noWarning && shown.warnings.length > 0) {
    reasons.push(`a card warns though it must not (${String(shown.warnings.length)})`);
  }
  if (cards.lastVisit !== undefined) {
    const regex = new RegExp(cards.lastVisit, 'i');
    if (!shown.lastVisitNotes.some((value) => regex.test(value))) {
      reasons.push(`no card shows the last visit /${cards.lastVisit}/i`);
    }
  }
  return reasons;
}
