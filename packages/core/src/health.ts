import type { HealthCheckStatus, HealthReport, ServiceName } from '@floty/contracts';
import { utcNow, type Clock } from './clock.js';

/** A dependency probe: resolves when the dependency is reachable, rejects (or hangs) otherwise. */
export type HealthCheck = () => Promise<unknown>;

export interface RunHealthChecksOptions {
  service: ServiceName;
  checks: Readonly<Record<string, HealthCheck>>;
  clock: Clock;
  /** A check that has not settled after this long counts as down. */
  timeoutMs: number;
  /** Called with the failure of each check that is down, for server-side logging. */
  onFailure?: (name: string, error: unknown) => void;
}

/** Thrown (and passed to `onFailure`) when a check does not settle within `timeoutMs`. */
export class HealthCheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Health check timed out after ${String(timeoutMs)} ms`);
    this.name = 'HealthCheckTimeoutError';
  }
}

/**
 * Runs all checks in parallel, each bounded by `timeoutMs`, and summarises them.
 * The report says only up/down per check; error details go to `onFailure`, never to the caller.
 */
export async function runHealthChecks(options: RunHealthChecksOptions): Promise<HealthReport> {
  const { service, checks, clock, timeoutMs, onFailure } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive number, got ${String(timeoutMs)}`);
  }

  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, check]): Promise<[string, HealthCheckStatus]> => {
      try {
        await withTimeout(check, timeoutMs);
        return [name, 'up'];
      } catch (error: unknown) {
        onFailure?.(name, error);
        return [name, 'down'];
      }
    }),
  );

  const results = Object.fromEntries(entries);
  return {
    service,
    status: entries.every(([, status]) => status === 'up') ? 'ok' : 'unavailable',
    checks: results,
    checkedAt: utcNow(clock),
  };
}

async function withTimeout(check: HealthCheck, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HealthCheckTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    // A check that throws synchronously is still reported as down.
    await Promise.race([Promise.resolve().then(check), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
