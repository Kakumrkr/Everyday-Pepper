import { SmsPhoneSchema, TenantIdSchema, UserIdSchema, type TenantId } from '@pepper/contracts';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import {
  approvalTexts,
  memberships,
  smsConsents,
  userPhones,
  users,
  type ApprovalTextRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// Cards sent to members by text for their OK (S63, ADR-0066): one row per text, the lookup
// behind "Y" and a code, and who gets them.

const Id = z.uuid();
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Records a queued approval text, in the transaction that queued it. */
export async function insertApprovalText(
  tx: TenantTx,
  input: {
    /** The outbox message's id. */
    id: string;
    proposalId: string;
    userId: string;
    phone: string;
    fingerprint: string;
    codeHash: string;
    expiresAt: Date;
    createdAt: Date;
  },
): Promise<void> {
  await tx.insert(approvalTexts).values({
    id: Id.parse(input.id),
    proposalId: Id.parse(input.proposalId),
    userId: UserIdSchema.parse(input.userId),
    phone: SmsPhoneSchema.parse(input.phone),
    fingerprint: z.string().min(1).max(200).parse(input.fingerprint),
    codeHash: HashSchema.parse(input.codeHash),
    expiresAt: input.expiresAt,
    createdAt: input.createdAt,
  });
}

/** The text, locked for its reply (`FOR UPDATE`): two replies at once use it once. */
export async function lockApprovalText(
  tx: TenantTx,
  id: string,
): Promise<ApprovalTextRow | undefined> {
  const [row] = await tx
    .select()
    .from(approvalTexts)
    .where(eq(approvalTexts.id, Id.parse(id)))
    .for('update');
  return row;
}

/** Spends the text's code; `false` when it was already used. */
export async function markApprovalTextUsed(tx: TenantTx, id: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(approvalTexts)
    // `GREATEST`: a reply "before" the text by a clock that ran behind still records cleanly.
    .set({ usedAt: sql`GREATEST(${at.toISOString()}::timestamptz, ${approvalTexts.createdAt})` })
    .where(and(eq(approvalTexts.id, Id.parse(id)), isNull(approvalTexts.usedAt)))
    .returning({ id: approvalTexts.id });
  return rows.length > 0;
}

/**
 * Links a spent text to the execution its approval made (S63.2, AC-X-91); `false`: no such
 * spent text, or it already has one.
 */
export async function setApprovalTextExecution(
  tx: TenantTx,
  id: string,
  executionId: string,
): Promise<boolean> {
  const rows = await tx
    .update(approvalTexts)
    .set({ executionId: Id.parse(executionId) })
    .where(
      and(
        eq(approvalTexts.id, Id.parse(id)),
        isNotNull(approvalTexts.usedAt),
        isNull(approvalTexts.executionId),
      ),
    )
    .returning({ id: approvalTexts.id });
  return rows.length > 0;
}

/** Of these executions, the ones a text reply approved (S63.2, AC-X-91). */
export async function listExecutionsApprovedByText(
  tx: TenantTx,
  executionIds: readonly string[],
): Promise<Set<string>> {
  if (executionIds.length === 0) return new Set();
  const rows = await tx
    .select({ executionId: approvalTexts.executionId })
    .from(approvalTexts)
    .where(
      inArray(
        approvalTexts.executionId,
        executionIds.map((id) => Id.parse(id)),
      ),
    );
  return new Set(rows.flatMap((row) => (row.executionId === null ? [] : [row.executionId])));
}

/**
 * Which text a reply with this code's HMAC answers, across businesses (`sms_approval_target`,
 * ids only): a live one first, else one expired or used in the last day; `undefined`: none.
 */
export async function smsApprovalTarget(
  db: Database | TenantTx,
  phone: string,
  codeHash: string,
  at: Date,
): Promise<{ tenantId: TenantId; approvalTextId: string; live: boolean } | undefined> {
  const parsed = SmsPhoneSchema.safeParse(phone);
  const hash = HashSchema.safeParse(codeHash);
  if (!parsed.success || !hash.success) return undefined;
  const { rows } = await db.execute<{ tenant_id: string; approval_text_id: string; live: boolean }>(
    sql`SELECT tenant_id, approval_text_id, live FROM sms_approval_target(${parsed.data}, ${hash.data}, ${at.toISOString()}::timestamptz)`,
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    tenantId: TenantIdSchema.parse(row.tenant_id),
    approvalTextId: Id.parse(row.approval_text_id),
    live: row.live,
  };
}

/** A member who gets cards by text: an owner or manager, the switch on, a checked number. */
export interface CardTextRecipient {
  userId: string;
  phone: string;
}

/**
 * The business's members who get cards by text now (AC-X-82): owners and managers with "Text me
 * cards" on and a checked number that still has their own consent in force here.
 */
export async function listCardTextRecipients(tx: TenantTx): Promise<CardTextRecipient[]> {
  const rows = await tx
    .select({ userId: memberships.userId, phone: userPhones.phone })
    .from(memberships)
    .innerJoin(userPhones, eq(userPhones.userId, memberships.userId))
    // A reply approves only with a second factor (as a session would): none, no texts.
    .innerJoin(users, and(eq(users.id, memberships.userId), eq(users.twoFactorEnabled, true)))
    .innerJoin(
      smsConsents,
      and(
        eq(smsConsents.userId, memberships.userId),
        eq(smsConsents.phone, userPhones.phone),
        eq(smsConsents.source, 'member_settings'),
        isNull(smsConsents.revokedAt),
      ),
    )
    .where(
      and(
        eq(memberships.cardTexts, true),
        inArray(memberships.role, ['owner', 'manager']),
        isNotNull(userPhones.phone),
      ),
    )
    .orderBy(memberships.createdAt, memberships.id);
  return rows.flatMap((row) =>
    row.phone === null ? [] : [{ userId: row.userId, phone: row.phone }],
  );
}

/** Sets the member's "Text me cards" in the transaction's business; `false`: not a member. */
export async function setMembershipCardTexts(
  tx: TenantTx,
  userId: string,
  on: boolean,
): Promise<boolean> {
  const rows = await tx
    .update(memberships)
    .set({ cardTexts: on })
    .where(eq(memberships.userId, UserIdSchema.parse(userId)))
    .returning({ id: memberships.id });
  return rows.length > 0;
}
