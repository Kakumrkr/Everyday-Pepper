import { randomUUID } from 'node:crypto';
import { smsSegments, TwilioMessageSidSchema } from '@pepper/contracts';
import { SmsRejectedError, type SmsAccepted, type SmsMessage, type SmsSender } from '@pepper/core';
import { z } from 'zod';
import type { SmsConfig } from './config.js';

// The SMS senders (S61, ADR-0065 §1) behind core's `SmsSender` port: Twilio's Messages API, and
// the sandbox that never leaves the machine. Coded from Twilio's documentation and tested on
// fixtures in its documented shapes (src/fixtures/twilio); S64 confirms it live. Every answer is
// outside input: validated, and never logged (it echoes the number and the words).

const TWILIO_API = 'https://api.twilio.com';
/** Well below the outbox lease (ADR-0024), so a hung call fails the attempt. */
const TIMEOUT_MS = 15_000;

const CreatedSchema = z.object({
  sid: TwilioMessageSidSchema,
  status: z.string().max(30),
  num_segments: z
    .string()
    .regex(/^\d{1,2}$/)
    .nullish(),
});

const ErrorSchema = z.object({ code: z.number().int().min(1).max(999_999) });

/**
 * Whether Twilio refused the text for good: a bad request about this text (400: an invalid or
 * unsubscribed number, a body it won't send) or a resource it doesn't have (404). Throttling
 * (429), its own trouble (5xx) and our credentials (401, 403) are tried again with backoff, for
 * about two hours: a passing problem loses no text, and the alert after the last attempt says so.
 */
function isPermanent(status: number): boolean {
  return status === 400 || status === 404;
}

export interface TwilioSmsOptions {
  accountSid: string;
  authToken: string;
  /** A Messaging Service (`MG…`) or a `+1` number. */
  sender: string;
  /** Tests give their own; production uses the global `fetch`. */
  fetch?: typeof fetch;
}

/** `SmsSender` on Twilio's Messages API (`POST /2010-04-01/Accounts/{sid}/Messages.json`). */
export class TwilioSmsSender implements SmsSender {
  private readonly fetchImpl: typeof fetch;
  private readonly authorization: string;

  constructor(private readonly options: TwilioSmsOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;
  }

