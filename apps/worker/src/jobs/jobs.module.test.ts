import 'reflect-metadata';
import type * as Core from '@pepper/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobsRunner, type JobsOptions } from './jobs.module.js';

// The runner's wiring with the domain passes replaced; the real ones run against Postgres in
// jobs.int.test.ts.

const appointments = vi.hoisted(() => ({ sendDueReminders: vi.fn() }));
vi.mock('@pepper/appointments', () => appointments);
const core = vi.hoisted(() => ({ cleanUp: vi.fn() }));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  cleanUp: core.cleanUp,
}));
vi.mock('@pepper/runtime', () => ({ DATABASE: Symbol('DATABASE') }));

const DB = { db: true };
const clock = { now: () => new Date('2026-11-02T15:00:00Z') };
const OPTIONS: JobsOptions = {
  key: Buffer.alloc(32, 3),
  reminderPollMs: 60_000,
  cleanupIntervalMs: 86_400_000,
  clock,
};

beforeEach(() => {
  vi.clearAllMocks();
  appointments.sendDueReminders.mockResolvedValue({ queued: 1, skipped: 0 });
  core.cleanUp.mockResolvedValue({ businesses: 2, bookingRequests: 3, outboxMessages: 4 });
});

describe('JobsRunner', () => {
  it('queues due reminders with the outbox key and the clock', async () => {
    const runner = new JobsRunner(DB as never, OPTIONS);
    await runner.reminders.runOnce();
    expect(appointments.sendDueReminders).toHaveBeenCalledWith(DB.db, {
      key: OPTIONS.key,
      clock,
    });
  });

  it('cleans up with the clock', async () => {
    const runner = new JobsRunner(DB as never, OPTIONS);
    await runner.cleanup.runOnce();
    expect(core.cleanUp).toHaveBeenCalledWith(DB.db, { clock });
  });

  it('starts the clean-up at once and the reminders on their interval, and stops both', async () => {
    vi.useFakeTimers();
    try {
      const { key, reminderPollMs, cleanupIntervalMs } = OPTIONS;
      // No clock: the system clock.
      const runner = new JobsRunner(DB as never, { key, reminderPollMs, cleanupIntervalMs });
      runner.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      expect(core.cleanUp).toHaveBeenCalledTimes(1);
      expect(appointments.sendDueReminders).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(appointments.sendDueReminders).toHaveBeenCalledTimes(1);
      await runner.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(10 * 86_400_000);
      expect(appointments.sendDueReminders).toHaveBeenCalledTimes(1);
      expect(core.cleanUp).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
