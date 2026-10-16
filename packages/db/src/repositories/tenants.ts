import {
  NewTenantSchema,
  TenantIdSchema,
  UserIdSchema,
  type NewTenant,
  type UserId,
} from '@floty/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { isUniqueViolation, TenantSlugTakenError } from '../errors.js';
import { newId } from '../ids.js';
import { memberships, tenants, type Tenant } from '../schema.js';
import { withTenant, type TenantTx } from '../tenant.js';

/**
 * Creates a business, and with `owner` that user's owner membership in the same transaction.
 * Its id is generated here and becomes the tenant of the insert's own transaction, which is the
 * only way RLS lets a row into `tenants`.
 */
export async function createTenant(
  db: Database,
  input: NewTenant,
  options: { owner?: UserId } = {},
): Promise<Tenant> {
  const values = NewTenantSchema.parse(input);
  const owner = options.owner === undefined ? undefined : UserIdSchema.parse(options.owner);
  const id = TenantIdSchema.parse(newId());
  try {
    return await withTenant(db, id, async (tx) => {
      const [tenant] = await tx
        .insert(tenants)
        .values({ id, ...values })
        .returning();
      if (owner !== undefined) {
        await tx.insert(memberships).values({ userId: owner, role: 'owner' });
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
      return tenant!;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'tenants_slug_unique')) {
      throw new TenantSlugTakenError({ cause: error });
    }
    throw error;
  }
}

/** The transaction's tenant. */
export async function findCurrentTenant(tx: TenantTx): Promise<Tenant | undefined> {
  const [tenant] = await tx
    .select()
    .from(tenants)
    .where(eq(tenants.id, sql`current_tenant_id()`));
  return tenant;
}
