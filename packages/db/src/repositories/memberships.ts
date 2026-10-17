import {
  MembershipRoleSchema,
  UserIdSchema,
  type MembershipRole,
  type UserId,
} from '@floty/contracts';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { isUniqueViolation, MembershipExistsError } from '../errors.js';
import { memberships, tenants, users, type Membership } from '../schema.js';
import type { TenantTx, UserTx } from '../tenant.js';

// Every function runs inside `withTenant`: `tenant_id` defaults to the transaction's tenant and
// RLS hides other tenants' rows, so no function takes a tenant id.

export async function addMembership(
  tx: TenantTx,
  input: { userId: UserId; role: MembershipRole },
): Promise<Membership> {
  const values = {
    userId: UserIdSchema.parse(input.userId),
    role: MembershipRoleSchema.parse(input.role),
  };
  try {
    const [membership] = await tx.insert(memberships).values(values).returning();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
    return membership!;
  } catch (error) {
    if (isUniqueViolation(error, 'memberships_tenant_user_unique')) {
      throw new MembershipExistsError({ cause: error });
    }
    throw error;
  }
}

export async function listMemberships(tx: TenantTx): Promise<Membership[]> {
  return tx.select().from(memberships).orderBy(asc(memberships.createdAt), asc(memberships.id));
}

export async function findMembership(
  tx: TenantTx,
  userId: UserId,
): Promise<Membership | undefined> {
  const [membership] = await tx
    .select()
    .from(memberships)
    .where(eq(memberships.userId, UserIdSchema.parse(userId)));
  return membership;
}

/** A member of the transaction's tenant with their name and email (users are global). */
export interface TenantMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
  joinedAt: Date;
}

/** Everyone in the transaction's tenant, longest-standing first. */
export async function listTenantMembers(tx: TenantTx): Promise<TenantMember[]> {
  return tx
    .select({
      membershipId: memberships.id,
      userId: memberships.userId,
      name: users.name,
      email: users.email,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}

/**
 * Serialises membership changes in the transaction's tenant: holds a row lock on the tenant
 * until the transaction ends, so two concurrent changes cannot both pass the "keep one
 * owner" check. Call it first, then read the memberships the decision depends on.
 * `FOR NO KEY UPDATE` does not block inserts that only reference the tenant.
 */
export async function lockTenantMemberships(tx: TenantTx): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM tenants WHERE id = current_tenant_id() FOR NO KEY UPDATE`);
}

export async function countOwners(tx: TenantTx): Promise<number> {
  const [row] = await tx
    .select({ owners: count() })
    .from(memberships)
    .where(eq(memberships.role, 'owner'));
  return row?.owners ?? 0;
}

/** Gives the member another role; returns the updated membership, or undefined if none. */
export async function updateMembershipRole(
  tx: TenantTx,
  userId: UserId,
  role: MembershipRole,
): Promise<Membership | undefined> {
  const [membership] = await tx
    .update(memberships)
    .set({ role: MembershipRoleSchema.parse(role) })
    .where(eq(memberships.userId, UserIdSchema.parse(userId)))
    .returning();
  return membership;
}

/** Removes the member; returns the removed membership, or undefined if none. */
export async function deleteMembership(
  tx: TenantTx,
  userId: UserId,
): Promise<Membership | undefined> {
  const [membership] = await tx
    .delete(memberships)
    .where(eq(memberships.userId, UserIdSchema.parse(userId)))
    .returning();
  return membership;
}

/**
 * How many businesses the transaction user owns, across tenants: runs in a user context
 * (`withUser`, or `setTransactionUser` with no tenant set), where `member_read` applies.
 */
export async function countOwnedBusinesses(tx: UserTx): Promise<number> {
  const [row] = await tx
    .select({ owned: count() })
    .from(memberships)
    .where(and(eq(memberships.userId, sql`current_user_id()`), eq(memberships.role, 'owner')));
  return row?.owned ?? 0;
}

/** One of the signed-in user's businesses, as listed for switching between them. */
export interface UserBusiness {
  tenantId: string;
  name: string;
  slug: string;
  role: MembershipRole;
}

/** The transaction user's businesses (inside `withUser`), oldest membership first. */
export async function listUserBusinesses(tx: UserTx): Promise<UserBusiness[]> {
  return tx
    .select({
      tenantId: tenants.id,
      name: tenants.name,
      slug: tenants.slug,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(eq(memberships.userId, sql`current_user_id()`))
    .orderBy(asc(memberships.createdAt), asc(memberships.id));
}
