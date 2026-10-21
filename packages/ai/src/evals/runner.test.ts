import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import { CassetteProvider } from './cassette.js';
import { loadCases, loadCassette, loadPrices, saveCassette } from './files.js';
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
    expect((await loadPrices(paths)).models).toEqual({});
  });
});
