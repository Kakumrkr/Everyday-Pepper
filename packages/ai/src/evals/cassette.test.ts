import { describe, expect, it } from 'vitest';
import { contractRequest } from '../provider-contract.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import {
  CassetteError,
  CassetteProvider,
  recordingProvider,
  replayOrRecordProvider,
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

describe('replayOrRecordProvider (never pay twice for one answer)', () => {
  it('replays unchanged requests for free and calls the real model from the first change on', async () => {
    const earlier: CassetteStep[] = [];
    await recordingProvider(
      new ScriptedProvider([
        scriptedResponse({ text: 'old one' }),
        scriptedResponse({ text: 'old two' }),
      ]),
      earlier,
    ).respond(contractRequest);
    earlier.push({
      fingerprint: requestFingerprint(contractRequest),
      response: scriptedResponse({ text: 'old two' }),
    });

    const real = new ScriptedProvider([
      scriptedResponse({ text: 'new two' }),
      scriptedResponse({ text: 'new three' }),
    ]);
    const steps: CassetteStep[] = [];
    const provider = replayOrRecordProvider(real, earlier, steps);
    expect((await provider.respond(contractRequest)).text).toBe('old one');
    expect(real.requests).toHaveLength(0);
    const changed = { ...contractRequest, instructions: 'A new prompt.' };
    expect((await provider.respond(changed)).text).toBe('new two');
    // Once it has left the recording, even an unchanged request goes to the real model.
    const streamed = [];
    for await (const event of provider.stream(contractRequest)) streamed.push(event);
    expect(streamed.at(-1)).toMatchObject({ type: 'done', response: { text: 'new three' } });
    expect(real.requests).toHaveLength(2);
    expect(steps.map((step) => step.response.text)).toEqual(['old one', 'new two', 'new three']);
    expect(steps[1]?.fingerprint).toBe(requestFingerprint(changed));
  });

  it('records everything when there is no earlier recording, and never replays a hand-written step', async () => {
    const real = new ScriptedProvider([scriptedResponse({ text: 'real' })]);
    const steps: CassetteStep[] = [];
    const provider = replayOrRecordProvider(
      real,
      [{ response: scriptedResponse({ text: 'hand' }) }],
      steps,
    );
    expect((await provider.respond(contractRequest)).text).toBe('real');
    expect(real.requests).toHaveLength(1);
  });
});
