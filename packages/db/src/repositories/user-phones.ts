import { SmsPhoneSchema, UserIdSchema, type UserId } from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { userPhones, type UserPhoneRow } from '../schema.js';
import type { TenantTx } from '../tenant.js';

// A person's own mobile number (S63, ADR-0066 §1). Global like `users`: no RLS, keyed by the
// signed-in user the caller resolved from the session.

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

export async function findUserPhone(
  db: Database | TenantTx,
  userId: UserId,
): Promise<UserPhoneRow | undefined> {
  const [row] = await db
    .select()
    .from(userPhones)
    .where(eq(userPhones.userId, UserIdSchema.parse(userId)));
  return row;
}

/** The user's row, locked (`FOR UPDATE`): two checks at once count their tries once each. */
export async function lockUserPhone(
  db: Database | TenantTx,
  userId: UserId,
): Promise<UserPhoneRow | undefined> {
  const [row] = await db
    .select()
    .from(userPhones)
    .where(eq(userPhones.userId, UserIdSchema.parse(userId)))
    .for('update');
  return row;
}

/** Starts a check of `phone`, replacing any in flight (its tries start again). */
export async function startUserPhoneCheck(
  db: Database | TenantTx,
  input: { userId: UserId; phone: string; codeHash: string; expiresAt: Date },
): Promise<void> {
  const check = {
    checkPhone: SmsPhoneSchema.parse(input.phone),
    checkHash: HashSchema.parse(input.codeHash),
    checkExpiresAt: input.expiresAt,
    checkAttempts: 0,
  };
  await db
    .insert(userPhones)
    .values({ userId: UserIdSchema.parse(input.userId), ...check })
    .onConflictDoUpdate({ target: userPhones.userId, set: check });
}

/** Counts a wrong code against the check in flight. */
export async function countUserPhoneCheckMiss(
  db: Database | TenantTx,
  userId: UserId,
): Promise<void> {
  await db
    .update(userPhones)
    .set({ checkAttempts: sql`LEAST(${userPhones.checkAttempts} + 1, 10)` })
    .where(eq(userPhones.userId, UserIdSchema.parse(userId)));
}

/** The checked number becomes the user's; the check in flight ends. */
export async function setVerifiedUserPhone(
  db: Database | TenantTx,
  userId: UserId,
  phone: string,
  at: Date,
): Promise<void> {
  await db
    .update(userPhones)
    .set({
      phone: SmsPhoneSchema.parse(phone),
      verifiedAt: at,
      checkPhone: null,
      checkHash: null,
      checkExpiresAt: null,
      checkAttempts: 0,
    })
    .where(eq(userPhones.userId, UserIdSchema.parse(userId)));
}
