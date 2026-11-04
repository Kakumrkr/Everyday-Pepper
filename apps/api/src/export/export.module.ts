import { Module } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

/** The business export (S51, ADR-0053). Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [ExportController],
  providers: [ExportService, RateLimiter],
})
export class ExportModule {}
