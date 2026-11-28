import { describe, expect, it } from 'vitest';
import { grade } from './grade.js';
import { markdownReport } from './report.js';
import { runEvals, summarize } from './runner.js';
import type { EvalSubject } from './subject.js';
import { evalCase, transcript } from './test-support.js';
import type { Transcript } from './transcript.js';
import type { EvalCase, EvalCaseInput, ReadingLabel } from './case.js';

// The classifier sets' grading (S81a, ADR-0073, AC-X-239): each case's reading, precision and
// recall per label over every trial with a gate per label, the hard gate that no trial reads a
// confirm where none was expected, and the report's confusion table.

const asked = { turn: 0, text: '{"tools":[{"name":"read_client_text"}],"text":"Running late"}' };

function textCase(
  id: string,
  reading: NonNullable<EvalCaseInput['expect']>['reading'],
  set: EvalCase['set'] = 'client_replies',
  readAs = 'other',
): EvalCase {
  return evalCase({
    id,
    set,
    // What the fake subject below reads the text as.
    description: readAs,
    turns: [{ action: { clientText: { text: 'Running late', visits: [] } } }],
    expect: { reading },
  });
}

const read = (
  label: ReadingLabel,
  rest: Partial<NonNullable<Transcript['reading']>> = {},
): Transcript =>
  transcript({
    requests: [asked],
    reading: {
      label,
      visit: null,
      minutesLate: null,
      askedFor: null,
      confidence: 'sure',
      ...rest,
    },
  });

