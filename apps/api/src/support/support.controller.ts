import {
  PUBLIC_SUPPORT_PER_HOUR,
  SUPPORT_SCREENSHOT_MAX_BYTES,
  SupportScreenshotSchema,
  type SupportScreenshot,
  PublicSupportInputSchema,
  SupportCreatedSchema,
  SupportRatingInputSchema,
  SupportReplyInputSchema,
  SupportThreadChangeSchema,
  SupportThreadInputSchema,
  SupportThreadListSchema,
  SupportThreadSchema,
  SupportUnreadSchema,
  type SupportCreated,
  type SupportThread,
  type SupportThreadList,
  type SupportUnread,
} from '@pepper/contracts';
import {
  countSupportUnread,
  discardSupportScreenshot,
  readSupportScreenshotImage,
  uploadSupportScreenshot,
  SupportScreenshotsUnavailableError,
  listSupportThreads,
  openSupportThread,
  rateSupportThread,
  readSupportThread,
  replyToSupportThread,
  solveSupportThread,
  submitPublicSupportRequest,
  type Actor,
  type Mailer,
  type SupportOptions,
  type TenantContext,
} from '@pepper/core';
import type { Database } from '@pepper/db';
import { currentRequestContext, DATABASE, MAILER } from '@pepper/runtime';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Optional,
  Query,
  Res,
  Inject,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { CurrentTenant, TenantGuard } from '../auth/guards.js';
import { answering, toHttpError } from '../http/domain-errors.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { readUpload, SCREENSHOT_UPLOAD } from '../http/raw-body.js';
import { parseBody } from '../http/zod-body.js';
import { ScreenshotParamsSchema, ScreenshotQuerySchema } from './screenshot-params.js';
import {
  SCREENSHOT_STORE,
  sendScreenshot,
  type ScreenshotStoreOrNone,
} from './screenshot-store.js';
import { OperatorGuard, OpsController } from './ops.controller.js';

// Pepper's own support (S59, PCR-010, AC-X-14…17). `/v1/support/*`: every member of the
// active business, in the threads the database lets them read (their own; owners and managers
// all of the business's), so another's is simply not found. `/v1/public/support`: the form for
// people who can't sign in. Message text is never logged.

export { SUPPORT_OPTIONS, type SupportModuleOptions } from './support-options.js';
import { SUPPORT_OPTIONS, type SupportModuleOptions } from './support-options.js';

// The domain's own limits (5 requests, 50 messages a day per person) are exact; this one only
// stops a script hammering the api between them.
const MEMBER_WRITES: RateLimit = { name: 'support-write', max: 30, windowSeconds: 600 };
// AC-X-17: 3 an hour from one address, and 3 an hour for one typed email.
const PUBLIC_BY_ADDRESS: RateLimit = {
  name: 'support-public-ip',
  max: PUBLIC_SUPPORT_PER_HOUR,
  windowSeconds: 3600,
};
const PUBLIC_BY_EMAIL: RateLimit = {
  name: 'support-public-email',
  max: PUBLIC_SUPPORT_PER_HOUR,
  windowSeconds: 3600,
};

// The domain's 20 a day per person is exact (AC-X-28); this stops a script between them.
const SCREENSHOT_UPLOADS: RateLimit = { name: 'support-screenshot', max: 30, windowSeconds: 600 };
// A thread shows a few thumbnails and their full images: generous for a person.
const SCREENSHOT_READS: RateLimit = {
  name: 'support-screenshot-read',
  max: 300,
  windowSeconds: 60,
};

const ThreadParamsSchema = z.object({ threadId: z.string().max(100) });

type IncomingRequest = Parameters<typeof clientAddress>[0];

function userAgentOf(request: IncomingRequest): string | null {
  const header = request.headers['user-agent'];
  const value = Array.isArray(header) ? header[0] : header;
  return value === undefined || value === '' ? null : value.slice(0, 300);
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}

