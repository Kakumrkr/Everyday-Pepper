import { Module } from '@nestjs/common';
import { TeamController } from './team.controller.js';
import { TeamService } from './team.service.js';

/** The team and audit log endpoints. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({ controllers: [TeamController], providers: [TeamService] })
export class TeamModule {}
