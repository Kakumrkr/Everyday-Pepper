import { UserIdSchema, type NewTenant, type UserId } from '@pepper/contracts';
import { appendAuditEntry, createTenant, type Database, type Tenant } from '@pepper/db';

/**
 * The most businesses one user may own (S8, approved by the user). Guards against scripted
 * sign-ups filling the database; a real multi-location owner can be raised later.
 */
export const BUSINESS_LIMIT_PER_OWNER = 5;

/**
 * Creates a business owned by `owner`, with its `tenant.created` audit entry, in one
 * transaction. Throws `TenantSlugTakenError` or `BusinessLimitReachedError` (`@pepper/db`).
 * `owner` comes from the authenticated session.
 */
export async function createBusiness(
  db: Database,
  owner: UserId,
  input: NewTenant,
  options: { requestId?: string | undefined } = {},
): Promise<Tenant> {
  const ownerUserId = UserIdSchema.parse(owner);
  return createTenant(db, input, {
    owner: ownerUserId,
    ownerLimit: BUSINESS_LIMIT_PER_OWNER,
    afterInsert: (tx, tenant) =>
      appendAuditEntry(tx, {
        actor: { kind: 'user', userId: ownerUserId },
        change: {
          action: 'tenant.created',
          entity: { type: 'tenant', id: tenant.id },
          before: null,
          after: {
            slug: tenant.slug,
            timeZone: tenant.timeZone,
            locale: tenant.locale,
            templateId: tenant.templateId,
            ownerUserId,
          },
        },
        requestId: options.requestId,
      }),
  });
}