@Controller('v1/support')
@UseGuards(TenantGuard)
export class SupportController {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(SUPPORT_OPTIONS) private readonly options: SupportModuleOptions,
    private readonly limits: RateLimiter,
    @Optional()
    @Inject(SCREENSHOT_STORE)
    private readonly screenshots: ScreenshotStoreOrNone = null,
  ) {
    this.db = database.db;
  }

  private domain(): SupportOptions {
    return this.options;
  }

  private screenshotOptions() {
    return {
      store: this.screenshots,
      ...(this.options.clock !== undefined && { clock: this.options.clock }),
    };
  }

  /**
   * One screenshot for a request or reply (S59.2.3, AC-X-28), the image itself as the body:
   * 201 its id and size, unsent until a message names it. 413 `screenshot_too_large`; 415/422
   * `screenshot_rejected` with what to fix; 429 `screenshot_limit_reached` (20 a day) or
   * `too_many_requests`; 503 `screenshots_unavailable`.
   */
  @Post('screenshots')
  async upload(
    @CurrentTenant() tenant: TenantContext,
    @Req() request: IncomingMessage,
  ): Promise<SupportScreenshot> {
    // Before reading the body: without storage there is nowhere to put it.
    if (this.screenshots === null) throw toHttpError(new SupportScreenshotsUnavailableError());
    await this.limits.hit(SCREENSHOT_UPLOADS, tenant.userId);
    const bytes = await readUpload(request, SUPPORT_SCREENSHOT_MAX_BYTES, SCREENSHOT_UPLOAD);
    return SupportScreenshotSchema.parse(
      await answering(() =>
        uploadSupportScreenshot(this.db, actorOf(tenant), bytes, this.screenshotOptions()),
      ),
    );
  }

  /** Removes an unsent screenshot of the member's own before sending: 204; 404 otherwise. */
  @Delete('screenshots/:screenshotId')
  @HttpCode(204)
  async discard(@CurrentTenant() tenant: TenantContext, @Param() params: unknown): Promise<void> {
    const { screenshotId } = parseBody(ScreenshotParamsSchema, params);
    await answering(() =>
      discardSupportScreenshot(this.db, actorOf(tenant), screenshotId, this.screenshotOptions()),
    );
  }

  /**
   * The image (`?size=thumb|full`, WebP) for a member who may read its thread, or its own
   * unsent upload (AC-X-29); 404 `screenshot_not_found` for anything else. Never cached.
   */
  @Get('screenshots/:screenshotId')
  async image(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Query() query: unknown,
    @Res() response: ServerResponse,
  ): Promise<void> {
    const { screenshotId } = parseBody(ScreenshotParamsSchema, params);
    const { size } = parseBody(ScreenshotQuerySchema, query);
    await this.limits.hit(SCREENSHOT_READS, tenant.userId);
    const image = await answering(() =>
      readSupportScreenshotImage(
        this.db,
        actorOf(tenant),
        screenshotId,
        size,
        this.screenshotOptions(),
      ),
    );
    sendScreenshot(response, image);
  }

  /** "Your requests" and the unread count. */
  @Get('threads')
  async list(@CurrentTenant() tenant: TenantContext): Promise<SupportThreadList> {
    return SupportThreadListSchema.parse(
      await answering(() => listSupportThreads(this.db, actorOf(tenant))),
    );
  }

  /** More's count of unread answers. */
  @Get('unread')
  async unread(@CurrentTenant() tenant: TenantContext): Promise<SupportUnread> {
    const unread = await answering(() => countSupportUnread(this.db, actorOf(tenant)));
    return SupportUnreadSchema.parse({ unread });
  }

  /** 201 the reference; 429 `support_limit_reached` (5 a day) or `too_many_requests`. */
  @Post('threads')
  async open(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: unknown,
    @Req() request: IncomingRequest,
  ): Promise<SupportCreated> {
    const input = parseBody(SupportThreadInputSchema, body);
    await this.limits.hit(MEMBER_WRITES, tenant.userId);
    return SupportCreatedSchema.parse(
      await answering(() =>
        openSupportThread(
          this.db,
          actorOf(tenant),
          input,
          { userAgent: userAgentOf(request) },
          this.domain(),
        ),
      ),
    );
  }

  /** The thread with its messages (marks the team's answers read); 404 `support_thread_not_found`. */
  @Get('threads/:threadId')
  async read(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
  ): Promise<SupportThread> {
    const { threadId } = parseBody(ThreadParamsSchema, params);
    return SupportThreadSchema.parse(
      await answering(() => readSupportThread(this.db, actorOf(tenant), threadId, this.options)),
    );
  }

  /** 201 the thread with the reply; 404; 429 `support_limit_reached` (50 messages a day). */
  @Post('threads/:threadId/messages')
  async reply(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<SupportThread> {
    const { threadId } = parseBody(ThreadParamsSchema, params);
    const input = parseBody(SupportReplyInputSchema, body);
    await this.limits.hit(MEMBER_WRITES, tenant.userId);
    return SupportThreadSchema.parse(
      await answering(() =>
        replyToSupportThread(this.db, actorOf(tenant), threadId, input, this.domain()),
      ),
    );
  }

  /** Marks it solved; 404 `support_thread_not_found`. */
  @Patch('threads/:threadId')
  async solve(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<SupportThread> {
    const { threadId } = parseBody(ThreadParamsSchema, params);
    parseBody(SupportThreadChangeSchema, body);
    return SupportThreadSchema.parse(
      await answering(() => solveSupportThread(this.db, actorOf(tenant), threadId, this.options)),
    );
  }

  /**
   * "Did this help?" (S59.2.2, AC-X-26): the opener's answer on a solved request; 409
   * `support_not_ratable` otherwise; 404 `support_thread_not_found`.
   */
  @Put('threads/:threadId/rating')
  async rate(
    @CurrentTenant() tenant: TenantContext,
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<SupportThread> {
    const { threadId } = parseBody(ThreadParamsSchema, params);
    const input = parseBody(SupportRatingInputSchema, body);
    return SupportThreadSchema.parse(
      await answering(() =>
        rateSupportThread(this.db, actorOf(tenant), threadId, input, this.options),
      ),
    );
  }
}

/** The form for people who can't sign in (AC-X-17): no session, limited per address and email. */
@Controller('v1/public/support')
export class PublicSupportController {
  private readonly db: Database;
  private readonly logger = new Logger(PublicSupportController.name);

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(MAILER) private readonly mailer: Mailer | null,
    @Inject(SUPPORT_OPTIONS) private readonly options: SupportModuleOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
  }

  /** 201 the reference; 429 `too_many_requests`. */
  @Post()
  @HttpCode(201)
  async submit(@Body() body: unknown, @Req() request: IncomingRequest): Promise<SupportCreated> {
    const input = parseBody(PublicSupportInputSchema, body);
    await this.limits.hit(PUBLIC_BY_ADDRESS, clientAddress(request));
    // The email as a digest: the Redis key never holds the address.
    const emailKey = createHash('sha256').update(input.email.toLowerCase()).digest('hex');
    await this.limits.hit(PUBLIC_BY_EMAIL, emailKey);
    const result = await answering(() =>
      submitPublicSupportRequest(this.db, this.mailer, input, {
        supportEmail: this.options.supportEmail,
        release: this.options.release,
        userAgent: userAgentOf(request),
        ...(this.options.clock !== undefined && { clock: this.options.clock }),
      }),
    );
    if (!result.sent && this.options.supportEmail !== null && this.mailer !== null) {
      // Kept for the console; the reference, never the text or the address.
      this.logger.warn(`A public support request could not be emailed: ${result.reference}`);
    }
    return SupportCreatedSchema.parse({
      reference: result.reference,
      id: null,
      replyTo: result.replyTo,
    });
  }
}

@Module({})
export class SupportModule {
  static forRoot(options: SupportModuleOptions): DynamicModule {
    return {
      module: SupportModule,
      controllers: [SupportController, PublicSupportController, OpsController],
      providers: [{ provide: SUPPORT_OPTIONS, useValue: options }, RateLimiter, OperatorGuard],
    };
  }
}
