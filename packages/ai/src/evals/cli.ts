// `pnpm --filter @pepper/ai eval [--provider scripted|openai] [--record] [--set <set>]...
//   [--case <id>]... [--chunk <n>] [--chunk-size <n>] [--trials <k>] [--max-cost <usd>] [--routine <model>]
//   [--strong <model>] [--routine-effort <e>] [--strong-effort <e>] [--label <text>]
//   [--cassettes <dir>] [--phase <n>] [--concurrency <n>] [--retrieval]` (ADR-0027, ADR-0030, S27;
//   `--phase`, S29; `--concurrency`, S31: cases at once, default 4; `--retrieval`, S31: the
//   episode_retrieval set's recall@5 instead of the cases; `--phase-estimate-ok`, S31: the
//   phase's worst-case estimate may pass its cap, and from S38b the $4.50 stop, their actual
//   spend still may not). Replays cassettes by
// default, at no cost: every case (the files and those generated from the tool guides) runs
// through the real agent loop and tools in a seeded world on Postgres: `EVAL_DATABASE_URL` (a
// migrated database, the services' login), or a throwaway one in Docker. Only `--provider
// openai --record` calls the real API, under the budget policy (playbook §4): OPENAI_API_KEY
// from the environment, a price for both models, at most 20 cases a run (`--chunk`), an
// estimate under the run's cap and under the ledger's $4.50 stop, a stop during the run when
// either is reached, and an entry in the ledger whatever happens. A recording replays the
// answers an earlier one already has for unchanged requests, so nothing is paid for twice.
// `--cassettes` keeps each candidate model's answers in its own directory (default: the
// provider's), since a request does not name the model that answered it. Embeddings (S31): the
// hash embedder with scripted cassettes; with openai the recorded ones (`evals/embeddings/`),
// a recording embedding what they lack with the real model under the same guards.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase, prepareDatabase, type DatabaseHandle } from '@pepper/db';
import { loadOpenAiConfig, type OpenAiConfig } from '../openai/config.js';
import { hashEmbedder, type Embedder } from '../embedder.js';
import { OpenAiEmbedder } from '../openai/openai-embedder.js';
import { OpenAiProvider } from '../openai/openai-provider.js';
import type { LlmProvider } from '../provider.js';
import { EvalSetSchema } from './case.js';
import {
  CassetteProvider,
  replayOrRecordProvider,
  type Cassette,
  type CassetteStep,
} from './cassette.js';
import {
  DEFAULT_RUN_CAP_USD,
  MAX_CASES_PER_RUN,
  estimateRunCost,
  refuseRun,
  selectCases,
} from './cost.js';
import {
  loadCases,
  loadCassette,
  loadLedger,
  loadPrices,
  saveCassette,
  saveLedger,
} from './files.js';
import {
  loadEmbeddingStore,
  saveEmbeddingStore,
  storeEmbedder,
  type EmbeddingStore,
} from './embeddings.js';
import {
  guardedEmbedder,
  guardedProvider,
  refuseCumulative,
  PHASE_CAPS_USD,
  phaseLabel,
  phaseSpentUsd,
  refusePhase,
  spentUsd,
  SpendTracker,
  type LedgerEntry,
} from './ledger.js';
import { markdownReport } from './report.js';
import { loadRetrievalSet, retrievalTexts, runRetrieval } from './retrieval.js';
import { runEvals, summarize, type CaseResult } from './runner.js';
import { loopSubject } from './subject.js';
import { toolEvalCases } from '../tools/eval-cases.js';

const print = (text: string) => process.stdout.write(`${text}\n`);

