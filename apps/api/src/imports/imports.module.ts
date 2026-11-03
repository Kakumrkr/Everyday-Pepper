import { Module } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { ImportsController } from './imports.controller.js';
import { ImportsService } from './imports.service.js';

/** Client import (S48, ADR-0049). Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [ImportsController],
  providers: [ImportsService, RateLimiter],
})
export class ImportsModule {}
