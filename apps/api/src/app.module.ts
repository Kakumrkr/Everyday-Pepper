import { outboxKeyFrom } from '@pepper/core';
import { ConnectionsModule, HealthModule, MailModule } from '@pepper/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BookingEmailsModule } from './booking-emails/booking-emails.js';
import { ClientsModule } from './clients/clients.module.js';
import type { ApiConfig } from './config.js';
import { PublicBookingModule } from './public-booking/public-booking.module.js';
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
        TasksModule,
        AppointmentsModule,
        MailModule.forRoot(config.mail),
        BookingEmailsModule.forRoot({
          baseUrl: config.auth.baseUrl,
          outboxKey: outboxKeyFrom(config.outboxSecret),
        }),
        PublicBookingModule.forRoot({ codeKey: config.bookingCodeKey }),
      ],
    };
  }
}