/** The embedding model the evals record with (playbook D-5). */
const EVAL_EMBEDDING_MODEL = 'text-embedding-3-small';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'scripted' },
      record: { type: 'boolean', default: false },
      set: { type: 'string', multiple: true },
      case: { type: 'string', multiple: true },
      chunk: { type: 'string' },
      'chunk-size': { type: 'string' },
      trials: { type: 'string', default: '1' },
      'max-cost': { type: 'string', default: String(DEFAULT_RUN_CAP_USD) },
      routine: { type: 'string' },
      strong: { type: 'string' },
      'routine-effort': { type: 'string' },
      'strong-effort': { type: 'string' },
      label: { type: 'string' },
      cassettes: { type: 'string' },
      phase: { type: 'string' },
      concurrency: { type: 'string', default: '4' },
      retrieval: { type: 'boolean', default: false },
      'phase-estimate-ok': { type: 'boolean', default: false },
    },
  });
  const here = new URL('../../evals/', import.meta.url);
  const paths = {
    root: fileURLToPath(here),
    budgetDoc: fileURLToPath(new URL('../../../docs/plan/ai-budget.md', here)),
  };
  const provider = values.provider;
  if (provider !== 'scripted' && provider !== 'openai') {
    print('--provider is scripted or openai');
    return 2;
  }
  if (values.record && provider !== 'openai') {
    print('--record is only for --provider openai');
    return 2;
  }
  // From Phase 7 every real run names its phase, which has its own cap (playbook §4).
  const phase = values.phase === undefined ? null : Number(values.phase);
  if (values.record && (phase === null || !Number.isInteger(phase) || phase < 7)) {
    print('--record needs --phase <n> (7 or later): each phase has its own OpenAI cap');
    return 2;
  }
  const cassettes = values.cassettes ?? provider;
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(cassettes)) {
    print('--cassettes is a directory name: lower-case letters, digits, dots and dashes');
    return 2;
  }
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
    print('--trials is 1 to 10');
    return 2;
  }
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    print('--concurrency is 1 to 8');
    return 2;
  }
  const embeddings: EmbeddingStore | null =
    provider === 'openai' ? await loadEmbeddingStore(paths, EVAL_EMBEDDING_MODEL) : null;
  if (values.retrieval) return retrieval(paths, embeddings, values.record ? phase : null);
  const sets = (values.set ?? []).map((set) => EvalSetSchema.parse(set));
  const cases = selectCases([...(await loadCases(paths)), ...toolEvalCases()], {
    sets,
    ids: values.case ?? [],
    chunk: values.chunk === undefined ? null : Number(values.chunk),
    ...(values['chunk-size'] !== undefined && { chunkSize: Number(values['chunk-size']) }),
  });
  if (cases.length === 0) {
    print('No cases selected.');
    return 2;
  }

  const earlier = new Map<string, Cassette | null>(
    await Promise.all(
      cases.map(
        async (evalCase) =>
          [evalCase.id, await loadCassette(paths, cassettes, evalCase.id)] as const,
      ),
    ),
  );
  let providerFor: (
    caseId: string,
    trial: number,
    placeholders: ReadonlyMap<string, string>,
  ) => LlmProvider;
  const recorded = new Map<string, CassetteStep[][]>();
  let embedder: Embedder = embeddings === null ? hashEmbedder() : storeEmbedder(embeddings);
  let recording: {
    tracker: SpendTracker;
    ledgerEntry: Omit<LedgerEntry, 'status' | 'actualUsd' | 'byModel' | 'charsPerToken'>;
  } | null = null;

  if (values.record) {
    if (cases.length > MAX_CASES_PER_RUN) {
      print(
        `Refused: ${String(cases.length)} cases; a real run takes at most ${String(MAX_CASES_PER_RUN)} (use --chunk 1, 2…).`,
      );
      return 2;
    }
    const config = recordingConfig({
      OPENAI_MODEL_ROUTINE: values.routine,
      OPENAI_MODEL_STRONG: values.strong,
      OPENAI_REASONING_ROUTINE: values['routine-effort'],
      OPENAI_REASONING_STRONG: values['strong-effort'],
    });
    if (typeof config === 'string') {
      print(config);
      return 2;
    }
    const prices = await loadPrices(paths);
    const ledger = await loadLedger(paths);
    const capUsd = Number(values['max-cost']);
    // Every route must be priced; the estimate assumes every call is on the dearer one.
    let estimate = 0;
    for (const model of new Set([config.models.routine, config.models.strong])) {
      const price = prices.models[model];
      const usd = price === undefined ? 0 : estimateRunCost(cases, trials, price).usd;
      const refusal = refuseRun({ model, prices, estimateUsd: usd, capUsd });
      if (refusal !== null) {
        print(`Refused: ${refusal}`);
        return 2;
      }
      estimate = Math.max(estimate, usd);
    }
    const spent = spentUsd(ledger);
    const overall = refuseCumulative({
      spentUsd: spent,
      estimateUsd: estimate,
      estimateOk: values['phase-estimate-ok'],
    });
    if (overall !== null) {
      print(`Refused: ${overall}`);
      return 2;
    }
    // Checked above: recording always has a phase.
    const runPhase = phase ?? 0;
    const phaseSpent = phaseSpentUsd(ledger, runPhase);
    const phaseRefusal = refusePhase({
      phase: runPhase,
      spentUsd: phaseSpent,
      estimateUsd: estimate,
      estimateOk: values['phase-estimate-ok'],
    });
    if (phaseRefusal !== null) {
      print(`Refused: ${phaseRefusal}`);
      return 2;
    }
    const effort = (route: 'routine' | 'strong') => config.reasoning?.[route] ?? 'default';
    print(
      `Estimated at most $${estimate.toFixed(2)} for ${String(cases.length)} cases × ${String(trials)} on ${config.models.routine} (${effort('routine')}) / ${config.models.strong} (${effort('strong')}); spent so far $${spent.toFixed(4)}.`,
    );
    const tracker = new SpendTracker({
      prices,
      spentBeforeUsd: spent,
      capUsd,
      phase: { spentBeforeUsd: phaseSpent, capUsd: PHASE_CAPS_USD[runPhase] ?? 0 },
    });
    recording = {
      tracker,
      ledgerEntry: {
        id: ledger.entries.length + 1,
        at: new Date().toISOString(),
        label: phaseLabel(
          runPhase,
          values.label ?? `${sets.join('+') || 'all'} pass^${String(trials)}`,
        ),
        cases: cases.length,
        trials,
        estimateUsd: estimate,
      },
    };
    const real = guardedProvider(new OpenAiProvider(config), tracker);
    embedder = storeEmbedder(
      embeddings ?? { version: 1, model: EVAL_EMBEDDING_MODEL, vectors: {} },
      guardedEmbedder(
        new OpenAiEmbedder({
          apiKey: config.apiKey,
          model: EVAL_EMBEDDING_MODEL,
          timeoutMs: config.timeoutMs,
        }),
        tracker,
      ),
    );
    providerFor = (caseId, trial, placeholders) => {
      const runs = recorded.get(caseId) ?? [];
      recorded.set(caseId, runs);
      const steps: CassetteStep[] = [];
      runs[trial] = steps;
      return replayOrRecordProvider(
        real,
        earlier.get(caseId)?.trials[trial] ?? [],
        steps,
        placeholders,
      );
    };
  } else {
    providerFor = (caseId, trial, placeholders) =>
      new CassetteProvider(earlier.get(caseId)?.trials[trial] ?? [], placeholders);
  }

  const startedAt = new Date().toISOString();
  let results: CaseResult[] = [];
  let failure: unknown = null;
  try {
    const database = await evalDatabase();
    try {
      results = await runEvals({
        cases,
        trials,
        concurrency,
        subject: loopSubject(database.db, { embedder }),
        providerFor: (evalCase, trial, world) =>
          providerFor(evalCase.id, trial, world.placeholders),
      });
    } finally {
      await database.close();
    }
  } catch (error) {
    failure = error;
  }
  if (recording !== null) {
    // Whatever happened, what was paid for is kept: the answers, embeddings, the ledger entry.
    if (embeddings !== null) await saveEmbeddingStore(paths, embeddings);
    for (const [caseId, runs] of recorded) {
      const kept = [...(earlier.get(caseId)?.trials ?? [])];
      runs.forEach((steps, trial) => {
        kept[trial] = steps;
      });
      if (kept.length > 0)
        await saveCassette(paths, cassettes, caseId, { version: 1, trials: kept });
    }
    const { tracker, ledgerEntry } = recording;
    const ledger = await loadLedger(paths);
    await saveLedger(paths, {
      ...ledger,
      entries: [
        ...ledger.entries,
        {
          ...ledgerEntry,
          status:
            failure !== null ? 'failed' : tracker.stopReason() !== null ? 'stopped' : 'completed',
          actualUsd: tracker.runUsd,
          byModel: tracker.byModel(),
          charsPerToken: tracker.charsPerToken(),
        },
      ],
    });
    print(
      `Spent $${tracker.runUsd.toFixed(4)} on this run (ledger entry ${String(ledgerEntry.id)}).`,
    );
  }
  if (failure !== null) {
    throw failure instanceof Error ? failure : new Error('The eval run failed', { cause: failure });
  }

  const summary = summarize(results);
  const report = markdownReport(results, {
    provider: values.record ? `${cassettes} (recording)` : `${cassettes} cassettes`,
    trials,
    costUsd: recording === null ? null : recording.tracker.runUsd,
    startedAt,
  });
  const out = join(paths.root, 'reports');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'latest.md'), report);
  await writeFile(
    join(out, 'latest.json'),
    `${JSON.stringify(
      {
        startedAt,
        costUsd: recording?.tracker.runUsd ?? null,
        byModel: recording?.tracker.byModel() ?? null,
        summary,
        results,
      },
      null,
      2,
    )}\n`,
  );
  print(report);
  return summary.meetsGates ? 0 : 1;
}

