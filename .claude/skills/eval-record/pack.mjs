// Packs eval cases into recording runs by worst-case estimate (S30b, S31), so each run passes
// the runner's guards. Writes one line of case ids per run to <scratch>/runs.txt.
// Run from the repo root after `pnpm --filter @pepper/ai build`:
//   node .claude/skills/eval-record/pack.mjs <scratch> [--set <set>]... [--case <id>]...
//     [--per-run <usd>] [--routine <model>] [--strong <model>]
// With no --set or --case it packs every case (the files and those generated from the guides).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    set: { type: 'string', multiple: true, default: [] },
    case: { type: 'string', multiple: true, default: [] },
    'per-run': { type: 'string', default: '0.56' },
    routine: { type: 'string', default: 'gpt-6-luna' },
    strong: { type: 'string', default: 'gpt-6.1-sol' },
  },
});
const scratch = positionals[0];
if (scratch === undefined) throw new Error('Usage: pack.mjs <scratch dir> [options]');

const ai = resolve('packages/ai');
const load = (path) => import(pathToFileURL(join(ai, 'dist', path)).href);
const { estimateRunCost } = await load('evals/cost.js');
const { loadCases } = await load('evals/files.js');
const { toolEvalCases } = await load('tools/eval-cases.js');

const prices = JSON.parse(readFileSync(join(ai, 'evals/prices.json'), 'utf8')).models;
for (const model of [values.routine, values.strong]) {
  if (prices[model] === undefined) throw new Error(`No price for ${model} in prices.json`);
}
const all = [...(await loadCases({ root: join(ai, 'evals/') })), ...toolEvalCases()];
const picked = all.filter(
  (c) =>
    (values.set.length === 0 && values.case.length === 0) ||
    values.set.includes(c.set) ||
    values.case.includes(c.id),
);
const unknown = values.case.filter((id) => !all.some((c) => c.id === id));
if (unknown.length > 0) throw new Error(`Unknown case ids: ${unknown.join(', ')}`);

const perRun = Number(values['per-run']);
const estimate = (c) =>
  Math.max(...[values.routine, values.strong].map((m) => estimateRunCost([c], 1, prices[m]).usd));
const runs = [];
let current = [];
let sum = 0;
let total = 0;
for (const c of picked) {
  const usd = estimate(c);
  total += usd;
  if (sum + usd > perRun && current.length > 0) {
    runs.push(current);
    current = [];
    sum = 0;
  }
  current.push(c.id);
  sum += usd;
}
if (current.length > 0) runs.push(current);

writeFileSync(join(scratch, 'runs.txt'), runs.map((run) => `${run.join(' ')}\n`).join(''));
console.log(
  `${String(picked.length)} cases in ${String(runs.length)} runs; worst-case estimate $${total.toFixed(2)} (actual is usually about a tenth)`,
);
