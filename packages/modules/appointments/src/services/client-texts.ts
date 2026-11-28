import {
  ClientIdSchema,
  ClientTextReplyRequestSchema,
  ClientTextReplySchema,
  CLIENT_TEXT_WINDOW_DAYS,
  FeedItemIdSchema,
  OutboxDedupeKeySchema,
  OutboxMessageIdSchema,
  SmsBodySchema,
  formatDate,
  fromZoned,
  smsReplySender,
  smsSendableAt,
  toZoned,
  type ClientId,
  type ClientTextReply,
  type ClientTextReplyRequest,
} from '@pepper/contracts';
import {
  ClientNotFoundError,
  FeedItemNotFoundError,
  auditActorOf,
  queueSms,
  requirePermission,
  systemClock,
  type Actor,
  type Clock,
} from '@pepper/core';
import {
  appendAuditEntry,
  cancelOutboxMessages,
  closeFeedItem,
  countInboundClientTexts,
  deleteClientTextReply,
  findClient,
  findClientNextVisit,
  findClientText,
  findCurrentTenant,
  insertClientTextReply,
  insertInboundClientText,
  newId,
  reopenClientTextCard,
  smsReplyTarget,
  withMember,
  withTenant,
  writeClientTextCard,
  type Database,
  type SmsProvider,
} from '@pepper/db';
import { ClientTextNotSendableError } from '../errors.js';
import { reminderSettingsOf, textableNumber } from './reminders.js';

// Client texts kept (S80, ADR-0072). A client's text to Pepper's one number that isn't a keyword
// reaches here after the webhook's signature check and the keywords, with no business in it.
// `sms_reply_target` answers whose it is (ids only): the one business, and its one client whose
// consent in force is for the number, that texted it in the last 7 days. Anything else is stored
// nowhere. The kept text becomes one card a day per client for owners and managers, naming the
// client's next visit; they answer with Reply, a text in their own words under the client's
// consent, held for Undo and the quiet hours. No model reads the words in S80.

const DAY_MS = 86_400_000;
/** How long a text's card stays open (a text a week old is no longer news). */
export const CLIENT_TEXT_CARD_DAYS = CLIENT_TEXT_WINDOW_DAYS;
/** The most texts a card counts ("1000 texts"; the webhook limits a number long before). */
const CLIENT_TEXT_COUNT_MAX = 1000;
/** Seconds a reply waits before it may go, so Undo can take it back (like the AI's emails). */
export const CLIENT_TEXT_REPLY_HOLD_SECONDS = 10;

/** One text that reached Pepper's number and wasn't a keyword, "C" or a card's "Y"/"N". */
export interface InboundClientText {
  provider: SmsProvider;
  /** The provider's id for it: a replay has the same one. */
  eventId: string;
  from: string;
  body: string;
  receivedAt: Date;
}

/** What became of it: `kept` (by one business; `replay` when already kept) or `unrouted`. */
export type KeepClientTextResult = { outcome: 'kept'; replay: boolean } | { outcome: 'unrouted' };

/**
 * Keeps a client's text by the one business it belongs to (AC-X-229) and puts it on the card for
 * owners and managers (AC-X-232), in that business's transaction; `unrouted` when no business,
 * or more than one, fits (AC-X-230): it is stored nowhere.
 */
export async function keepClientText(
  db: Database,
  text: InboundClientText,
): Promise<KeepClientTextResult> {
  const body = text.body.trim();
  if (body.length === 0) return { outcome: 'unrouted' };
  const target = await smsReplyTarget(db, text.from, text.receivedAt);
  if (target === undefined) return { outcome: 'unrouted' };
  return withTenant(db, target.tenantId, async (tx) => {
    const kept = await insertInboundClientText(tx, {
      clientId: target.clientId,
      // Kept as sent, within the table's limit (a long text is cut, never refused).
      body: body.slice(0, 1600),
      provider: text.provider,
      eventId: text.eventId,
      receivedAt: text.receivedAt,
    });
    if (kept === undefined) return { outcome: 'kept', replay: true };
    await appendAuditEntry(tx, {
      actor: { kind: 'system' },
      change: {
        action: 'client_text.received',
        entity: { type: 'client_text', id: kept.id },
        before: null,
        after: { clientId: target.clientId },
      },
    });
    const tenant = await findCurrentTenant(tx);
    const timeZone = tenant?.timeZone ?? 'UTC';
    const at = text.receivedAt.getTime();
    const local = toZoned(timeZone, at);
    const next = await findClientNextVisit(tx, target.clientId, text.receivedAt);
    await writeClientTextCard(tx, {
      clientId: target.clientId,
      day: formatDate(local),
      textId: kept.id,
      receivedAt: text.receivedAt,
      // The texts of the client's local day so far, this one included.
      count: Math.min(
        CLIENT_TEXT_COUNT_MAX,
        await countInboundClientTexts(tx, target.clientId, {
          from: new Date(fromZoned(timeZone, local, 0)),
          to: new Date(at + 1),
        }),
      ),
      nextVisit: next ?? null,
      expiresAt: new Date(at + CLIENT_TEXT_CARD_DAYS * DAY_MS),
    });
    return { outcome: 'kept', replay: false };
  });
}

