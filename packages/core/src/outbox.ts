import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxMessageIdSchema,
  outboxRetryDelayMs,
  type OutboxMessageId,
} from '@pepper/contracts';

// Rules of the transactional outbox (ADR-0024) that need no database: sealing a message's
// content, and what a failed delivery attempt leads to.

/** One plain-text email, ready for a mail server. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /**
   * A stable id for the email (the outbox message's), sent as its `Message-ID`, so a mail
   * server or provider that dedupes on it drops a resend after a crash.
   */
  id?: string;
}

/** Sends email: SMTP (Mailpit in development and CI) today, a provider's API later. */
export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** One Web Push message to one device (ADR-0026), ready for its push service. */
export interface PushMessage {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** The notification as JSON (`{ title, body, url, tag }`), encrypted to the device. */
  payload: string;
  /** How long the push service may hold it while the device is offline. */
  ttlSeconds: number;
  /** Replaces a not-yet-delivered push with the same topic (letters and digits, ≤ 32). */
  topic?: string;
}

/** Sends Web Push messages (VAPID-signed, encrypted per RFC 8291). */
export interface Pusher {
  send(message: PushMessage): Promise<void>;
}

/** A push service refused a message with this HTTP status. */
export class PushRejectedError extends Error {
  constructor(readonly statusCode: number) {
    super(`The push service answered ${String(statusCode)}`);
    this.name = 'PushRejectedError';
  }
}

/**
 * The push service no longer knows the device (404, 410: the browser unsubscribed or the
 * subscription expired): its subscription is removed and the message dropped.
 */
export function isGonePush(error: unknown): boolean {
  return (
    error instanceof PushRejectedError && (error.statusCode === 404 || error.statusCode === 410)
  );
}

/** A channel that this worker has not configured (push without VAPID keys). */
export class ChannelUnavailableError extends Error {
  constructor(channel: 'push') {
    super(`No ${channel} sender is configured`);
    this.name = 'ChannelUnavailableError';
  }
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * The 32-byte key that seals outbox content, derived from `OUTBOX_SECRET` (HKDF-SHA256). The
 * api seals and the worker opens, so both need the same secret.
 */
export function outboxKeyFrom(secret: string): Buffer {
  if (secret.length < 32) throw new RangeError('The outbox secret needs at least 32 characters');
  return Buffer.from(hkdfSync('sha256', secret, '', 'pepper/outbox-messages', 32));
}

/** Thrown when sealed content cannot be opened: wrong key, other message, or tampering. */
export class OutboxContentError extends Error {
  override readonly name = 'OutboxContentError';

  constructor() {
    super('The outbox content cannot be opened');
  }
}

/**
 * Encrypts a message's content with AES-256-GCM, bound to the message's id: content copied to
 * another message does not open. Layout: version (1 byte), IV (12), tag (16), ciphertext.
 */
export function sealOutboxContent(key: Buffer, id: OutboxMessageId, content: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', checkedKey(key), iv);
  cipher.setAAD(associatedData(id));
  const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts content sealed by `sealOutboxContent` for the same id (`OutboxContentError`). */
export function openOutboxContent(key: Buffer, id: OutboxMessageId, sealed: Buffer): Buffer {
  if (sealed.length < HEADER_BYTES || sealed[0] !== VERSION) throw new OutboxContentError();
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, HEADER_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', checkedKey(key), iv);
    decipher.setAAD(associatedData(id));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    throw new OutboxContentError();
  }
}

function checkedKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new RangeError('The outbox key must be 32 bytes');
  return key;
}

function associatedData(id: OutboxMessageId): Buffer {
  return Buffer.from(`pepper/outbox/v1\n${OutboxMessageIdSchema.parse(id)}`);
}

/** What a failed attempt leads to: another attempt at `retryAt`, or giving up (`dead`). */
export type FailureOutcome =
  { kind: 'retry'; retryAt: Date; errorName: string } | { kind: 'dead'; errorName: string };

/**
 * Decides what follows a failed delivery attempt (the `attempts`-th, counted at the claim). A
 * permanent failure (content that cannot be opened, or a mail server's 5xx answer such as an
 * unknown mailbox) gives up at once; anything else retries with backoff until the last attempt.
 */
export function failureOutcome(error: unknown, attempts: number, now: Date): FailureOutcome {
  const errorName = errorNameOf(error);
  if (isPermanent(error) || attempts >= OUTBOX_MAX_ATTEMPTS) return { kind: 'dead', errorName };
  return {
    kind: 'retry',
    retryAt: new Date(now.getTime() + outboxRetryDelayMs(attempts)),
    errorName,
  };
}

/**
 * The error's code (e.g. nodemailer's `ECONNECTION`) or name: never its message, which may
 * echo an address.
 */
export function errorNameOf(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as Error & { code?: unknown };
    return typeof code === 'string' && code !== '' ? code : error.name;
  }
  return 'UnknownError';
}

function isPermanent(error: unknown): boolean {
  if (error instanceof OutboxContentError) return true;
  // A push refused for good (bad request, our keys, too large); 408 and 429 are worth a retry.
  if (error instanceof PushRejectedError) {
    const { statusCode } = error;
    return statusCode >= 400 && statusCode < 500 && statusCode !== 408 && statusCode !== 429;
  }
  if (!(error instanceof Error)) return false;
  const { responseCode } = error as Error & { responseCode?: unknown };
  return typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600;
}
