import {
  BrandColorSchema,
  MailingAddressSchema,
  NewTenantSchema,
  TenantIdSchema,
  TenantSlugSchema,
  UserIdSchema,
  type BrandColor,
  type NewTenant,
  type TenantSlug,
  type UserId,
} from '@pepper/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../client.js';
import { BusinessLimitReachedError, isUniqueViolation, TenantSlugTakenError } from '../errors.js';
import { newId } from '../ids.js';
import { insightRuns, memberships, tenants, type Tenant } from '../schema.js';
import { setTransactionTenant, setTransactionUser, type TenantTx } from '../tenant.js';
import { countOwnedBusinesses } from './memberships.js';

export interface CreateTenantOptions {
  /** Becomes the business's owner, in the same transaction. */
  owner?: UserId;
  /**
   * With `owner`: the most businesses that user may own. Checked and inserted in one
   * transaction, serialised per user, so concurrent sign-ups cannot exceed it.
   */
  ownerLimit?: number;
  /** Runs in the new tenant's context before commit (e.g. to write its audit entry). */
  afterInsert?: (tx: TenantTx, tenant: Tenant) => Promise<void>;
}

/**
 * Creates a business, and with `owner` that user's owner membership in the same transaction.
 * Its id is generated here and becomes the tenant of the insert's own transaction, which is the
 * only way RLS lets a row into `tenants`. Throws `TenantSlugTakenError` for a taken slug and
 * `BusinessLimitReachedError` when the owner is at `ownerLimit`.
 */
export async function createTenant(
  db: Database,
  input: NewTenant,
  options: CreateTenantOptions = {},
): Promise<Tenant> {
  const values = NewTenantSchema.parse(input);
  const owner = options.owner === undefined ? undefined : UserIdSchema.parse(options.owner);
  const { ownerLimit, afterInsert } = options;
  if (ownerLimit !== undefined && owner === undefined) {
    throw new Error('ownerLimit needs an owner');
  }
  const id = TenantIdSchema.parse(newId());
  try {
    return await db.transaction(async (tx) => {
      if (owner !== undefined && ownerLimit !== undefined) {
        await checkOwnerLimit(tx, owner, z.number().int().min(1).parse(ownerLimit));
      }
      await setTransactionTenant(tx, id);
      const [tenant] = await tx
        .insert(tenants)
        .values({ id, ...values })
        .returning();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- INSERT ... RETURNING of one row returns one row
      const created = tenant!;
      if (owner !== undefined) {
        await tx.insert(memberships).values({ userId: owner, role: 'owner' });
      }
      // The worker's insights pass finds the business by this row (ADR-0039).
      await tx.insert(insightRuns).values({});
      await afterInsert?.(tx, created);
      return created;
    });
  } catch (error) {
    if (isUniqueViolation(error, 'tenants_slug_unique')) {
      throw new TenantSlugTakenError({ cause: error });
    }
    throw error;
  }
}

/**
 * Throws if `owner` already owns `limit` businesses. Runs before the transaction gets its
 * tenant: in the user context, `member_read` shows the user's memberships across tenants. The
 * advisory lock (released at commit) makes a second concurrent creation wait for this one.
 */
async function checkOwnerLimit(tx: TenantTx, owner: UserId, limit: number): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`pepper.create_tenant:${owner}`}, 0))`,
  );
  await setTransactionUser(tx, owner);
  const owned = await countOwnedBusinesses(tx);
  await setTransactionUser(tx, null);
  if (owned >= limit) throw new BusinessLimitReachedError(limit);
}

/** The transaction's tenant. */
export async function findCurrentTenant(tx: TenantTx): Promise<Tenant | undefined> {
  const [tenant] = await tx
    .select()
    .from(tenants)
    .where(eq(tenants.id, sql`current_tenant_id()`));
  return tenant;
}

/** Sets the transaction's business's booking page color; `undefined` when there is none. */
export async function updateCurrentTenantBrandColor(
  tx: TenantTx,
  brandColor: BrandColor | null,
): Promise<Tenant | undefined> {
  const [tenant] = await tx
    .update(tenants)
    .set({ brandColor: brandColor === null ? null : BrandColorSchema.parse(brandColor) })
    .where(eq(tenants.id, sql`current_tenant_id()`))
    .returning();
  return tenant;
}

/** Sets (or, with `null`, clears) the business's mailing address for commercial mail (S36). */
export async function updateCurrentTenantMailingAddress(
  tx: TenantTx,
  mailingAddress: string | null,
): Promise<Tenant | undefined> {
  const [tenant] = await tx
    .update(tenants)
    .set({
      mailingAddress: mailingAddress === null ? null : MailingAddressSchema.parse(mailingAddress),
    })
    .where(eq(tenants.id, sql`current_tenant_id()`))
    .returning();
  return tenant;
}

/**
 * Records that the business's setup was reviewed (S46, PCR-009), the first time only: the
 * business, or `undefined` when it already was (nothing is written then, so of two concurrent
 * calls exactly one gets the row). Touches no other column.
 */
export async function markCurrentTenantSetupReviewed(
  tx: TenantTx,
  at: Date,
): Promise<Tenant | undefined> {
  const [tenant] = await tx
    .update(tenants)
    .set({ setupReviewedAt: at })
    .where(and(eq(tenants.id, sql`current_tenant_id()`), isNull(tenants.setupReviewedAt)))
    .returning();
  return tenant;
}

/**
 * Runs `work` in a transaction bound to the business whose booking page is at `slug`, for
 * anonymous visitors (ADR-0022); `undefined` when no business has that slug. The business is
 * found through the read-only `public_lookup` policy, which needs no tenant; the transaction is
 * then bound to that business, without a user, so the work has the full tenant scope: it must
 * return only what the booking page may show.
 */
export async function withPublicTenant<T>(
  db: Database,
  slug: TenantSlug,
  work: (tx: TenantTx, tenant: Tenant) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T | undefined> {
  const value = TenantSlugSchema.parse(slug);
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('app.public_slug', ${value}, true)`);
      const [tenant] = await tx.select().from(tenants).where(eq(tenants.slug, value));
      await tx.execute(sql`SELECT set_config('app.public_slug', '', true)`);
      if (tenant === undefined) return undefined;
      await setTransactionTenant(tx, TenantIdSchema.parse(tenant.id));
      return work(tx, tenant);
    },
    { accessMode: options.readOnly === true ? 'read only' : 'read write' },
  );
}
