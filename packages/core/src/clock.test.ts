import { describe, expect, it } from 'vitest';
import { ManualClock, systemClock, utcNow } from './clock.js';

describe('systemClock', () => {
  it('returns the current time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });
});

describe('ManualClock', () => {
  it('starts at the given instant and does not move by itself', () => {
    const clock = new ManualClock('2026-10-15T14:30:00Z');
    expect(clock.now().toISOString()).toBe('2026-10-15T14:30:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-10-15T14:30:00.000Z');
  });

  it('accepts a Date and returns copies that callers cannot mutate', () => {
    const clock = new ManualClock(new Date('2026-10-15T14:30:00Z'));
    clock.now().setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-15T14:30:00.000Z');
  });

  it('advances by milliseconds and can be set', () => {
    const clock = new ManualClock('2026-10-15T14:30:00Z');
    clock.advanceBy(90 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-10-15T16:00:00.000Z');
    clock.set('2026-11-01T06:00:00Z');
    expect(clock.now().toISOString()).toBe('2026-11-01T06:00:00.000Z');
  });

  it('crosses the US DST change as a plain UTC instant', () => {
    // US DST ends 2026-11-01 at 06:00Z: 01:30 EDT plus one hour is 01:30 EST, no gap or repeat in UTC.
    const clock = new ManualClock('2026-11-01T05:30:00Z');
    clock.advanceBy(60 * 60 * 1000);
    expect(clock.now().toISOString()).toBe('2026-11-01T06:30:00.000Z');
  });

  it('rejects invalid input', () => {
    expect(() => new ManualClock('not a date')).toThrow(RangeError);
    const clock = new ManualClock('2026-10-15T14:30:00Z');
    expect(() => {
      clock.set(new Date(Number.NaN));
    }).toThrow(RangeError);
    expect(() => {
      clock.advanceBy(Number.NaN);
    }).toThrow(RangeError);
    expect(() => {
      clock.advanceBy(Number.POSITIVE_INFINITY);
    }).toThrow(RangeError);
  });
});

describe('utcNow', () => {
  it('returns the clock time as a UTC ISO string', () => {
    expect(utcNow(new ManualClock('2026-10-15T10:30:00-04:00'))).toBe('2026-10-15T14:30:00.000Z');
  });
});
