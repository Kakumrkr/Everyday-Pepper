import {
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type TenantId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import { countWeekActions, listWeekBookings } from './repositories/proof.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { startTestDatabase, type TestDatabase } from './test-support.js';

// The week card's reads against real Postgres (S55, ADR-0058; AC-W4-10): the window by when a
// visit was booked, what stands, the claimed offers, and the 14 days a nudge counts for.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase({ maxConnections: 4 });
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const NOW = new Date('2026-11-05T15:00:00.000Z');
const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const WINDOW = { from: daysAgo(7), to: NOW, regularBackDays: 14 };

interface Business {
  tenant: TenantId;
  service: string;
  staff: string;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const created = await createTenant(db, {
    name: 'Juniper',
    slug: `juniper-proof-${String(slugs)}`,
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
      priceFromCents: 4500,
      priceToCents: null,
      active: true,
    });
    const staff = await insertStaffMember(tx, {
      displayName: 'Jess',
      color: '#2a7230',
      active: true,
      membershipId: null,
    });
    return { tenant, service: service.id, staff: staff.id };
  });
}

const client = (tx: TenantTx, name: string) =>
  insertClient(tx, { name, email: null, phone: null, source: 'team' });

let hour = 0;
/** A visit booked `bookedDaysAgo` days before NOW, starting in the days ahead. */
async function booked(
  tx: TenantTx,
  b: Business,
  clientId: string,
  bookedDaysAgo: number,
  overrides: { source?: 'team' | 'ai' | 'booking_page'; priceFromCents?: number | null } = {},
) {
  hour += 1;
  const start = new Date(NOW.getTime() + DAY_MS + hour * 3_600_000);
  const row = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(clientId),
    serviceId: ServiceIdSchema.parse(b.service),
    staffMemberId: StaffMemberIdSchema.parse(b.staff),
    startsAt: start,
    endsAt: new Date(start.getTime() + 3_600_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: overrides.priceFromCents === undefined ? 4500 : overrides.priceFromCents,
    priceToCents: null,
    source: overrides.source ?? 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
    manageTokenHash: null,
  });
  await tx.execute(
    sql`UPDATE bookings SET created_at = ${daysAgo(bookedDaysAgo)} WHERE id = ${row.id}`,
  );
  return row;
}

let keys = 0;
/** An AI action on `entityId` done `doneDaysAgo` days before NOW. */
async function action(
  tx: TenantTx,
  name: string,
  entityId: string,
  doneDaysAgo: number,
  status: 'done' | 'undone' = 'done',
) {
  keys += 1;
  await tx.execute(sql`
    INSERT INTO ai_action_executions
      (id, action, tool, outcome, idempotency_key, status, entity_type, entity_id, explanation, created_at,
       undone_at)
    VALUES (${newId()}, ${name}, 'test_tool', 'execute', ${`proof-test-${String(keys)}`}, ${status}, 'client',
      ${entityId}, '{"requestMessageId":null,"steps":[],"facts":[]}'::jsonb, ${daysAgo(doneDaysAgo)},
      ${status === 'undone' ? NOW : null})
  `);
}

/** A regular's offer for the freed time, claimed with `bookingId`. */
async function claimedOffer(tx: TenantTx, b: Business, clientId: string, bookingId: string) {
  keys += 1;
  const [match] = (
    await tx.execute<{ id: string }>(sql`
      INSERT INTO waitlist_matches (id, booking_id, staff_member_id, starts_at, ends_at, status, outcome)
      VALUES (${newId()}, ${bookingId}, ${b.staff}, ${NOW}, ${new Date(NOW.getTime() + 3_600_000)}, 'done', 'offered') RETURNING id
    `)
  ).rows;
  await tx.execute(sql`
    INSERT INTO waitlist_offers
      (id, match_id, entry_id, source, client_id, service_id, staff_member_id, starts_at, rank,
       token_hash, status, expires_at, booking_id)
    VALUES (${newId()}, ${match?.id}, NULL, 'regular', ${clientId}, ${b.service}, ${b.staff}, ${NOW}, 1,
      ${String(keys).padStart(64, 'a')}, 'claimed', ${NOW}, ${bookingId})
  `);
}

