import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';

/** The operator feed. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [FeedController],
  providers: [FeedService],
})
export class FeedModule {}
