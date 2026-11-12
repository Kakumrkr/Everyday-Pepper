import {
  classifySmsKeyword,
  ClientIdSchema,
  ClientTextsSchema,
  SmsConsentSourceSchema,
  SmsConsentWordingVersionSchema,
  UtcDateTimeSchema,
  OutboxDedupeKeySchema,
  OutboxMessageIdSchema,
  OutboxSmsSchema,
  smsDeliveryStatusOf,
  smsConsentText,
  smsKeywordReply,
  SmsPhoneSchema,
  smsSendableAt,
  TenantIdSchema,
  type AuditActor,
  type ClientId,
  type ClientTexts,
  type OutboxDedupeKey,
  type OutboxMessageId,
  type OutboxSmsInput,
  type SmsConsentSource,
  type SmsConsentWordingVersion,
  type SmsKeyword,
  type TenantId,
} from '@pepper/contracts';
import {
  advanceSmsDelivery,
  appendAuditEntry,
  findActiveSmsConsent,
  findClient,
  findCurrentTenant,
  insertOutboxMessage,
  insertSmsConsent,
  insertSmsKeywordEvent,
  isSmsOptedOut,
  listSmsConsentsForClient,
  newId,
  revokeSmsConsent,
  smsConsentBusinesses,
  withMember,
  withSmsInbound,
  withTenant,
  type Database,
  type SmsProvider,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import { ClientNotFoundError } from '../errors.js';
import { sealOutboxContent } from '../outbox.js';
import { can } from '../permissions.js';

// The SMS channel's rules (S61, ADR-0065): who may be texted, when, and what a reply asks for.
// Callers queue with `queueSms` inside their change's transaction; delivery
// (`deliverOutboxMessage`) asks `smsPermission` again, so a forgotten check never sends a text.

/**
 * Whether the business may text a number now (ADR-0065 §3): `allowed`; `not_textable` (not a
 * US or Canadian number); `opted_out` (replied STOP, for every business on Pepper's number);
 * `no_consent` (the business has no active consent for it). Callers fall back to email.
 */
export type SmsPermission = 'allowed' | 'not_textable' | 'opted_out' | 'no_consent';

export async function smsPermission(tx: TenantTx, phone: string): Promise<SmsPermission> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return 'not_textable';
  if (await isSmsOptedOut(tx, parsed.data)) return 'opted_out';
  if ((await findActiveSmsConsent(tx, parsed.data)) === undefined) return 'no_consent';
  return 'allowed';
}

/**
 * Queues a text in the open transaction of a business, so it is sent if and only if the change
 * commits (like `queueEmail`). Its words are normalised to GSM-7 and refused above the segment
 * limit (`OutboxSmsSchema`). A text that isn't urgent is due at the first sendable time in the
 * business's zone (AC-X-60). Returns the message id, or `undefined` when the business already
 * queued a message with this dedupe key.
 */
export async function queueSms(
  tx: TenantTx,
  sms: OutboxSmsInput,
  options: { key: Buffer; dedupeKey: OutboxDedupeKey; now: Date },
): Promise<OutboxMessageId | undefined> {
  const content = OutboxSmsSchema.parse(sms);
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('A text is queued in a business’s transaction');
  const now = options.now.getTime();
  const availableAt = content.urgent === true ? now : smsSendableAt(tenant.timeZone, now);
  const id = OutboxMessageIdSchema.parse(newId());
  const row = await insertOutboxMessage(tx, {
    id,
    type: 'sms',
    dedupeKey: OutboxDedupeKeySchema.parse(options.dedupeKey),
    payload: sealOutboxContent(options.key, id, Buffer.from(JSON.stringify(content))),
    availableAt: new Date(availableAt),
  });
  return row === undefined ? undefined : id;
}

export interface SmsConsentInput {
  phone: string;
  source: SmsConsentSource;
  /** `booking_page`: the client who ticked the box. */
  clientId?: string | null;
  /** `member_settings`: the member, for texts to themselves. */
  userId?: string | null;
  wordingVersion: SmsConsentWordingVersion;
  givenAt: Date;
}

