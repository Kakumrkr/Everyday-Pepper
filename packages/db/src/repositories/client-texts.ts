import {
  ClientIdSchema,
  SmsPhoneSchema,
  TenantIdSchema,
  type ClientId,
  type TenantId,
} from '@pepper/contracts';
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  bookings,
  clientTexts,
  waitlistEntries,
  waitlistOffers,
  type ClientTextRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// A client's own texts and the team's replies (S80, ADR-0072): the lookup that routes a text to
// one business (`sms_reply_target`, ids only), the kept texts, and the marks that say a waitlist
// offer went by text (a reply to it comes back to its business).

const Id = z.uuid();
const ProviderSchema = z.enum(['twilio', 'sandbox']);
const EventIdSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/);
const BodySchema = z.string().min(1).max(1600);

/**
 * Whose a text from this number is (AC-X-229, AC-X-230), through `sms_reply_target`, in any
 * transaction: the one business and its one client whose consent in force is for the number and
 * that it texted in the 7 days before `at`; `undefined` for none, or for more than one.
 */
export async function smsReplyTarget(
  db: Database | TenantTx,
  phone: string,
  at: Date,
): Promise<{ tenantId: TenantId; clientId: ClientId } | undefined> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return undefined;
  const { rows } = await db.execute<{ tenant_id: string; client_id: string }>(
    sql`SELECT tenant_id, client_id FROM sms_reply_target(${parsed.data}, ${at.toISOString()}::timestamptz)`,
  );
  const [row] = rows;
  if (row === undefined || rows.length !== 1) return undefined;
  return {
    tenantId: TenantIdSchema.parse(row.tenant_id),
    clientId: ClientIdSchema.parse(row.client_id),
  };
}

/** Keeps a client's text, once per provider id; `undefined` for a replay. */
export async function insertInboundClientText(
  tx: TenantTx,
  input: {
    clientId: string;
    body: string;
    provider: string;
    eventId: string;
    receivedAt: Date;
  },
): Promise<ClientTextRow | undefined> {
  const [row] = await tx
    .insert(clientTexts)
    .values({
      clientId: Id.parse(input.clientId),
      direction: 'in',
      body: BodySchema.parse(input.body),
      provider: ProviderSchema.parse(input.provider),
      providerEventId: EventIdSchema.parse(input.eventId),
      createdAt: input.receivedAt,
    })
    .onConflictDoNothing({
      target: [clientTexts.tenantId, clientTexts.provider, clientTexts.providerEventId],
    })
    .returning();
  return row;
}

/** Records a member's reply, queued as `outboxMessageId`, in the transaction that queued it. */
export async function insertClientTextReply(
  tx: TenantTx,
  input: {
    clientId: string;
    body: string;
    outboxMessageId: string;
    userId: string;
    /** The card the reply closed (Undo opens it again); `null` from the profile. */
    feedItemId: string | null;
    at: Date;
  },
): Promise<ClientTextRow> {
  const [row] = await tx
    .insert(clientTexts)
    .values({
      clientId: Id.parse(input.clientId),
      direction: 'out',
      body: BodySchema.parse(input.body),
      outboxMessageId: Id.parse(input.outboxMessageId),
      sentByUserId: Id.parse(input.userId),
      feedItemId: input.feedItemId === null ? null : Id.parse(input.feedItemId),
      createdAt: input.at,
    })
    .returning();
  if (row === undefined) throw new Error('The reply was not recorded');
  return row;
}

/** One kept text or reply of the business, by id. */
export async function findClientText(tx: TenantTx, id: string): Promise<ClientTextRow | undefined> {
  const parsed = Id.safeParse(id);
  if (!parsed.success) return undefined;
  const [row] = await tx.select().from(clientTexts).where(eq(clientTexts.id, parsed.data));
  return row;
}

/** Removes a reply that was taken back before it was sent (Undo). Returns whether it was there. */
export async function deleteClientTextReply(tx: TenantTx, id: string): Promise<boolean> {
  const rows = await tx
    .delete(clientTexts)
    .where(and(eq(clientTexts.id, Id.parse(id)), eq(clientTexts.direction, 'out')))
    .returning({ id: clientTexts.id });
  return rows.length > 0;
}

