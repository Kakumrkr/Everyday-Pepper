import type { LlmUsage } from '@pepper/contracts';
import { isLlmError } from '../errors.js';
import type { LlmProvider } from '../provider.js';
import { EVAL_SET_GATES, EVAL_SET_PASS3_GATES, type EvalCase, type EvalSet } from './case.js';
import { CassetteError } from './cassette.js';
import { grade } from './grade.js';
import { BudgetStopError } from './ledger.js';
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
  /** How many cases run at once (default 1). */
  concurrency?: number;
}

function describeFailure(error: unknown): string {
  if (error instanceof BudgetStopError) return `budget stop: ${error.message}`;
  if (error instanceof CassetteError) return `cassette ${error.kind}: ${error.message}`;
  if (isLlmError(error)) return `provider failed: ${error.code}`;
  return `subject failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Runs every case `trials` times and grades each run with code. Up to `concurrency` cases run at
 * once (each in its own seeded world, with its own cassette); a case's trials run in order, and
 * the results come back in the cases' order. A budget stop ends the whole run there: no case
 * starts after it, the cases already running finish, and the stopped trial failed with the
 * reason.
 */
export async function runEvals(options: RunOptions): Promise<CaseResult[]> {
  const results: (CaseResult | undefined)[] = [];
  let stopped = false;

  const runCase = async (evalCase: EvalCase): Promise<CaseResult> => {
    const trials: TrialResult[] = [];
    for (let trial = 0; trial < options.trials && !stopped; trial += 1) {
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
        if (error instanceof BudgetStopError) stopped = true;
        trials.push({
          passed: false,
          reasons: [describeFailure(error)],
          usage: emptyUsage(),
          models: [],
        });
      }
    }
    return {
      id: evalCase.id,
      set: evalCase.set,
      holdout: evalCase.holdout,
      passed: trials.length > 0 && trials.every((trial) => trial.passed),
      trials,
    };
  };

  // One iterator shared by the workers: each case is taken once.
  const queue = options.cases.entries();
  const worker = async () => {
    for (const [index, evalCase] of queue) {
      if (stopped) return;
      results[index] = await runCase(evalCase);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 1, options.cases.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results.filter((result): result is CaseResult => result !== undefined);
}

export interface SetSummary {
  set: EvalSet;
  cases: number;
  passed: number;
  rate: number;
  gate: number;
  meetsGate: boolean;
}

/**
 * Pass rate per set against its gate (playbook §2; at pass^3 its pass^3 gate), only for the sets
 * that were run.
 */
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
    // A set whose every case ran at least three times is judged at pass^3.
    const pass3 = inSet.every((result) => result.trials.length >= 3);
    const gate = (pass3 ? EVAL_SET_PASS3_GATES[set] : undefined) ?? EVAL_SET_GATES[set];
    sets.push({ set, cases: inSet.length, passed, rate, gate, meetsGate: rate >= gate });
  }
  const usage = results
    .flatMap((result) => result.trials)
    .reduce((total, trial) => addUsage(total, trial.usage), emptyUsage());
  return { sets, usage, meetsGates: sets.length > 0 && sets.every((set) => set.meetsGate) };
}
