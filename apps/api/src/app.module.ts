import { ConnectionsModule, HealthModule } from '@floty/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import type { ApiEnv } from './config.js';

@Module({})
export class AppModule {
  static forRoot(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConnectionsModule.forRoot({ databaseUrl: env.DATABASE_URL, redisUrl: env.REDIS_URL }),
        HealthModule.forRoot({ service: 'api' }),
      ],
    };
  }
}