export interface ClientTextReplyOptions {
  /** Whether this deployment sends texts (`SMS_PROVIDER` set, ADR-0065); default no. */
  texts?: boolean | undefined;
  outboxKey: Buffer;
  clock?: Clock;
}

/**
 * A member's reply to a client's text (AC-X-233): owners and managers, in their own words, as a
 * text from the business ("Plum Salon via Pepper: …") under the client's consent in force (v1 or v3, purpose
 * `reply`), checked again at delivery (a STOP drops it), held `CLIENT_TEXT_REPLY_HOLD_SECONDS`
 * for Undo and then until the quiet hours end. Audited as the member, without the words. The
 * card it answers is done. `ClientTextNotSendableError` when it can't go.
 */
export async function replyToClientText(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  request: ClientTextReplyRequest,
  options: ClientTextReplyOptions,
): Promise<ClientTextReply> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const { body, feedItemId } = ClientTextReplyRequestSchema.parse(request);
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    if ((await findClient(tx, id)) === undefined) throw new ClientNotFoundError();
    const tenant = await findCurrentTenant(tx);
    if (tenant === undefined) throw new Error('The business is not visible to this transaction');
    if (options.texts !== true || !reminderSettingsOf(tenant).texts) {
      throw new ClientTextNotSendableError('texts_off');
    }
    const phone = await textableNumber(tx, id, 'reply');
    if (phone === null) throw new ClientTextNotSendableError('no_consent');
    const words = SmsBodySchema.safeParse(`${smsReplySender([tenant.name])}: ${body}`);
    if (!words.success) throw new ClientTextNotSendableError('too_long');
    const heldUntil = new Date(now.getTime() + CLIENT_TEXT_REPLY_HOLD_SECONDS * 1000);
    const messageId = await queueSms(
      tx,
      { to: phone, body: words.data, wordsBy: 'member', purpose: 'reply' },
      {
        key: options.outboxKey,
        dedupeKey: OutboxDedupeKeySchema.parse(`client_text.reply:${newId()}`),
        now: heldUntil,
      },
    );
    if (messageId === undefined) throw new Error('A new reply was queued already');
    const reply = await insertClientTextReply(tx, {
      clientId: id,
      body,
      outboxMessageId: messageId,
      userId: actor.context.userId,
      feedItemId: feedItemId ?? null,
      at: now,
    });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client_text.replied',
        entity: { type: 'client_text', id: reply.id },
        before: null,
        after: { clientId: id, outboxMessageId: messageId },
      },
      requestId: actor.requestId,
    });
    if (feedItemId !== undefined) {
      const closed = await closeFeedItem(tx, FeedItemIdSchema.parse(feedItemId), 'done', now);
      // Another kind or another client's card: nothing is done (the transaction rolls back).
      if (closed?.kind !== 'client_text' || closed.clientId !== id) {
        throw new FeedItemNotFoundError();
      }
    }
    return ClientTextReplySchema.parse({
      replyId: reply.id,
      sendsAt: new Date(smsSendableAt(tenant.timeZone, heldUntil.getTime())).toISOString(),
    });
  });
}

/**
 * Undo of a reply (AC-X-233): taken back while no worker is sending it (its message cancelled,
 * the reply removed, the client's card open again), else `too_late`. Audited as the member.
 */
export async function undoClientTextReply(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  replyId: string,
  options: { clock?: Clock } = {},
): Promise<{ outcome: 'taken_back' | 'too_late' }> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const now = (options.clock ?? systemClock).now();
  return withMember(db, actor.context, async (tx) => {
    if ((await findClient(tx, id)) === undefined) throw new ClientNotFoundError();
    const reply = await findClientText(tx, replyId);
    if (reply?.clientId !== id || reply.direction !== 'out' || reply.outboxMessageId === null) {
      throw new ClientTextNotSendableError('not_found');
    }
    const { cancelled } = await cancelOutboxMessages(
      tx,
      [OutboxMessageIdSchema.parse(reply.outboxMessageId)],
      now,
    );
    if (cancelled.length === 0) return { outcome: 'too_late' as const };
    await deleteClientTextReply(tx, reply.id);
    // The card the reply closed, if any, opens again; a card the member closed with Done stays.
    if (reply.feedItemId !== null) await reopenClientTextCard(tx, reply.feedItemId);
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'client_text.reply_taken_back',
        entity: { type: 'client_text', id: reply.id },
        before: { clientId: id },
        after: null,
      },
      requestId: actor.requestId,
    });
    return { outcome: 'taken_back' as const };
  });
}
