import {
  MemoryEpisodeIdSchema,
  MemoryEpisodesResponseSchema,
  MemoryFactChangeSchema,
  MemoryFactIdSchema,
  MemoryFactInputSchema,
  MemoryFactSchema,
  MemoryFactsHttpQuerySchema,
  MemoryFactsResponseSchema,
  MemoryFactsShownRequestSchema,
  MemoryFactsShownResponseSchema,
  MemorySettingsSchema,
  type MemoryEpisodesResponse,
  type MemoryFact,
  type MemoryFactsResponse,
  type MemoryFactsShownResponse,
  type MemorySettings,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { MemoryService } from './memory.service.js';

const FactParamsSchema = z.object({ factId: MemoryFactIdSchema });
const EpisodeParamsSchema = z.object({ episodeId: MemoryEpisodeIdSchema });

/**
 * Remembered values must not outlive their deletion in a browser or service-worker cache
 * (playbook §7 S32): no answer here is stored.
 */
const NoStore = () => Header('cache-control', 'private, no-store');

/**
 * What Pepper remembers, `/v1/memory` (S32, ADR-0038): "What I know", the client profile's
 * facts and visit notes, the member's own past conversations, and the business's pause switch.
 * Who may read or change a fact is the memory service's call (ADR-0034: staff read only what
 * the member-scope policies let them, and change only the facts of clients and visits they
 * reach); a fact the member can't read is not found. Answers are checked against the contracts
 * on the way out and are never cached.
 */
@Controller('v1/memory')
@UseGuards(TenantGuard)
export class MemoryController {
  constructor(private readonly memory: MemoryService) {}

  @Get('facts')
  @NoStore()
  @RequirePermission('business.read')
  async facts(
    @CurrentTenant() tenant: TenantContext,
    @Query() query: unknown,
  ): Promise<MemoryFactsResponse> {
    const parsed = parseBody(MemoryFactsHttpQuerySchema, query);
    return MemoryFactsResponseSchema.parse({
      facts: await answering(() => this.memory.facts(tenant, parsed)),
    });
  }

  /** 200 `{ facts }`: each `known` or `gone`, in the order asked. A POST keeps ids out of URLs. */
  @Post('facts/shown')
  @HttpCode(200)
  @NoStore()
  @RequirePermission('ai.chat')
  async shown(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<MemoryFactsShownResponse> {
    const { factIds } = parseBody(MemoryFactsShownRequestSchema, body);
    return MemoryFactsShownResponseSchema.parse({
      facts: await answering(() => this.memory.shown(tenant, factIds)),
    });
  }

  /** 201 the fact (a key the subject has replaces its value); 404 `memory_subject_not_found`. */
  @Post('facts')
  @NoStore()
  @RequirePermission('business.read')
  async save(@CurrentTenant() tenant: TenantContext, @Body() body: unknown): Promise<MemoryFact> {
    const input = parseBody(MemoryFactInputSchema, body);
    return MemoryFactSchema.parse(await answering(() => this.memory.save(tenant, input)));
  }

  /** 404 `memory_fact_not_found`; 403 for a fact the member reads but may not change. */
  @Patch('facts/:factId')
  @NoStore()
  @RequirePermission('business.read')
  async change(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<MemoryFact> {
    const { factId } = parseBody(FactParamsSchema, params);
    const change = parseBody(MemoryFactChangeSchema, body);
    return MemoryFactSchema.parse(
      await answering(() => this.memory.change(tenant, factId, change)),
    );
  }

  /** 204: forgotten everywhere, final (playbook D-11). 404 `memory_fact_not_found`. */
  @Delete('facts/:factId')
  @HttpCode(204)
  @NoStore()
  @RequirePermission('business.read')
  async forget(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { factId } = parseBody(FactParamsSchema, params);
    await answering(() => this.memory.forget(tenant, factId));
  }

  /** The member's own past conversations, newest first. */
  @Get('episodes')
  @NoStore()
  @RequirePermission('ai.chat')
  async episodes(@CurrentTenant() tenant: TenantContext): Promise<MemoryEpisodesResponse> {
    return MemoryEpisodesResponseSchema.parse({
      episodes: await answering(() => this.memory.episodes(tenant)),
    });
  }

  /** 204; 404 `memory_episode_not_found` (also for a colleague's). */
  @Delete('episodes/:episodeId')
  @HttpCode(204)
  @NoStore()
  @RequirePermission('ai.chat')
  async deleteEpisode(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<void> {
    const { episodeId } = parseBody(EpisodeParamsSchema, params);
    await answering(() => this.memory.deleteEpisode(tenant, episodeId));
  }

  @Get('settings')
  @NoStore()
  @RequirePermission('business.read')
  async settings(@CurrentTenant() tenant: TenantContext): Promise<MemorySettings> {
    return MemorySettingsSchema.parse(await answering(() => this.memory.settings(tenant)));
  }

  /** Pauses or resumes remembering new things (owners and managers, playbook D-15). */
  @Put('settings')
  @NoStore()
  @RequirePermission('settings.manage')
  async changeSettings(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<MemorySettings> {
    const settings = parseBody(MemorySettingsSchema, body);
    return MemorySettingsSchema.parse(
      await answering(() => this.memory.changeSettings(tenant, settings)),
    );
  }
}