describe('the week card reads (AC-W4-10)', () => {
  it('lists what was booked in the window that stands, with price, fill and nudge', async () => {
    const b = await newBusiness();
    const ids = await withTenant(db, b.tenant, async (tx) => {
      const ana = await client(tx, 'Ana Ruiz');
      const sam = await client(tx, 'Sam Diaz');
      const bea = await client(tx, 'Bea Tran');
      const gone = await client(tx, 'Gone Person');
      const online = await booked(tx, b, ana.id, 2, { source: 'booking_page' });
      // An unpriced visit falls back to its service's price.
      const unpriced = await booked(tx, b, sam.id, 1, { source: 'ai', priceFromCents: null });
      const filled = await booked(tx, b, bea.id, 3);
      await claimedOffer(tx, b, bea.id, filled.id);
      // Booked 8 days ago: outside the window.
      await booked(tx, b, ana.id, 8, { source: 'booking_page' });
      // Cancelled since: not standing.
      const cancelled = await booked(tx, b, sam.id, 1, { source: 'ai' });
      await tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${cancelled.id}`);
      // A deleted client's visit counts for nothing (deleted after a visit already past).
      await booked(tx, b, gone.id, 1, { source: 'ai' });
      await tx.execute(sql`UPDATE clients SET deleted_at = ${NOW} WHERE id = ${gone.id}`);
      return { online: online.id, unpriced: unpriced.id, filled: filled.id };
    });
    const rows = await withTenant(db, b.tenant, (tx) => listWeekBookings(tx, WINDOW));
    expect(
      rows.map(({ id, source, priceCents, filled, nudged }) => [
        id,
        source,
        priceCents,
        filled,
        nudged,
      ]),
    ).toEqual([
      [ids.filled, 'team', 4500, true, false],
      [ids.online, 'booking_page', 4500, false, false],
      [ids.unpriced, 'ai', 4500, false, false],
    ]);
  });

  it('marks a booking nudged only by a done nudge to its client in the 14 days before', async () => {
    const b = await newBusiness();
    const expected = await withTenant(db, b.tenant, async (tx) => {
      const [ana, sam, bea, lea, tom] = [
        await client(tx, 'Ana Ruiz'),
        await client(tx, 'Sam Diaz'),
        await client(tx, 'Bea Tran'),
        await client(tx, 'Lea Fox'),
        await client(tx, 'Tom Lee'),
      ];
      await action(tx, 'message.rebooking_nudge', ana.id, 10); // 7 days before her booking
      await action(tx, 'message.rebooking_nudge', sam.id, 20); // 17 days before: too long ago
      await action(tx, 'message.rebooking_nudge', bea.id, 5, 'undone');
      await action(tx, 'message.waitlist_offer', lea.id, 5); // not a nudge
      await action(tx, 'message.rebooking_nudge', tom.id, 1); // after his booking
      return {
        ana: (await booked(tx, b, ana.id, 3)).id,
        sam: (await booked(tx, b, sam.id, 3)).id,
        bea: (await booked(tx, b, bea.id, 3)).id,
        lea: (await booked(tx, b, lea.id, 3)).id,
        tom: (await booked(tx, b, tom.id, 3)).id,
      };
    });
    const rows = await withTenant(db, b.tenant, (tx) => listWeekBookings(tx, WINDOW));
    const nudged = new Map(rows.map((row) => [row.id, row.nudged]));
    expect(
      Object.fromEntries(Object.entries(expected).map(([name, id]) => [name, nudged.get(id)])),
    ).toEqual({
      ana: true,
      sam: false,
      bea: false,
      lea: false,
      tom: false,
    });
  });

  it("counts the AI's done actions in the window by kind", async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenant, async (tx) => {
      const ana = await client(tx, 'Ana Ruiz');
      await action(tx, 'message.rebooking_nudge', ana.id, 1);
      await action(tx, 'message.rebooking_nudge', ana.id, 6);
      await action(tx, 'booking.move', ana.id, 2);
      await action(tx, 'booking.move', ana.id, 2, 'undone');
      await action(tx, 'booking.move', ana.id, 9);
    });
    const counts = await withTenant(db, b.tenant, (tx) => countWeekActions(tx, WINDOW));
    expect(Object.fromEntries(counts)).toEqual({ 'message.rebooking_nudge': 2, 'booking.move': 1 });
  });

  it("reads only the business's own rows", async () => {
    const mine = await newBusiness();
    const theirs = await newBusiness();
    await withTenant(db, theirs.tenant, async (tx) => {
      const ana = await client(tx, 'Ana Ruiz');
      await booked(tx, theirs, ana.id, 1, { source: 'booking_page' });
      await action(tx, 'booking.move', ana.id, 1);
    });
    await withTenant(db, mine.tenant, async (tx) => {
      expect(await listWeekBookings(tx, WINDOW)).toEqual([]);
      expect((await countWeekActions(tx, WINDOW)).size).toBe(0);
    });
  });
});
