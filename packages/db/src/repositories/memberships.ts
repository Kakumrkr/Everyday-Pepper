import {
  MembershipRoleSchema,
  UserIdSchema,
  type MembershipRole,
  type UserId,
} from '@floty/contracts';
import { asc, eq, sql } from 'drizzle-orm';
import { isUniqueViolation, MembershipExistsError } from '../errors.js';
import { memberships, tenants, type Membership } from '../schema.js';
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