/**
 * Records a consent in the open transaction of a business (ADR-0065 §7, AC-X-58), replacing the
 * number's earlier one, with the words as shown (the business's name as it is now), and audits it
 * (how and which wording; never the number). Returns the consent's id.
 */
export async function recordSmsConsent(
  tx: TenantTx,
  input: SmsConsentInput,
  audit: { actor: AuditActor; requestId?: string | undefined },
): Promise<string> {
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined) throw new Error('A consent is recorded in a business’s transaction');
  const { id, replaced } = await insertSmsConsent(tx, {
    ...input,
    shownText: smsConsentText(input.wordingVersion, tenant.name),
  });
  if (replaced !== null) await auditRevoked(tx, replaced, audit);
  await appendAuditEntry(tx, {
    actor: audit.actor,
    change: {
      action: 'sms.consent_given',
      entity: { type: 'sms_consent', id },
      before: null,
      after: {
        source: input.source,
        wordingVersion: input.wordingVersion,
        clientId:
          input.clientId === undefined || input.clientId === null
            ? null
            : ClientIdSchema.parse(input.clientId),
      },
    },
    requestId: audit.requestId,
  });
  return id;
}

/**
 * Revokes the number's consent in the open transaction of a business (the client asked a member
 * to stop, or a member turned their own texts off): no text goes to it from the next delivery.
 * Returns whether there was one.
 */
export async function revokeSmsConsentFor(
  tx: TenantTx,
  phone: string,
  audit: { actor: AuditActor; requestId?: string | undefined; now: Date },
): Promise<boolean> {
  const revoked = await revokeSmsConsent(tx, phone, audit.now);
  if (revoked === null) return false;
  await auditRevoked(tx, revoked, audit);
  return true;
}

/**
 * Where a client's texts stand, for their profile (S61.2, AC-X-66): their latest consent, with
 * the words exactly as shown. Staff see only their own clients (`ClientNotFoundError`).
 */
export async function getClientTexts(
  db: Database,
  actor: Actor,
  clientId: ClientId,
): Promise<ClientTexts> {
  requirePermission(actor, 'clients.read');
  const id = ClientIdSchema.parse(clientId);
  return withMember(db, actor.context, (tx) => clientTextsIn(tx, actor, id));
}

/**
 * Stops a client's texts from the profile (S61.2, AC-X-67): their consent in force is revoked
 * (audited as the member), so no text goes to the number from the next delivery. Only the
 * client can turn texts back on (START, or the booking page's box). Answers the new status;
 * nothing in force: the status unchanged.
 */
export async function stopClientTexts(
  db: Database,
  actor: Actor,
  clientId: ClientId,
  options: { clock?: Clock } = {},
): Promise<ClientTexts> {
  requirePermission(actor, 'clients.manage');
  const id = ClientIdSchema.parse(clientId);
  const now = new Date((options.clock ?? systemClock).now());
  return withMember(db, actor.context, async (tx) => {
    if ((await findClient(tx, id)) === undefined) throw new ClientNotFoundError();
    const [latest] = await listSmsConsentsForClient(tx, id, 1);
    if (latest?.revokedAt === null) {
      await revokeSmsConsentFor(tx, latest.phone, {
        actor: auditActorOf(actor),
        requestId: actor.requestId,
        now,
      });
    }
    return clientTextsIn(tx, actor, id);
  });
}

async function clientTextsIn(tx: TenantTx, actor: Actor, id: ClientId): Promise<ClientTexts> {
  const client = await findClient(tx, id);
  if (client === undefined) throw new ClientNotFoundError();
  const [latest] = await listSmsConsentsForClient(tx, id, 1);
  const textable = SmsPhoneSchema.safeParse(client.phone ?? '').success;
  if (latest === undefined) {
    return ClientTextsSchema.parse({ status: 'never', textable, consent: null, canStop: false });
  }
  const active = latest.revokedAt === null;
  const status = !active ? 'stopped' : (await isSmsOptedOut(tx, latest.phone)) ? 'opted_out' : 'on';
  return ClientTextsSchema.parse({
    status,
    textable,
    consent: {
      phone: latest.phone,
      source: SmsConsentSourceSchema.parse(latest.source),
      wordingVersion: SmsConsentWordingVersionSchema.parse(latest.wordingVersion),
      words: latest.shownText,
      givenAt: UtcDateTimeSchema.parse(latest.givenAt.toISOString()),
      stoppedAt:
        latest.revokedAt === null ? null : UtcDateTimeSchema.parse(latest.revokedAt.toISOString()),
    },
    canStop: active && can(actor.context, 'clients.manage'),
  });
}

