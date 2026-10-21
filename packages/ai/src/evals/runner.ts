import type { LlmUsage } from '@pepper/contracts';
import { isLlmError } from '../errors.js';
import type { LlmProvider } from '../provider.js';
import { EVAL_SET_GATES, type EvalCase, type EvalSet } from './case.js';
import { CassetteError } from './cassette.js';
import { grade } from './grade.js';
import type { EvalSubject } from './subject.js';
import { addUsage, emptyUsage } from './transcript.js';
import type { EvalWorld } from './world.js';

export interface TrialResult {
  passed: boolean;
  reasons: string[];
  usage: LlmUsage;
  models: string[];
}

export interface CaseResult {
  id: string;
  set: EvalSet;
  holdout: boolean;
  /** pass^k: the case passes only if every trial does. */
  passed: boolean;
  trials: TrialResult[];
}

export interface RunOptions {
  cases: readonly EvalCase[];
  /** How many times each case runs (pass^k). */
  trials: number;
  /** The model for one trial of one case in its seeded world (a cassette, a fake, the real one). */
  providerFor: (evalCase: EvalCase, trial: number, world: EvalWorld) => LlmProvider;
  /** Runs a case (`loopSubject`: the agent loop on Postgres). */
  subject: EvalSubject;
}

function describeFailure(error: unknown): string {
  if (error instanceof CassetteError) return `cassette ${error.kind}: ${error.message}`;
  if (isLlmError(error)) return `provider failed: ${error.code}`;
  return `subject failed: ${error instanceof Error ? error.message : String(error)}`;
}

/** Runs every case `trials` times and grades each run with code. */
export async function runEvals(options: RunOptions): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const evalCase of options.cases) {
    const trials: TrialResult[] = [];
    for (let trial = 0; trial < options.trials; trial += 1) {
      try {
        const transcript = await options.subject(evalCase, (world) =>
          options.providerFor(evalCase, trial, world),
        );
        const reasons = grade(evalCase, transcript);
        trials.push({
          passed: reasons.length === 0,
          reasons,
          usage: transcript.usage,
          models: transcript.models,
        });
      } catch (error) {
        trials.push({
          passed: false,
          reasons: [describeFailure(error)],
          usage: emptyUsage(),
          models: [],
        });
      }
    }
    results.push({
      id: evalCase.id,
      set: evalCase.set,
      holdout: evalCase.holdout,
      passed: trials.every((trial) => trial.passed),
      trials,
    });
  }
  return results;
}

export interface SetSummary {
  set: EvalSet;
  cases: number;
  passed: number;
  rate: number;
  gate: number;
  meetsGate: boolean;
}

/** Pass rate per set against its gate (playbook §2), only for the sets that were run. */
export function summarize(results: readonly CaseResult[]): {
  sets: SetSummary[];
  usage: LlmUsage;
  meetsGates: boolean;
} {
  const sets: SetSummary[] = [];
  for (const set of Object.keys(EVAL_SET_GATES) as EvalSet[]) {
    const inSet = results.filter((result) => result.set === set);
    if (inSet.length === 0) continue;
    const passed = inSet.filter((result) => result.passed).length;
    const rate = passed / inSet.length;
    const gate = EVAL_SET_GATES[set];
    sets.push({ set, cases: inSet.length, passed, rate, gate, meetsGate: rate >= gate });
  }
  const usage = results
    .flatMap((result) => result.trials)
    .reduce((total, trial) => addUsage(total, trial.usage), emptyUsage());
  return { sets, usage, meetsGates: sets.length > 0 && sets.every((set) => set.meetsGate) };
}
