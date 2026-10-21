import type { Clock } from '@pepper/core';

// A circuit breaker for the model provider (ADR-0030, AC-X-2, OWASP agentic ASI08 cascading
// failures): after a few failures in a row the loop stops calling for a while and answers with
// the fallback at once, so a provider outage costs neither the member's time nor tokens. One
// call is let through after the pause to see whether the provider is back.

export interface BreakerOptions {
  /** Failures in a row that open the breaker. */
  failures: number;
  /** How long it stays open before one call may try again. */
  openForMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failures: 3, openForMs: 30_000 };

export class CircuitBreaker {
  private failuresInARow = 0;
  private openUntil: number | null = null;
  private probing = false;

  constructor(
    private readonly clock: Clock,
    private readonly options: BreakerOptions = DEFAULT_BREAKER,
  ) {}

  /** Whether a call may go out now. While half-open, only one at a time does. */
  allow(): boolean {
    if (this.openUntil === null) return true;
    if (this.clock.now().getTime() < this.openUntil || this.probing) return false;
    this.probing = true;
    return true;
  }

  /** A call answered: the provider is up. */
  succeeded(): void {
    this.failuresInARow = 0;
    this.openUntil = null;
    this.probing = false;
  }

  /** A call failed for the provider's reasons (not the member's, not a cancel). */
  failed(): void {
    this.probing = false;
    this.failuresInARow += 1;
    if (this.failuresInARow >= this.options.failures) {
      this.openUntil = this.clock.now().getTime() + this.options.openForMs;
    }
  }

  /** A call that ended without telling us about the provider (cancelled): lets the probe go. */
  released(): void {
    this.probing = false;
  }

  get isOpen(): boolean {
    return this.openUntil !== null && this.clock.now().getTime() < this.openUntil;
  }
}
