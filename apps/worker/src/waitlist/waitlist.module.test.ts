import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitlistMatchGivenUpError } from '@pepper/ai';
import { WaitlistModule, WaitlistRunner, type WaitlistOptions } from './waitlist.module.js';

// The waitlist runner's wiring with BullMQ, Redis and the matcher replaced; the real queue,
// Redis, Postgres and SMTP are in waitlist.int.test.ts (AC-W5-1).

const fakes = vi.hoisted(() => {
  type Processor = (job: { data: unknown }) => Promise<unknown>;
  const state = {
    processor: undefined as Processor | undefined,
    failed: undefined as ((job: unknown, error: Error) => void) | undefined,
    queue: { addBulk: vi.fn(), close: vi.fn() },
    worker: { close: vi.fn() },
    redis: { on: vi.fn(), quit: vi.fn(() => Promise.resolve('OK')) },
  };
  return state;
});

vi.mock('bullmq', () => ({
  Queue: vi.fn(function Queue() {
    return fakes.queue;
  }),
  Worker: vi.fn(function Worker(_name: string, processor: (job: { data: unknown }) => unknown) {
    fakes.processor = processor as never;
    return {
      ...fakes.worker,
      on: (_event: string, listener: (job: unknown, error: Error) => void) => {
        fakes.failed = listener;
      },
    };
  }),
}));
vi.mock('ioredis', () => ({
  Redis: vi.fn(function Redis() {
    return fakes.redis;
  }),
}));
const relay = vi.hoisted(() => ({ relayDueMatches: vi.fn() }));
vi.mock('./relay.js', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  relayDueMatches: relay.relayDueMatches,
}));
const ai = vi.hoisted(() => ({ runWaitlistMatch: vi.fn() }));
vi.mock('@pepper/ai', async (actual) => ({
  ...(await actual<{ WaitlistMatchGivenUpError: typeof WaitlistMatchGivenUpError }>()),
  runWaitlistMatch: ai.runWaitlistMatch,
}));
const runtime = vi.hoisted(() => ({ raiseAlert: vi.fn() }));
vi.mock('@pepper/runtime', () => ({
  DATABASE: Symbol('DATABASE'),
  raiseAlert: runtime.raiseAlert,
}));

const NOW = new Date('2026-10-20T15:00:00Z');
const OPTIONS: WaitlistOptions = {
  redisUrl: 'redis://127.0.0.1:1',
  key: Buffer.alloc(32),
  baseUrl: 'https://app.pepper.test',
  pollMs: 5_000,
  clock: { now: () => NOW },
};
const JOB = {
  data: {
    matchId: '0199f4b2-7c1e-7a00-8000-000000000001',
    tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
  },
};

const runner = () => new WaitlistRunner({ db: {} as never }, OPTIONS);

beforeEach(() => {
  vi.clearAllMocks();
  fakes.processor = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WaitlistRunner', () => {
  it('does nothing before it starts', async () => {
    await runner().relayOnce();
    expect(relay.relayDueMatches).not.toHaveBeenCalled();
  });

  it('relays on its interval and closes everything on shutdown', async () => {
    vi.useFakeTimers();
    relay.relayDueMatches.mockResolvedValue(0);
    const waitlist = runner();
    waitlist.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OPTIONS.pollMs);
    expect(relay.relayDueMatches).toHaveBeenCalledWith({}, fakes.queue, NOW);
    await waitlist.onApplicationShutdown();
    expect(fakes.worker.close).toHaveBeenCalled();
    expect(fakes.queue.close).toHaveBeenCalled();
    expect(fakes.redis.quit).toHaveBeenCalled();
  });

  it('never overlaps relay passes, and survives a failing one', async () => {
    let finish: () => void = () => undefined;
    relay.relayDueMatches.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => {
            resolve(1);
          };
        }),
    );
    const waitlist = runner();
    waitlist.onApplicationBootstrap();
    const first = waitlist.relayOnce();
    await waitlist.relayOnce();
    expect(relay.relayDueMatches).toHaveBeenCalledTimes(1);
    finish();
    await first;
    relay.relayDueMatches.mockRejectedValue(new Error('database down'));
    await waitlist.relayOnce();
    await waitlist.relayOnce();
    relay.relayDueMatches.mockResolvedValue(0);
    await waitlist.relayOnce();
    expect(relay.relayDueMatches).toHaveBeenCalledTimes(4);
    await waitlist.onApplicationShutdown();
  });

  it('matches each job with the template settings, and alerts with ids only on a failure', async () => {
    const waitlist = runner();
    waitlist.onApplicationBootstrap();
    ai.runWaitlistMatch.mockResolvedValueOnce('proposed');
    await expect(fakes.processor?.(JOB)).resolves.toBe('proposed');
    const [, due, matcher] = ai.runWaitlistMatch.mock.calls[0] as [
      unknown,
      unknown,
      {
        autonomyOf: (id: string | null) => unknown;
        waitlistOf: (id: string | null) => unknown;
        emails: unknown;
      },
    ];
    expect(due).toEqual(JOB.data);
    expect(matcher.emails).toEqual({ baseUrl: OPTIONS.baseUrl, outboxKey: OPTIONS.key });
    expect(matcher.autonomyOf(null)).toEqual({});
    expect(matcher.autonomyOf('beauty-salon')).toBeTypeOf('object');
    expect(matcher.waitlistOf(null)).toMatchObject({ offerFanOut: 3 });
    // A job without a valid match is refused before any match runs.
    await expect(fakes.processor?.({ data: { matchId: 'x' } })).rejects.toThrow();

    // A failure the relay retries (the database down) is not alerted; a match given up is.
    fakes.failed?.(JOB, new Error('database down'));
    expect(runtime.raiseAlert).not.toHaveBeenCalled();
    fakes.failed?.(JOB, new WaitlistMatchGivenUpError(new Error('database down')));
    expect(runtime.raiseAlert).toHaveBeenCalledWith('Waitlist match failed', JOB.data);
    fakes.failed?.(undefined, new WaitlistMatchGivenUpError(new Error('database down')));
    expect(runtime.raiseAlert).toHaveBeenLastCalledWith('Waitlist match failed', {
      matchId: 'undefined',
      tenantId: 'undefined',
    });
    await waitlist.onApplicationShutdown();
  });

  it('the module provides the runner with its options', () => {
    const module = WaitlistModule.forRoot(OPTIONS);
    expect(module.exports).toEqual([WaitlistRunner]);
    expect(module.providers).toContainEqual(expect.objectContaining({ useValue: OPTIONS }));
  });
});
