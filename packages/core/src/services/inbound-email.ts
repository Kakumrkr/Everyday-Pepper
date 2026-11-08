import {
  SUPPORT_MESSAGE_MAX,
  SUPPORT_MESSAGES_PER_DAY,
  SUPPORT_SCREENSHOT_MAX_BYTES,
  SUPPORT_SCREENSHOTS_PER_DAY,
  SUPPORT_SCREENSHOTS_PER_MESSAGE,
  SUPPORT_THREADS_PER_DAY,
  SupportContextSchema,
  TenantIdSchema,
  UserIdSchema,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  appendSupportMessage,
  attachSupportScreenshots,
  claimInboundEmails,
  countInboundLanded,
  countSupportScreenshotUploads,
  countSupportWrites,
  emptyHeldInboundEmails,
  failInboundEmailsPastAttempts,
  findSupportThread,
  findSupportThreadForInbound,
  finishInboundEmail,
  hasActivation,
  insertInboundEmail,
  insertSupportScreenshot,
  insertSupportThread,
  isBusinessBookable,
  listTenantMembers,
  lockReceivedInboundEmail,
  lockSupportThread,
  lockSupportWriter,
  markSupportThreadRead,
  newId,
  setTransactionInboundMail,
  setTransactionUser,
  withInboundMail,
  withTenant,
  type ClaimedInboundEmail,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { systemClock } from '../clock.js';
import { replyTextOf } from '../email-text.js';
import {
  INBOUND_EMAIL_MAX_BYTES,
  isAutoReply,
  isSpam,
  senderVerdict,
  type InboundAttachment,
  type InboundMailSource,
} from '../inbound-email.js';
import { findSupportReference, supportReplyKeysFrom } from '../support-reply-address.js';
import { queueEmail } from './outbox.js';
import type { ScreenshotStorage } from './support-screenshots.js';
import {
  emailTeam,
  firstNameOf,
  newSupportReference,
  requesterOf,
  REFERENCE_TRIES,
  SUPPORT_REPLY_ABOVE,
  type SupportOptions,
} from './support.js';

// Replies by email (S59.3, ADR-0063, AC-X-33…38). The webhook stores what arrived
// (`recordInboundEmail`); the worker's job (`processInboundEmails`) fetches each email from the
// provider and decides: landed in its thread as the member's, held for the team (an unknown or
// unverified sender), ignored (auto-replies, spam, loops, no request named) or refused (too
// big, over a limit, empty). A verified sender is told what didn't go through; nobody else ever
// gets an email. No email content is logged; only a held one's sender and text are stored.

export interface InboundEmailOptions extends SupportOptions {
  /** Where replies come (`INBOUND_EMAIL_DOMAIN`): the signed addresses' domain. */
  inboundDomain: string;
  /** The receiving server's authserv-id (`INBOUND_AUTHSERV_ID`); `null`: every reply is held. */
  authservId: string | null;
  source: InboundMailSource;
  /** Where emailed images go as screenshots; `null`: none are kept (and the sender is told). */
  store: ScreenshotStorage | null;
  /** Emails taken in one pass (the rest wait for the next). */
  limit?: number;
}

export interface InboundEmailResult {
  landed: number;
  held: number;
  ignored: number;
  refused: number;
  /** Given up for good (no such email at the provider, or every attempt failed). */
  failed: number;
  /** Left for a later attempt (the provider or the database failed this time). */
  retried: number;
  /** Held emails emptied after 7 days. */
  emptied: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOOP_LIMIT = 5;
const REOPEN_DAYS = 30;
const HELD_DAYS = 7;
/** Inline images this small are signatures' icons and tracking pixels, not screenshots. */
const INLINE_ICON_BYTES = 3 * 1024;
const NAMED_FILES = 5;

/**
 * Stores an email the webhook announced (AC-X-33); `false` when it is already stored (the same
 * event, provider email or `Message-ID`), which changes nothing.
 */
export async function recordInboundEmail(
  db: Database,
  input: {
    provider: 'resend';
    eventId: string;
    providerEmailId: string;
    messageId: string | null;
    receivedAt: Date;
  },
): Promise<boolean> {
  const messageId =
    input.messageId !== null && /^<[^<>\s]{1,298}>$/.test(input.messageId.trim())
      ? input.messageId.trim()
      : null;
  const row = await withInboundMail(db, (tx) => insertInboundEmail(tx, { ...input, messageId }));
  return row !== undefined;
}

/** What a verified sender is told about their email (AC-X-36). */
export interface InboundNote {
  reference: string;
  /** The text was longer than a message holds and was cut. */
  cut?: boolean;
  /** Files left out, by name (or kind), with why. */
  skipped?: string[];
  /** Nothing was added: over the day's limit. */
  overLimit?: boolean;
  /** Nothing was added: no words and no images. */
  empty?: boolean;
  /** The reply opened a new request (the old one was solved over 30 days ago). */
  followUp?: string;
}

/** The note's words (AC-X-36): what happened, in words a person can act on. */
export function inboundNoteText(
  note: InboundNote,
  firstName: string,
  link: string,
): { subject: string; text: string } {
  const lines: string[] = [];
  if (note.overLimit === true) {
    lines.push(
      `Your email to ${note.reference} wasn’t added: you’ve sent as many messages as we take in a day. Send it again tomorrow, or write in the app.`,
    );
  } else if (note.empty === true) {
    lines.push(
      `Your email to ${note.reference} had no words we could find above the quoted email, so nothing was added. Write your answer at the top of your reply.`,
    );
  } else {
    if (note.followUp !== undefined) {
      lines.push(
        `${note.reference} was closed over ${String(REOPEN_DAYS)} days ago, so your email opened a new request: ${note.followUp}.`,
      );
    } else {
      lines.push(`We added your email to ${note.reference}.`);
    }
    if (note.cut === true) {
      lines.push(
        `It was longer than ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters, so the end was cut. Send the rest in another reply.`,
      );
    }
    if (note.skipped !== undefined && note.skipped.length > 0) {
      const named = note.skipped.slice(0, NAMED_FILES);
      const more = note.skipped.length - named.length;
      lines.push(
        `${note.skipped.length === 1 ? 'This file wasn’t' : 'These files weren’t'} added: ${named.join('; ')}${more > 0 ? `; and ${String(more)} more` : ''}.`,
        `We take up to ${String(SUPPORT_SCREENSHOTS_PER_MESSAGE)} screenshots a message (JPEG, PNG or WebP, up to 10 MB). Add others in the app.`,
      );
    }
  }
  return {
    subject: `About your email to ${note.followUp ?? note.reference}`,
    text: [
      firstName === '' ? 'Hi,' : `Hi ${firstName},`,
      '',
      ...lines,
      '',
      `See the request: ${link}`,
      '',
      '— The Pepper team',
    ].join('\n'),
  };
}

/**
 * One pass of the inbound job: takes up to `limit` received emails and decides each one; gives
 * up on those past their attempts; empties held emails older than 7 days. Each email is its own
 * work: one failing is left for its next attempt and never stops the others.
 */
export async function processInboundEmails(
  db: Database,
  options: InboundEmailOptions,
): Promise<InboundEmailResult> {
  const clock = options.clock ?? systemClock;
  const result: InboundEmailResult = {
    landed: 0,
    held: 0,
    ignored: 0,
    refused: 0,
    failed: 0,
    retried: 0,
    emptied: 0,
  };
  const claimed = await withInboundMail(db, (tx) =>
    claimInboundEmails(tx, {
      now: clock.now(),
      leaseMs: LEASE_MS,
      limit: options.limit ?? 20,
      maxAttempts: MAX_ATTEMPTS,
    }),
  );
  for (const row of claimed) {
    try {
      const outcome = await processOne(db, row, options, clock.now());
      if (outcome !== 'gone') result[outcome] += 1;
    } catch {
      // Left `received`: taken again when its lease ends, until its last attempt.
      result.retried += 1;
    }
  }
  const now = clock.now();
  result.failed += await withInboundMail(db, (tx) =>
    failInboundEmailsPastAttempts(tx, { now, maxAttempts: MAX_ATTEMPTS }),
  );
  result.emptied = await withInboundMail(db, (tx) =>
    emptyHeldInboundEmails(tx, new Date(now.getTime() - HELD_DAYS * DAY_MS)),
  );
  return result;
}

type Outcome = 'landed' | 'held' | 'ignored' | 'refused' | 'failed' | 'gone';

/** Records an outcome that names no business (yet), unless another worker already did. */
async function finishUnmatched(
  db: Database,
  id: string,
  status: 'ignored' | 'refused' | 'failed',
  reason: string,
  now: Date,
): Promise<Outcome> {
  return withInboundMail(db, async (tx) => {
    if ((await lockReceivedInboundEmail(tx, id)) === undefined) return 'gone';
    await finishInboundEmail(tx, id, { status, reason }, now);
    return status;
  });
}

interface StoredImage {
  id: string;
  width: number;
  height: number;
  widths: number[];
  bytes: number;
}

async function processOne(
  db: Database,
  row: ClaimedInboundEmail,
  options: InboundEmailOptions,
  now: Date,
): Promise<Outcome> {
  const email = await options.source.fetch(row.providerEmailId);
  if (email === null) return finishUnmatched(db, row.id, 'failed', 'not_found', now);
  if (email.size !== null && email.size > INBOUND_EMAIL_MAX_BYTES) {
    return finishUnmatched(db, row.id, 'refused', 'too_large', now);
  }
  if (isAutoReply(email)) return finishUnmatched(db, row.id, 'ignored', 'auto_reply', now);
  if (isSpam(email)) return finishUnmatched(db, row.id, 'ignored', 'spam', now);
  const reference = findSupportReference(
    supportReplyKeysFrom(options.outboxKey),
    options.inboundDomain,
    email,
  );
  const found = reference === null ? undefined : await findSupportThreadForInbound(db, reference);
  if (reference === null || found === undefined) {
    return finishUnmatched(db, row.id, 'ignored', 'no_request', now);
  }
  const tenantId = TenantIdSchema.parse(found.tenantId);
  const { threadId } = found;
  const text = replyTextOf(email, SUPPORT_REPLY_ABOVE);

  // 1. Who sent it, may they write here, and is there room: decided in one short transaction.
  const decision = await withTenant(db, tenantId, async (tx) => {
    await setTransactionInboundMail(tx);
    if ((await lockReceivedInboundEmail(tx, row.id)) === undefined) return 'gone' as const;
    const hold = async (reason: string) => {
      await finishInboundEmail(
        tx,
        row.id,
        {
          status: 'held',
          reason,
          tenantId,
          threadId,
          fromAddress: email.from,
          heldText: text === '' ? '(no text)' : text,
        },
        now,
      );
      return 'held' as const;
    };
    const member = (await listTenantMembers(tx)).find(
      (candidate) => candidate.email.toLowerCase() === email.from,
    );
    if (member === undefined) return hold('unknown_sender');
    const userId = UserIdSchema.parse(member.userId);
    // The member's own view of the thread: RLS decides whether they may read it.
    await setTransactionUser(tx, userId);
    if ((await findSupportThread(tx, threadId, userId)) === undefined) {
      return hold('unknown_sender');
    }
    if (senderVerdict(email, options.authservId) !== 'pass') return hold('unverified_sender');
    const recent = await countInboundLanded(tx, {
      tenantId,
      threadId,
      since: new Date(now.getTime() - HOUR_MS),
    });
    if (recent >= LOOP_LIMIT) {
      await finishInboundEmail(
        tx,
        row.id,
        { status: 'ignored', reason: 'loop', tenantId, threadId },
        now,
      );
      return 'ignored' as const;
    }
    const uploaded = await countSupportScreenshotUploads(
      tx,
      userId,
      new Date(now.getTime() - DAY_MS),
    );
    return {
      userId,
      room: Math.max(
        0,
        Math.min(SUPPORT_SCREENSHOTS_PER_MESSAGE, SUPPORT_SCREENSHOTS_PER_DAY - uploaded),
      ),
    };
  });
  if (typeof decision === 'string') return decision;

  // 2. The images, checked and stored outside any transaction (as an upload is).
  const images = await storeImages(email.attachments, decision.room, tenantId, options.store);
  try {
    // 3. The message, its screenshots, the team's email and the sender's note, together with
    // the inbound row's outcome: a retry can't land it twice.
    const landed = await withTenant(db, tenantId, async (tx) => {
      await setTransactionInboundMail(tx);
      await setTransactionUser(tx, decision.userId);
      if ((await lockReceivedInboundEmail(tx, row.id)) === undefined) {
        return { outcome: 'gone' as const, kept: 0 };
      }
      return land(tx, {
        inboundId: row.id,
        text,
        images,
        tenantId,
        threadId,
        userId: decision.userId,
        options,
        now,
      });
    });
    const unused = images.stored.slice(landed.kept);
    if (unused.length > 0) await deleteImages(options.store, tenantId, unused);
    return landed.outcome;
  } catch (error) {
    await deleteImages(options.store, tenantId, images.stored);
    throw error;
  }
}

async function deleteImages(
  store: ScreenshotStorage | null,
  tenantId: string,
  images: readonly StoredImage[],
): Promise<void> {
  if (store === null || images.length === 0) return;
  await store
    .delete(images.map((image) => ({ tenantId, id: image.id, widths: image.widths })))
    .catch(() => undefined);
}

function nameOf(attachment: InboundAttachment): string {
  const name = (attachment.filename ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 80);
  if (name !== '') return name;
  return attachment.contentType?.split(';')[0]?.trim().slice(0, 40) ?? 'a file';
}

/**
 * Checks and stores up to `room` images (attached or inline) through the screenshot port, in
 * their order; everything else is named in `skipped` (tiny inline icons are dropped unnamed).
 */
async function storeImages(
  attachments: readonly InboundAttachment[],
  room: number,
  tenantId: string,
  store: ScreenshotStorage | null,
): Promise<{ stored: StoredImage[]; skipped: string[] }> {
  const stored: StoredImage[] = [];
  const skipped: string[] = [];
  for (const attachment of attachments) {
    const type = (attachment.contentType ?? '').toLowerCase();
    const looksLikeImage =
      type.startsWith('image/') ||
      /\.(png|jpe?g|webp|heic|heif|gif)$/i.test(attachment.filename ?? '');
    if (!looksLikeImage) {
      skipped.push(`${nameOf(attachment)} (not an image)`);
      continue;
    }
    if (attachment.inline && attachment.size !== null && attachment.size < INLINE_ICON_BYTES)
      continue;
    if (store === null) {
      skipped.push(`${nameOf(attachment)} (screenshots are off)`);
      continue;
    }
    if (stored.length >= room) {
      skipped.push(`${nameOf(attachment)} (over the limit)`);
      continue;
    }
    if (attachment.size !== null && attachment.size > SUPPORT_SCREENSHOT_MAX_BYTES) {
      skipped.push(`${nameOf(attachment)} (over 10 MB)`);
      continue;
    }
    const bytes = await attachment.content();
    if (attachment.inline && bytes.byteLength < INLINE_ICON_BYTES) continue;
    if (bytes.byteLength > SUPPORT_SCREENSHOT_MAX_BYTES) {
      skipped.push(`${nameOf(attachment)} (over 10 MB)`);
      continue;
    }
    const image = await store.process(bytes);
    if (image.kind === 'rejected') {
      skipped.push(
        `${nameOf(attachment)} (${image.reason === 'heic' ? 'HEIC: send it as JPEG' : 'not a JPEG, PNG or WebP image'})`,
      );
      continue;
    }
    const widest = image.variants.at(-1);
    if (widest === undefined) continue;
    const id = newId();
    const widths = image.variants.map((variant) => variant.width);
    try {
      await Promise.all(
        image.variants.map((variant) => store.put(tenantId, id, variant.width, variant.data)),
      );
    } catch (error) {
      await deleteImages(store, tenantId, [
        ...stored,
        { id, width: 0, height: 0, widths, bytes: 0 },
      ]);
      throw error;
    }
    stored.push({
      id,
      width: image.width,
      height: image.height,
      widths,
      bytes: widest.data.byteLength,
    });
  }
  return { stored, skipped };
}

/** Lands a verified reply (AC-X-34/36/37/38): the member's message, as in the app. */
async function land(
  tx: TenantTx,
  input: {
    inboundId: string;
    text: string;
    images: { stored: StoredImage[]; skipped: string[] };
    tenantId: string;
    threadId: string;
    userId: UserId;
    options: InboundEmailOptions;
    now: Date;
  },
): Promise<{ outcome: Outcome; kept: number }> {
  const { text, images, tenantId, threadId, userId, options, now } = input;
  const thread = await lockSupportThread(tx, threadId);
  if (thread === undefined) {
    await finishInboundEmail(
      tx,
      input.inboundId,
      { status: 'ignored', reason: 'no_request', tenantId },
      now,
    );
    return { outcome: 'ignored', kept: 0 };
  }
  const requester = await requesterOf(tx, userId);
  const firstName = firstNameOf(requester.name);
  const note = async (body: InboundNote, linkThread: string) => {
    const words = inboundNoteText(body, firstName, `${options.baseUrl}/support/${linkThread}`);
    await queueEmail(
      tx,
      { to: requester.email, ...words, autoSubmitted: true },
      { key: options.outboxKey, dedupeKey: `support.inbound_note:${input.inboundId}`, now },
    );
  };
  const refuse = async (reason: string, body: InboundNote) => {
    await note(body, threadId);
    await finishInboundEmail(
      tx,
      input.inboundId,
      { status: 'refused', reason, tenantId, threadId },
      now,
    );
    return { outcome: 'refused' as const, kept: 0 };
  };

  const followUp =
    thread.status === 'solved' &&
    thread.solvedAt !== null &&
    thread.solvedAt.getTime() < now.getTime() - REOPEN_DAYS * DAY_MS;
  await lockSupportWriter(tx, userId);
  const counts = await countSupportWrites(tx, userId, new Date(now.getTime() - DAY_MS));
  if (
    counts.messages >= SUPPORT_MESSAGES_PER_DAY ||
    (followUp && counts.threads >= SUPPORT_THREADS_PER_DAY)
  ) {
    return refuse('limit', { reference: thread.reference, overLimit: true });
  }
  // The day's screenshots again, under the writer's lock: a reply sent at the same moment counts.
  const uploaded = await countSupportScreenshotUploads(
    tx,
    userId,
    new Date(now.getTime() - DAY_MS),
  );
  const room = Math.max(0, SUPPORT_SCREENSHOTS_PER_DAY - uploaded);
  const kept = images.stored.slice(0, room);
  const skipped = [
    ...images.skipped,
    ...images.stored.slice(room).map(() => 'an image (over the day’s screenshots)'),
  ];
  if (text === '' && kept.length === 0) {
    return refuse('empty', { reference: thread.reference, empty: true });
  }
  const prefix = followUp ? `Follow-up to ${thread.reference}.\n\n` : '';
  const room4000 = SUPPORT_MESSAGE_MAX - prefix.length;
  const words = text === '' ? 'Sent screenshots by email.' : text;
  const cut = words.length > room4000;
  const body = `${prefix}${cut ? `${words.slice(0, room4000 - 1).trimEnd()}…` : words}`;

  let target = { threadId, reference: thread.reference, messageId: '' };
  if (followUp) {
    const context = SupportContextSchema.parse({
      appVersion: options.release,
      userAgent: 'Email',
      role: requester.role,
      setup: {
        bookable: await isBusinessBookable(tx),
        firstBooking: await hasActivation(tx, 'first_booking'),
      },
    });
    let created: { id: string; messageId: string; reference: string } | null = null;
    for (let attempt = 0; attempt < REFERENCE_TRIES && created === null; attempt += 1) {
      const reference = newSupportReference();
      const row = await insertSupportThread(tx, {
        reference,
        kind: thread.kind,
        openedByUserId: userId,
        context,
        body,
        now,
        channel: 'email',
      });
      if (row !== null) created = { ...row, reference };
    }
    if (created === null) throw new Error('No free support reference');
    target = { threadId: created.id, reference: created.reference, messageId: created.messageId };
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId },
      change: {
        action: 'support_thread.opened',
        entity: { type: 'support_thread', id: created.id },
        before: null,
        after: { kind: thread.kind, status: 'waiting_on_pepper', channel: 'email' },
      },
    });
  } else {
    const written = await appendSupportMessage(tx, {
      threadId,
      author: { kind: 'member', userId },
      body,
      status: 'waiting_on_pepper',
      now,
      channel: 'email',
    });
    target.messageId = written.id;
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId },
      change: {
        action: 'support_thread.replied',
        entity: { type: 'support_thread', id: threadId },
        before: { status: thread.status },
        after: { status: 'waiting_on_pepper', channel: 'email' },
      },
    });
  }
  for (const image of kept) {
    await insertSupportScreenshot(tx, {
      id: image.id,
      uploadedBy: userId,
      width: image.width,
      height: image.height,
      widths: image.widths,
      bytes: image.bytes,
      now,
    });
  }
  if (kept.length > 0) {
    await attachSupportScreenshots(tx, {
      ids: kept.map((image) => image.id),
      threadId: target.threadId,
      messageId: target.messageId,
      now,
    });
  }
  await markSupportThreadRead(tx, target.threadId, userId, now);
  await emailTeam(tx, options, {
    threadId: target.threadId,
    reference: target.reference,
    kind: thread.kind,
    message: body,
    requester,
    context: null,
    screenshots: kept.length,
    dedupeKey: followUp
      ? `support.opened:${target.threadId}`
      : `support.replied:${target.messageId}`,
    now,
    first: followUp,
    byEmail: true,
  });
  if (cut || skipped.length > 0 || followUp) {
    await note(
      {
        reference: thread.reference,
        cut,
        skipped,
        ...(followUp && { followUp: target.reference }),
      },
      target.threadId,
    );
  }
  await finishInboundEmail(
    tx,
    input.inboundId,
    {
      status: 'landed',
      tenantId,
      threadId: target.threadId,
      supportMessageId: target.messageId,
      ...(followUp && { reason: 'follow_up' }),
    },
    now,
  );
  return { outcome: 'landed', kept: kept.length };
}
