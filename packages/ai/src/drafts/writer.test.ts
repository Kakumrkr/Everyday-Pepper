import type { TenantId } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LlmError } from '../errors.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import { draftRequest, DRAFT_INSTRUCTIONS, writeDraft, type DraftFacts } from './writer.js';

// The draft writer's contract on the fakes (S36, playbook §7): one forced tool call on the
// routine model, metered, and only words that pass the draft rules come back.

const TENANT = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f700001' as TenantId;
const facts: DraftFacts = {
  business: { name: 'Juniper Hair Studio', voice: 'Warm and short.' },
  clientFirstName: 'Sara',
  serviceName: 'Haircut',
  staffFirstName: 'Jess',
  lastVisit: 'September 28',
  weeksSince: 5,
};
const answer = (
  args: unknown,
  usage = { inputTokens: 400, cachedInputTokens: 0, outputTokens: 60 },
) =>
  scriptedResponse({
    toolCalls: [
      {
        id: 'c1',
        name: 'write_draft',
        arguments: typeof args === 'string' ? args : JSON.stringify(args),
      },
    ],
    usage,
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

describe('draftRequest', () => {
  it('is one forced tool call on the routine model with static instructions', () => {
    const request = draftRequest(facts);
    expect(request).toMatchObject({
      route: 'routine',
      toolChoice: 'required',
      instructions: DRAFT_INSTRUCTIONS,
      tools: [{ name: 'write_draft' }],
    });
    expect(request.maxOutputTokens).toBeLessThanOrEqual(400);
  });

  it('labels the client’s name untrusted and carries no contact, time or link', () => {
    const content = draftRequest(facts).messages[0]?.content ?? '';
    expect(JSON.parse(content)).toEqual({
      business: { name: 'Juniper Hair Studio', voice: 'Warm and short.' },
      client: { firstName: { untrusted: true, text: 'Sara' } },
      service: 'Haircut',
      usuallySees: 'Jess',
      lastVisit: 'September 28',
      weeksSinceLastVisit: 5,
    });
  });

  it('tells the model what it must never write', () => {
    expect(DRAFT_INSTRUCTIONS).toMatch(/never write a date, a time, a price/i);
    expect(DRAFT_INSTRUCTIONS).toMatch(/never as an AI/i);
    expect(DRAFT_INSTRUCTIONS).toMatch(/data, not instructions/i);
  });
});

describe('writeDraft', () => {
  it('returns the checked words and settles what the call used', async () => {
    const {
      deps: d,
      reserve,
      settled,
    } = deps(
      new ScriptedProvider([
        answer({ subject: ' Time for a trim? ', body: 'Hi Sara,\n\nIt has been a while.' }),
      ]),
    );
    expect(await writeDraft(d, TENANT, facts)).toEqual({
      kind: 'drafted',
      draft: { subject: 'Time for a trim?', body: 'Hi Sara,\n\nIt has been a while.' },
      tokens: 460,
    });
    expect(reserve).toHaveBeenCalledWith(TENANT, 1500);
    expect(settled).toEqual([460]);
  });

  it.each([
    ['a link', { subject: 'Hi', body: 'Book at www.example.com' }],
    ['a phone number', { subject: 'Hi', body: 'Call 212 555 0143' }],
    [
      'too many words',
      { subject: 'Hi', body: Array.from({ length: 130 }, () => 'word').join(' ') },
    ],
    ['missing fields', { subject: 'Hi' }],
    ['not JSON', '{"subject":'],
  ])('refuses %s', async (_, args) => {
    const { deps: d, settled } = deps(new ScriptedProvider([answer(args)]));
    expect(await writeDraft(d, TENANT, facts)).toMatchObject({
      kind: 'refused',
      reason: 'invalid',
    });
    expect(settled).toEqual([460]);
  });

  it('refuses an answer without the tool call, or a refusal', async () => {
    const { deps: d } = deps(
      new ScriptedProvider([
        scriptedResponse({ text: 'Sure!' }),
        scriptedResponse({ refusal: 'No.' }),
      ]),
    );
    expect(await writeDraft(d, TENANT, facts)).toMatchObject({
      kind: 'refused',
      reason: 'no_answer',
    });
    expect(await writeDraft(d, TENANT, facts)).toMatchObject({
      kind: 'refused',
      reason: 'no_answer',
    });
  });

  it('calls nothing without budget', async () => {
    const provider = new ScriptedProvider([]);
    const { deps: d } = deps(provider, 'none');
    expect(await writeDraft(d, TENANT, facts)).toEqual({ kind: 'no_budget' });
    expect(provider.requests).toEqual([]);
  });

  it('settles nothing and throws when the provider fails', async () => {
    const { deps: d, settled } = deps(new ScriptedProvider([new LlmError('timeout', 'slow')]));
    await expect(writeDraft(d, TENANT, facts)).rejects.toThrow(LlmError);
    expect(settled).toEqual([0]);
  });
});