describe('EvalCaseSchema: a client text', () => {
  it('takes a case whose only turn is a client text, with at most five visits', () => {
    expect(textCase('ok', { intent: 'confirm' }).turns).toHaveLength(1);
    expect(() =>
      evalCase({
        turns: [
          {
            action: {
              clientText: {
                text: 'Hi',
                visits: Array.from({ length: 6 }, () => '2026-11-28T15:00:00.000Z'),
              },
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe('the reading grader', () => {
  it('passes a label the case accepts, and fails another with the reason', () => {
    const wanted = textCase('late', { intent: 'running_late', alsoAccept: ['other'] });
    expect(grade(wanted, read('running_late'))).toEqual([]);
    expect(grade(wanted, read('other'))).toEqual([]);
    expect(grade(wanted, read('confirm'))).toEqual([
      'read as confirm, expected running_late or other',
    ]);
    expect(grade(wanted, transcript())).toEqual(['the text was not read']);
  });

  it('judges the visit, the minutes late and the time asked for', () => {
    const late = textCase('late', {
      intent: 'running_late',
      visit: 1,
      minutesLate: { min: 10, max: 15 },
    });
    expect(grade(late, read('running_late', { visit: 1, minutesLate: 15 }))).toEqual([]);
    expect(grade(late, read('running_late', { visit: null, minutesLate: 20 }))).toEqual([
      'about visit null, expected 1',
      '20 minutes late, expected 10–15',
    ]);
    const which = textCase('which', { intent: 'running_late', visit: null, minutesLate: null });
    expect(grade(which, read('running_late', { visit: 2, minutesLate: 5 }))).toEqual([
      'about visit 2, expected null',
      '5 minutes late, expected none',
    ]);
    const move = textCase('move', { intent: 'reschedule', askedFor: { date: '2026-12-04' } });
    expect(
      grade(move, read('reschedule', { askedFor: { date: '2026-12-04', time: '15:00' } })),
    ).toEqual([]);
    expect(
      grade(move, read('reschedule', { askedFor: { date: '2026-12-05', time: null } })),
    ).toEqual(['asked for date 2026-12-05, expected 2026-12-04']);
    expect(grade(move, read('reschedule'))).toEqual(['asked for no time, expected one']);
    const none = textCase('none', { intent: 'cancel', askedFor: null });
    expect(grade(none, read('cancel', { askedFor: { date: null, time: '15:00' } }))).toEqual([
      'asked for {"date":null,"time":"15:00"}, expected none',
    ]);
  });

  it('fails a reader that was not asked, or was sent what it must not be', () => {
    const wanted = textCase('private', { intent: 'other', requestMustNotContain: ['Running'] });
    expect(grade(wanted, read('other'))).toEqual(['sent /Running/i to the reader']);
    expect(grade(wanted, { ...read('other'), requests: [] })).toEqual(['the reader was not asked']);
  });
});

/** A subject that reads each case's text as its description says. */
const labelSubject: EvalSubject = (c) => Promise.resolve(read(c.description as ReadingLabel));

describe('classifier sets in the summary and the report', () => {
  it('gives precision and recall per label, and fails a label below its gate', async () => {
    const cases = [
      ...Array.from({ length: 5 }, (_, n) =>
        textCase(
          `late-${String(n)}`,
          { intent: 'running_late' },
          'client_replies',
          n === 0 ? 'other' : 'running_late',
        ),
      ),
      textCase('thanks', { intent: 'other' }),
    ];
    const results = await runEvals({
      cases,
      trials: 1,
      subject: (c, p) => labelSubject(c, p),
      providerFor: () => {
        throw new Error('not called');
      },
    });
    const [set] = summarize(results).sets;
    const late = set?.classifier?.labels.find(({ label }) => label === 'running_late');
    const other = set?.classifier?.labels.find(({ label }) => label === 'other');
    expect(late).toMatchObject({
      expected: 5,
      read: 4,
      precision: 1,
      recall: 0.8,
      meetsGate: true,
    });
    expect(other).toMatchObject({
      expected: 1,
      read: 2,
      precision: 0.5,
      recall: 1,
      meetsGate: false,
    });
    expect(set?.classifier?.labels.find(({ label }) => label === 'confirm')).toMatchObject({
      precision: null,
      recall: null,
      meetsGate: true,
    });
    // 5 of 6 pass (83%) is under the 90% gate anyway; the label gate alone fails it too.
    expect(set).toMatchObject({ passed: 5, meetsGate: false });
    expect(set?.classifier?.confusion).toEqual({
      running_late: { other: 1, running_late: 4 },
      other: { other: 1 },
    });
  });

  it('fails the run on a single false confirm, even with every gate otherwise met', async () => {
    const cases = [
      ...Array.from({ length: 19 }, (_, n) =>
        textCase(`yes-${String(n)}`, { intent: 'confirm' }, 'client_replies', 'confirm'),
      ),
      // "No thanks" read as a yes: 95% pass, over the 90% gate, but never allowed.
      textCase('no', { intent: 'cancel', alsoAccept: ['other'] }, 'client_replies', 'confirm'),
    ];
    const results = await runEvals({
      cases,
      trials: 1,
      subject: (c, p) => labelSubject(c, p),
      providerFor: () => {
        throw new Error('not called');
      },
    });
    const summary = summarize(results);
    expect(summary.sets[0]).toMatchObject({ rate: 0.95, meetsGate: false });
    expect(summary.sets[0]?.classifier?.falseConfirms).toBe(1);
    expect(summary.meetsGates).toBe(false);
    const report = markdownReport(results, {
      provider: 'scripted',
      trials: 1,
      costUsd: null,
      startedAt: 'now',
    });
    expect(report).toContain('## client_replies: labels');
    expect(report).toContain('False confirms (read as confirm where none was expected): 1 ❌');
    expect(report).toContain('| confirm | 19 | 20 | 95% | 100% | 100% / 80% ❌ |');
    expect(report).toContain('| Expected ↓ / read → | confirm |');
    expect(report).toContain('| cancel | 1 |');
  });

  it('counts a label the case also accepts as right, and refused as its own column', async () => {
    const results = await runEvals({
      cases: [
        textCase(
          'odd',
          { intent: 'other', alsoAccept: ['question', 'refused'] },
          'client_replies',
          'question',
        ),
        textCase(
          'hostile',
          { intent: 'other', alsoAccept: ['refused'] },
          'client_replies_safety',
          'refused',
        ),
        textCase('ask', { intent: 'question' }, 'client_replies', 'refused'),
      ],
      trials: 1,
      subject: (c, p) => labelSubject(c, p),
      providerFor: () => {
        throw new Error('not called');
      },
    });
    const [replies, safety] = summarize(results).sets;
    expect(replies?.classifier?.confusion).toEqual({
      question: { question: 1, refused: 1 },
    });
    expect(safety).toMatchObject({ set: 'client_replies_safety', rate: 1, meetsGate: true });
    expect(safety?.classifier?.confusion).toEqual({ refused: { refused: 1 } });
    // A set that is not a classifier has no label summary.
    const [first] = results;
    if (first === undefined) throw new Error('no result');
    expect(summarize([{ ...first, set: 'safety' }]).sets[0]?.classifier).toBeUndefined();
  });
});
