import {
  BusinessSchema,
  UserBusinessSchema,
  type Business,
  type BookingPageSettings,
  type MembershipRole,
  type NewTenant,
  type TenantId,
  type UserBusiness,
  type UserId,
} from '@pepper/contracts';
import { seedBusinessIn } from '@pepper/appointments';
import { createBusiness, updateBookingPage, type TenantContext } from '@pepper/core';
import {
  findCurrentTenant,
  findMembership,
  listUserBusinesses,
  withTenant,
  withUser,
  type Database,
} from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { getTemplate } from '@pepper/templates';
import { Inject, Injectable } from '@nestjs/common';
import { seedFromTemplate } from './template-seed.js';

/** Businesses and memberships of signed-in users, over the tenant-scoped repositories. */
@Injectable()
export class TenancyService {
  private readonly db: Database;

  constructor(@Inject(DATABASE) database: { db: Database }) {
    this.db = database.db;
  }

  /** The user's role in the tenant now, or `null` if they are not a member. */
  async roleIn(tenantId: TenantId, userId: UserId): Promise<MembershipRole | null> {
    const membership = await withTenant(this.db, tenantId, (tx) => findMembership(tx, userId));
    return membership?.role ?? null;
  }

  /** Every business the user belongs to, with their role. */
  async businessesOf(userId: UserId): Promise<UserBusiness[]> {
    const businesses = await withUser(this.db, userId, listUserBusinesses);
    return businesses.map((business) => UserBusinessSchema.parse(business));
  }

  /**
   * Creates a business owned by `owner`, with its audit entry; with a business type, also its
   * starting menu, the owner as staff (named `ownerName`) and the type's hours, in the same
   * transaction (S45, ADR-0046). Throws `TenantSlugTakenError` or `BusinessLimitReachedError`
   * (`@pepper/db`).
   */
  async createBusiness(owner: UserId, input: NewTenant, ownerName: string): Promise<Business> {
    const requestId = currentRequestContext()?.requestId;
    const templateId = input.templateId ?? null;
    const seed =
      templateId === null
        ? undefined
        : seedFromTemplate(getTemplate(templateId), { userId: owner, name: ownerName });
    return toBusiness(
      await createBusiness(this.db, owner, input, {
        requestId,
        seed:
          seed === undefined
            ? undefined
            : async (tx, actor) => {
                await seedBusinessIn(tx, actor, seed);
              },
      }),
    );
  }

  /** Sets the booking page's settings, audited (owners and managers). */
  async updateBookingPage(tenant: TenantContext, settings: BookingPageSettings): Promise<Business> {
    const requestId = currentRequestContext()?.requestId;
    return toBusiness(await updateBookingPage(this.db, { context: tenant, requestId }, settings));
  }

  /** The business itself (tenant-scoped read). */
  async business(tenantId: TenantId): Promise<Business | null> {
    const tenant = await withTenant(this.db, tenantId, findCurrentTenant);
    return tenant === undefined ? null : toBusiness(tenant);
  }
}

function toBusiness(tenant: {
  id: string;
  name: string;
  slug: string;
  timeZone: string;
  locale: string;
  templateId: string | null;
  brandColor: string | null;
  phone: string | null;
  publicAddress: string | null;
  cancellationPolicy: string | null;
  depositRefundHours: number;
}): Business {
  const { id, name, slug, timeZone, locale, templateId, brandColor } = tenant;
  const { phone, publicAddress, cancellationPolicy, depositRefundHours } = tenant;
  return BusinessSchema.parse({
    ...{ id, name, slug, timeZone, locale, templateId, brandColor, depositRefundHours },
    ...{ phone, publicAddress, cancellationPolicy },
  });
}
