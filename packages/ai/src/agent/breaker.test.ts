import { ManualClock } from '@pepper/core';
import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './breaker.js';

describe('CircuitBreaker', () => {
  it('opens after failures in a row, lets one probe through after the pause, and closes on success', () => {
    const clock = new ManualClock(new Date('2026-10-21T15:00:00Z'));
    const breaker = new CircuitBreaker(clock, { failures: 3, openForMs: 30_000 });
    breaker.failed();
    breaker.failed();
    expect(breaker.allow()).toBe(true);
    breaker.failed();
    expect([breaker.isOpen, breaker.allow()]).toEqual([true, false]);
    clock.advanceBy(30_000);
    expect(breaker.allow()).toBe(true);
    // Only one probe at a time.
    expect(breaker.allow()).toBe(false);
    breaker.failed();
    expect(breaker.allow()).toBe(false);
    clock.advanceBy(30_000);
    expect(breaker.allow()).toBe(true);
    breaker.succeeded();
    expect([breaker.isOpen, breaker.allow(), breaker.allow()]).toEqual([false, true, true]);
  });

  it('a success resets the count, and a cancelled probe frees the next one', () => {
    const clock = new ManualClock(new Date('2026-10-21T15:00:00Z'));
    const breaker = new CircuitBreaker(clock, { failures: 2, openForMs: 1_000 });
    breaker.failed();
    breaker.succeeded();
    breaker.failed();
    expect(breaker.allow()).toBe(true);
    breaker.failed();
    clock.advanceBy(1_000);
    expect(breaker.allow()).toBe(true);
    breaker.released();
    expect(breaker.allow()).toBe(true);
  });
});
