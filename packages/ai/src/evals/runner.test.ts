import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import { CassetteProvider } from './cassette.js';
import { BudgetStopError } from './ledger.js';
import {
  loadCases,
  loadCassette,
  loadLedger,
  loadPrices,
  saveCassette,
  saveLedger,
} from './files.js';
import { markdownReport } from './report.js';
import { runEvals, summarize } from './runner.js';
import type { EvalSubject } from './subject.js';
import { evalCase, transcript } from './test-support.js';
import type { EvalWorld } from './world.js';

const paths = { root: fileURLToPath(new URL('../../evals/', import.meta.url)) };

/**
 * A subject without a database, for the runner's own tests: one model call per user turn,
 * tools not run (the real subject, `loopSubject`, is proven in evals.int.test.ts).
 */
const oneCallSubject: EvalSubject = async (evalCase, providerFor) => {
  const provider = providerFor({ placeholders: new Map() } as unknown as EvalWorld);
  const result = transcript();
  for (const turn of evalCase.turns) {
    if (!('user' in turn)) continue;
    const response = await provider.respond({
      route: 'routine',
      instructions: 'test',
      messages: [{ role: 'user', content: turn.user }],
      tools: [],
      toolChoice: 'auto',
      maxOutputTokens: 100,
    });
    if (response.text !== '') result.replies.push(response.text);
    for (const call of response.toolCalls) {
      result.toolCalls.push({
        name: call.name,
        arguments: JSON.parse(call.arguments),
        raw: call.arguments,
      });
    }
  }
  return result;
};

describe('runEvals', () => {
  it('runs pass^k and fails the case when any trial fails, recording why', async () => {
    const steps = [
      scriptedResponse({
        toolCalls: [{ id: 'c', name: 'find_clients', arguments: '{"name":"Maria"}' }],
      }),
      new LlmError('timeout', 'slow'),
      scriptedResponse({ text: 'hmm' }),
    ];
    const provider = new ScriptedProvider(steps);
    const flaky = evalCase({ expect: { toolCalls: [{ name: 'find_clients' }] } });
    const [result] = await runEvals({
      cases: [flaky],
      trials: 4,
      subject: oneCallSubject,
      providerFor: () => provider,
    });
    expect(result?.passed).toBe(false);
    expect(result?.trials.map((trial) => trial.reasons)).toEqual([
      [],
      ['provider failed: timeout'],
      ['expected a call to find_clients'],
      [expect.stringMatching(/^subject failed: ScriptedProvider: no step left/)],
    ]);
  });

  it('ends the whole run at a budget stop, keeping what ran (playbook §4)', async () => {
    const results = await runEvals({
      cases: [evalCase({ id: 'first' }), evalCase({ id: 'second' }), evalCase({ id: 'third' })],
      trials: 2,
      subject: oneCallSubject,
      providerFor: (c, trial) =>
        c.id === 'second' && trial === 1
          ? new ScriptedProvider([
              () => Promise.reject(new BudgetStopError('The total reached the $4.50 stop.')),
            ])
          : new ScriptedProvider([scriptedResponse({ text: 'ok' })]),
    });
    expect(results.map((r) => [r.id, r.trials.length, r.passed])).toEqual([
      ['first', 2, true],
      ['second', 2, false],
    ]);
    expect(results[1]?.trials[1]?.reasons).toEqual([
      'budget stop: The total reached the $4.50 stop.',
    ]);
  });

  it('runs cases side by side, keeping their order, and starts none after a budget stop', async () => {
    let running = 0;
    let most = 0;
    const delayed =
      (ms: (n: number) => number): EvalSubject =>
      async (c, providerFor) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, ms(Number(c.id.slice(1)))));
        try {
          return await oneCallSubject(c, providerFor);
        } finally {
          running -= 1;
        }
      };
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const results = await runEvals({
      cases: ids.map((id) => evalCase({ id })),
      trials: 1,
      concurrency: 3,
      // The later cases finish first, so the order of results is the cases', not the finishes'.
      subject: delayed((n) => 40 - n * 5),
      providerFor: () => new ScriptedProvider([scriptedResponse({ text: 'ok' })]),
    });
    expect(results.map((r) => [r.id, r.passed])).toEqual(ids.map((id) => [id, true]));
    expect(most).toBe(3);

    const stopped = await runEvals({
      cases: ids.map((id) => evalCase({ id })),
      trials: 1,
      concurrency: 2,
      subject: delayed((n) => n * 20),
      providerFor: (c) =>
        c.id === 'c1'
          ? new ScriptedProvider([() => Promise.reject(new BudgetStopError('Phase cap reached.'))])
          : new ScriptedProvider([scriptedResponse({ text: 'ok' })]),
    });
    // c1 stops the run; c2 was already running and finishes; nothing else starts.
    expect(stopped.map((r) => [r.id, r.passed])).toEqual([
      ['c1', false],
      ['c2', true],
    ]);
  });

  it('reports cassette misses', async () => {
    const [result] = await runEvals({
      cases: [evalCase()],
      trials: 1,
      subject: oneCallSubject,
      providerFor: () => new CassetteProvider([]),
    });
    expect(result?.trials[0]?.reasons).toEqual(['cassette miss: no recorded answer for call 1']);
  });
});

