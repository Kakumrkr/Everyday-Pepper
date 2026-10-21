import type { ChatEvent } from '@pepper/contracts';
import { describe, expect, it, vi } from 'vitest';
import { chatEventOf, runTurn, SseParser } from './chat-stream';

const ID = '0199f4b2-7c1e-7a00-8000-0000000000a1';

const frame = (seq: number, event: ChatEvent) =>
  `id: ${String(seq)}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const started: ChatEvent = {
  type: 'turn.started',
  conversationId: ID,
  turnId: ID,
  requestMessageId: ID,
} as ChatEvent;
const delta = (text: string): ChatEvent => ({ type: 'text.delta', delta: text });
const done: ChatEvent = { type: 'turn.completed', reason: 'answered' };

/** A response whose body yields `chunks`, then ends (or errors, like a dropped connection). */
function streamOf(chunks: string[], { drop = false } = {}): Response {
  const encoder = new TextEncoder();
  const left = [...chunks];
  // Pulled one chunk at a time, so a drop comes after what arrived (an error discards a queue).
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = left.shift();
      if (chunk !== undefined) controller.enqueue(encoder.encode(chunk));
      else if (drop) controller.error(new Error('connection reset'));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('SseParser', () => {
  it('reads events across chunk boundaries, skips heartbeats, joins data lines', () => {
    const parser = new SseParser();
    expect(parser.push('id: 1\nevent: a\nda')).toEqual([]);
    expect(
      parser.push('ta: {"x":1}\n\n: keep-alive\n\nid: 2\r\nevent: b\r\ndata: x\r\ndata: y\r\n\r\n'),
    ).toEqual([
      { id: '1', event: 'a', data: '{"x":1}' },
      { id: '2', event: 'b', data: 'x\ny' },
    ]);
  });
});

describe('chatEventOf', () => {
  it('accepts only events that fit the contract, under their own name', () => {
    const [ok] = new SseParser().push(frame(1, delta('Hi')));
    expect(ok && chatEventOf(ok)).toEqual({ seq: 1, event: delta('Hi') });
    const bad = [
      { id: '1', event: 'text.delta', data: '{"type":"text.delta","delta":""}' },
      { id: '1', event: 'text.delta', data: 'not json' },
      { id: 'x', event: 'text.delta', data: JSON.stringify(delta('Hi')) },
      { id: '1', event: 'turn.completed', data: JSON.stringify(delta('Hi')) },
      { id: '1', event: 'html', data: '{"type":"html","html":"<script>"}' },
    ];
    for (const item of bad) expect(chatEventOf(item)).toBeNull();
  });
});

describe('runTurn', () => {
  const noWait = () => Promise.resolve();

  it('streams a turn to the end', async () => {
    const events: number[] = [];
    const result = await runTurn({
      start: () =>
        Promise.resolve(streamOf([frame(1, started), frame(2, delta('Hi')), frame(3, done)])),
      resume: vi.fn(),
      onEvent: (envelope) => events.push(envelope.seq),
      signal: new AbortController().signal,
      wait: noWait,
    });
    expect(result).toEqual({ kind: 'finished' });
    expect(events).toEqual([1, 2, 3]);
  });

  it('resumes after a drop from the last event seen, each event once', async () => {
    const events: number[] = [];
    const resume = vi.fn((turnId: string, after: number) => {
      expect([turnId, after]).toEqual([ID, 2]);
      // The log replays from after the last event; a repeat of 2 is ignored anyway.
      return Promise.resolve(
        streamOf([frame(2, delta('Hi')), frame(3, delta(' there')), frame(4, done)]),
      );
    });
    const result = await runTurn({
      start: () =>
        Promise.resolve(streamOf([frame(1, started), frame(2, delta('Hi'))], { drop: true })),
      resume,
      onEvent: (envelope) => events.push(envelope.seq),
      signal: new AbortController().signal,
      wait: noWait,
    });
    expect(result).toEqual({ kind: 'finished' });
    expect(events).toEqual([1, 2, 3, 4]);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('gives up after its retries, saying the turn may still finish', async () => {
    const resume = vi.fn(() => Promise.reject(new Error('offline')));
    const result = await runTurn({
      start: () => Promise.resolve(streamOf([frame(1, started)], { drop: true })),
      resume,
      onEvent: () => undefined,
      signal: new AbortController().signal,
      wait: noWait,
    });
    expect(result).toEqual({ kind: 'lost', turnId: ID });
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it('reports a refusal to start, and a stop', async () => {
    const refused = await runTurn({
      start: () => Promise.resolve(Response.json({ code: 'turn_in_progress' }, { status: 409 })),
      resume: vi.fn(),
      onEvent: () => undefined,
      signal: new AbortController().signal,
    });
    expect(refused).toEqual({ kind: 'refused', status: 409, body: { code: 'turn_in_progress' } });
    const controller = new AbortController();
    controller.abort();
    const stopped = await runTurn({
      start: () => Promise.reject(new Error('aborted')),
      resume: vi.fn(),
      onEvent: () => undefined,
      signal: controller.signal,
    });
    expect(stopped).toEqual({ kind: 'stopped' });
  });

  it('a drop before the turn started is lost (nothing to resume)', async () => {
    const result = await runTurn({
      start: () => Promise.resolve(streamOf([], { drop: true })),
      resume: vi.fn(),
      onEvent: () => undefined,
      signal: new AbortController().signal,
      wait: noWait,
    });
    expect(result).toEqual({ kind: 'lost', turnId: null });
  });
});
