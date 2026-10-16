import {
  MembershipRoleSchema,
  UserIdSchema,
  type MembershipRole,
  type UserId,
} from '@floty/contracts';
import { asc, eq } from 'drizzle-orm';
import { isUniqueViolation, MembershipExistsError } from '../errors.js';
import { memberships, type Membership } from '../schema.js';
import type { TenantTx } from '../tenant.js';

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
