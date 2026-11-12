import {
  BookingIdSchema,
  BookingTextKindSchema,
  SmsDeliveryStatusSchema,
  SmsPhoneSchema,
  TenantIdSchema,
  type BookingId,
  type BookingTextKind,
  type SmsDeliveryStatus,
  type TenantId,
} from '@pepper/contracts';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  bookingManageLinks,
  bookingTexts,
  bookings,
  outboxMessages,
  smsDeliveries,
  type BookingRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Texts to clients about their bookings (S62, ADR-0065): what each queued text was about, the
// extra reschedule/cancel links reminders carry, and the lookup behind "C" to confirm.

const Id = z.uuid();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Records what a queued text is about, in the transaction that queued it. */
export async function insertBookingText(
  tx: TenantTx,
  input: {
    /** The outbox message's id. */
    id: string;
    clientId: string;
    bookingId: BookingId;
    kind: BookingTextKind;
    startsAt: Date;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(bookingTexts).values({
    id: Id.parse(input.id),
    clientId: Id.parse(input.clientId),
    bookingId: BookingIdSchema.parse(input.bookingId),
    kind: BookingTextKindSchema.parse(input.kind),
    startsAt: input.startsAt,
    createdAt: input.createdAt,
  });
}

/** Whether the business has queued a reminder text to the client before (S62 top-up). */
export async function hasReminderText(tx: TenantTx, clientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: bookingTexts.id })
    .from(bookingTexts)
    .where(
      and(
        eq(bookingTexts.clientId, Id.parse(clientId)),
        inArray(bookingTexts.kind, ['day_before', 'same_day']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The client's latest text and where its message stands (AC-X-76). */
export interface LastBookingText {
  kind: BookingTextKind;
  createdAt: Date;
  messageStatus: 'pending' | 'sent' | 'dead' | 'cancelled';
  availableAt: Date;
  sentAt: Date | null;
  lastError: string | null;
  deliveryStatus: SmsDeliveryStatus | null;
}

export async function findLastBookingText(
  tx: TenantTx,
  clientId: string,
): Promise<LastBookingText | undefined> {
  const [row] = await tx
    .select({
      kind: bookingTexts.kind,
      createdAt: bookingTexts.createdAt,
      messageStatus: outboxMessages.status,
      availableAt: outboxMessages.availableAt,
      sentAt: outboxMessages.sentAt,
      lastError: outboxMessages.lastError,
      deliveryStatus: smsDeliveries.status,
    })
    .from(bookingTexts)
    .innerJoin(
      outboxMessages,
      and(
        eq(outboxMessages.tenantId, bookingTexts.tenantId),
        eq(outboxMessages.id, bookingTexts.id),
      ),
    )
    .leftJoin(
      smsDeliveries,
      and(eq(smsDeliveries.tenantId, bookingTexts.tenantId), eq(smsDeliveries.id, bookingTexts.id)),
    )
    .where(eq(bookingTexts.clientId, Id.parse(clientId)))
    .orderBy(desc(bookingTexts.createdAt), desc(bookingTexts.id))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    kind: BookingTextKindSchema.parse(row.kind),
    createdAt: row.createdAt,
    messageStatus: z.enum(['pending', 'sent', 'dead', 'cancelled']).parse(row.messageStatus),
    availableAt: row.availableAt,
    sentAt: row.sentAt,
    lastError: row.lastError,
    deliveryStatus:
      row.deliveryStatus === null ? null : SmsDeliveryStatusSchema.parse(row.deliveryStatus),
  };
}

/** Stores another reschedule/cancel link of a booking (its token's hash). */
export async function insertBookingManageLink(
  tx: TenantTx,
  input: { bookingId: BookingId; tokenHash: string; createdAt: Date },
): Promise<void> {
  await tx.insert(bookingManageLinks).values({
    tokenHash: HashSchema.parse(input.tokenHash),
    bookingId: BookingIdSchema.parse(input.bookingId),
    createdAt: input.createdAt,
  });
}

/** How many reminder links of a booking are stored. */
export async function countBookingManageLinks(tx: TenantTx, bookingId: BookingId): Promise<number> {
  const rows = await tx
    .select({ id: bookingManageLinks.id })
    .from(bookingManageLinks)
    .where(eq(bookingManageLinks.bookingId, BookingIdSchema.parse(bookingId)));
  return rows.length;
}

/** Removes one reminder link (one that was never sent). */
export async function deleteBookingManageLink(tx: TenantTx, tokenHash: string): Promise<void> {
  await tx
    .delete(bookingManageLinks)
    .where(eq(bookingManageLinks.tokenHash, HashSchema.parse(tokenHash)));
}

/** The id of the booking a reminder's link (its token's hash) opens. */
export async function findBookingIdByManageLink(
  tx: TenantTx,
  tokenHash: string,
): Promise<BookingId | undefined> {
  const hash = HashSchema.safeParse(tokenHash);
  if (!hash.success) return undefined;
  const [row] = await tx
    .select({ bookingId: bookingManageLinks.bookingId })
    .from(bookingManageLinks)
    .where(eq(bookingManageLinks.tokenHash, hash.data));
  return row === undefined ? undefined : BookingIdSchema.parse(row.bookingId);
}

/**
 * Removes up to `limit` of the business's reminder links of bookings that started before
 * `before` (the clean-up passes 30 days ago). Returns how many.
 */
export async function deleteOldBookingManageLinks(
  tx: TenantTx,
  before: Date,
  limit: number,
): Promise<number> {
  const max = z.number().int().min(1).max(10_000).parse(limit);
  const rows = await tx
    .delete(bookingManageLinks)
    .where(
      sql`${bookingManageLinks.id} IN (SELECT l.id FROM booking_manage_links l JOIN bookings b ON b.tenant_id = l.tenant_id AND b.id = l.booking_id WHERE b.starts_at < ${before} LIMIT ${max})`,
    )
    .returning({ id: bookingManageLinks.id });
  return rows.length;
}

/**
 * Which booking a "C" from this number confirms (AC-X-74), through `sms_confirm_target`, which
 * answers ids only, in any transaction: the soonest upcoming confirmed booking a reminder went
 * about, in the 48 hours before `at`, to a client whose consent in force is for this number.
 */
export async function smsConfirmTarget(
  db: Database | TenantTx,
  phone: string,
  at: Date,
): Promise<{ tenantId: TenantId; bookingId: BookingId } | undefined> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  if (!parsed.success) return undefined;
  const { rows } = await db.execute<{ tenant_id: string; booking_id: string }>(
    sql`SELECT tenant_id, booking_id FROM sms_confirm_target(${parsed.data}, ${at.toISOString()}::timestamptz)`,
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenantId: TenantIdSchema.parse(row.tenant_id),
    bookingId: BookingIdSchema.parse(row.booking_id),
  };
}

/**
 * Whether a reminder text went about the booking at `startsAt` in the 48 hours before `at`
 * (the lookup's condition, checked again under the booking's lock, AC-X-74).
 */
export async function hasRecentReminderText(
  tx: TenantTx,
  input: { bookingId: BookingId; startsAt: Date; at: Date },
): Promise<boolean> {
  const since = new Date(input.at.getTime() - 48 * 3_600_000);
  const [row] = await tx
    .select({ id: bookingTexts.id })
    .from(bookingTexts)
    .where(
      and(
        eq(bookingTexts.bookingId, BookingIdSchema.parse(input.bookingId)),
        inArray(bookingTexts.kind, ['day_before', 'same_day']),
        eq(bookingTexts.startsAt, input.startsAt),
        sql`${bookingTexts.createdAt} > ${since}`,
        sql`${bookingTexts.createdAt} <= ${input.at}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Marks a booking confirmed by its client at `at`, once: the row when this call marked it,
 * `undefined` when it was already marked (or isn't visible).
 */
export async function markBookingClientConfirmed(
  tx: TenantTx,
  bookingId: BookingId,
  at: Date,
): Promise<BookingRow | undefined> {
  const [row] = await tx
    .update(bookings)
    .set({ clientConfirmedAt: at })
    .where(
      and(eq(bookings.id, BookingIdSchema.parse(bookingId)), isNull(bookings.clientConfirmedAt)),
    )
    .returning();
  return row;
}