/**
 * The episode_retrieval set (S31): recall@5 on the recorded embeddings (openai), or on the
 * hash embedder (scripted: a smoke run, not the gate). A recording embeds what the store lacks
 * (the set's texts only, a few thousand tokens), under the phase's cap, with a ledger entry.
 */
async function retrieval(
  paths: { root: string; budgetDoc: string },
  store: EmbeddingStore | null,
  /** The phase a recording is for (`null`: replay only). */
  phase: number | null,
): Promise<number> {
  const set = await loadRetrievalSet(paths);
  let embedder: Embedder = store === null ? hashEmbedder() : storeEmbedder(store);
  let tracker: SpendTracker | null = null;
  const ledger = await loadLedger(paths);
  if (phase !== null && store !== null) {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey === '') {
      print('Recording needs OPENAI_API_KEY in the environment.');
      return 2;
    }
    const prices = await loadPrices(paths);
    const phaseSpent = phaseSpentUsd(ledger, phase);
    tracker = new SpendTracker({
      prices,
      spentBeforeUsd: spentUsd(ledger),
      capUsd: 0.01,
      phase: { spentBeforeUsd: phaseSpent, capUsd: PHASE_CAPS_USD[phase] ?? 0 },
    });
    const reason = tracker.stopReason();
    if (reason !== null) {
      print(`Refused: ${reason}`);
      return 2;
    }
    embedder = storeEmbedder(
      store,
      guardedEmbedder(
        new OpenAiEmbedder({ apiKey, model: EVAL_EMBEDDING_MODEL, timeoutMs: 30_000 }),
        tracker,
      ),
    );
    // Embedded together, in as few calls as the batch limit allows.
    const texts = retrievalTexts(set);
    for (let from = 0; from < texts.length; from += 64) {
      await embedder.embed({ input: texts.slice(from, from + 64) });
    }
  }
  const database = await evalDatabase();
  let result: Awaited<ReturnType<typeof runRetrieval>>;
  try {
    result = await runRetrieval(database.db, embedder, set);
  } finally {
    await database.close();
  }
  if (tracker !== null && store !== null) {
    await saveEmbeddingStore(paths, store);
    await saveLedger(paths, {
      ...ledger,
      entries: [
        ...ledger.entries,
        {
          id: ledger.entries.length + 1,
          at: new Date().toISOString(),
          label: phaseLabel(phase ?? 7, 'episode_retrieval embeddings'),
          cases: set.queries.length,
          trials: 1,
          estimateUsd: 0.01,
          status: 'completed',
          actualUsd: tracker.runUsd,
          byModel: tracker.byModel(),
          charsPerToken: tracker.charsPerToken(),
        },
      ],
    });
    print(`Spent $${tracker.runUsd.toFixed(6)} on embeddings.`);
  }
  print(
    `episode_retrieval recall@5: ${String(result.found)}/${String(result.queries)} (${(result.recall * 100).toFixed(1)}%), gate 95%: ${result.meetsGate ? 'met' : 'missed'}`,
  );
  for (const miss of result.misses) {
    print(`- missed "${miss.query}" (${miss.expected}): got ${miss.got.join(', ')}`);
  }
  return result.meetsGate ? 0 : 1;
}

