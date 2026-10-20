import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxRunner, type OutboxOptions } from './outbox.module.js';

// The runner's wiring with BullMQ and Redis replaced; the real queue, Redis, Postgres and SMTP
// are in outbox.int.test.ts.

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
const relay = vi.hoisted(() => ({ relayDue: vi.fn(), handleDeliveryJob: vi.fn() }));
vi.mock('./relay.js', () => ({ ...relay, OUTBOX_QUEUE: 'outbox' }));
const runtime = vi.hoisted(() => ({ raiseAlert: vi.fn() }));
vi.mock('@pepper/runtime', () => ({
  DATABASE: Symbol('DATABASE'),
  MAILER: Symbol('MAILER'),
  raiseAlert: runtime.raiseAlert,
}));

const OPTIONS: OutboxOptions = {
  redisUrl: 'redis://127.0.0.1:1',
  key: Buffer.alloc(32),
  pollMs: 60_000,
  clock: { now: () => new Date('2026-10-20T15:00:00Z') },
};
const JOB = {
  data: {
    messageId: '0199f4b2-7c1e-7a00-8000-000000000001',
    tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
  },
};
const mailer = { send: vi.fn() };

function runner(withMailer = true): OutboxRunner {
  return new OutboxRunner({ db: {} as never }, withMailer ? mailer : null, OPTIONS);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.processor = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OutboxRunner', () => {
  it('starts nothing without a mailer', async () => {
    const outbox = runner(false);
    outbox.onApplicationBootstrap();
    expect(fakes.processor).toBeUndefined();
    await outbox.relayOnce();
    expect(relay.relayDue).not.toHaveBeenCalled();
    await expect(outbox.onApplicationShutdown()).resolves.toBeUndefined();
  });

  it('relays on its interval and closes everything on shutdown', async () => {
    vi.useFakeTimers();
    relay.relayDue.mockResolvedValue(0);
    const outbox = runner();
    outbox.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OPTIONS.pollMs);
    expect(relay.relayDue).toHaveBeenCalledWith({}, fakes.queue, OPTIONS.clock?.now());
    await outbox.onApplicationShutdown();
    expect(fakes.worker.close).toHaveBeenCalled();
    expect(fakes.queue.close).toHaveBeenCalled();
    expect(fakes.redis.quit).toHaveBeenCalled();
  });

  it('never overlaps relay passes, and survives a failing one', async () => {
    let finish: () => void = () => undefined;
    relay.relayDue.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => {
            resolve(1);
          };
        }),
    );
    const outbox = runner();
    outbox.onApplicationBootstrap();
    const first = outbox.relayOnce();
    await outbox.relayOnce();
    expect(relay.relayDue).toHaveBeenCalledTimes(1);
    finish();
    await first;
    relay.relayDue.mockRejectedValue(new Error('database down'));
    await outbox.relayOnce();
    await outbox.relayOnce();
    relay.relayDue.mockResolvedValue(0);
    await outbox.relayOnce();
    expect(relay.relayDue).toHaveBeenCalledTimes(4);
    await outbox.onApplicationShutdown();
  });

  it('delivers jobs, and raises an alert with ids only for a message given up', async () => {
    const outbox = runner();
    outbox.onApplicationBootstrap();
    relay.handleDeliveryJob.mockResolvedValueOnce('sent');
    await expect(fakes.processor?.(JOB)).resolves.toBe('sent');
    expect(runtime.raiseAlert).not.toHaveBeenCalled();
    relay.handleDeliveryJob.mockResolvedValueOnce('dead');
    await expect(fakes.processor?.(JOB)).resolves.toBe('dead');
    expect(runtime.raiseAlert).toHaveBeenCalledWith('Outbox message given up', JOB.data);
    expect(relay.handleDeliveryJob).toHaveBeenCalledWith(
      {},
      JOB.data,
      expect.objectContaining({ key: OPTIONS.key, mailer }),
    );
    fakes.failed?.(JOB, new Error('database down'));
    await outbox.onApplicationShutdown();
  });
});
