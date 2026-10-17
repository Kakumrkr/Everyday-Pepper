import {
  InviteEmailSchema,
  MembershipRoleSchema,
  TenantIdSchema,
  UserIdSchema,
  type MembershipRole,
  type UserId,
} from '@floty/contracts';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { invites, type InviteRow } from '../schema.js';
import { setTransactionTenant, type TenantTx } from '../tenant.js';

// Invites of the transaction's tenant (ADR-0014). Run inside `withTenant`, except
// `withInviteTenant`, which finds an invite by its token before any tenant is known.

const TokenHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a SHA-256 hex digest');

/** Neither accepted nor revoked (it may still have expired). */
const unresolved = and(isNull(invites.acceptedAt), isNull(invites.revokedAt));

/** Open at `now`: unresolved and not yet expired. */
function openAt(now: Date) {
  return and(unresolved, gt(invites.expiresAt, now));
}

export interface NewInvite {
  email: string;
  role: MembershipRole;
  tokenHash: string;
  invitedBy: UserId;
  expiresAt: Date;
}

export async function insertInvite(tx: TenantTx, input: NewInvite): Promise<InviteRow> {
  const [invite] = await tx
    .insert(invites)
    .values({
      email: InviteEmailSchema.parse(input.email),
      role: MembershipRoleSchema.parse(input.role),
      tokenHash: TokenHashSchema.parse(input.tokenHash),
      invitedByUserId: UserIdSchema.parse(input.invitedBy),
      expiresAt: input.expiresAt,
    })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
  return invite!;
}

/** The tenant's invites open at `now`, newest first. */
export async function listOpenInvites(tx: TenantTx, now: Date): Promise<InviteRow[]> {
  return tx.select().from(invites).where(openAt(now)).orderBy(desc(invites.id));
}

export async function countOpenInvites(tx: TenantTx, now: Date): Promise<number> {
  const [row] = await tx.select({ open: count() }).from(invites).where(openAt(now));
  return row?.open ?? 0;
}

/** The invite with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockInvite(tx: TenantTx, id: string): Promise<InviteRow | undefined> {
  const [invite] = await tx
    .select()
    .from(invites)
    .where(eq(invites.id, z.uuid().parse(id)))
    .for('update');
  return invite;
}

/** The unresolved invites for `email` (at most one, by the partial unique index), locked. */
export async function lockUnresolvedInvitesFor(tx: TenantTx, email: string): Promise<InviteRow[]> {
  return tx
    .select()
    .from(invites)
    .where(and(unresolved, eq(invites.email, InviteEmailSchema.parse(email))))
    .for('update');
}

/** Marks an unresolved invite revoked; returns it, or undefined if it was not unresolved. */
export async function revokeInvite(
  tx: TenantTx,
  id: string,
  now: Date,
): Promise<InviteRow | undefined> {
  const [invite] = await tx
    .update(invites)
    .set({ revokedAt: now })
    .where(and(eq(invites.id, z.uuid().parse(id)), unresolved))
    .returning();
  return invite;
}

/** Marks an unresolved invite accepted by `userId`; returns it, or undefined if it was not. */
export async function markInviteAccepted(
  tx: TenantTx,
  id: string,
  userId: UserId,
  now: Date,
): Promise<InviteRow | undefined> {
  const [invite] = await tx
    .update(invites)
    .set({ acceptedAt: now, acceptedByUserId: UserIdSchema.parse(userId) })
    .where(and(eq(invites.id, z.uuid().parse(id)), unresolved))
    .returning();
  return invite;
}

/**
 * Runs `work` in a transaction bound to the tenant of the invite whose token hashes to
 * `tokenHash`, with that invite as found; returns `undefined` (without calling `work`) if no
 * invite has this hash. The lookup runs before any tenant is set, where the `invite_lookup`
 * policy shows exactly the one row whose hash the transaction presents. The tenant then comes
 * from that row, never from the request. `work` should lock and re-check the invite
 * (`lockInvite`) before acting on it.
 */
export async function withInviteTenant<T>(
  db: Database,
  tokenHash: string,
  work: (tx: TenantTx, invite: InviteRow) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T | undefined> {
  const hash = TokenHashSchema.parse(tokenHash);
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', ${hash}, true)`);
      const [invite] = await tx.select().from(invites).where(eq(invites.tokenHash, hash));
      await tx.execute(sql`SELECT set_config('app.invite_token_hash', '', true)`);
      if (invite === undefined) return undefined;
      await setTransactionTenant(tx, TenantIdSchema.parse(invite.tenantId));
      return work(tx, invite);
    },
    { accessMode: options.readOnly === true ? 'read only' : 'read write' },
  );
}