/** The key from the environment only; the models and efforts from the flags or the environment. */
function recordingConfig(flags: Record<string, string | undefined>): OpenAiConfig | string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(flags)) if (value !== undefined) env[name] = value;
  const config = loadOpenAiConfig(env);
  return (
    config ??
    'Recording needs OPENAI_API_KEY in the environment and the models (--routine and --strong, or OPENAI_MODEL_ROUTINE and OPENAI_MODEL_STRONG).'
  );
}

/** `EVAL_DATABASE_URL`, or a throwaway migrated Postgres in Docker (dev tool only). */
async function evalDatabase(): Promise<{ db: DatabaseHandle['db']; close(): Promise<void> }> {
  const url = process.env['EVAL_DATABASE_URL'];
  if (url !== undefined && url !== '') {
    const handle = createDatabase({ url, maxConnections: 12 });
    return { db: handle.db, close: () => handle.close() };
  }
  const { postgresUrlAs, startPostgres } = await import('@pepper/testing');
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'eval-runner-password');
  await prepareDatabase(postgres.url, appUrl);
  const handle = createDatabase({ url: appUrl, maxConnections: 12 });
  return {
    db: handle.db,
    close: async () => {
      await handle.close();
      await postgres.stop();
    },
  };
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    print(`Eval run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);
