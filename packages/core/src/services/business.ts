import {
  BookingPageSettingsSchema,
  TenantIdSchema,
  UserIdSchema,
  type BookingPageSettings,
  type NewTenant,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  createTenant,
  findCurrentTenant,
  recordActivation,
  updateCurrentTenantBookingPage,
  withMember,
  type Database,
  type Tenant,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';

/**
 * The most businesses one user may own (S8, approved by the user). Guards against scripted
 * sign-ups filling the database; a real multi-location owner can be raised later.
 */
export const BUSINESS_LIMIT_PER_OWNER = 5;

/**
 * Creates a business owned by `owner`, with its `tenant.created` audit entry, in one
 * transaction. Throws `TenantSlugTakenError` or `BusinessLimitReachedError` (`@pepper/db`).
 * `owner` comes from the authenticated session. `seed` runs last in the same transaction, as
 * the owner (S45: the business type's menu, staff and hours, written by the layers above).
 */
export async function createBusiness(
  db: Database,
  owner: UserId,
  input: NewTenant,
  options: {
    requestId?: string | undefined;
    seed?: ((tx: TenantTx, actor: Actor, tenant: Tenant) => Promise<void>) | undefined;
  } = {},
): Promise<Tenant> {
  const ownerUserId = UserIdSchema.parse(owner);
  return createTenant(db, input, {
    owner: ownerUserId,
    ownerLimit: BUSINESS_LIMIT_PER_OWNER,
    afterInsert: async (tx, tenant) => {
      await appendAuditEntry(tx, {
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
      });
      // Ids and the time only (S45, ADR-0046): links the business to its owner's sign-up.
      await recordActivation(tx, 'business_created', { accountId: ownerUserId });
      if (options.seed !== undefined) {
        const context = { tenantId: TenantIdSchema.parse(tenant.id), userId: ownerUserId };
        const actor: Actor = {
          context: { ...context, role: 'owner' },
          requestId: options.requestId,
        };
        await options.seed(tx, actor, tenant);
      }
    },
  });
}

/** The booking page's profile fields (S47); the audit names those that changed. */
const PROFILE_FIELDS = ['phone', 'publicAddress', 'cancellationPolicy'] as const;

/**
 * Sets the booking page's settings (PCR-001: its color, `null` for Pepper's neutral default;
 * S47: the phone, public address and cancellation policy, `null` for not shown); a field left
 * out stays. A `tenant.updated` audit entry holds the fields that changed. Owners and managers.
 */
export async function updateBookingPage(
  db: Database,
  actor: Actor,
  settings: BookingPageSettings,
): Promise<Tenant> {
  requirePermission(actor, 'settings.manage');
  const parsed = BookingPageSettingsSchema.parse(settings);
  return withMember(db, actor.context, async (tx) => {
    const before = await findCurrentTenant(tx);
    const after = await updateCurrentTenantBookingPage(tx, parsed);
    // A member's own business is always visible to them.
    if (before === undefined || after === undefined)
      throw new Error('No tenant in this transaction');
    const colorChanged = before.brandColor !== after.brandColor;
    const profileChanged = PROFILE_FIELDS.filter((field) => before[field] !== after[field]);
    if (colorChanged || profileChanged.length > 0) {
      // The profile's values are not kept (a home address is someone's): only which changed.
      const values = (brandColor: string | null) =>
        profileChanged.length === 0
          ? { brandColor }
          : { ...(colorChanged ? { brandColor } : {}), profileChanged };
      await appendAuditEntry(tx, {
        actor: auditActorOf(actor),
        change: {
          action: 'tenant.updated',
          entity: { type: 'tenant', id: after.id },
          before: values(before.brandColor),
          after: values(after.brandColor),
        },
        requestId: actor.requestId,
      });
    }
    return after;
  });
}
