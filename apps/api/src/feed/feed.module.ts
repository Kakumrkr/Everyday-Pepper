import { Module } from '@nestjs/common';
import { FeedController } from './feed.controller.js';
import { FeedService } from './feed.service.js';
import { ProofController, ProofService } from './proof.controller.js';

/** The operator feed and the proof of value (S55). Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [FeedController, ProofController],
  providers: [FeedService, ProofService],
})
export class FeedModule {}
