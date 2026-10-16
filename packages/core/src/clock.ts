import { UtcDateTimeSchema, type UtcDateTime } from '@floty/contracts';

/**
 * Source of the current time. Domain code takes a Clock instead of calling `new Date()`
 * so tests can control time (DST transitions, reminders, undo windows).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock for tests: starts at `start` and only moves when told to. */
export class ManualClock implements Clock {
  #current: number;

  constructor(start: Date | string) {
    this.#current = toEpochMs(start);
  }

  now(): Date {
    return new Date(this.#current);
  }

  set(to: Date | string): void {
    this.#current = toEpochMs(to);
  }

  advanceBy(ms: number): void {
    if (!Number.isFinite(ms)) {
      throw new RangeError(`advanceBy expects a finite number of milliseconds, got ${String(ms)}`);
    }
    this.#current += ms;
  }
}

/** The clock's current instant as a UTC ISO string. */
export function utcNow(clock: Clock): UtcDateTime {
  return UtcDateTimeSchema.parse(clock.now().toISOString());
}

function toEpochMs(value: Date | string): number {
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`Invalid date: ${String(value)}`);
  }
  return ms;
}