describe('summarize and markdownReport', () => {
  it('rates each set against its gate and lists failing trials', async () => {
    const results = await runEvals({
      cases: [
        evalCase({ id: 'ok', expect: { replyMatches: ['sure'] } }),
        evalCase({ id: 'bad', set: 'safety', holdout: true, expect: { replyMatches: ['never'] } }),
      ],
      trials: 1,
      subject: oneCallSubject,
      providerFor: () => new ScriptedProvider([scriptedResponse({ text: 'Sure.' })]),
    });
    const summary = summarize(results);
    expect(summary.sets).toEqual([
      { set: 'scheduling', cases: 1, passed: 1, rate: 1, gate: 0.9, meetsGate: true },
      { set: 'safety', cases: 1, passed: 0, rate: 0, gate: 1, meetsGate: false },
    ]);
    expect(summary.meetsGates).toBe(false);
    const report = markdownReport(results, {
      provider: 'scripted',
      trials: 1,
      costUsd: 0.0123,
      startedAt: '2026-10-20T00:00:00Z',
    });
    expect(report).toContain('| safety | 0/1 | 0% | 100% ❌ |');
    expect(report).toContain('cost: $0.0123');
    expect(report).toContain('**bad** (safety, holdout)');
    expect(report).toContain('trial 1: reply does not match /never/i');
    expect(summarize([]).meetsGates).toBe(false);
    expect(
      markdownReport([], { provider: 'x', trials: 1, costUsd: null, startedAt: 'now' }),
    ).toContain('$0 (no real calls)');
  });
});

describe('eval files', () => {
  it('saves and loads cassettes, loads prices, and refuses duplicate or invalid cases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-evals-'));
    try {
      const temp = { root };
      await saveCassette(temp, 'openai', 'case-a', {
        version: 1,
        trials: [[{ response: scriptedResponse({ text: 'x' }) }]],
      });
      expect((await loadCassette(temp, 'openai', 'case-a'))?.trials[0]?.[0]?.response.text).toBe(
        'x',
      );
      expect(await loadCassette(temp, 'openai', 'missing')).toBeNull();
      expect(
        JSON.parse(await readFile(join(root, 'cassettes/openai/case-a.json'), 'utf8')),
      ).toMatchObject({
        version: 1,
      });

      await mkdir(join(root, 'cases'));
      const one = { ...evalCase(), id: 'same' };
      await writeFile(join(root, 'cases', 'a.json'), JSON.stringify(one));
      await writeFile(join(root, 'cases', 'b.json'), JSON.stringify([one]));
      await expect(loadCases(temp)).rejects.toThrow('Duplicate eval case id same');
      await writeFile(join(root, 'cases', 'b.json'), JSON.stringify({ id: 'broken' }));
      await expect(loadCases(temp)).rejects.toThrow('b.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect((await loadPrices(paths)).checkedOn).not.toBeUndefined();
  });

  it("keeps the ledger and rewrites only the budget doc's ledger section", async () => {
    const root = await mkdtemp(join(tmpdir(), 'pepper-ledger-'));
    try {
      const budgetDoc = join(root, 'ai-budget.md');
      const temp = { root, budgetDoc };
      expect((await loadLedger(temp)).entries).toEqual([]);
      await writeFile(
        budgetDoc,
        '# Budget\n\nPolicy text.\n\n<!-- ledger:start (written by the eval runner) -->\nold\n<!-- ledger:end -->\n\nNotes.\n',
      );
      const ledger = {
        version: 1 as const,
        budgetUsd: 5 as const,
        entries: [
          {
            id: 1,
            at: '2026-10-22T10:00:00.000Z',
            label: 'smoke',
            status: 'completed' as const,
            cases: 5,
            trials: 1,
            estimateUsd: 0.3,
            actualUsd: 0.01,
            byModel: {},
            charsPerToken: null,
          },
        ],
      };
      await saveLedger(temp, ledger);
      expect(await loadLedger(temp)).toEqual(ledger);
      const doc = await readFile(budgetDoc, 'utf8');
      expect(doc).toMatch(/^# Budget\n\nPolicy text\./);
      expect(doc).toContain(
        '| 1 | 2026-10-22 | smoke | completed | 5 × 1 | $0.30 | $0.0100 | $0.0100 |',
      );
      expect(doc).not.toContain('\nold\n');
      expect(doc).toMatch(/<!-- ledger:end -->\n\nNotes\.\n$/);
      await writeFile(budgetDoc, 'no markers');
      await expect(saveLedger(temp, ledger)).rejects.toThrow(/no ledger markers/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
