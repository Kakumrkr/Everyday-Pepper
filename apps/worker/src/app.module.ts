import { outboxKeyFrom } from '@pepper/core';
import { ConnectionsModule, HealthModule, MailModule } from '@pepper/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from './config.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { episodeWriterFor } from './outbox/episodes.js';
import { WebPusher } from './push/web-pusher.js';
import { WaitlistModule } from './waitlist/waitlist.module.js';

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
          pusher: config.push === null ? null : new WebPusher(config.push),
          episodes: config.episodes === null ? null : episodeWriterFor(config.episodes),
        }),
        JobsModule.forRoot({
          key: outboxKeyFrom(config.outboxSecret),
          reminderPollMs: config.reminderPollMs,
          cleanupIntervalMs: config.cleanupIntervalMs,
          insightsPollMs: config.insightsPollMs,
          drafts: config.drafts,
          pushes: config.push !== null,
        }),
        ...(config.waitlist === null
          ? []
          : [
              WaitlistModule.forRoot({
                redisUrl: config.redisUrl,
                key: outboxKeyFrom(config.outboxSecret),
                baseUrl: config.waitlist.baseUrl,
                pollMs: config.waitlist.pollMs,
              }),
            ]),
      ],
    };
  }
}
