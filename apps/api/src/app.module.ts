import { ConnectionsModule, HealthModule } from '@pepper/runtime';
import { Module, type DynamicModule } from '@nestjs/common';
import { AppointmentsModule } from './appointments/appointments.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ClientsModule } from './clients/clients.module.js';
import type { ApiConfig } from './config.js';
import { MailModule } from './mail/mailer.js';
import { PublicBookingModule } from './public-booking/public-booking.module.js';
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
        AppointmentsModule,
        MailModule.forRoot(config.mail),
        PublicBookingModule.forRoot({
          baseUrl: config.auth.baseUrl,
          codeKey: config.bookingCodeKey,
        }),
      ],
    };
  }
}
