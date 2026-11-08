import type { IncomingMessage } from 'node:http';
import { ResendWebhookEventSchema, WebhookAckSchema, type WebhookAck } from '@pepper/contracts';
import { recordEmailProblem, recordInboundEmail, systemClock, type Clock } from '@pepper/core';
import type { Database } from '@pepper/db';
import { DATABASE } from '@pepper/runtime';
import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
  type DynamicModule,
} from '@nestjs/common';
import { apiError, SkipOriginCheck } from '../auth/guards.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { svixKeyOf, verifySvix } from './svix.js';

// Resend's inbound email webhook (S59.3, ADR-0063 §3, AC-X-33): no session and no Origin (Resend
// calls it). The Svix signature over the raw bytes is checked before anything is parsed; then an
// `email.received` event is stored once (its event id, provider email id and Message-ID unique)
// and acknowledged. The worker fetches the email from Resend's API and decides what it is. Off
// (404) until `RESEND_WEBHOOK_SECRET` is set. Nothing of an email is logged.

export interface InboundModuleOptions {
  /** `RESEND_WEBHOOK_SECRET`; `null`: the route is off. */
  webhookSecret: string | null;
  clock?: Clock;
}

export const INBOUND_OPTIONS = Symbol('INBOUND_OPTIONS');

// Resend calls from a few addresses, and retries a refused call with backoff: the limit only
// stops a flood (each refused call costs one HMAC).
const DELIVERIES: RateLimit = { name: 'inbound-webhook-ip', max: 1200, windowSeconds: 600 };

/** Nest's raw body (`rawBody: true` on the app): the exact bytes the signature covers. */
type WebhookRequest = IncomingMessage & { rawBody?: Buffer };

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Controller('v1/webhooks/resend')
export class InboundController {
  private readonly db: Database;
  private readonly key: Buffer | null;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(INBOUND_OPTIONS) private readonly options: InboundModuleOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
    this.key = options.webhookSecret === null ? null : svixKeyOf(options.webhookSecret);
    // A secret set but unusable must stop the process, never turn the route off quietly.
    if (options.webhookSecret !== null && this.key === null) {
      throw new Error('Invalid api environment: RESEND_WEBHOOK_SECRET');
    }
  }

  /**
   * One webhook event: 200 `{ received: true }` (stored, already stored, or a type we don't
   * store; a bounce or complaint is recorded, S59.3.2); 401 `webhook_signature_invalid`; 400 `validation_failed`; 404 while off; 413 over the
   * JSON limit.
   */
  @Post()
  @HttpCode(200)
  @SkipOriginCheck()
  async receive(@Req() request: WebhookRequest): Promise<WebhookAck> {
    if (this.key === null) throw new NotFoundException(apiError('webhook_not_found'));
    await this.limits.hit(DELIVERIES, clientAddress(request));
    const raw = request.rawBody;
    const now = (this.options.clock ?? systemClock).now();
    if (
      raw === undefined ||
      !verifySvix(
        this.key,
        {
          id: header(request, 'svix-id'),
          timestamp: header(request, 'svix-timestamp'),
          signature: header(request, 'svix-signature'),
        },
        raw,
        now,
      )
    ) {
      throw new UnauthorizedException(apiError('webhook_signature_invalid'));
    }
    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException(apiError('validation_failed'));
    }
    const event = ResendWebhookEventSchema.safeParse(json);
    if (!event.success) throw new BadRequestException(apiError('validation_failed'));
    if (event.data.type === 'email.received') {
      const emailId = event.data.data.email_id;
      if (emailId === undefined) throw new BadRequestException(apiError('validation_failed'));
      await recordInboundEmail(this.db, {
        provider: 'resend',
        // Checked by the signature: Svix's own id for this event.
        eventId: header(request, 'svix-id') ?? '',
        providerEmailId: emailId,
        messageId: event.data.data.message_id ?? null,
        receivedAt: now,
      });
    } else if (event.data.type === 'email.bounced' || event.data.type === 'email.complained') {
      // A support email couldn't be delivered, or was marked as spam (S59.3.2, AC-X-42).
      const recipients = event.data.data.to ?? [];
      if (recipients.length === 0) throw new BadRequestException(apiError('validation_failed'));
      await recordEmailProblem(this.db, {
        provider: 'resend',
        eventId: header(request, 'svix-id') ?? '',
        type: event.data.type,
        recipients,
        bounceType: event.data.data.bounce?.type ?? null,
        occurredAt: now,
      });
    }
    return WebhookAckSchema.parse({ received: true });
  }
}

/** The inbound email webhook. Needs `ConnectionsModule`. */
@Module({})
export class InboundModule {
  static forRoot(options: InboundModuleOptions): DynamicModule {
    return {
      module: InboundModule,
      controllers: [InboundController],
      providers: [{ provide: INBOUND_OPTIONS, useValue: options }, RateLimiter],
    };
  }
}
