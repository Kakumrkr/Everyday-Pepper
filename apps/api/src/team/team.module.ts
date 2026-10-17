import { Module } from '@nestjs/common';
import { InvitesController } from './invites.controller.js';
import { InvitesService } from './invites.service.js';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

/** The team, invite and audit log endpoints. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({
  controllers: [TeamController, InvitesController],
  providers: [TeamService, InvitesService],
})
export class TeamModule {}
