import type { LlmUsage } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { LlmError } from './errors.js';
import { meteredProvider } from './metering.js';
import { contractRequest } from './provider-contract.js';
import { ScriptedProvider, scriptedResponse } from './scripted-provider.js';

const USAGE: LlmUsage = { inputTokens: 100, cachedInputTokens: 60, outputTokens: 20 };

async function drain(events: AsyncIterable<unknown>): Promise<number> {
  const all: unknown[] = [];
  for await (const event of events) all.push(event);
  return all.length;
}

describe('meteredProvider (ADR-0027, ADR-0013)', () => {
  it('meters each answer, complete or streamed, with the model that answered', async () => {
    const meter = vi.fn(() => Promise.resolve());
    const provider = meteredProvider(
      new ScriptedProvider([
        scriptedResponse({ text: 'one', usage: USAGE, model: 'm-1' }),
        scriptedResponse({ text: 'two words', usage: USAGE, model: 'm-2' }),
      ]),
      meter,
    );
    expect((await provider.respond(contractRequest)).text).toBe('one');
    expect(await drain(provider.stream(contractRequest))).toBe(3);
    expect(meter.mock.calls).toEqual([
      [USAGE, 'm-1'],
      [USAGE, 'm-2'],
    ]);
  });

  it('meters a failure the provider may bill, then rethrows it; others meter nothing', async () => {
    const meter = vi.fn(() => Promise.resolve());
    const billed = new LlmError('unavailable', 'failed late', USAGE);
    const provider = meteredProvider(
      new ScriptedProvider([billed, new LlmError('timeout', 'slow'), billed]),
      meter,
    );
    await expect(provider.respond(contractRequest)).rejects.toBe(billed);
    await expect(provider.respond(contractRequest)).rejects.toMatchObject({ code: 'timeout' });
    await expect(drain(provider.stream(contractRequest))).rejects.toBe(billed);
    expect(meter.mock.calls).toEqual([
      [USAGE, 'unknown'],
      [USAGE, 'unknown'],
    ]);
  });

  it('fails the call when metering fails, so no answer goes out unmetered', async () => {
    const provider = meteredProvider(
      new ScriptedProvider([scriptedResponse(), scriptedResponse()]),
      () => Promise.reject(new Error('database down')),
    );
    await expect(provider.respond(contractRequest)).rejects.toThrow('database down');
    await expect(drain(provider.stream(contractRequest))).rejects.toThrow('database down');
  });
});
