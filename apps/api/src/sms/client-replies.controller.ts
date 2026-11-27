import { replyToClientText, undoClientTextReply } from '@pepper/appointments';
import {
  ClientIdSchema,
  ClientTextReplyRequestSchema,
  ClientTextReplySchema,
  ClientTextUndoSchema,
  type ClientTextReply,
} from '@pepper/contracts';
import { systemClock, type Actor, type Clock, type TenantContext } from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { z } from 'zod';
import { apiError, CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering, TooManyRequestsException } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';

// A member's reply to a client's text (S80, ADR-0072, AC-X-233): owners and managers write it on
// the text's card or the client's profile; it goes as a text from the business, held for Undo
// and the quiet hours, under the client's consent. Neither the words nor a number is logged.

export interface ClientRepliesOptions {
  outboxKey: Buffer;
  /** Whether this deployment sends texts (`SMS_PROVIDER` set). */
  texts: boolean;
  clock?: Clock;
}

export const CLIENT_REPLIES_OPTIONS = Symbol('CLIENT_REPLIES_OPTIONS');

// A reply costs a text: at most 60 an hour per business.
const REPLIES_PER_TENANT: RateLimit = { name: 'client-reply-tenant', max: 60, windowSeconds: 3600 };

const ClientParamsSchema = z.object({ clientId: ClientIdSchema });
const ReplyParamsSchema = z.object({ clientId: ClientIdSchema, replyId: z.uuid() });

@Controller('v1/clients')
@UseGuards(TenantGuard)
export class ClientRepliesController {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(CLIENT_REPLIES_OPTIONS) private readonly options: ClientRepliesOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
  }

  /**
   * 201 `{ replyId, sendsAt }`; 409 `texts_off` or `client_not_textable` (no consent in force,
   * or the number replied STOP); 422 `reply_too_long` (with the business's name it doesn't fit
   * one text); 404 `client_not_found` or `feed_item_not_found`; 429 over 60 an hour.
   */
  @Post(':clientId/texts/replies')
  @RequirePermission('clients.manage')
  async reply(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<ClientTextReply> {
    const { clientId } = parseBody(ClientParamsSchema, params);
    const request = parseBody(ClientTextReplyRequestSchema, body);
    // Only a queued reply counts: a refused one costs no text.
    if (await this.limits.spent(REPLIES_PER_TENANT, tenant.tenantId)) {
      throw new TooManyRequestsException(apiError('too_many_requests'));
    }
    const reply = ClientTextReplySchema.parse(
      await answering(() =>
        replyToClientText(this.db, actorOf(tenant), clientId, request, {
          texts: this.options.texts,
          outboxKey: this.options.outboxKey,
          clock: this.clock(),
        }),
      ),
    );
    await this.limits.hit(REPLIES_PER_TENANT, tenant.tenantId).catch(() => undefined);
    return reply;
  }

  /** Undo: 200 `{ outcome: 'taken_back' | 'too_late' }`; 404 `reply_not_found`. */
  @Delete(':clientId/texts/replies/:replyId')
  @HttpCode(200)
  @RequirePermission('clients.manage')
  async undo(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<z.infer<typeof ClientTextUndoSchema>> {
    const { clientId, replyId } = parseBody(ReplyParamsSchema, params);
    return ClientTextUndoSchema.parse(
      await answering(() =>
        undoClientTextReply(this.db, actorOf(tenant), clientId, replyId, {
          clock: this.clock(),
        }),
      ),
    );
  }

  private clock(): Clock {
    return this.options.clock ?? systemClock;
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}

/** Replies to clients' texts. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({})
export class ClientRepliesModule {
  static forRoot(options: ClientRepliesOptions): DynamicModule {
    return {
      module: ClientRepliesModule,
      controllers: [ClientRepliesController],
      providers: [{ provide: CLIENT_REPLIES_OPTIONS, useValue: options }, RateLimiter],
    };
  }
}
