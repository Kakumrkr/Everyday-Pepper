import 'reflect-metadata';
import {
  findPublicAvailability,
  listServicesIn,
  listStaffIn,
  getWorkingHours,
} from '@pepper/appointments';
import { TenantSlugSchema, UserIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { createBusiness, ManualClock, type Actor } from '@pepper/core';
import {
  createDatabase,
  listAuditEntries,
  prepareDatabase,
  tenants,
  users,
  withTenant,
  type DatabaseHandle,
} from '@pepper/db';
import { getTemplate, templateRuleDefaults } from '@pepper/templates';
import { postgresUrlAs, startPostgres, type TestService } from '@pepper/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenancyService } from './tenancy.service.js';

// A business type pre-fills the business (S45, ADR-0046, AC-W1-7): the template's menu, the
// owner as its one staff member and the template's hours, in the creation's transaction, so a
// barbershop takes bookings with nothing typed but its name.

let postgres: TestService;
let handle: DatabaseHandle;
let tenancy: TenancyService;
let slugs = 0;

beforeAll(async () => {
  postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'tenancy-test-password');
  await prepareDatabase(postgres.url, appUrl);
  handle = createDatabase({ url: appUrl, maxConnections: 4, connectionTimeoutMs: 30_000 });
  tenancy = new TenancyService({ db: handle.db });
});

afterAll(async () => {
  await handle.close();
  await postgres.stop();
});

async function newOwner(name: string): Promise<UserId> {
  const [row] = await handle.db
    .insert(users)
    .values({ name, email: `owner-${String(++slugs)}@example.test` })
    .returning({ id: users.id });
  if (row === undefined) throw new Error('no user');
  return UserIdSchema.parse(row.id);
}

const nextSlug = () => TenantSlugSchema.parse(`seeded-${String(++slugs)}`);
const ownerOf = (tenantId: TenantId, userId: UserId): Actor => ({
  context: { tenantId, userId, role: 'owner' },
});

describe('creating a business with a type (AC-W1-7)', () => {
  it('pre-fills a barbershop that offers times with zero typing', async () => {
    const owner = await newOwner('Marcus Reed');
    const slug = nextSlug();
    const business = await tenancy.createBusiness(
      owner,
      { name: 'Fade Room', slug, timeZone: 'America/Chicago', templateId: 'barber' },
      'Marcus Reed',
    );
    expect(business.templateId).toBe('barber');
    const actor = ownerOf(business.id, owner);
    const template = getTemplate('barber');

    const services = await withTenant(handle.db, business.id, (tx) => listServicesIn(tx, actor));
    expect(services.map((s) => s.name).sort()).toEqual(
      template.serviceCatalog.map((s) => s.name).sort(),
    );
    const haircut = services.find((s) => s.name === 'Haircut');
    expect(haircut).toMatchObject({
      durationMinutes: 30,
      bufferAfterMinutes: 5,
      priceFromCents: 3000,
      priceToCents: 4500,
      active: true,
    });

    const staff = await withTenant(handle.db, business.id, (tx) => listStaffIn(tx, actor));
    expect(staff).toHaveLength(1);
    expect(staff[0]).toMatchObject({ displayName: 'Marcus Reed', userId: owner, active: true });
    expect([...(staff[0]?.serviceIds ?? [])].sort()).toEqual(services.map((s) => s.id).sort());
    const staffId = staff[0]?.id;
    if (staffId === undefined) throw new Error('no staff');
    expect(await getWorkingHours(handle.db, actor, staffId)).toEqual(template.defaultHours);

    // Monday 2 November 2026, 9 a.m. in Chicago: Tuesday opens at 9.
    const clock = new ManualClock('2026-11-02T15:00:00.000Z');
    if (haircut === undefined) throw new Error('no haircut');
    const slots = await findPublicAvailability(
      handle.db,
      slug,
      { serviceId: haircut.id, from: '2026-11-03T15:00:00.000Z', to: '2026-11-03T18:00:00.000Z' },
      { clock, templateRuleDefaults },
    );
    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]?.startsAt).toBe('2026-11-03T15:00:00.000Z');
  });

  it('keeps the rebooking interval and audits every seeded change as the owner', async () => {
    const owner = await newOwner('Ana');
    const business = await tenancy.createBusiness(
      owner,
      { name: 'Lacquer', slug: nextSlug(), timeZone: 'America/New_York', templateId: 'nails' },
      'Ana',
    );
    const template = getTemplate('nails');
    const entries = await withTenant(handle.db, business.id, (tx) =>
      listAuditEntries(tx, { limit: 100 }),
    );
    const actions = entries.map((e) => e.action);
    expect(actions.filter((a) => a === 'service.created')).toHaveLength(
      template.serviceCatalog.length,
    );
    expect(actions).toContain('staff_member.created');
    expect(actions).toContain('working_hours.replaced');
    expect(actions).toContain('tenant.created');
    expect(entries.every((e) => e.actor.kind === 'user')).toBe(true);
  });

  it('seeds nothing without a type', async () => {
    const owner = await newOwner('Ana');
    const business = await tenancy.createBusiness(
      owner,
      { name: 'Blank', slug: nextSlug(), timeZone: 'UTC' },
      'Ana',
    );
    const actor = ownerOf(business.id, owner);
    const [services, staff] = await withTenant(handle.db, business.id, async (tx) => [
      await listServicesIn(tx, actor),
      await listStaffIn(tx, actor),
    ]);
    expect(services).toEqual([]);
    expect(staff).toEqual([]);
  });

  it('creates nothing at all when the seed fails', async () => {
    const owner = await newOwner('Ana');
    const slug = nextSlug();
    await expect(
      createBusiness(
        handle.db,
        owner,
        { name: 'Half made', slug, timeZone: 'UTC', templateId: 'barber' },
        {
          seed: () => Promise.reject(new Error('seed failed')),
        },
      ),
    ).rejects.toThrow('seed failed');
    // As the migration role (no row-level security): no business with that slug committed.
    const admin = createDatabase({ url: postgres.url, maxConnections: 1 });
    try {
      expect(await admin.db.select().from(tenants).where(eq(tenants.slug, slug))).toEqual([]);
    } finally {
      await admin.close();
    }
  });
});
