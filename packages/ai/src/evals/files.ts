import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EvalCaseSchema, type EvalCase } from './case.js';
import { CassetteSchema, type Cassette } from './cassette.js';
import { PriceTableSchema, type PriceTable } from './cost.js';
import { budgetMarkdown, emptyLedger, LedgerSchema, type Ledger } from './ledger.js';

/** The eval files of the package: `evals/cases`, `evals/cassettes/<provider>`, prices. */
export interface EvalPaths {
  root: string;
  /** `docs/plan/ai-budget.md`, whose ledger section is rewritten after every real run. */
  budgetDoc?: string;
}

/** Reads every `*.json` case under `evals/cases` (sorted, ids unique). */
export async function loadCases(paths: EvalPaths): Promise<EvalCase[]> {
  const dir = join(paths.root, 'cases');
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  const cases: EvalCase[] = [];
  for (const file of files) {
    const raw: unknown = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const list = Array.isArray(raw) ? raw : [raw];
    for (const item of list) {
      const parsed = EvalCaseSchema.safeParse(item);
      if (!parsed.success) throw new Error(`${file}: ${parsed.error.message}`);
      cases.push(parsed.data);
    }
  }
  const ids = new Set<string>();
  for (const evalCase of cases) {
    if (ids.has(evalCase.id)) throw new Error(`Duplicate eval case id ${evalCase.id}`);
    ids.add(evalCase.id);
  }
  return cases;
}

const cassettePath = (paths: EvalPaths, provider: string, caseId: string) =>
  join(paths.root, 'cassettes', provider, `${caseId}.json`);

/** A case's cassette for `provider`, or `null` when none was written. */
export async function loadCassette(
  paths: EvalPaths,
  provider: string,
  caseId: string,
): Promise<Cassette | null> {
  let text: string;
  try {
    text = await readFile(cassettePath(paths, provider, caseId), 'utf8');
  } catch {
    return null;
  }
  return CassetteSchema.parse(JSON.parse(text));
}

export async function saveCassette(
  paths: EvalPaths,
  provider: string,
  caseId: string,
  cassette: Cassette,
): Promise<void> {
  await mkdir(join(paths.root, 'cassettes', provider), { recursive: true });
  await writeFile(
    cassettePath(paths, provider, caseId),
    `${JSON.stringify(CassetteSchema.parse(cassette), null, 2)}\n`,
  );
}

export async function loadPrices(paths: EvalPaths): Promise<PriceTable> {
  return PriceTableSchema.parse(
    JSON.parse(await readFile(join(paths.root, 'prices.json'), 'utf8')),
  );
}

/** The budget ledger (`evals/ledger.json`); none yet means nothing was spent. */
export async function loadLedger(paths: EvalPaths): Promise<Ledger> {
  let text: string;
  try {
    text = await readFile(join(paths.root, 'ledger.json'), 'utf8');
  } catch {
    return emptyLedger();
  }
  return LedgerSchema.parse(JSON.parse(text));
}

const LEDGER_START = '<!-- ledger:start (written by the eval runner) -->';
const LEDGER_END = '<!-- ledger:end -->';

/**
 * Writes the ledger and, when the paths name it, the ledger section of the budget doc (the
 * text between its markers; the rest of the doc is left alone).
 */
export async function saveLedger(paths: EvalPaths, ledger: Ledger): Promise<void> {
  await writeFile(
    join(paths.root, 'ledger.json'),
    `${JSON.stringify(LedgerSchema.parse(ledger), null, 2)}\n`,
  );
  if (paths.budgetDoc === undefined) return;
  const doc = await readFile(paths.budgetDoc, 'utf8');
  const start = doc.indexOf(LEDGER_START);
  const end = doc.indexOf(LEDGER_END);
  if (start === -1 || end < start) throw new Error(`${paths.budgetDoc} has no ledger markers`);
  await writeFile(
    paths.budgetDoc,
    `${doc.slice(0, start + LEDGER_START.length)}\n${budgetMarkdown(ledger)}\n${doc.slice(end)}`,
  );
}