async function auditRevoked(
  tx: TenantTx,
  id: string,
  audit: { actor: AuditActor; requestId?: string | undefined },
): Promise<void> {
  await appendAuditEntry(tx, {
    actor: audit.actor,
    change: {
      action: 'sms.consent_revoked',
      entity: { type: 'sms_consent', id },
      before: { active: true },
      after: { active: false },
    },
    requestId: audit.requestId,
  });
}

/** One text that reached Pepper's number, after the webhook's signature check. */
export interface InboundSms {
  provider: SmsProvider;
  /** The provider's id for it (Twilio's `MessageSid`): a replay has the same one. */
  eventId: string;
  from: string;
  body: string;
  receivedAt: Date;
}

/** What a text to Pepper's number did: the keyword it carried, and the reply to send back. */
export interface InboundSmsResult {
  keyword: SmsKeyword | null;
  /** `null`: no reply (not a keyword, a replay, or a sender Pepper never texts). */
  reply: string | null;
}

/**
 * Handles a text to Pepper's number in the webhook's own request (ADR-0065 §5, AC-X-59): STOP,
 * START or HELP is recorded once and answered; anything else is neither stored nor answered (two-way
 * texting is V1.1). After this returns for a STOP, the next delivery to the number is dropped.
 * The reply names the businesses the number said yes to (S61.2).
 */
export async function handleInboundSms(
  db: Database,
  sms: InboundSms,
  options: { helpUrl: string },
): Promise<InboundSmsResult> {
  const keyword = classifySmsKeyword(sms.body);
  const from = SmsPhoneSchema.safeParse(sms.from);
  if (keyword === null || !from.success) return { keyword, reply: null };
  const businesses = await withSmsInbound(db, async (tx) => {
    const recorded = await insertSmsKeywordEvent(tx, {
      provider: sms.provider,
      eventId: sms.eventId,
      phone: from.data,
      keyword,
      origin: 'keyword',
      receivedAt: sms.receivedAt,
    });
    // The reply names who texts this number (S61.2, AC-X-68): names only, never a client.
    return recorded ? smsConsentBusinesses(tx, from.data) : null;
  });
  return {
    keyword,
    reply: businesses === null ? null : smsKeywordReply(keyword, options.helpUrl, businesses),
  };
}

/**
 * Records a provider's opt-out for a number (Twilio's 21610 when a text was sent: the person
 * replied STOP to Twilio directly), once per outbox message.
 */
export async function recordProviderOptOut(
  db: Database,
  input: { provider: SmsProvider; messageId: OutboxMessageId; phone: string; at: Date },
): Promise<void> {
  await withSmsInbound(db, (tx) =>
    insertSmsKeywordEvent(tx, {
      provider: input.provider,
      eventId: `${OutboxMessageIdSchema.parse(input.messageId)}:21610`,
      phone: input.phone,
      keyword: 'stop',
      origin: 'provider',
      receivedAt: input.at,
    }),
  );
}

/**
 * A provider's status callback for a business's text (ADR-0065 §6, AC-X-62), the business and
 * message named by the signed URL: recorded forwards only. `ignored`: a status Pepper doesn't
 * track (`receiving`).
 */
export async function recordSmsStatus(
  db: Database,
  input: {
    tenantId: TenantId;
    messageId: string;
    providerMessageId: string;
    status: string;
    errorCode: number | null;
  },
): Promise<'moved' | 'kept' | 'missing' | 'ignored'> {
  const status = smsDeliveryStatusOf(input.status);
  if (status === null) return 'ignored';
  const tenant = TenantIdSchema.safeParse(input.tenantId);
  if (!tenant.success) return 'missing';
  return withTenant(db, tenant.data, (tx) =>
    advanceSmsDelivery(tx, {
      id: input.messageId,
      providerMessageId: input.providerMessageId,
      status,
      errorCode: input.errorCode,
    }),
  );
}
