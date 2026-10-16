import type { ServiceName } from '@floty/contracts';
import { systemClock } from '@floty/core';
import { Module, type DynamicModule } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { CLOCK, SERVICE_NAME } from './health.tokens.js';

/**
 * `GET /health/live` and `GET /health/ready` for `service`.
 * Readiness runs the `READINESS_CHECKS` provided by a global module (`ConnectionsModule`).
 */
@Module({})
export class HealthModule {
  static forRoot(options: { service: ServiceName }): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: SERVICE_NAME, useValue: options.service },
        { provide: CLOCK, useValue: systemClock },
      ],
    };
  }
}
