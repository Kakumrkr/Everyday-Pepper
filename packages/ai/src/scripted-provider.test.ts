import { describe, expect, it } from 'vitest';
import { LlmError } from './errors.js';
import {
  CONTRACT_USAGE,
  contractRequest,
  providerContract,
  type ContractScenario,
} from './provider-contract.js';
import { ScriptedProvider, scriptedResponse, waitForAbort } from './scripted-provider.js';

function scripted(scenario: ContractScenario): ScriptedProvider {
  const usage = CONTRACT_USAGE;
  switch (scenario.kind) {
    case 'text':
      return new ScriptedProvider([scriptedResponse({ text: scenario.text, usage })]);
    case 'tool_call':
      return new ScriptedProvider([
        scriptedResponse({
          toolCalls: [{ id: scenario.id, name: scenario.name, arguments: scenario.arguments }],
          usage,
        }),
      ]);
    case 'refusal':
      return new ScriptedProvider([
        scriptedResponse({ finishReason: 'refused', refusal: scenario.refusal, usage }),
      ]);
    case 'length':
      return new ScriptedProvider([
        scriptedResponse({ text: scenario.text, finishReason: 'length', usage }),
      ]);
    case 'error':
      return new ScriptedProvider([new LlmError(scenario.code, `scripted ${scenario.code}`)]);
    case 'hang':
      return new ScriptedProvider([(_request, options) => waitForAbort(options.signal)]);
  }
}

providerContract('ScriptedProvider', { provider: scripted });

describe('ScriptedProvider', () => {
  it('records requests, answers functions of the request, and fails loudly when the script runs out', async () => {
    const provider = new ScriptedProvider([
      (request) => scriptedResponse({ text: `You said: ${String(request.messages.length)}` }),
    ]);
    expect(provider.remaining).toBe(1);
    expect((await provider.respond(contractRequest)).text).toBe('You said: 1');
    expect(provider.requests).toEqual([contractRequest]);
    await expect(provider.respond(contractRequest)).rejects.toThrow('no step left for call 2');
  });

  it('refuses an invalid request as bad_request, like a real provider', async () => {
    const provider = new ScriptedProvider([scriptedResponse()]);
    await expect(provider.respond({ ...contractRequest, messages: [] })).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('refuses a call whose signal already fired, and validates scripted answers', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new ScriptedProvider([scriptedResponse()]).respond(contractRequest, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'aborted' });
    const broken = new ScriptedProvider([() => ({ ...scriptedResponse(), model: '' })]);
    await expect(broken.respond(contractRequest)).rejects.toThrow();
  });

  it('streams an empty answer as a single done', async () => {
    const events = [];
    for await (const event of new ScriptedProvider([scriptedResponse()]).stream(contractRequest)) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(['done']);
  });
});

describe('waitForAbort', () => {
  it('rejects at once for a signal that already fired', async () => {
    await expect(waitForAbort(AbortSignal.abort())).rejects.toMatchObject({ code: 'aborted' });
  });
});
