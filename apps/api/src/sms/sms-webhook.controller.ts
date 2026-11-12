import type { IncomingMessage, ServerResponse } from 'node:http';
import { confirmBookingByText } from '@pepper/appointments';
import {
  classifySmsReply,
  OutboxMessageIdSchema,
  TenantIdSchema,
  TwilioInboundSmsSchema,
  TwilioStatusCallbackSchema,
  WebhookAckSchema,
  type WebhookAck,
} from '@pepper/contracts';
import { handleInboundSms, recordSmsStatus, systemClock, type Clock } from '@pepper/core';
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
  Res,
  UnauthorizedException,
  type DynamicModule,
} from '@nestjs/common';
import { apiError, SkipOriginCheck } from '../auth/guards.js';
import { clientAddress, RateLimiter, type RateLimit } from '../http/rate-limit.js';
import { verifyTwilioSignature } from './twilio-signature.js';

// Twilio's SMS webhooks (S61, ADR-0065 §5–6, AC-X-59, AC-X-61, AC-X-62): no session and no
// Origin (Twilio calls them). The signature over the public URL and the exact form fields, and
// the account, are checked before anything is read. A text to Pepper's number is handled in this
// request: STOP is honoured before Twilio has its answer, and the reply goes back as TwiML; a
// "C" confirms the booking a reminder was about (S62, AC-X-74). A status callback moves the
// delivery the signed URL names. Off (404) unless SMS is on with
// Twilio. Neither a number nor a text is logged.

export interface SmsWebhookOptions {
  /** Twilio's account and auth token; `null`: SMS isn't on with Twilio, the routes are 404. */
  twilio: { accountSid: string; authToken: string } | null;
  /** The public origin Twilio calls (`AUTH_BASE_URL`): the signature covers the full URL. */
  baseUrl: string;
  clock?: Clock;
}

export const SMS_WEBHOOK_OPTIONS = Symbol('SMS_WEBHOOK_OPTIONS');

// Twilio calls from many addresses; the limit only stops a flood (each refused call costs one HMAC).
const DELIVERIES: RateLimit = { name: 'sms-webhook-ip', max: 1200, windowSeconds: 600 };

/** Nest's raw body (`rawBody: true` on the app): the form's exact bytes. */
type WebhookRequest = IncomingMessage & { rawBody?: Buffer; originalUrl?: string };

/** An empty TwiML answer: no reply. */
const NO_REPLY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twiml(reply: string | null): string {
  if (reply === null) return NO_REPLY;
  const text = reply
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${text}</Message></Response>`;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

@Controller('v1/webhooks/sms')
export class SmsWebhookController {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(SMS_WEBHOOK_OPTIONS) private readonly options: SmsWebhookOptions,
    private readonly limits: RateLimiter,
  ) {
    this.db = database.db;
  }

  /**
   * A text to Pepper's number: 200 with TwiML (a reply to STOP, START, HELP or "C", else none); 401
   * `webhook_signature_invalid`; 400 `validation_failed`; 404 while off.
   */
  @Post()
  @HttpCode(200)
  @SkipOriginCheck()
  async receive(
    @Req() request: WebhookRequest,
    @Res({ passthrough: true }) response: ServerResponse,
  ): Promise<string> {
    const { fields, twilio } = await this.verified(request);
    const parsed = TwilioInboundSmsSchema.safeParse(Object.fromEntries(fields));
    if (!parsed.success || parsed.data.AccountSid !== twilio.accountSid) {
      throw new BadRequestException(apiError('validation_failed'));
    }
    const receivedAt = (this.options.clock ?? systemClock).now();
    const result = await handleInboundSms(
      this.db,
      {
        provider: 'twilio',
        eventId: parsed.data.MessageSid,
        from: parsed.data.From,
        body: parsed.data.Body,
        receivedAt,
      },
      { helpUrl: new URL('/help', this.options.baseUrl).toString() },
    );
    // A keyword (an opt-out first) always wins; only then is a "C" read.
    const reply =
      result.keyword === null && classifySmsReply(parsed.data.Body) === 'confirm'
        ? (await confirmBookingByText(this.db, { from: parsed.data.From, receivedAt })).reply
        : result.reply;
    // Only on success: an error stays JSON, like every other answer.
    response.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return twiml(reply);
  }

  /**
   * A text's delivery report, the business and message in the signed query: 200
   * `{ received: true }` (recorded, kept or unknown, so Twilio doesn't send it again); 401; 400;
   * 404 while off.
   */
  @Post('status')
  @HttpCode(200)
  @SkipOriginCheck()
  async status(@Req() request: WebhookRequest): Promise<WebhookAck> {
    const { fields, twilio, url } = await this.verified(request);
    const parsed = TwilioStatusCallbackSchema.safeParse(Object.fromEntries(fields));
    // The signature covers the query, so neither can be forged.
    const tenantId = TenantIdSchema.safeParse(url.searchParams.get('t'));
    const messageId = OutboxMessageIdSchema.safeParse(url.searchParams.get('m'));
    if (
      !parsed.success ||
      parsed.data.AccountSid !== twilio.accountSid ||
      !tenantId.success ||
      !messageId.success
    ) {
      throw new BadRequestException(apiError('validation_failed'));
    }
    await recordSmsStatus(this.db, {
      tenantId: tenantId.data,
      messageId: messageId.data,
      providerMessageId: parsed.data.MessageSid,
      status: parsed.data.MessageStatus,
      errorCode: parsed.data.ErrorCode,
    });
    return WebhookAckSchema.parse({ received: true });
  }

  /** The form's fields once Twilio's signature for the public URL checks out (else 401/404). */
  private async verified(request: WebhookRequest): Promise<{
    fields: [string, string][];
    twilio: { accountSid: string; authToken: string };
    url: URL;
  }> {
    const { twilio } = this.options;
    if (twilio === null) throw new NotFoundException(apiError('webhook_not_found'));
    await this.limits.hit(DELIVERIES, clientAddress(request));
    const raw = request.rawBody;
    // The URL Twilio called: the public origin and the path with its query, as received.
    const url = new URL(request.originalUrl ?? request.url ?? '/', this.options.baseUrl);
    const fields = raw === undefined ? [] : [...new URLSearchParams(raw.toString('utf8'))];
    if (
      raw === undefined ||
      !verifyTwilioSignature(
        twilio.authToken,
        url.toString(),
        fields,
        header(request, 'x-twilio-signature'),
      )
    ) {
      throw new UnauthorizedException(apiError('webhook_signature_invalid'));
    }
    return { fields, twilio, url };
  }
}

/** Twilio's SMS webhooks. Needs `ConnectionsModule`. */
@Module({})
export class SmsWebhookModule {
  static forRoot(options: SmsWebhookOptions): DynamicModule {
    return {
      module: SmsWebhookModule,
      controllers: [SmsWebhookController],
      providers: [{ provide: SMS_WEBHOOK_OPTIONS, useValue: options }, RateLimiter],
    };
  }
}