/** The client's texts and the replies, newest first (the profile shows the last 20). */
export async function listClientTexts(
  tx: TenantTx,
  clientId: string,
  limit = 20,
): Promise<ClientTextRow[]> {
  const max = z.number().int().min(1).max(100).parse(limit);
  return tx
    .select()
    .from(clientTexts)
    .where(eq(clientTexts.clientId, Id.parse(clientId)))
    .orderBy(desc(clientTexts.createdAt), desc(clientTexts.id))
    .limit(max);
}

/** How many texts the client sent in `[from, to)` (the card says "3 texts"). */
export async function countInboundClientTexts(
  tx: TenantTx,
  clientId: string,
  range: { from: Date; to: Date },
): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(clientTexts)
    .where(
      and(
        eq(clientTexts.clientId, Id.parse(clientId)),
        eq(clientTexts.direction, 'in'),
        sql`${clientTexts.createdAt} >= ${range.from} AND ${clientTexts.createdAt} < ${range.to}`,
      ),
    );
  return row?.count ?? 0;
}

/**
 * Removes up to `limit` of the business's texts and replies that came before `before` (the
 * clean-up passes 90 days ago, AC-X-235), then the cards whose text is gone. Returns how many
 * texts.
 */
export async function deleteOldClientTexts(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const max = z.number().int().min(1).max(10_000).parse(limit);
  const rows = await tx
    .delete(clientTexts)
    .where(
      sql`${clientTexts.id} IN (SELECT id FROM client_texts WHERE created_at < ${before} LIMIT ${max})`,
    )
    .returning({ id: clientTexts.id });
  if (rows.length > 0) {
    await tx.execute(
      sql`DELETE FROM feed_items f WHERE f.kind = 'client_text' AND NOT EXISTS (SELECT 1 FROM client_texts ct WHERE ct.id::text = f.payload->>'textId')`,
    );
  }
  return rows.length;
}

/** Marks a waitlist offer as queued by text at `at` (S80: a reply to it comes back here). */
export async function markWaitlistOfferTexted(
  tx: TenantTx,
  offerId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(waitlistOffers)
    .set({ textedAt: at })
    .where(eq(waitlistOffers.id, Id.parse(offerId)));
}

/** Marks a waitlist entry's opt-in text as queued at `at` (S80: a reply to it comes back here). */
export async function markWaitlistEntryTexted(
  tx: TenantTx,
  entryId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(waitlistEntries)
    .set({ textedAt: at })
    .where(eq(waitlistEntries.id, Id.parse(entryId)));
}

/** Every kept text and reply, for the business's export (AC-X-235). */
export async function listClientTextsForExport(tx: TenantTx): Promise<
  {
    id: string;
    clientId: string;
    direction: string;
    body: string;
    sentByUserId: string | null;
    createdAt: Date;
  }[]
> {
  return tx
    .select({
      id: clientTexts.id,
      clientId: clientTexts.clientId,
      direction: clientTexts.direction,
      body: clientTexts.body,
      sentByUserId: clientTexts.sentByUserId,
      createdAt: clientTexts.createdAt,
    })
    .from(clientTexts)
    .orderBy(asc(clientTexts.createdAt), asc(clientTexts.id));
}

/** The client's next confirmed visit after `after` (the card names it: likely what a text is about). */
export async function findClientNextVisit(
  tx: TenantTx,
  clientId: string,
  after: Date,
): Promise<
  { bookingId: string; staffMemberId: string; serviceId: string; startsAt: Date } | undefined
> {
  const [row] = await tx
    .select({
      bookingId: bookings.id,
      staffMemberId: bookings.staffMemberId,
      serviceId: bookings.serviceId,
      startsAt: bookings.startsAt,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.clientId, Id.parse(clientId)),
        eq(bookings.status, 'confirmed'),
        gt(bookings.startsAt, after),
      ),
    )
    .orderBy(asc(bookings.startsAt), asc(bookings.id))
    .limit(1);
  return row;
}
