import type { HealthReport, ServiceName } from '@floty/contracts';
import { runHealthChecks, type Clock } from '@floty/core';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CLOCK,
  READINESS_CHECKS,
  READINESS_TIMEOUT_MS,
  SERVICE_NAME,
  type ReadinessChecks,
} from './health.tokens.js';

@Controller('health')
export class HealthController {
  readonly #logger = new Logger(HealthController.name);

  constructor(
    @Inject(SERVICE_NAME) private readonly service: ServiceName,
    @Inject(READINESS_CHECKS) private readonly checks: ReadinessChecks,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The process is up and serving HTTP. Does not touch dependencies. */
  @Get('live')
  @Header('Cache-Control', 'no-store')
  live(): Promise<HealthReport> {
    return this.#run({});
  }

  /** Every dependency is reachable. Answers 503 with the same body shape when one is not. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(): Promise<HealthReport> {
    const report = await this.#run(this.checks);
    if (report.status !== 'ok') {
      throw new ServiceUnavailableException(report);
    }
    return report;
  }

  #run(checks: ReadinessChecks): Promise<HealthReport> {
    return runHealthChecks({
      service: this.service,
      checks,
      clock: this.clock,
      timeoutMs: READINESS_TIMEOUT_MS,
      onFailure: (name, error) => {
        this.#logger.warn(`Readiness check "${name}" failed: ${describe(error)}`);
      },
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
