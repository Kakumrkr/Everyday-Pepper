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
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
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

/** Stores another reschedule/cancel link of a booking (its token's hash), until `expiresAt`. */
export async function insertBookingManageLink(
  tx: TenantTx,
  input: { bookingId: BookingId; tokenHash: string; expiresAt: Date; createdAt: Date },
): Promise<void> {
  await tx.insert(bookingManageLinks).values({
    tokenHash: HashSchema.parse(input.tokenHash),
    bookingId: BookingIdSchema.parse(input.bookingId),
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  });
}

/**
 * The id of the booking a reminder's link (its token's hash) opens, while the link hasn't
 * expired at `now`.
 */
export async function findBookingIdByManageLink(
  tx: TenantTx,
  tokenHash: string,
  now: Date,
): Promise<BookingId | undefined> {
  const hash = HashSchema.safeParse(tokenHash);
  if (!hash.success) return undefined;
  const [row] = await tx
    .select({ bookingId: bookingManageLinks.bookingId })
    .from(bookingManageLinks)
    .where(
      and(
        eq(bookingManageLinks.tokenHash, hash.data),
        sql`${bookingManageLinks.expiresAt} > ${now}`,
      ),
    );
  return row === undefined ? undefined : BookingIdSchema.parse(row.bookingId);
}

/** Removes the business's expired reminder links (the clean-up). Returns how many. */
export async function deleteExpiredBookingManageLinks(tx: TenantTx, now: Date): Promise<number> {
  const rows = await tx
    .delete(bookingManageLinks)
    .where(lt(bookingManageLinks.expiresAt, now))
    .returning({ hash: bookingManageLinks.tokenHash });
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
