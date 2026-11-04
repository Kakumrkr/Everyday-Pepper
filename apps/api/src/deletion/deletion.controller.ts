import {
  AccountDeletionRequestSchema,
  BusinessDeletionRequestSchema,
  type DeletionStatus,
} from '@pepper/contracts';
import {
  accountDeletion,
  businessDeletion,
  cancelAccountDeletion,
  cancelBusinessDeletion,
  scheduleAccountDeletion,
  scheduleBusinessDeletion,
  systemClock,
  type Clock,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Optional,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import { AuthService, type AuthSession } from '../auth/auth.service.js';
import {
  apiError,
  CurrentSession,
  CurrentTenant,
  RequirePermission,
  SessionGuard,
  TenantGuard,
} from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';

/** The clock a deletion's day is counted from (tests replace it). */
export const DELETION_CLOCK = Symbol('DELETION_CLOCK');

// A password is tried a few times at most: deleting an account must not become a way to guess it.
const PASSWORD_TRIES: RateLimit = { name: 'account-deletion', max: 5, windowSeconds: 900 };

/**
 * Deleting the business or the account (S51.2, ADR-0054, AC-W1-40, AC-W1-42). Each is
 * scheduled 30 days ahead and can be kept until then; the worker deletes it after.
 * - `GET /v1/tenant/deletion` (every member), `POST` with the business's name and `DELETE`
 *   (owners: `business.delete`): 400 `deletion_name_mismatch`, 409 `account_being_deleted`.
 * - `GET /v1/me/deletion`, `POST` with the password (400 `wrong_password`, 409
 *   `account_owns_business`, 429 after 5 tries in 15 minutes) and `DELETE`: the signed-in
 *   account; scheduling it ends every other session.
 */
@Controller('v1')
export class DeletionController {
  private readonly db: Database;
  private readonly clock: Clock;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    private readonly auth: AuthService,
    private readonly limits: RateLimiter,
    @Optional() @Inject(DELETION_CLOCK) clock?: Clock,
  ) {
    this.db = database.db;
    this.clock = clock ?? systemClock;
  }

  @Get('tenant/deletion')
  @UseGuards(TenantGuard)
  @RequirePermission('business.read')
  business(@CurrentTenant() tenant: TenantContext): Promise<DeletionStatus> {
    return answering(() => businessDeletion(this.db, actorOf(tenant)));
  }

  @Post('tenant/deletion')
  @HttpCode(200)
  @UseGuards(TenantGuard)
  @RequirePermission('business.delete')
  deleteBusiness(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<DeletionStatus> {
    const request = parseBody(BusinessDeletionRequestSchema, body);
    return answering(() =>
      scheduleBusinessDeletion(this.db, actorOf(tenant), request, { clock: this.clock }),
    );
  }

  @Delete('tenant/deletion')
  @UseGuards(TenantGuard)
  @RequirePermission('business.delete')
  keepBusiness(@CurrentTenant() tenant: TenantContext): Promise<DeletionStatus> {
    return answering(() => cancelBusinessDeletion(this.db, actorOf(tenant)));
  }

  @Get('me/deletion')
  @UseGuards(SessionGuard)
  account(@CurrentSession() session: AuthSession): Promise<DeletionStatus> {
    return accountDeletion(this.db, session.user.id);
  }

  @Post('me/deletion')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async deleteAccount(
    @CurrentSession() session: AuthSession,
    @Req() request: IncomingMessage,
    @Body() body: unknown,
  ): Promise<DeletionStatus> {
    const { password } = parseBody(AccountDeletionRequestSchema, body);
    await this.limits.hit(PASSWORD_TRIES, session.user.id);
    if (!(await this.auth.verifyPassword(request.headers, password))) {
      throw new BadRequestException(apiError('wrong_password'));
    }
    return answering(() =>
      scheduleAccountDeletion(
        this.db,
        { userId: session.user.id, sessionId: session.id },
        { clock: this.clock },
      ),
    );
  }

  @Delete('me/deletion')
  @UseGuards(SessionGuard)
  keepAccount(@CurrentSession() session: AuthSession): Promise<DeletionStatus> {
    return cancelAccountDeletion(this.db, session.user.id);
  }
}

function actorOf(tenant: TenantContext) {
  return { context: tenant, requestId: currentRequestContext()?.requestId };
}
