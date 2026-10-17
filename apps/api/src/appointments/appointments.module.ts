import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller.js';
import { AppointmentsService } from './appointments.service.js';

/** Services, staff, hours and time off. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
})
export class AppointmentsModule {}
