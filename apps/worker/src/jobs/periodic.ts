import type { Logger } from '@nestjs/common';

// A pass that runs every `everyMs` in this process: passes never overlap, a failing pass is
// logged once (its error's name only) until one succeeds again, and `stop` waits for the pass
// in flight, so nothing uses the database after shutdown has closed it.

export class Periodic {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private failing = false;

  constructor(
    private readonly name: string,
    private readonly everyMs: number,
    private readonly pass: () => Promise<unknown>,
    private readonly logger: Pick<Logger, 'warn'>,
  ) {}

  /** Starts the timer; with `immediately`, the first pass runs now. */
  start(options: { immediately?: boolean } = {}): void {
    this.timer = setInterval(() => void this.runOnce(), this.everyMs);
    if (options.immediately === true) void this.runOnce();
  }

  /** One pass, unless one is running. */
  async runOnce(): Promise<void> {
    if (this.running !== undefined) return;
    this.running = this.pass().then(
      () => {
        this.failing = false;
      },
      (error: unknown) => {
        if (!this.failing) {
          this.logger.warn(`${this.name} failed: ${error instanceof Error ? error.name : 'error'}`);
        }
        this.failing = true;
      },
    );
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }
}
