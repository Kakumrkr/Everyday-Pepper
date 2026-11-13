import {
  SmsConsentSourceSchema,
  SmsConsentWordingVersionSchema,
  SmsDeliveryStatusSchema,
  SmsKeywordSchema,
  SmsPhoneSchema,
  smsStatusMovesForward,
  type SmsConsentSource,
  type SmsConsentWordingVersion,
  type SmsDeliveryStatus,
  type SmsKeyword,
} from '@pepper/contracts';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { smsConsents, smsDeliveries, smsKeywordEvents, type SmsConsentRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The SMS channel (S61, ADR-0065). Consents and deliveries are the business's rows (RLS); keyword
// events are platform rows, written in the SMS context (`withSmsInbound`) and asked at delivery
// through `sms_opted_out`, a boolean.

const Id = z.uuid();
const ProviderSchema = z.enum(['twilio', 'sandbox']);
export type SmsProvider = z.infer<typeof ProviderSchema>;

export interface NewSmsConsent {
  phone: string;
  source: SmsConsentSource;
  /** The client who ticked the box (`booking_page`). */
  clientId?: string | null;
  /** The member, for texts to themselves (`member_settings`). */
  userId?: string | null;
  wordingVersion: SmsConsentWordingVersion;
  /** The words as shown (`smsConsentText`), the business's name in them. */
  shownText: string;
  givenAt: Date;
}

/**
 * Records a consent for the transaction's business, revoking the number's active one first (at
 * `givenAt`, so the record shows which was in force when). Returns the new row's id and the
 * revoked one's, if any.
 */
export async function insertSmsConsent(
  tx: TenantTx,
  input: NewSmsConsent,
): Promise<{ id: string; replaced: string | null }> {
  const phone = SmsPhoneSchema.parse(input.phone);
  const source = SmsConsentSourceSchema.parse(input.source);
  // Only the same source's (S63): a client's consent and a member's own stand side by side.
  const revoked = await revokeActive(tx, phone, source, input.givenAt);
  const [row] = await tx
    .insert(smsConsents)
    .values({
      phone,
      source,
      clientId:
        input.clientId === undefined || input.clientId === null ? null : Id.parse(input.clientId),
      userId: input.userId === undefined || input.userId === null ? null : Id.parse(input.userId),
      wordingVersion: SmsConsentWordingVersionSchema.parse(input.wordingVersion),
      shownText: z.string().min(20).max(600).parse(input.shownText),
      givenAt: input.givenAt,
    })
    .returning({ id: smsConsents.id });
  if (row === undefined) throw new Error('The consent was not recorded');
  return { id: row.id, replaced: revoked[0] ?? null };
}

/**
 * Revokes the number's active consent of one source in the business (a client's, or a member's
 * own: S63); its id, or `null` when none was.
 */
export async function revokeSmsConsent(
  tx: TenantTx,
  phone: string,
  source: SmsConsentSource,
  now: Date,
): Promise<string | null> {
  return (
    (
      await revokeActive(tx, SmsPhoneSchema.parse(phone), SmsConsentSourceSchema.parse(source), now)
    )[0] ?? null
  );
}

async function revokeActive(
  tx: TenantTx,
  phone: string,
  source: SmsConsentSource,
  at: Date,
): Promise<string[]> {
  // `GREATEST`: a consent given "later" by a clock that ran ahead still revokes cleanly.
  const rows = await tx
    .update(smsConsents)
    .set({ revokedAt: sql`GREATEST(${at.toISOString()}::timestamptz, ${smsConsents.givenAt})` })
    .where(
      and(
        eq(smsConsents.phone, phone),
        eq(smsConsents.source, source),
        isNull(smsConsents.revokedAt),
      ),
    )
    .returning({ id: smsConsents.id });
  return rows.map((row) => row.id);
}

/** The number's active consent in the business (any source: either lets the business text it). */
export async function findActiveSmsConsent(
  tx: TenantTx,
  phone: string,
): Promise<SmsConsentRow | undefined> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return undefined;
  const [row] = await tx
    .select()
    .from(smsConsents)
    .where(and(eq(smsConsents.phone, parsed.data), isNull(smsConsents.revokedAt)));
  return row;
}

/** The member's own active consent for the number in the business (S63: "Text me cards"). */
export async function findActiveMemberSmsConsent(
  tx: TenantTx,
  phone: string,
  userId: string,
): Promise<SmsConsentRow | undefined> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return undefined;
  const [row] = await tx
    .select()
    .from(smsConsents)
    .where(
      and(
        eq(smsConsents.phone, parsed.data),
        eq(smsConsents.source, 'member_settings'),
        eq(smsConsents.userId, z.uuid().parse(userId)),
        isNull(smsConsents.revokedAt),
      ),
    );
  return row;
}

/**
 * The client's consent records in the business, the latest first (S61.2, AC-X-66): what the
 * profile shows. A member's scope (staff: their own clients) is the caller's to check.
 */
export async function listSmsConsentsForClient(
  tx: TenantTx,
  clientId: string,
  limit = 5,
): Promise<SmsConsentRow[]> {
  return tx
    .select()
    .from(smsConsents)
    .where(eq(smsConsents.clientId, Id.parse(clientId)))
    .orderBy(desc(smsConsents.givenAt), desc(smsConsents.id))
    .limit(z.number().int().min(1).max(50).parse(limit));
}

