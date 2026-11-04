import { Module } from '@nestjs/common';
import { RateLimiter } from '../http/rate-limit.js';
import { DeletionController } from './deletion.controller.js';

/**
 * Deleting the business or the account (S51.2, ADR-0054). Needs `AuthModule` (global) and
 * `ConnectionsModule`; the worker does the deleting once the day comes.
 */
@Module({
  controllers: [DeletionController],
  providers: [RateLimiter],
})
export class DeletionModule {}
