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
import { Inject, Injectable } from '@nestjs/common';

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
   * Creates a business owned by `owner`, with its audit entry. Throws `TenantSlugTakenError`
   * or `BusinessLimitReachedError` (`@pepper/db`).
   */
  async createBusiness(owner: UserId, input: NewTenant): Promise<Business> {
    const requestId = currentRequestContext()?.requestId;
    return toBusiness(await createBusiness(this.db, owner, input, { requestId }));
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
}): Business {
  const { id, name, slug, timeZone, locale, templateId, brandColor } = tenant;
  return BusinessSchema.parse({ id, name, slug, timeZone, locale, templateId, brandColor });
}
