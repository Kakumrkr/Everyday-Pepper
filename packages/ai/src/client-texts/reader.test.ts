import type { BookingId, ClientTextQuestion, TenantId } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  CLIENT_TEXT_INSTRUCTIONS,
  clientTextRequest,
  readClientText,
  readingFrom,
} from './reader.js';

// The client text reader on the fakes (S81a, ADR-0073, AC-X-237/238): one forced tool call on
// the routine model, metered, shown the text as untrusted data and the visits as labels and
// local times only; anything that isn't a reading is refused.

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001' as TenantId;
const V1 = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7000a1' as BookingId;
const V2 = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f7000a2' as BookingId;
const question: ClientTextQuestion = {
  text: 'Running 10 late, sorry!',
  // Saturday 28 Nov 2026, 9:00 in New York.
  now: '2026-11-28T14:00:00.000Z' as ClientTextQuestion['now'],
  timeZone: 'America/New_York',
  visits: [
    { id: V1, startsAt: '2026-11-28T15:30:00.000Z' as ClientTextQuestion['now'] },
    { id: V2, startsAt: '2026-12-05T20:00:00.000Z' as ClientTextQuestion['now'] },
  ],
};
const args = (overrides: Record<string, unknown> = {}) => ({
  intent: 'running_late',
  visit: 'v1',
  askedForDate: null,
  askedForTime: null,
  minutesLate: 10,
  confidence: 'sure',
  ...overrides,
});
const answer = (value: unknown) =>
  scriptedResponse({
    toolCalls: [
      {
        id: 'c1',
        name: 'read_client_text',
        arguments: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    usage: { inputTokens: 600, cachedInputTokens: 0, outputTokens: 30 },
  });

function deps(provider: ScriptedProvider, reservation: 'ok' | 'none' = 'ok') {
  const settled: number[] = [];
  const reserve = vi.fn(() =>
    Promise.resolve(
      reservation === 'none'
        ? null
        : {
            state: 'ok' as const,
            settle: (tokens: number) => {
              settled.push(tokens);
              return Promise.resolve();
            },
          },
    ),
  );
  return { deps: { provider, reserve }, reserve, settled };
}

describe('clientTextRequest (AC-X-237)', () => {
  it('is one forced tool call on the routine model with static instructions', () => {
    expect(clientTextRequest(question)).toMatchObject({
      route: 'routine',
      toolChoice: 'required',
      instructions: CLIENT_TEXT_INSTRUCTIONS,
      tools: [{ name: 'read_client_text' }],
    });
  });

  it('carries the text as untrusted data, now and the visits as labels with local times', () => {
    const request = clientTextRequest(question);
    expect(JSON.parse(String(request.messages[0]?.content))).toEqual({
      now: { weekday: 'Saturday', date: '2026-11-28', time: '09:00' },
      visits: [
        { label: 'v1', weekday: 'Saturday', date: '2026-11-28', time: '10:30' },
        { label: 'v2', weekday: 'Saturday', date: '2026-12-05', time: '15:00' },
      ],
      text: { untrusted: true, text: 'Running 10 late, sorry!' },
    });
    // The booking ids stay in the reader.
    expect(JSON.stringify(request)).not.toContain(V1);
    expect(JSON.stringify(request)).not.toContain(V2);
  });

  it('refuses a question the contract doesn’t allow (extra fields, six visits)', () => {
    expect(() =>
      clientTextRequest({ ...question, clientName: 'Maria' } as unknown as ClientTextQuestion),
    ).toThrow();
    expect(() =>
      clientTextRequest({
        ...question,
        visits: Array.from({ length: 6 }, () => ({ id: V1, startsAt: question.now })),
      }),
    ).toThrow();
  });
});

describe('readingFrom (AC-X-238)', () => {
  it('puts the visit id back for its label', () => {
    expect(readingFrom(args(), question.visits)).toEqual({
      intent: 'running_late',
      visitId: V1,
      askedFor: null,
      minutesLate: 10,
      confidence: 'sure',
    });
    expect(readingFrom(args({ visit: 'v2' }), question.visits)?.visitId).toBe(V2);
    expect(readingFrom(args({ visit: null }), question.visits)?.visitId).toBeNull();
  });

  it('drops the fields that do not belong to the intent', () => {
    expect(
      readingFrom(
        args({ intent: 'confirm', askedForDate: '2026-12-01', minutesLate: 5 }),
        question.visits,
      ),
    ).toEqual({
      intent: 'confirm',
      visitId: V1,
      askedFor: null,
      minutesLate: null,
      confidence: 'sure',
    });
    expect(
      readingFrom(
        args({ intent: 'reschedule', askedForDate: '2026-12-04', askedForTime: null }),
        question.visits,
      ),
    ).toMatchObject({ askedFor: { date: '2026-12-04', time: null }, minutesLate: null });
    expect(
      readingFrom(args({ intent: 'reschedule', minutesLate: null }), question.visits)?.askedFor,
    ).toBeNull();
  });

  it('refuses a label not offered, a malformed time, minutes out of range or an extra field', () => {
    for (const bad of [
      args({ visit: 'v3' }),
      args({ visit: V1 }),
      args({ intent: 'reschedule', askedForTime: '3pm' }),
      args({ minutesLate: 500 }),
      args({ minutesLate: 0 }),
      args({ intent: 'refund' }),
      { ...args(), price: 0 },
    ]) {
      expect(readingFrom(bad, question.visits)).toBeNull();
    }
    expect(readingFrom(args(), [])).toBeNull();
  });
});

describe('readClientText', () => {
  it('returns the reading and settles what the call used', async () => {
    const provider = new ScriptedProvider([answer(args())]);
    const { deps: d, settled, reserve } = deps(provider);
    expect(await readClientText(d, TENANT, question)).toEqual({
      kind: 'read',
      reading: {
        intent: 'running_late',
        visitId: V1,
        askedFor: null,
        minutesLate: 10,
        confidence: 'sure',
      },
      tokens: 630,
    });
    expect(reserve).toHaveBeenCalledWith(TENANT, 1_500);
    expect(settled).toEqual([630]);
    expect(provider.requests).toHaveLength(1);
  });

  it('refuses broken JSON, an answer without the call and a reading that is not one', async () => {
    for (const step of [
      answer('{not json'),
      scriptedResponse({ text: 'They are running late.' }),
      answer(args({ visit: 'v9' })),
    ]) {
      const { deps: d } = deps(new ScriptedProvider([step]));
      expect(await readClientText(d, TENANT, question)).toMatchObject({ kind: 'refused' });
    }
  });

  it('returns the visit id as the contract has it, lower case', async () => {
    const { deps: d } = deps(new ScriptedProvider([answer(args())]));
    const shouted = {
      ...question,
      visits: [{ ...question.visits[0], id: V1.toUpperCase() as BookingId }],
    } as ClientTextQuestion;
    expect(await readClientText(d, TENANT, shouted)).toMatchObject({ reading: { visitId: V1 } });
  });

  it('calls nothing without a reservation', async () => {
    const provider = new ScriptedProvider([]);
    const { deps: d } = deps(provider, 'none');
    expect(await readClientText(d, TENANT, question)).toEqual({ kind: 'no_budget' });
    expect(provider.requests).toHaveLength(0);
  });

  it('settles nothing and throws what the provider throws', async () => {
    const provider = new ScriptedProvider([new LlmError('unavailable', 'down')]);
    const { deps: d, settled } = deps(provider);
    await expect(readClientText(d, TENANT, question)).rejects.toBeInstanceOf(LlmError);
    expect(settled).toEqual([0]);
  });
});
