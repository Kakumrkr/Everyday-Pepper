import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

/**
 * Services, staff, hours, time off, rules, bookings, availability and the waitlist. Needs
 * `AuthModule` (global), `ConnectionsModule` and `BookingEmailsModule` (global).
 */
@Module({
  controllers: [AppointmentsController, BookingsController],
  providers: [AppointmentsService, BookingsService],
})
export class AppointmentsModule {}
