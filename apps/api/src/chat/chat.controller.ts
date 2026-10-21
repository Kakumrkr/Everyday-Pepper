import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChatTurnRequestSchema,
  ConversationIdSchema,
  ConversationTurnIdSchema,
  type ChatEventEnvelope,
  type ChatHistoryResponse,
  type ChatStatus,
  type ConversationsResponse,
} from '@pepper/contracts';
import type { TenantContext } from '@pepper/core';
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthSession } from '../auth/auth.service.js';
import {
  apiError,
  CurrentSession,
  CurrentTenant,
  RequirePermission,
  TenantGuard,
} from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';
import { ChatService } from './chat.service.js';

const TurnParamsSchema = z.object({ turnId: ConversationTurnIdSchema });
const ConversationParamsSchema = z.object({ conversationId: ConversationIdSchema });
const LastEventIdSchema = z.coerce.number().int().min(0).max(10_000).catch(0);

/** Per member: a turn costs tokens and runs tools (OWASP LLM10/06 unbounded consumption). */
export const MEMBER_TURNS: RateLimit = { name: 'chat-member', max: 20, windowSeconds: 300 };
/** Per business, behind the member limit: a backstop when many members chat at once. */
export const BUSINESS_TURNS: RateLimit = { name: 'chat-business', max: 300, windowSeconds: 3_600 };
/** Per address: before the session's business is known to the limiter. */
export const ADDRESS_TURNS: RateLimit = { name: 'chat-address', max: 60, windowSeconds: 300 };

const HEARTBEAT_MS = 15_000;

/**
 * Chat with the AI, `/v1/chat` (ADR-0030). `POST /v1/chat/turns` starts a turn and answers
 * with its typed events as server-sent events (`id:` is the event's sequence, `event:` its
 * type); `GET /v1/chat/turns/:turnId/events` resumes them after `Last-Event-ID`. Every member
 * reaches only their own conversations; what the AI may do is each tool's own permission.
 */
@Controller('v1/chat')
@UseGuards(TenantGuard)
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly limiter: RateLimiter,
  ) {}

  /** 200 `text/event-stream`; 409 `turn_in_progress`; 429 `too_many_requests`. */
  @Post('turns')
  @RequirePermission('ai.chat')
  async startTurn(
    @CurrentTenant() tenant: TenantContext,
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const input = parseBody(ChatTurnRequestSchema, body);
    await this.limiter.hit(ADDRESS_TURNS, clientAddress(request));
    await this.limiter.hit(MEMBER_TURNS, `${tenant.tenantId}:${tenant.userId}`);
    await this.limiter.hit(BUSINESS_TURNS, tenant.tenantId);
    const started = await answering(() => this.chat.start(tenant, session.user.name, input));
    if (started.kind === 'busy') throw new ConflictException(apiError('turn_in_progress'));
    const turn = await answering(() => this.chat.turn(tenant, started.turnId));
    await this.stream(response, this.chat.follow(tenant, turn, 0, closedOf(response)));
  }

  /** Resumes a turn's events after `Last-Event-ID`; 404 `conversation_not_found`. */
  @Get('turns/:turnId/events')
  @RequirePermission('ai.chat')
  async events(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Req() request: IncomingMessage,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const { turnId } = parseBody(TurnParamsSchema, params);
    const turn = await answering(() => this.chat.turn(tenant, turnId));
    const after = LastEventIdSchema.parse(request.headers['last-event-id']);
    await this.stream(response, this.chat.follow(tenant, turn, after, closedOf(response)));
  }

  /** 202: the turn stops at its next step (a write already started still finishes). */
  @Post('turns/:turnId/cancel')
  @HttpCode(202)
  @RequirePermission('ai.chat')
  async cancel(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { turnId } = parseBody(TurnParamsSchema, params);
    await answering(() => this.chat.cancel(tenant, turnId));
  }

  /** Whether the AI can answer now: `on`, `off` (not set up) or `paused` (allowance used up). */
  @Get('status')
  @RequirePermission('ai.chat')
  status(@CurrentTenant() tenant: TenantContext): Promise<ChatStatus> {
    return answering(() => this.chat.status(tenant));
  }

  @Get('conversations')
  @RequirePermission('ai.chat')
  conversations(@CurrentTenant() tenant: TenantContext): Promise<ConversationsResponse> {
    return answering(() => this.chat.conversations(tenant));
  }

  /** The member's conversation as they see it; 404 `conversation_not_found`. */
  @Get('conversations/:conversationId')
  @RequirePermission('ai.chat')
  history(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<ChatHistoryResponse> {
    const { conversationId } = parseBody(ConversationParamsSchema, params);
    return answering(() => this.chat.history(tenant, conversationId));
  }

  private async stream(
    response: ServerResponse,
    events: AsyncGenerator<ChatEventEnvelope>,
  ): Promise<void> {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'private, no-store, no-transform',
      connection: 'keep-alive',
      // Tells a buffering proxy (nginx) to pass events on at once.
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    const heartbeat = setInterval(() => {
      response.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);
    try {
      for await (const { seq, event } of events) {
        response.write(sseFrame(seq, event.type, event));
      }
    } catch {
      // The turn keeps running; the client can resume with Last-Event-ID.
    } finally {
      clearInterval(heartbeat);
      if (!response.destroyed) response.end();
    }
  }
}

/** One server-sent event: the JSON is on one line, so it can't end the frame early. */
export function sseFrame(seq: number, type: string, data: unknown): string {
  return `id: ${String(seq)}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Whether the client has gone. The response's `close` (not the request's, which comes as soon
 * as its body was read) is the connection closing before the stream ended.
 */
function closedOf(response: ServerResponse): () => boolean {
  let closed = false;
  response.once('close', () => {
    closed = true;
  });
  return () => closed;
}
