import { Logger } from '@nestjs/common';
import 'reflect-metadata';
import type * as Core from '@pepper/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { templateInsights } from '@pepper/templates';
import { JobsRunner, type JobsOptions } from './jobs.module.js';

// The runner's wiring with the domain passes replaced; the real ones run against Postgres in
// jobs.int.test.ts.

const appointments = vi.hoisted(() => ({
  sendDueReminders: vi.fn(),
  runDueInsights: vi.fn(),
  runDueBriefings: vi.fn(),
}));
vi.mock('@pepper/appointments', () => appointments);
const core = vi.hoisted(() => ({
  cleanUp: vi.fn(),
  sendDueTaskPushes: vi.fn(),
  runSupportHousekeeping: vi.fn(),
}));
vi.mock('@pepper/core', async (original) => ({
  ...(await original<typeof Core>()),
  cleanUp: core.cleanUp,
  sendDueTaskPushes: core.sendDueTaskPushes,
  runSupportHousekeeping: core.runSupportHousekeeping,
}));
vi.mock('@pepper/runtime', () => ({ DATABASE: Symbol('DATABASE'), MAILER: Symbol('MAILER') }));
const drafts = vi.hoisted(() => ({ run: vi.fn(), morningDraftsJob: vi.fn() }));
vi.mock('./drafts.js', () => ({ morningDraftsJob: drafts.morningDraftsJob }));

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
  appointments.runDueInsights.mockResolvedValue({
    businesses: 1,
    created: 2,
    updated: 0,
    expired: 1,
  });
  core.cleanUp.mockResolvedValue({
    businesses: 2,
    bookingRequests: 3,
    outboxMessages: 4,
    expiredProposals: 5,
    conversations: 6,
  });
  core.sendDueTaskPushes.mockResolvedValue(1);
  core.runSupportHousekeeping.mockResolvedValue({ closed: 1, reminded: 2, failed: 0 });
  appointments.runDueBriefings.mockResolvedValue({ businesses: 1, written: 2, pushes: 0 });
  drafts.run.mockResolvedValue({ businesses: 1, drafted: 3, failed: 0 });
  drafts.morningDraftsJob.mockReturnValue(drafts.run);
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

  it("runs due insights with the clock and the templates' thresholds", async () => {
    const runner = new JobsRunner(DB as never, OPTIONS);
    await runner.insights.runOnce();
    expect(appointments.runDueInsights).toHaveBeenCalledWith(DB.db, {
      clock,
      insightsOf: templateInsights,
    });
  });

  it('briefs every morning, with pushes only when this worker sends them (S38a)', async () => {
    await new JobsRunner(DB as never, OPTIONS).morning.runOnce();
    expect(drafts.run).not.toHaveBeenCalled();
    expect(appointments.runDueBriefings).toHaveBeenCalledWith(
      DB.db,
      expect.objectContaining({ clock, insightsOf: templateInsights, pushKey: null }),
    );
    const [, options] = appointments.runDueBriefings.mock.calls[0] as [
      unknown,
      { morningHourOf: (id: null) => number },
    ];
    expect(options.morningHourOf(null)).toBe(7);
    await new JobsRunner(DB as never, { ...OPTIONS, pushes: true }).morning.runOnce();
    expect(appointments.runDueBriefings).toHaveBeenLastCalledWith(
      DB.db,
      expect.objectContaining({ pushKey: OPTIONS.key }),
    );
  });

  it('runs the morning drafts only when configured, before the briefing, built once', async () => {
    const order: string[] = [];
    drafts.run.mockImplementation(() => {
      order.push('drafts');
      return Promise.resolve({ businesses: 1, drafted: 3, failed: 0 });
    });
    appointments.runDueBriefings.mockImplementation(() => {
      order.push('briefing');
      return Promise.resolve({ businesses: 1, written: 2, pushes: 0 });
    });
    const config = {
      openai: {} as never,
      monthlyTokens: 1000,
      baseUrl: 'https://app.example',
      pollMs: 60_000,
    };
    const runner = new JobsRunner(DB as never, { ...OPTIONS, drafts: config });
    expect(drafts.morningDraftsJob).toHaveBeenCalledTimes(1);
    expect(drafts.morningDraftsJob).toHaveBeenCalledWith(DB.db, config, {
      outboxKey: OPTIONS.key,
      clock,
    });
    await runner.morning.runOnce();
    await runner.morning.runOnce();
    expect(order).toEqual(['drafts', 'briefing', 'drafts', 'briefing']);
    expect(drafts.morningDraftsJob).toHaveBeenCalledTimes(1);
  });

  it('still briefs when the drafts pass throws (S38a code review)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    drafts.run.mockRejectedValueOnce(new Error('database down'));
    const runner = new JobsRunner(DB as never, {
      ...OPTIONS,
      drafts: {
        openai: {} as never,
        monthlyTokens: 1000,
        baseUrl: 'https://a.example',
        pollMs: 60_000,
      },
    });
    await runner.morning.runOnce();
    expect(appointments.runDueBriefings).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Morning drafts failed: Error');
    warn.mockRestore();
  });

  it('warns when a morning draft broke, not only refused (S36b code review)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    drafts.run.mockResolvedValueOnce({ businesses: 1, drafted: 0, failed: 2 });
    const runner = new JobsRunner(DB as never, {
      ...OPTIONS,
      drafts: {
        openai: {} as never,
        monthlyTokens: 1000,
        baseUrl: 'https://a.example',
        pollMs: 60_000,
      },
    });
    await runner.morning.runOnce();
    expect(warn).toHaveBeenCalledWith('Morning drafts: 2 failed');
    warn.mockRestore();
  });

  it('runs the insights every minute by default, or on its own interval', async () => {
    vi.useFakeTimers();
    try {
      const runner = new JobsRunner(DB as never, OPTIONS);
      runner.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(appointments.runDueInsights).toHaveBeenCalledTimes(1);
      await runner.onApplicationShutdown();
      appointments.runDueInsights.mockClear();
      const slower = new JobsRunner(DB as never, { ...OPTIONS, insightsPollMs: 300_000 });
      slower.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(appointments.runDueInsights).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(240_000);
      expect(appointments.runDueInsights).toHaveBeenCalledTimes(1);
      await slower.onApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the support job with the team address, the links, the mailer and the clock (S59.2.2)', async () => {
    const mailer = { send: vi.fn() };
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const runner = new JobsRunner(
      DB as never,
      {
        ...OPTIONS,
        support: {
          supportEmail: 'support@pepper.test',
          baseUrl: 'https://app.pepper.test',
          pollMs: 300_000,
        },
      },
      mailer,
    );
    await runner.support.runOnce();
    expect(core.runSupportHousekeeping).toHaveBeenCalledWith(DB.db, {
      outboxKey: OPTIONS.key,
      supportEmail: 'support@pepper.test',
      baseUrl: 'https://app.pepper.test',
      mailer,
      clock,
    });
    // Counts only.
    expect(log).toHaveBeenCalledWith('Support: 2 reminders, 1 closed after quiet days');
    log.mockRestore();
  });

  it('runs the support job without an address, links or mailer when none is configured', async () => {
    const runner = new JobsRunner(DB as never, OPTIONS);
    await runner.support.runOnce();
    expect(core.runSupportHousekeeping).toHaveBeenCalledWith(
      DB.db,
      expect.objectContaining({ supportEmail: null, baseUrl: null, mailer: null }),
    );
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

  it('pushes due to-dos on the reminders interval only when this worker sends pushes', async () => {
    expect(new JobsRunner(DB as never, OPTIONS).dueTasks).toBeNull();
    const runner = new JobsRunner(DB as never, { ...OPTIONS, pushes: true });
    await runner.dueTasks?.runOnce();
    expect(core.sendDueTaskPushes).toHaveBeenCalledWith(DB.db, { key: OPTIONS.key, clock });

    vi.useFakeTimers();
    try {
      core.sendDueTaskPushes.mockClear();
      const timed = new JobsRunner(DB as never, { ...OPTIONS, pushes: true });
      timed.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(core.sendDueTaskPushes).toHaveBeenCalledTimes(1);
      await timed.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(core.sendDueTaskPushes).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
