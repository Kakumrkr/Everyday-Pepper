import { ConnectionsModule, HealthModule, type ServiceConfig } from '@floty/runtime';
import { Module, type DynamicModule } from '@nestjs/common';

@Module({})
export class AppModule {
  static forRoot(config: ServiceConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConnectionsModule.forRoot({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl }),
        HealthModule.forRoot({ service: config.service }),
      ],
    };
  }
}
