import {
  BookingSeriesIdSchema,
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type ClientId,
  type ServiceId,
  type StaffMemberId,
  type TenantId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import {
  BookingSeriesKeyTakenError,
  findBookingSeries,
  findBookingSeriesByIdempotencyKey,
  insertBookingSeries,
  listSeriesBookings,
} from './repositories/booking-series.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import { addMembership } from './repositories/memberships.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Series of recurring visits against real Postgres (S72, ADR-0070, AC-X-183, AC-X-184): the
// visits are ordinary bookings with `series_id`, a series' key is unique per business, a booking
// can only join a series of its own business, and staff reach their own staff member's series.
// Tenant isolation is in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

interface Business {
  tenant: TenantId;
  service: ServiceId;
  jess: StaffMemberId;
  marco: StaffMemberId;
  client: ClientId;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Juniper',
    slug: `juniper-series-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenant = TenantIdSchema.parse(created.id);
  return withTenant(db, tenant, async (tx) => {
    const service = await insertService(tx, {
      name: 'Haircut',
      category: null,
      durationMinutes: 60,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 6500,
      priceToCents: null,
      active: true,
    });
    const staff = (displayName: string) =>
      insertStaffMember(tx, { displayName, color: '#2a7230', active: true, membershipId: null });
    const client = await insertClient(tx, {
      name: 'Maria Lopez',
      email: null,
      phone: null,
      source: 'team',
    });
    return {
      tenant,
      service: ServiceIdSchema.parse(service.id),
      jess: StaffMemberIdSchema.parse((await staff('Jess')).id),
      marco: StaffMemberIdSchema.parse((await staff('Marco')).id),
      client: ClientIdSchema.parse(client.id),
    };
  });
}

const starts = ['2026-12-01T12:00:00Z', '2026-12-08T12:00:00Z', '2026-12-15T12:00:00Z'];

function series(tx: TenantTx, staffMemberId: StaffMemberId, key: string | null = null) {
  return insertBookingSeries(tx, {
    staffMemberId,
    everyWeeks: 1,
    requestedStarts: starts.map((iso) => new Date(iso)),
    idempotencyKey: key,
    createdBy: null,
  });
}

function visit(
  tx: TenantTx,
  b: Business,
  staffMemberId: StaffMemberId,
  iso: string,
  seriesId: string,
) {
  const start = new Date(iso);
  return insertBooking(tx, {
    clientId: b.client,
    serviceId: b.service,
    staffMemberId,
    startsAt: start,
    endsAt: new Date(start.getTime() + 3_600_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: 6500,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
    seriesId,
  });
}

describe('booking series (S72)', () => {
  it('keeps what was asked and lists its visits earliest first', async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenant, async (tx) => {
      const made = await series(tx, b.jess, 'series-key-1');
      const id = BookingSeriesIdSchema.parse(made.id);
      for (const iso of [...starts].reverse()) await visit(tx, b, b.jess, iso, made.id);
      expect(
        (await findBookingSeries(tx, id))?.requestedStarts.map((d) => d.toISOString()),
      ).toEqual(starts.map((iso) => new Date(iso).toISOString()));
      expect((await findBookingSeriesByIdempotencyKey(tx, 'series-key-1'))?.id).toBe(made.id);
      const visits = await listSeriesBookings(tx, id);
      expect(visits.map((row) => row.startsAt.toISOString())).toEqual(
        starts.map((iso) => new Date(iso).toISOString()),
      );
      expect(visits.every((row) => row.seriesId === made.id)).toBe(true);
    });
  });

  it('refuses a second series with the same key in the business, not in another', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    await withTenant(db, b.tenant, (tx) => series(tx, b.jess, 'series-key-2'));
    await expect(
      withTenant(db, b.tenant, (tx) => series(tx, b.marco, 'series-key-2')),
    ).rejects.toBeInstanceOf(BookingSeriesKeyTakenError);
    await expect(
      withTenant(db, other.tenant, (tx) => series(tx, other.jess, 'series-key-2')),
    ).resolves.toBeDefined();
  });

  it('refuses a booking joining another business’s series, and a rule out of range', async () => {
    const b = await newBusiness();
    const other = await newBusiness();
    const theirs = await withTenant(db, other.tenant, (tx) => series(tx, other.jess));
    await expect(
      withTenant(db, b.tenant, (tx) => visit(tx, b, b.jess, starts[0] ?? '', theirs.id)),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23503');
    await expect(
      withTenant(db, b.tenant, (tx) =>
        insertBookingSeries(tx, {
          staffMemberId: b.jess,
          everyWeeks: 5,
          requestedStarts: starts.map((iso) => new Date(iso)),
          idempotencyKey: null,
          createdBy: null,
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23514');
    await expect(
      withTenant(db, b.tenant, (tx) =>
        insertBookingSeries(tx, {
          staffMemberId: b.jess,
          everyWeeks: 1,
          requestedStarts: [new Date(starts[0] ?? '')],
          idempotencyKey: null,
          createdBy: null,
        }),
      ),
    ).rejects.toSatisfy((error: unknown) => sqlState(error) === '23514');
  });

  it("lets staff reach their own staff member's series only (AC-X-184)", async () => {
    const b = await newBusiness();
    const jessUser = await insertUser(db, 'Jess');
    const owner = await insertUser(db, 'Ana');
    const { jessSeries, marcoSeries } = await withTenant(db, b.tenant, async (tx) => {
      await addMembership(tx, { userId: owner, role: 'owner' });
      const membership = await addMembership(tx, { userId: jessUser, role: 'staff' });
      await tx.execute(
        sql`UPDATE staff_members SET membership_id = ${membership.id} WHERE id = ${b.jess}`,
      );
      return { jessSeries: await series(tx, b.jess), marcoSeries: await series(tx, b.marco) };
    });
    const asJess = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withMember(db, { tenantId: b.tenant, userId: jessUser }, work);
    expect(
      await asJess((tx) => findBookingSeries(tx, BookingSeriesIdSchema.parse(jessSeries.id))),
    ).toBeDefined();
    expect(
      await asJess((tx) => findBookingSeries(tx, BookingSeriesIdSchema.parse(marcoSeries.id))),
    ).toBeUndefined();
    // Staff can't make a series for a colleague.
    await expect(asJess((tx) => series(tx, b.marco))).rejects.toSatisfy(
      (error: unknown) => sqlState(error) === '42501',
    );
    const asOwner = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withMember(db, { tenantId: b.tenant, userId: owner }, work);
    expect(
      await asOwner((tx) => findBookingSeries(tx, BookingSeriesIdSchema.parse(marcoSeries.id))),
    ).toBeDefined();
  });
});
