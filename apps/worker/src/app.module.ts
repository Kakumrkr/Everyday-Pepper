import { outboxKeyFrom } from '@pepper/core';
import {
  ConnectionsModule,
  HealthModule,
  MailModule,
  ResendInboundSource,
  smsSenderFor,
} from '@pepper/runtime';
import { S3ObjectStore } from '@pepper/storage';
import { Logger, Module, type DynamicModule } from '@nestjs/common';
import type { WorkerConfig } from './config.js';
import { ImportsModule } from './imports/imports.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';
import { episodeWriterFor } from './outbox/episodes.js';
import { WebPusher } from './push/web-pusher.js';
import { WaitlistModule } from './waitlist/waitlist.module.js';

const smsLogger = new Logger('SmsSandbox');

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
          sms: smsSenderFor(config.sms, (line) => {
            smsLogger.log(line);
          }),
          smsStatusBaseUrl: config.smsStatusBaseUrl,
        }),
        JobsModule.forRoot({
          key: outboxKeyFrom(config.outboxSecret),
          reminderPollMs: config.reminderPollMs,
          reminders: { baseUrl: config.support.baseUrl, texts: config.sms !== null },
          cleanupIntervalMs: config.cleanupIntervalMs,
          insightsPollMs: config.insightsPollMs,
          morningPollMs: config.morningPollMs,
          drafts: config.drafts,
          pushes: config.push !== null,
          objectStore: config.storage === null ? null : new S3ObjectStore(config.storage),
          support: config.support,
          inbound:
            config.inbound === null
              ? null
              : {
                  domain: config.inbound.domain,
                  authservId: config.inbound.authservId,
                  source: new ResendInboundSource({ apiKey: config.inbound.resendApiKey }),
                  baseUrl: config.inbound.baseUrl,
                  release: config.release ?? 'unknown',
                  pollMs: config.inbound.pollMs,
                },
        }),
        ImportsModule.forRoot({ redisUrl: config.redisUrl, pollMs: config.importPollMs }),
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
