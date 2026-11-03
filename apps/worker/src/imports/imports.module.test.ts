import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportsModule, ImportsRunner, type ImportsOptions } from './imports.module.js';

// The import runner's wiring with BullMQ, Redis and the import service replaced; the service
// itself runs against real Postgres in packages/modules/imports (AC-W1-3).

const fakes = vi.hoisted(() => {
  type Processor = (job: { data: unknown }) => Promise<unknown>;
  return {
    processor: undefined as Processor | undefined,
    failed: undefined as ((job: unknown, error: Error) => void) | undefined,
    queue: { addBulk: vi.fn(), close: vi.fn() },
    worker: { close: vi.fn() },
    redis: {
      on: vi.fn(),
      quit: vi.fn(() => Promise.resolve('OK')),
      disconnect: vi.fn(),
      status: 'ready',
    },
  };
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
const relay = vi.hoisted(() => ({ relayDueImports: vi.fn() }));
vi.mock('./relay.js', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  relayDueImports: relay.relayDueImports,
}));
const imports = vi.hoisted(() => ({ runImport: vi.fn(), tidyImports: vi.fn() }));
vi.mock('@pepper/imports', () => imports);
const runtime = vi.hoisted(() => ({ raiseAlert: vi.fn() }));
vi.mock('@pepper/runtime', () => ({
  DATABASE: Symbol('DATABASE'),
  raiseAlert: runtime.raiseAlert,
}));

const NOW = new Date('2026-11-03T15:00:00Z');
const OPTIONS: ImportsOptions = {
  redisUrl: 'redis://127.0.0.1:1',
  pollMs: 2_000,
  tidyMs: 60_000,
  clock: { now: () => NOW },
};
const JOB = {
  data: {
    batchId: '0199f4b2-7c1e-7a00-8000-000000000001',
    tenantId: '0199f4b2-7c1e-7a00-8000-0000000000aa',
  },
};

const runner = () => new ImportsRunner({ db: {} as never }, OPTIONS);

beforeEach(() => {
  vi.clearAllMocks();
  fakes.processor = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ImportsRunner', () => {
  it('does nothing before it starts', async () => {
    await runner().relayOnce();
    expect(relay.relayDueImports).not.toHaveBeenCalled();
  });

  it('relays and tidies on their intervals, and closes everything on shutdown', async () => {
    vi.useFakeTimers();
    relay.relayDueImports.mockResolvedValue(0);
    imports.tidyImports.mockResolvedValue(0);
    const running = runner();
    running.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(OPTIONS.pollMs);
    expect(relay.relayDueImports).toHaveBeenCalledWith({}, fakes.queue, NOW);
    expect(imports.tidyImports).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(imports.tidyImports).toHaveBeenCalledWith({}, OPTIONS.clock);
    await running.onApplicationShutdown();
    expect(fakes.worker.close).toHaveBeenCalledWith(false);
    expect(fakes.queue.close).toHaveBeenCalled();
    expect(fakes.redis.quit).toHaveBeenCalled();
  });

  it('closes at once when Redis is unreachable', async () => {
    fakes.redis.status = 'reconnecting';
    const running = runner();
    running.onApplicationBootstrap();
    await running.onApplicationShutdown();
    expect(fakes.worker.close).toHaveBeenCalledWith(true);
    expect(fakes.redis.disconnect).toHaveBeenCalled();
    expect(fakes.redis.quit).not.toHaveBeenCalled();
    fakes.redis.status = 'ready';
  });

  it('never overlaps relay passes, and survives failing passes', async () => {
    let finish: () => void = () => undefined;
    relay.relayDueImports.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => {
            resolve(1);
          };
        }),
    );
    const running = runner();
    running.onApplicationBootstrap();
    const first = running.relayOnce();
    await running.relayOnce();
    expect(relay.relayDueImports).toHaveBeenCalledTimes(1);
    finish();
    await first;
    relay.relayDueImports.mockRejectedValue(new Error('database down'));
    await running.relayOnce();
    await running.relayOnce();
    expect(relay.relayDueImports).toHaveBeenCalledTimes(3);
    imports.tidyImports.mockRejectedValueOnce(new Error('database down'));
    await expect(running.tidyOnce()).resolves.toBeUndefined();
    await running.onApplicationShutdown();
  });

  it('runs each job, and alerts with ids only when an import is given up', async () => {
    const running = runner();
    running.onApplicationBootstrap();
    imports.runImport.mockResolvedValueOnce('done');
    await expect(fakes.processor?.(JOB)).resolves.toBe('done');
    expect(imports.runImport).toHaveBeenCalledWith({}, JOB.data, OPTIONS.clock);
    expect(runtime.raiseAlert).not.toHaveBeenCalled();
    imports.runImport.mockResolvedValueOnce('failed');
    await expect(fakes.processor?.(JOB)).resolves.toBe('failed');
    expect(runtime.raiseAlert).toHaveBeenCalledWith('Client import failed', JOB.data);
    // A job without a valid batch is refused before anything runs.
    await expect(fakes.processor?.({ data: { batchId: 'x' } })).rejects.toThrow();
    fakes.failed?.(JOB, new Error('database down'));
    await running.onApplicationShutdown();
  });

  it('the module provides the runner with its options', () => {
    const module = ImportsModule.forRoot(OPTIONS);
    expect(module.exports).toEqual([ImportsRunner]);
    expect(module.providers).toContainEqual(expect.objectContaining({ useValue: OPTIONS }));
  });
});