/** The client's consents in force (one a number), the latest first (S61.2, AC-X-67). */
export async function listActiveSmsConsentsForClient(
  tx: TenantTx,
  clientId: string,
): Promise<SmsConsentRow[]> {
  return tx
    .select()
    .from(smsConsents)
    .where(and(eq(smsConsents.clientId, Id.parse(clientId)), isNull(smsConsents.revokedAt)))
    .orderBy(desc(smsConsents.givenAt), desc(smsConsents.id));
}

/**
 * The names of the businesses a number has an active consent with, the latest first, two at
 * most (S61.2, AC-X-68): who a reply to Pepper's number names. Through `sms_consent_businesses`,
 * which answers names only, in any transaction.
 */
export async function smsConsentBusinesses(
  db: Database | TenantTx,
  phone: string,
): Promise<string[]> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return [];
  const { rows } = await db.execute<{ name: string }>(
    sql`SELECT name FROM sms_consent_businesses(${parsed.data})`,
  );
  return rows.map((row) => row.name);
}

/** Every consent record of the business, oldest first, for its export (ADR-0053). */
export async function listSmsConsentsForExport(tx: TenantTx): Promise<
  {
    id: string;
    phone: string;
    source: string;
    clientId: string | null;
    wordingVersion: string;
    shownText: string;
    givenAt: Date;
    revokedAt: Date | null;
  }[]
> {
  return tx
    .select({
      id: smsConsents.id,
      phone: smsConsents.phone,
      source: smsConsents.source,
      clientId: smsConsents.clientId,
      wordingVersion: smsConsents.wordingVersion,
      shownText: smsConsents.shownText,
      givenAt: smsConsents.givenAt,
      revokedAt: smsConsents.revokedAt,
    })
    .from(smsConsents)
    .orderBy(asc(smsConsents.givenAt), asc(smsConsents.id));
}

/** Records a sent text's delivery for the transaction's business (with the message marked sent). */
export async function insertSmsDelivery(
  tx: TenantTx,
  input: {
    /** The outbox message's id. */
    id: string;
    provider: SmsProvider;
    providerMessageId: string;
    segments: number;
    status: SmsDeliveryStatus;
  },
): Promise<void> {
  await tx
    .insert(smsDeliveries)
    .values({
      id: Id.parse(input.id),
      provider: ProviderSchema.parse(input.provider),
      providerMessageId: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/)
        .parse(input.providerMessageId),
      segments: z.number().int().min(1).max(10).parse(input.segments),
      status: SmsDeliveryStatusSchema.parse(input.status),
    })
    .onConflictDoNothing();
}

/**
 * Moves a delivery's status forwards (AC-X-62): `moved`; `kept` when the status isn't ahead of
 * the stored one (a late or repeated callback); `missing` when the business has no such text or
 * the provider's id doesn't match it.
 */
export async function advanceSmsDelivery(
  tx: TenantTx,
  input: {
    id: string;
    providerMessageId: string;
    status: SmsDeliveryStatus;
    errorCode: number | null;
  },
): Promise<'moved' | 'kept' | 'missing'> {
  const id = Id.safeParse(input.id);
  if (!id.success) return 'missing';
  const [row] = await tx
    .select({ status: smsDeliveries.status, providerMessageId: smsDeliveries.providerMessageId })
    .from(smsDeliveries)
    .where(eq(smsDeliveries.id, id.data))
    .for('update');
  if (row?.providerMessageId !== input.providerMessageId) return 'missing';
  const current = SmsDeliveryStatusSchema.parse(row.status);
  const next = SmsDeliveryStatusSchema.parse(input.status);
  if (!smsStatusMovesForward(current, next)) return 'kept';
  await tx
    .update(smsDeliveries)
    .set({
      status: next,
      errorCode:
        input.errorCode === null
          ? null
          : z.number().int().min(1).max(999_999).parse(input.errorCode),
    })
    .where(eq(smsDeliveries.id, id.data));
  return 'moved';
}

/** A sent text's delivery, for tests and the status callback's answer. */
export async function findSmsDelivery(
  tx: TenantTx,
  id: string,
): Promise<typeof smsDeliveries.$inferSelect | undefined> {
  const [row] = await tx
    .select()
    .from(smsDeliveries)
    .where(eq(smsDeliveries.id, Id.parse(id)));
  return row;
}

/**
 * Records one keyword event in the SMS context (`withSmsInbound`). `false` when the provider's
 * event is already recorded: a replay, which changes nothing.
 */
export async function insertSmsKeywordEvent(
  tx: TenantTx,
  input: {
    provider: SmsProvider;
    eventId: string;
    phone: string;
    keyword: SmsKeyword;
    origin: 'keyword' | 'provider';
    receivedAt: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(smsKeywordEvents)
    .values({
      provider: ProviderSchema.parse(input.provider),
      eventId: z
        .string()
        .regex(/^[A-Za-z0-9:_-]{1,100}$/)
        .parse(input.eventId),
      phone: SmsPhoneSchema.parse(input.phone),
      keyword: SmsKeywordSchema.parse(input.keyword),
      origin: z.enum(['keyword', 'provider']).parse(input.origin),
      receivedAt: input.receivedAt,
    })
    .onConflictDoNothing()
    .returning({ id: smsKeywordEvents.id });
  return rows.length === 1;
}

/** Whether the number is opted out of Pepper's texts (its latest STOP or START is a STOP). */
export async function isSmsOptedOut(db: Database | TenantTx, phone: string): Promise<boolean> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return false;
  const { rows } = await db.execute<{ opted_out: boolean }>(
    sql`SELECT sms_opted_out(${parsed.data}) AS opted_out`,
  );
  return rows[0]?.opted_out === true;
}
