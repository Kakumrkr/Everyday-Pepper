import { Module, type DynamicModule } from '@nestjs/common';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';
import { PUSH_OPTIONS, TeamPushes, type PushOptions } from './team-pushes.js';

/**
 * Web Push (ADR-0026): the device endpoints, and `TeamPushes` for every module (the booking
 * page). Needs `AuthModule` (global) and `ConnectionsModule`.
 */
@Module({})
export class PushModule {
  static forRoot(options: PushOptions): DynamicModule {
    return {
      module: PushModule,
      global: true,
      controllers: [PushController],
      providers: [{ provide: PUSH_OPTIONS, useValue: options }, PushService, TeamPushes],
      exports: [TeamPushes],
    };
  }
}
