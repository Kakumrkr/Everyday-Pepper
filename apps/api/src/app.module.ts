import { outboxKeyFrom } from '@pepper/core';
import { ConnectionsModule, HealthModule, MailModule } from '@pepper/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BookingEmailsModule } from './booking-emails/booking-emails.js';
import { ChatModule } from './chat/chat.module.js';
import { ClientsModule } from './clients/clients.module.js';
import { DeletionModule } from './deletion/deletion.module.js';
import { ScreenshotStoreModule } from './support/screenshot-store.js';
import { ExportModule } from './export/export.module.js';
import { ImportsModule } from './imports/imports.module.js';
import { MemoryModule } from './memory/memory.module.js';
import type { ApiConfig } from './config.js';
import { PhotosModule } from './photos/photos.module.js';
import { PublicBookingModule } from './public-booking/public-booking.module.js';
import { UnsubscribeModule } from './unsubscribe/unsubscribe.controller.js';
import { PushModule } from './push/push.module.js';
import { FeedModule } from './feed/feed.module.js';
import { InboundModule } from './inbound/inbound.controller.js';
import { SupportModule } from './support/support.controller.js';
import { TasksModule } from './tasks/tasks.module.js';
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
        ClientsModule,
        ImportsModule,
        ExportModule,
        DeletionModule,
        MemoryModule,
        TasksModule,
        FeedModule,
        AppointmentsModule,
        MailModule.forRoot(config.mail),
        BookingEmailsModule.forRoot({
          baseUrl: config.auth.baseUrl,
          outboxKey: outboxKeyFrom(config.outboxSecret),
        }),
        PushModule.forRoot({
          publicKey: config.pushPublicKey,
          outboxKey: outboxKeyFrom(config.outboxSecret),
        }),
        PublicBookingModule.forRoot({
          codeKey: config.bookingCodeKey,
          secureCookies: config.auth.baseUrl.startsWith('https:'),
        }),
        PhotosModule.forRoot(config.storage),
        ScreenshotStoreModule.forRoot(config.storage),
        UnsubscribeModule.forRoot({ outboxKey: outboxKeyFrom(config.outboxSecret) }),
        SupportModule.forRoot({
          outboxKey: outboxKeyFrom(config.outboxSecret),
          supportEmail: config.supportEmail,
          baseUrl: config.auth.baseUrl,
          release: config.release ?? 'unknown',
          inboundDomain: config.inbound.domain,
        }),
        InboundModule.forRoot({ webhookSecret: config.inbound.webhookSecret }),
        ChatModule.forRoot({
          openai: config.ai.openai,
          scripted: config.ai.scripted,
          monthlyTokens: config.ai.monthlyTokens,
          baseUrl: config.auth.baseUrl,
          outboxKey: outboxKeyFrom(config.outboxSecret),
        }),
      ],
    };
  }
}
