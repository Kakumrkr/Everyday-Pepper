import { describe, expect, it } from 'vitest';
import { contractRequest } from '../provider-contract.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  CassetteError,
  CassetteProvider,
  recordingProvider,
  requestFingerprint,
  type CassetteStep,
} from './cassette.js';

describe('requestFingerprint', () => {
  it('ignores key order but not content', () => {
    const reordered = Object.fromEntries(
      Object.entries(contractRequest).reverse(),
    ) as typeof contractRequest;
    expect(requestFingerprint(reordered)).toBe(requestFingerprint(contractRequest));
    expect(requestFingerprint({ ...contractRequest, instructions: 'Changed.' })).not.toBe(
      requestFingerprint(contractRequest),
    );
    expect(requestFingerprint(contractRequest)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CassetteProvider', () => {
  it('replays steps in order, then reports a miss', async () => {
    const provider = new CassetteProvider([
      { response: scriptedResponse({ text: 'one' }) },
      { response: scriptedResponse({ text: 'two' }) },
    ]);
    expect((await provider.respond(contractRequest)).text).toBe('one');
    const events = [];
    for await (const event of provider.stream(contractRequest)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['text_delta', 'done']);
    await expect(provider.respond(contractRequest)).rejects.toMatchObject({ kind: 'miss' });
  });

  it('refuses a recorded answer for a different request as stale', async () => {
    const provider = new CassetteProvider([
      { fingerprint: requestFingerprint(contractRequest), response: scriptedResponse() },
      { fingerprint: requestFingerprint(contractRequest), response: scriptedResponse() },
    ]);
    await expect(provider.respond(contractRequest)).resolves.toBeDefined();
    const changed = provider.respond({ ...contractRequest, instructions: 'A new prompt.' });
    await expect(changed).rejects.toBeInstanceOf(CassetteError);
    await expect(changed).rejects.toMatchObject({ kind: 'stale' });
  });

  it('streams an empty answer as a single done', async () => {
    const events = [];
    for await (const event of new CassetteProvider([{ response: scriptedResponse() }]).stream(
      contractRequest,
    )) {
      events.push(event.type);
    }
    expect(events).toEqual(['done']);
  });
});

describe('recordingProvider', () => {
  it('writes each answer down with its fingerprint, and the recording replays', async () => {
    const steps: CassetteStep[] = [];
    const recorder = recordingProvider(
      new ScriptedProvider([scriptedResponse({ text: 'hi' }), scriptedResponse({ text: 'again' })]),
      steps,
    );
    await recorder.respond(contractRequest);
    const streamed = [];
    for await (const event of recorder.stream(contractRequest)) streamed.push(event);
    expect(streamed.at(-1)?.type).toBe('done');
    expect(steps.map((step) => step.response.text)).toEqual(['hi', 'again']);
    expect(steps[0]?.fingerprint).toBe(requestFingerprint(contractRequest));
    const replay = new CassetteProvider(steps);
    expect((await replay.respond(contractRequest)).text).toBe('hi');
  });
});
