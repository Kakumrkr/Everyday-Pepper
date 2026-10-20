import { Module, type DynamicModule } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { PublicBookingController } from './public-booking.controller.js';
import {
  PUBLIC_BOOKING_OPTIONS,
  PublicBookingService,
  type PublicBookingOptions,
} from './public-booking.service.js';

/** The public booking page (ADR-0022). Needs `ConnectionsModule` and `MailModule`. */
@Module({})
export class PublicBookingModule {
  static forRoot(options: PublicBookingOptions): DynamicModule {
    return {
      module: PublicBookingModule,
      controllers: [PublicBookingController],
      providers: [
        { provide: PUBLIC_BOOKING_OPTIONS, useValue: options },
        PublicBookingService,
        RateLimiter,
      ],
    };
  }
}
