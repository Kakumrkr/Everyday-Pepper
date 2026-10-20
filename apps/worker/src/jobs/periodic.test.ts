import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Periodic } from './periodic.js';

const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Periodic', () => {
  it('runs a pass every interval, and at once when asked', async () => {
    const pass = vi.fn(() => Promise.resolve());
    const periodic = new Periodic('Job', 1000, pass, logger);
    periodic.start({ immediately: true });
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(pass).toHaveBeenCalledTimes(4);
    await periodic.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pass).toHaveBeenCalledTimes(4);
  });

  it('waits for the first interval by default', async () => {
    const pass = vi.fn(() => Promise.resolve());
    const periodic = new Periodic('Job', 1000, pass, logger);
    periodic.start();
    expect(pass).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(1);
    await periodic.stop();
  });

  it('never overlaps passes, and stop waits for the one in flight', async () => {
    let finish: () => void = () => undefined;
    const pass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const periodic = new Periodic('Job', 1000, pass, logger);
    periodic.start({ immediately: true });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pass).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = periodic.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('logs a failing pass once, by error name, until one succeeds', async () => {
    const pass = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new TypeError('secret detail'))
      .mockRejectedValueOnce(new TypeError('secret detail'))
      .mockResolvedValueOnce()
      .mockRejectedValueOnce('not an error');
    const periodic = new Periodic('Reminder job', 1000, pass, logger);
    for (let i = 0; i < 4; i += 1) await periodic.runOnce();
    expect(logger.warn.mock.calls).toEqual([
      ['Reminder job failed: TypeError'],
      ['Reminder job failed: error'],
    ]);
  });
});
