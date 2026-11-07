import {
  OperatorInboxQuerySchema,
  OperatorInboxSchema,
  OperatorMeSchema,
  OperatorPublicChangeSchema,
  OperatorPublicRequestSchema,
  OperatorThreadChangeSchema,
  OperatorThreadSchema,
  SupportNoteInputSchema,
  SupportReplyInputSchema,
  SupportSavedReplyInputSchema,
  SupportSavedReplyListSchema,
  SupportSavedReplySchema,
  UserIdSchema,
  type OperatorInbox,
  type OperatorMe,
  type OperatorPublicRequest,
  type OperatorThread,
  type SupportSavedReply,
  type SupportSavedReplyList,
} from '@pepper/contracts';
import {
  addSavedReply,
  editSavedReply,
  isOperator,
  listSavedReplies,
  noteOnPublicRequest,
  noteOnThread,
  readOperatorInbox,
  readOperatorThread,
  readPublicRequest,
  removeSavedReply,
  replyAsOperator,
  setPublicStatusAsOperator,
  setThreadStatusAsOperator,
  type Operator,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthSession } from '../auth/auth.service.js';
import { apiError, CurrentSession, SessionGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { parseBody } from '../http/zod-body.js';
import { SUPPORT_OPTIONS, type SupportModuleOptions } from './support-options.js';

// Pepper's support console (S59.2, ADR-0062, AC-X-19…22): `/v1/ops/*`, for the accounts the
// `operator` script granted, with two-step verification on. Every call is one logged operator
// transaction in core; nothing here takes a business from the request.

/**
 * Requires a signed-in Pepper operator (AC-X-19): 401 without a session, 403 `forbidden` for
 * any other account (an owner included), 403 `mfa_required` for an operator without two-step
 * verification. The grant is checked on every request, so a revoked operator stops at once.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  private readonly db: Database;

  constructor(
    private readonly sessions: SessionGuard,
    @Inject(DATABASE) database: { db: Database },
  ) {
    this.db = database.db;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.sessions.canActivate(context);
    const session = context.switchToHttp().getRequest<{ authSession?: AuthSession }>().authSession;
    const userId = UserIdSchema.safeParse(session?.user.id);
    if (!userId.success || !(await isOperator(this.db, userId.data))) {
      throw new ForbiddenException(apiError('forbidden'));
    }
    if (session?.user.twoFactorEnabled !== true) {
      throw new ForbiddenException(apiError('mfa_required'));
    }
    return true;
  }
}

const IdParamsSchema = z.object({ id: z.string().max(100) });

function operatorOf(session: AuthSession): Operator {
  return { userId: UserIdSchema.parse(session.user.id) };
}

@Controller('v1/ops')
@UseGuards(OperatorGuard)
export class OpsController {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(SUPPORT_OPTIONS) private readonly options: SupportModuleOptions,
  ) {
    this.db = database.db;
  }

  /** The console opens (the web asks before showing it). */
  @Get('me')
  me(@CurrentSession() session: AuthSession): OperatorMe {
    return OperatorMeSchema.parse({ operator: true, name: session.user.name });
  }

  /** The inbox's view, the longest waiting first (AC-X-20). */
  @Get('inbox')
  async inbox(
    @CurrentSession() session: AuthSession,
    @Query() query: unknown,
  ): Promise<OperatorInbox> {
    const input = parseBody(OperatorInboxQuerySchema, query);
    return OperatorInboxSchema.parse(
      await answering(() => readOperatorInbox(this.db, operatorOf(session), input)),
    );
  }

  /** A business's request; 404 `support_thread_not_found`. */
  @Get('threads/:id')
  async thread(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
  ): Promise<OperatorThread> {
    const { id } = parseBody(IdParamsSchema, params);
    return OperatorThreadSchema.parse(
      await answering(() => readOperatorThread(this.db, operatorOf(session), id, this.options)),
    );
  }

  /** The team's reply: emailed to the requester (AC-X-16/21). */
  @Post('threads/:id/messages')
  async reply(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<OperatorThread> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(SupportReplyInputSchema, body);
    return OperatorThreadSchema.parse(
      await answering(() => replyAsOperator(this.db, operatorOf(session), id, input, this.options)),
    );
  }

  /** An internal note, never shown to the business. */
  @Post('threads/:id/notes')
  async noteThread(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<OperatorThread> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(SupportNoteInputSchema, body);
    return OperatorThreadSchema.parse(
      await answering(() => noteOnThread(this.db, operatorOf(session), id, input, this.options)),
    );
  }

  /** Any status. */
  @Patch('threads/:id')
  async moveThread(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<OperatorThread> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(OperatorThreadChangeSchema, body);
    return OperatorThreadSchema.parse(
      await answering(() =>
        setThreadStatusAsOperator(this.db, operatorOf(session), id, input, this.options),
      ),
    );
  }

  /** A public request; 404 `support_thread_not_found`. */
  @Get('requests/:id')
  async request(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
  ): Promise<OperatorPublicRequest> {
    const { id } = parseBody(IdParamsSchema, params);
    return OperatorPublicRequestSchema.parse(
      await answering(() => readPublicRequest(this.db, operatorOf(session), id)),
    );
  }

  @Post('requests/:id/notes')
  async noteRequest(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<OperatorPublicRequest> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(SupportNoteInputSchema, body);
    return OperatorPublicRequestSchema.parse(
      await answering(() =>
        noteOnPublicRequest(this.db, operatorOf(session), id, input, this.options),
      ),
    );
  }

  /** The team's saved replies (S59.2.2, AC-X-23). */
  @Get('replies')
  async replies(@CurrentSession() session: AuthSession): Promise<SupportSavedReplyList> {
    return SupportSavedReplyListSchema.parse(
      await answering(() => listSavedReplies(this.db, operatorOf(session))),
    );
  }

  /** 201 the saved reply; 409 `saved_replies_full` at 100. */
  @Post('replies')
  async addReply(
    @CurrentSession() session: AuthSession,
    @Body() body: unknown,
  ): Promise<SupportSavedReply> {
    const input = parseBody(SupportSavedReplyInputSchema, body);
    return SupportSavedReplySchema.parse(
      await answering(() => addSavedReply(this.db, operatorOf(session), input, this.options)),
    );
  }

  /** 404 `saved_reply_not_found`. */
  @Put('replies/:id')
  async editReply(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<SupportSavedReply> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(SupportSavedReplyInputSchema, body);
    return SupportSavedReplySchema.parse(
      await answering(() => editSavedReply(this.db, operatorOf(session), id, input)),
    );
  }

  /** 204; 404 `saved_reply_not_found`. */
  @Delete('replies/:id')
  @HttpCode(204)
  async removeReply(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
  ): Promise<void> {
    const { id } = parseBody(IdParamsSchema, params);
    await answering(() => removeSavedReply(this.db, operatorOf(session), id));
  }

  @Patch('requests/:id')
  async moveRequest(
    @CurrentSession() session: AuthSession,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<OperatorPublicRequest> {
    const { id } = parseBody(IdParamsSchema, params);
    const input = parseBody(OperatorPublicChangeSchema, body);
    return OperatorPublicRequestSchema.parse(
      await answering(() =>
        setPublicStatusAsOperator(this.db, operatorOf(session), id, input, this.options),
      ),
    );
  }
}
