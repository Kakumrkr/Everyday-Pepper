import {
  BookingPageSettingsSchema,
  UserIdSchema,
  type BookingPageSettings,
  type NewTenant,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  createTenant,
  findCurrentTenant,
  updateCurrentTenantBrandColor,
  withMember,
  type Database,
  type Tenant,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';

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

/**
 * Sets the booking page's settings (PCR-001: its color; `null`: Pepper's neutral default),
 * with a `tenant.updated` audit entry when something changed. Owners and managers.
 */
export async function updateBookingPage(
  db: Database,
  actor: Actor,
  settings: BookingPageSettings,
): Promise<Tenant> {
  requirePermission(actor, 'settings.manage');
  const { brandColor } = BookingPageSettingsSchema.parse(settings);
  return withMember(db, actor.context, async (tx) => {
    const before = await findCurrentTenant(tx);
    const after = await updateCurrentTenantBrandColor(tx, brandColor);
    // A member's own business is always visible to them.
    if (before === undefined || after === undefined)
      throw new Error('No tenant in this transaction');
    if (before.brandColor !== after.brandColor) {
      await appendAuditEntry(tx, {
        actor: { kind: 'user', userId: actor.context.userId },
        change: {
          action: 'tenant.updated',
          entity: { type: 'tenant', id: after.id },
          before: { brandColor: before.brandColor },
          after: { brandColor: after.brandColor },
        },
        requestId: actor.requestId,
      });
    }
    return after;
  });
}
