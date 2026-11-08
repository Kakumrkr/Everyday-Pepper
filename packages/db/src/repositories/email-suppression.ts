import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { emailSuppressions } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Delivery problems Resend reported (S59.3.2, ADR-0063 Part 2, AC-X-42/43). Inserted in the
// inbound context (`withInboundMail`, the webhook); read and resumed in a logged operator
// transaction; asked at delivery through `support_mail_stopped`.

export const SUPPRESSION_KINDS = ['hard_bounce', 'soft_bounce', 'complaint'] as const;
export type SuppressionKind = (typeof SUPPRESSION_KINDS)[number];

const Address = z
  .string()
  .min(3)
  .max(254)
  .transform((value) => value.toLowerCase())
  .refine((value) => value.indexOf('@') > 0);
const Id = z.uuid();

/** Records one event; `false` when the same event is already recorded (nothing changes). */
export async function insertEmailSuppression(
  tx: TenantTx,
  input: {
    provider: 'resend';
    eventId: string;
    address: string;
    kind: SuppressionKind;
    occurredAt: Date;
  },
): Promise<boolean> {
  const rows = await tx
    .insert(emailSuppressions)
    .values({
      provider: input.provider,
      eventId: z.string().min(1).max(200).parse(input.eventId),
      address: Address.parse(input.address),
      kind: z.enum(SUPPRESSION_KINDS).parse(input.kind),
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: emailSuppressions.id });
  return rows.length === 1;
}

/** Whether support email to `address` is stopped (a hard bounce or complaint not resumed). */
export async function isSupportMailStopped(
  db: Database | TenantTx,
  address: string,
): Promise<boolean> {
  const parsed = Address.safeParse(address);
  if (!parsed.success) return false;
  const { rows } = await db.execute<{ stopped: boolean }>(
    sql`SELECT support_mail_stopped(${parsed.data}) AS stopped`,
  );
  return rows[0]?.stopped === true;
}

/** Why mail to each of `addresses` is stopped, and since when (operator transactions). */
export async function findSupportMailStops(
  tx: TenantTx,
  addresses: readonly string[],
): Promise<Map<string, { kind: 'hard_bounce' | 'complaint'; since: Date }>> {
  const list = [
    ...new Set(
      addresses.flatMap((a) => {
        const parsed = Address.safeParse(a);
        return parsed.success ? [parsed.data] : [];
      }),
    ),
  ];
  const stops = new Map<string, { kind: 'hard_bounce' | 'complaint'; since: Date }>();
  if (list.length === 0) return stops;
  const rows = await tx
    .select({
      address: emailSuppressions.address,
      kind: emailSuppressions.kind,
      occurredAt: emailSuppressions.occurredAt,
    })
    .from(emailSuppressions)
    .where(
      and(
        inArray(emailSuppressions.address, list),
        inArray(emailSuppressions.kind, ['hard_bounce', 'complaint']),
        isNull(emailSuppressions.resumedAt),
      ),
    )
    .orderBy(asc(emailSuppressions.address), desc(emailSuppressions.occurredAt));
  for (const row of rows) {
    if (stops.has(row.address)) continue;
    stops.set(row.address, {
      kind: row.kind === 'complaint' ? 'complaint' : 'hard_bounce',
      since: row.occurredAt,
    });
  }
  return stops;
}

/** Resume (AC-X-43): support email to `address` goes out again; `false` when it wasn't stopped. */
export async function resumeSupportMail(
  tx: TenantTx,
  input: { address: string; operatorUserId: string; now: Date },
): Promise<boolean> {
  const rows = await tx
    .update(emailSuppressions)
    .set({ resumedAt: input.now, resumedBy: Id.parse(input.operatorUserId) })
    .where(
      and(
        eq(emailSuppressions.address, Address.parse(input.address)),
        inArray(emailSuppressions.kind, ['hard_bounce', 'complaint']),
        isNull(emailSuppressions.resumedAt),
      ),
    )
    .returning({ id: emailSuppressions.id });
  return rows.length > 0;
}

/** Delivery problems recorded since `since`, by kind (AC-X-45). */
export async function countEmailSuppressions(
  tx: TenantTx,
  since: Date,
): Promise<Record<SuppressionKind, number>> {
  const rows = await tx
    .select({ kind: emailSuppressions.kind, count: sql<number>`count(*)::int` })
    .from(emailSuppressions)
    .where(gt(emailSuppressions.createdAt, since))
    .groupBy(emailSuppressions.kind);
  const counts: Record<SuppressionKind, number> = { hard_bounce: 0, soft_bounce: 0, complaint: 0 };
  for (const row of rows) counts[z.enum(SUPPRESSION_KINDS).parse(row.kind)] = row.count;
  return counts;
}
