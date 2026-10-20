import { outboxKeyFrom } from '@pepper/core';
import { ConnectionsModule, HealthModule, MailModule } from '@pepper/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from './config.js';
import { OutboxModule } from './outbox/outbox.module.js';

@Module({})
export class AppModule {
  static forRoot(config: WorkerConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConnectionsModule.forRoot({ databaseUrl: config.databaseUrl, redisUrl: config.redisUrl }),
        HealthModule.forRoot({ service: config.service }),
        MailModule.forRoot(config.mail),
        OutboxModule.forRoot({
          redisUrl: config.redisUrl,
          key: outboxKeyFrom(config.outboxSecret),
          pollMs: config.outboxPollMs,
        }),
      ],
    };
  }
}
