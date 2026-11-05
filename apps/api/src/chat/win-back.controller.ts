import {
  ClientIdSchema,
  WinBackDraftResultSchema,
  WinBackResponseSchema,
  type ClientId,
  type WinBackDraftResult,
  type WinBackResponse,
} from '@pepper/contracts';
import { draftWinBack } from '@pepper/ai';
import { listWinBackIn } from '@pepper/appointments';
import type { Clock, TenantContext } from '@pepper/core';
import { withTenant, type Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { actorOf, CHAT_CLOCK, ChatService } from './chat.service.js';

const ClientParamsSchema = z.object({ clientId: ClientIdSchema });

/** The win-back domain calls for a request (the draft through the chat's tool deps). */
@Injectable()
export class WinBackService {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(CHAT_CLOCK) private readonly clock: Clock,
    private readonly chat: ChatService,
  ) {
    this.db = database.db;
  }

  list(tenant: TenantContext): Promise<WinBackResponse> {
    return withTenant(this.db, tenant.tenantId, (tx) =>
      listWinBackIn(tx, actorOf(tenant), { clock: this.clock }),
    );
  }

  async draft(tenant: TenantContext, clientId: ClientId): Promise<WinBackDraftResult> {
    return draftWinBack(await this.chat.toolDeps(tenant), clientId);
  }
}

/**
 * "Haven't been back", `/v1/win-back` (S54.2, ADR-0057; AC-W4-6…8): the clients past their
 * usual gap with what each is worth, and the one-tap draft. Owners and managers only (403
 * `forbidden` for staff, from the domain); a refused draft is an answer, not an error.
 */
@Controller('v1/win-back')
@UseGuards(TenantGuard)
export class WinBackController {
  constructor(private readonly winBack: WinBackService) {}

  @Get()
  @RequirePermission('clients.read')
  async list(@CurrentTenant() tenant: TenantContext): Promise<WinBackResponse> {
    return WinBackResponseSchema.parse(await answering(() => this.winBack.list(tenant)));
  }

  /** 200 `{ kind: 'drafted', proposalId }` or `{ kind: 'refused', reason }`. */
  @Post(':clientId/draft')
  @HttpCode(200)
  @RequirePermission('bookings.manage')
  async draft(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<WinBackDraftResult> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    return WinBackDraftResultSchema.parse(
      await answering(() => this.winBack.draft(tenant, clientId)),
    );
  }
}
