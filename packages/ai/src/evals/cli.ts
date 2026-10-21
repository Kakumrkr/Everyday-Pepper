// `pnpm --filter @pepper/ai eval [--provider scripted|openai] [--record] [--set <set>]...
//   [--trials <k>] [--max-cost <usd>]` (ADR-0027, ADR-0030). Replays cassettes by default, at no
// cost: every case (the files and those generated from the tool guides) runs through the real
// agent loop and tools in a seeded world on Postgres: `EVAL_DATABASE_URL` (a migrated database,
// the services' login), or a throwaway one in Docker. Only `--provider openai --record` calls the
// real API: it needs OPENAI_API_KEY and a price for the model, estimates the run first and
// refuses above the cap (the $5 budget, playbook §4).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase, prepareDatabase, type DatabaseHandle } from '@pepper/db';
import { loadOpenAiConfig } from '../openai/config.js';
import { OpenAiProvider } from '../openai/openai-provider.js';
import type { LlmProvider } from '../provider.js';
import { EvalSetSchema } from './case.js';
import { CassetteProvider, recordingProvider, type CassetteStep } from './cassette.js';
import { DEFAULT_RUN_CAP_USD, costOfUsage, estimateRunCost, refuseRun } from './cost.js';
import { loadCases, loadCassette, loadPrices, saveCassette } from './files.js';
import { markdownReport } from './report.js';
import { runEvals, summarize } from './runner.js';
import { loopSubject } from './subject.js';
import { toolEvalCases } from '../tools/eval-cases.js';

const print = (text: string) => process.stdout.write(`${text}\n`);

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'scripted' },
      record: { type: 'boolean', default: false },
      set: { type: 'string', multiple: true },
      trials: { type: 'string', default: '1' },
      'max-cost': { type: 'string', default: String(DEFAULT_RUN_CAP_USD) },
    },
  });
  const paths = { root: fileURLToPath(new URL('../../evals/', import.meta.url)) };
  const provider = values.provider;
  if (provider !== 'scripted' && provider !== 'openai') {
    print('--provider is scripted or openai');
    return 2;
  }
  if (values.record && provider !== 'openai') {
    print('--record is only for --provider openai');
    return 2;
  }
  const trials = Number(values.trials);
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) {
    print('--trials is 1 to 10');
    return 2;
  }
  const sets = (values.set ?? []).map((set) => EvalSetSchema.parse(set));
  const cases = [...(await loadCases(paths)), ...toolEvalCases()].filter(
    (evalCase) => sets.length === 0 || sets.includes(evalCase.set),
  );
  const prices = await loadPrices(paths);

  let providerFor: (
    caseId: string,
    trial: number,
    placeholders: ReadonlyMap<string, string>,
  ) => LlmProvider;
  const recorded = new Map<string, CassetteStep[][]>();
  let pricedModel: string | null = null;

  if (values.record) {
    const config = loadOpenAiConfig(process.env);
    if (config === null) {
      print('Recording needs OPENAI_API_KEY, OPENAI_MODEL_ROUTINE and OPENAI_MODEL_STRONG.');
      return 2;
    }
    pricedModel = config.models.routine;
    const price = prices.models[pricedModel];
    const estimate = price === undefined ? 0 : estimateRunCost(cases, trials, price).usd;
    const refusal = refuseRun({
      model: pricedModel,
      prices,
      estimateUsd: estimate,
      capUsd: Number(values['max-cost']),
    });
    if (refusal !== null) {
      print(`Refused: ${refusal}`);
      return 2;
    }
    print(
      `Estimated at most $${estimate.toFixed(2)} for ${String(cases.length)} cases × ${String(trials)}.`,
    );
    const real = new OpenAiProvider(config);
    providerFor = (caseId, trial, placeholders) => {
      const runs = recorded.get(caseId) ?? [];
      recorded.set(caseId, runs);
      const steps: CassetteStep[] = [];
      runs[trial] = steps;
      return recordingProvider(real, steps, placeholders);
    };
  } else {
    const cassettes = new Map(
      await Promise.all(
        cases.map(
          async (evalCase) =>
            [evalCase.id, await loadCassette(paths, provider, evalCase.id)] as const,
        ),
      ),
    );
    providerFor = (caseId, trial, placeholders) =>
      new CassetteProvider(cassettes.get(caseId)?.trials[trial] ?? [], placeholders);
  }

  const startedAt = new Date().toISOString();
  const database = await evalDatabase();
  let results;
  try {
    results = await runEvals({
      cases,
      trials,
      subject: loopSubject(database.db),
      providerFor: (evalCase, trial, world) => providerFor(evalCase.id, trial, world.placeholders),
    });
  } finally {
    await database.close();
  }
  for (const [caseId, runs] of recorded) {
    await saveCassette(paths, provider, caseId, { version: 1, trials: runs });
  }

  const summary = summarize(results);
  const price = pricedModel === null ? undefined : prices.models[pricedModel];
  const costUsd = price === undefined ? null : costOfUsage(summary.usage, price);
  const report = markdownReport(results, {
    provider: values.record ? `${provider} (recording)` : `${provider} cassettes`,
    trials,
    costUsd,
    startedAt,
  });
  const out = join(paths.root, 'reports');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'latest.md'), report);
  await writeFile(
    join(out, 'latest.json'),
    `${JSON.stringify({ startedAt, costUsd, summary, results }, null, 2)}\n`,
  );
  print(report);
  return summary.meetsGates ? 0 : 1;
}

/** `EVAL_DATABASE_URL`, or a throwaway migrated Postgres in Docker (dev tool only). */
async function evalDatabase(): Promise<{ db: DatabaseHandle['db']; close(): Promise<void> }> {
  const url = process.env['EVAL_DATABASE_URL'];
  if (url !== undefined && url !== '') {
    const handle = createDatabase({ url, maxConnections: 4 });
    return { db: handle.db, close: () => handle.close() };
  }
  const { postgresUrlAs, startPostgres } = await import('@pepper/testing');
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'eval-runner-password');
  await prepareDatabase(postgres.url, appUrl);
  const handle = createDatabase({ url: appUrl, maxConnections: 4 });
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
