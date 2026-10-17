import { ConnectionsModule, HealthModule } from '@floty/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AuthModule } from './auth/auth.module.js';
import type { ApiConfig } from './config.js';
import { TeamModule } from './team/team.module.js';

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConnectionsModule.forRoot({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl }),
        HealthModule.forRoot({ service: config.service }),
        AuthModule.forRoot(config.auth),
        TeamModule,
        AppointmentsModule,
      ],
    };
  }
}
