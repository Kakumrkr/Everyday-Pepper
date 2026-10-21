import { ChatEventSchema, isFinalChatEvent, type ChatEventEnvelope } from '@pepper/contracts';

// The chat's side of `POST /v1/chat/turns` (S26, ADR-0031): server-sent events read from a
// fetch body (EventSource can't POST), each event checked against the contract before anyone
// sees it (OWASP LLM10), and a dropped stream resumed with `Last-Event-ID` from the event log
// (ADR-0030). The turn keeps running on the server when the connection drops; only Stop or
// leaving the chat cancels it.

/** One server-sent event as received. */
export interface SseFrame {
  id: string | null;
  event: string;
  data: string;
}

/** Splits a stream of text into server-sent events, across chunk boundaries. */
export class SseParser {
  private buffer = '';

  push(chunk: string): SseFrame[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n');
    const frames: SseFrame[] = [];
    let end = this.buffer.indexOf('\n\n');
    while (end !== -1) {
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const frame = frameOf(block);
      if (frame !== null) frames.push(frame);
      end = this.buffer.indexOf('\n\n');
    }
    return frames;
  }
}

function frameOf(block: string): SseFrame | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    // A comment (the server's heartbeat).
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length === 0 ? null : { id, event, data: data.join('\n') };
}

/** A frame as a chat event, or `null` for anything the contract doesn't allow. */
export function chatEventOf(frame: SseFrame): ChatEventEnvelope | null {
  const seq = Number(frame.id);
  if (!Number.isInteger(seq) || seq < 1) return null;
  let json: unknown;
  try {
    json = JSON.parse(frame.data);
  } catch {
    return null;
  }
  const event = ChatEventSchema.safeParse(json);
  if (!event.success || event.data.type !== frame.event) return null;
  return { seq, event: event.data };
}

export type TurnRun =
  | { kind: 'finished' }
  /** The api refused to start it (busy, rate limited, signed out). */
  | { kind: 'refused'; status: number; body: unknown }
  /** The connection kept dropping: the turn may still finish; its cards show on reload. */
  | { kind: 'lost'; turnId: string | null }
  | { kind: 'stopped' };

export interface RunTurnOptions {
  start: (signal: AbortSignal) => Promise<Response>;
  resume: (turnId: string, afterSeq: number, signal: AbortSignal) => Promise<Response>;
  onEvent: (envelope: ChatEventEnvelope) => void;
  signal: AbortSignal;
  /** Resume attempts after a drop. */
  retries?: number;
  /** Waits between resume attempts (tests pass a fake). */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Runs one turn's stream: starts it, hands every new event to `onEvent` once and in order,
 * and resumes after a drop from the last event seen.
 */
export async function runTurn(options: RunTurnOptions): Promise<TurnRun> {
  const { signal, retries = 3, wait = defaultWait } = options;
  // Updated by `deliver` as events arrive (an object, so the checks below read the latest).
  const progress: { turnId: string | null; lastSeq: number; finished: boolean } = {
    turnId: null,
    lastSeq: 0,
    finished: false,
  };
  const deliver = (envelope: ChatEventEnvelope) => {
    if (envelope.seq <= progress.lastSeq) return;
    progress.lastSeq = envelope.seq;
    if (envelope.event.type === 'turn.started') progress.turnId = envelope.event.turnId;
    if (isFinalChatEvent(envelope.event)) progress.finished = true;
    options.onEvent(envelope);
  };

  let response: Response;
  try {
    response = await options.start(signal);
  } catch {
    if (signal.aborted) return { kind: 'stopped' };
    return { kind: 'lost', turnId: progress.turnId };
  }
  if (!response.ok) {
    return {
      kind: 'refused',
      status: response.status,
      body: await response.json().catch(() => null),
    };
  }
  await readEvents(response, deliver, signal);
  for (let attempt = 0; !progress.finished && attempt < retries; attempt += 1) {
    if (signal.aborted) return { kind: 'stopped' };
    const { turnId } = progress;
    if (turnId === null) return { kind: 'lost', turnId };
    await wait(500 * 2 ** attempt);
    try {
      const resumed = await options.resume(turnId, progress.lastSeq, signal);
      if (resumed.ok) await readEvents(resumed, deliver, signal);
    } catch {
      // Try again (the next attempt waits longer).
    }
  }
  if (progress.finished) return { kind: 'finished' };
  return signal.aborted ? { kind: 'stopped' } : { kind: 'lost', turnId: progress.turnId };
}

async function readEvents(
  response: Response,
  deliver: (envelope: ChatEventEnvelope) => void,
  signal: AbortSignal,
): Promise<void> {
  if (response.body === null) return;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const parser = new SseParser();
  try {
    for (;;) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      for (const frame of parser.push(value)) {
        const envelope = chatEventOf(frame);
        if (envelope !== null) deliver(envelope);
      }
    }
  } catch {
    // The connection dropped; the caller resumes.
  } finally {
    reader.releaseLock();
  }
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
