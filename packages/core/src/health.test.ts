import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from './clock.js';
import { HealthCheckTimeoutError, runHealthChecks } from './health.js';

const clock = new ManualClock('2026-10-15T14:30:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('runHealthChecks', () => {
  it('reports ok when every check passes', async () => {
    const report = await runHealthChecks({
      service: 'api',
      checks: { database: () => Promise.resolve(), redis: () => Promise.resolve('PONG') },
      clock,
      timeoutMs: 100,
    });

    expect(report).toEqual({
      service: 'api',
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
      checkedAt: '2026-10-15T14:30:00.000Z',
    });
  });

  it('reports ok with no checks (liveness)', async () => {
    const report = await runHealthChecks({ service: 'worker', checks: {}, clock, timeoutMs: 100 });
    expect(report.status).toBe('ok');
    expect(report.checks).toEqual({});
  });

  it('marks a rejecting check down, passes the error to onFailure only', async () => {
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const onFailure = vi.fn();

    const report = await runHealthChecks({
      service: 'api',
      checks: { database: () => Promise.reject(error), redis: () => Promise.resolve() },
      clock,
      timeoutMs: 100,
      onFailure,
    });

    expect(report.status).toBe('unavailable');
    expect(report.checks).toEqual({ database: 'down', redis: 'up' });
    expect(JSON.stringify(report)).not.toContain('ECONNREFUSED');
    expect(onFailure).toHaveBeenCalledExactlyOnceWith('database', error);
  });

  it('marks a synchronously throwing check down', async () => {
    const report = await runHealthChecks({
      service: 'api',
      checks: {
        database: () => {
          throw new Error('boom');
        },
      },
      clock,
      timeoutMs: 100,
    });
    expect(report.checks).toEqual({ database: 'down' });
  });

  it('marks a hanging check down after the timeout', async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();

    const pending = runHealthChecks({
      service: 'worker',
      checks: { redis: () => new Promise(() => undefined) },
      clock,
      timeoutMs: 2_000,
      onFailure,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const report = await pending;

    expect(report.checks).toEqual({ redis: 'down' });
    expect(onFailure).toHaveBeenCalledWith('redis', expect.any(HealthCheckTimeoutError));
  });

  it('clears its timers when checks settle', async () => {
    vi.useFakeTimers();
    await runHealthChecks({
      service: 'api',
      checks: { database: () => Promise.resolve() },
      clock,
      timeoutMs: 2_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s', async (ms) => {
    await expect(
      runHealthChecks({ service: 'api', checks: {}, clock, timeoutMs: ms }),
    ).rejects.toThrow(RangeError);
  });
});
