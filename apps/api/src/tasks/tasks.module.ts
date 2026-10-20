import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

/** The business's to-dos. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
