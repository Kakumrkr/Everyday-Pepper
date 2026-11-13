import {
  MemberTextsSchema,
  StartPhoneCheckRequestSchema,
  StartPhoneCheckResponseSchema,
  UpdateMemberTextsRequestSchema,
  VerifyPhoneRequestSchema,
  type MemberTexts,
  type StartPhoneCheckResponse,
} from '@pepper/contracts';
import {
  getMemberTexts,
  setMemberCardTexts,
  smsCodeKeyFrom,
  startMemberPhoneCheck,
  systemClock,
  verifyMemberPhone,
  type Actor,
  type Clock,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Patch,
  Post,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { CurrentTenant, RequirePermission, TenantGuard } from '../auth/guards.js';
import { answering } from '../http/domain-errors.js';
import { RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { parseBody } from '../http/zod-body.js';

// A member's own number and "Text me cards" (S63, ADR-0066 §1–2, AC-X-80, AC-X-81). Every
// member may check their own number (the code's text goes from the session's business); owners
// and managers turn cards by text on. The number is the account's, never another member's.

export interface MemberTextsOptions {
  outboxKey: Buffer;
  clock?: Clock;
}

export const MEMBER_TEXTS_OPTIONS = Symbol('MEMBER_TEXTS_OPTIONS');

// A code costs a text: at most 5 an hour per account, and 20 an hour per business.
const CHECKS_PER_USER: RateLimit = { name: 'phone-check-user', max: 5, windowSeconds: 3600 };
const CHECKS_PER_TENANT: RateLimit = { name: 'phone-check-tenant', max: 20, windowSeconds: 3600 };

@Controller('v1/me')
@UseGuards(TenantGuard)
export class MemberTextsController {
  private readonly db: Database;
  private readonly codeKey: Buffer;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(MEMBER_TEXTS_OPTIONS) private readonly options: MemberTextsOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
    this.codeKey = smsCodeKeyFrom(options.outboxKey);
  }

  /** 200 the member's number, whether cards by text are on here, and whether they may be. */
  @Get('texts')
  @RequirePermission('business.read')
  async texts(@CurrentTenant() tenant: TenantContext): Promise<MemberTexts> {
    return MemberTextsSchema.parse(await answering(() => getMemberTexts(this.db, actorOf(tenant))));
  }

  /**
   * Texts a code to the number (AC-X-80): 200 `{ expiresAt }`; 422 `phone_not_textable`; 409
   * `phone_opted_out`; 429 `too_many_requests` (5 an hour).
   */
  @Post('phone')
  @HttpCode(200)
  @RequirePermission('business.read')
  async startCheck(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<StartPhoneCheckResponse> {
    const { phone } = parseBody(StartPhoneCheckRequestSchema, body);
    await this.limits.hit(CHECKS_PER_USER, tenant.userId);
    await this.limits.hit(CHECKS_PER_TENANT, tenant.tenantId);
    const { expiresAt } = await answering(() =>
      startMemberPhoneCheck(this.db, actorOf(tenant), phone, this.coded()),
    );
    return StartPhoneCheckResponseSchema.parse({ expiresAt: expiresAt.toISOString() });
  }

  /**
   * The code from the text: 200 the member's texts; 422 `phone_check_wrong_code`,
   * `phone_check_expired` or `phone_check_locked` (5 tries).
   */
  @Post('phone/verify')
  @HttpCode(200)
  @RequirePermission('business.read')
  async verify(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<MemberTexts> {
    const { code } = parseBody(VerifyPhoneRequestSchema, body);
    return MemberTextsSchema.parse(
      await answering(() => verifyMemberPhone(this.db, actorOf(tenant), code, this.coded())),
    );
  }

  /** "Text me cards" on or off (AC-X-81): 200; 403 for staff; 409 `phone_not_checked`. */
  @Patch('texts')
  @RequirePermission('business.read')
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
  ): Promise<MemberTexts> {
    const { cardTexts } = parseBody(UpdateMemberTextsRequestSchema, body);
    return MemberTextsSchema.parse(
      await answering(() =>
        setMemberCardTexts(this.db, actorOf(tenant), cardTexts, { clock: this.clock() }),
      ),
    );
  }

  private clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  private coded() {
    return { codeKey: this.codeKey, outboxKey: this.options.outboxKey, clock: this.clock() };
  }
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}

/** A member's own number and cards by text. Needs `AuthModule` (global) and `ConnectionsModule`. */
@Module({})
export class MemberTextsModule {
  static forRoot(options: MemberTextsOptions): DynamicModule {
    return {
      module: MemberTextsModule,
      controllers: [MemberTextsController],
      providers: [{ provide: MEMBER_TEXTS_OPTIONS, useValue: options }, RateLimiter],
    };
  }
}