  async send(message: SmsMessage): Promise<SmsAccepted> {
    const form = new URLSearchParams({ To: message.to, Body: message.body });
    if (this.options.sender.startsWith('MG')) form.set('MessagingServiceSid', this.options.sender);
    else form.set('From', this.options.sender);
    if (message.statusCallbackUrl !== undefined) {
      form.set('StatusCallback', message.statusCallbackUrl);
    }
    const account = encodeURIComponent(this.options.accountSid);
    const response = await this.fetchImpl(
      `${TWILIO_API}/2010-04-01/Accounts/${account}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: this.authorization,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const error = ErrorSchema.safeParse(await response.json().catch(() => null));
      throw new SmsRejectedError(
        response.status,
        error.success ? error.data.code : null,
        isPermanent(response.status),
      );
    }
    const created = CreatedSchema.parse(await response.json());
    const counted =
      created.num_segments === undefined || created.num_segments === null
        ? 0
        : Number(created.num_segments);
    return {
      provider: 'twilio',
      providerMessageId: created.sid,
      segments: counted >= 1 ? counted : smsSegments(message.body).segments,
      status: 'queued',
    };
  }
}

/** One text the sandbox kept. */
export interface SandboxText extends SmsMessage {
  providerMessageId: string;
  segments: number;
}

/** How many texts the sandbox keeps, the newest. */
const SANDBOX_KEEP = 100;

/**
 * `SmsSender` that never leaves the machine (`SMS_PROVIDER=sandbox`): the last 100 texts stay in
 * memory for tests and development, and each is logged with its number masked and no words.
 */
export class SandboxSmsSender implements SmsSender {
  private readonly kept: SandboxText[] = [];

  constructor(
    private readonly log: (line: string) => void = () => undefined,
    /** Where tests read what was sent (S63, `SandboxTextLog`); none: memory only. */
    private readonly textLog: SandboxTextLog | null = null,
  ) {}

  /** The same sender, also writing what it sends to `textLog` (the worker's, at start-up). */
  withTextLog(textLog: SandboxTextLog): SandboxSmsSender {
    return new SandboxSmsSender(this.log, textLog);
  }

  /** The texts kept, oldest first. */
  get sent(): readonly SandboxText[] {
    return this.kept;
  }

  send(message: SmsMessage): Promise<SmsAccepted> {
    const providerMessageId = `SB${randomUUID().replace(/-/g, '')}`;
    const { segments } = smsSegments(message.body);
    this.kept.push({ ...message, providerMessageId, segments });
    if (this.kept.length > SANDBOX_KEEP) this.kept.shift();
    this.log(`SMS sandbox: ${String(segments)} segment(s) to ${maskPhone(message.to)}`);
    const accepted: SmsAccepted = {
      provider: 'sandbox',
      providerMessageId,
      segments,
      status: 'delivered',
    };
    if (this.textLog === null) return Promise.resolve(accepted);
    return this.textLog
      .record({ to: message.to, body: message.body, sentAt: new Date().toISOString() })
      .then(() => accepted);
  }
}

/** One text the sandbox sent, as tests read it (S63, AC-X-87). */
export const SandboxSentTextSchema = z
  .object({ to: z.string(), body: z.string(), sentAt: z.iso.datetime() })
  .strict();
export type SandboxSentText = z.infer<typeof SandboxSentTextSchema>;

const SANDBOX_LOG_KEY = 'pepper:sms-sandbox:sent';
const SANDBOX_LOG_TTL_SECONDS = 24 * 60 * 60;

/**
 * The sandbox's sent texts in Redis (S63, ADR-0066 §5), shared by the worker that sends them
 * and the api's `/v1/dev/sms/sent` that tests read: the newest 100, kept a day. Only ever used
 * with `SMS_PROVIDER=sandbox` where tests run (CI, or a development machine).
 */
export class SandboxTextLog {
  constructor(
    private readonly redis: {
      lpush(key: string, value: string): Promise<unknown>;
      ltrim(key: string, start: number, stop: number): Promise<unknown>;
      expire(key: string, seconds: number): Promise<unknown>;
      lrange(key: string, start: number, stop: number): Promise<string[]>;
    },
  ) {}

  async record(text: SandboxSentText): Promise<void> {
    await this.redis.lpush(SANDBOX_LOG_KEY, JSON.stringify(SandboxSentTextSchema.parse(text)));
    await this.redis.ltrim(SANDBOX_LOG_KEY, 0, SANDBOX_KEEP - 1);
    await this.redis.expire(SANDBOX_LOG_KEY, SANDBOX_LOG_TTL_SECONDS);
  }

  /** The texts sent to `to`, the newest first. */
  async sentTo(to: string): Promise<SandboxSentText[]> {
    const rows = await this.redis.lrange(SANDBOX_LOG_KEY, 0, SANDBOX_KEEP - 1);
    return rows
      .map((row) => SandboxSentTextSchema.safeParse(parsedJson(row)))
      .flatMap((parsed) => (parsed.success && parsed.data.to === to ? [parsed.data] : []));
  }
}

function parsedJson(row: string): unknown {
  try {
    return JSON.parse(row);
  } catch {
    return null;
  }
}

/** A number with all but its last two digits hidden: `+1••••••••67`. */
export function maskPhone(phone: string): string {
  return phone.length <= 4
    ? '••••'
    : `${phone.slice(0, 2)}${'•'.repeat(phone.length - 4)}${phone.slice(-2)}`;
}

/** The configured sender, or `null` with SMS off. */
export function smsSenderFor(
  config: SmsConfig | null,
  log?: (line: string) => void,
  sandboxLog: SandboxTextLog | null = null,
): SmsSender | null {
  if (config === null) return null;
  if (config.provider === 'sandbox') return new SandboxSmsSender(log, sandboxLog);
  return new TwilioSmsSender({
    accountSid: config.accountSid,
    authToken: config.authToken,
    sender: config.sender,
  });
}
