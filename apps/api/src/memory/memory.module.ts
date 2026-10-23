import { Module } from '@nestjs/common';
import { MemoryController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';

/** What Pepper remembers, `/v1/memory`. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [MemoryController],
  providers: [MemoryService],
})
export class MemoryModule {}
