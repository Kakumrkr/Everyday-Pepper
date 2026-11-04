import {
  ClientIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type TenantId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking } from './repositories/bookings.js';
import { BUSINESS_EXPORT_TABLES, readBusinessExport } from './repositories/business-export.js';
import { deleteClientRow, insertClient } from './repositories/clients.js';
import { createTenant } from './repositories/tenants.js';
import { addMembership } from './repositories/memberships.js';
import { withMember, withTenant } from './tenant.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The business export's read against real Postgres (S51, ADR-0053, AC-W1-37): every tenant
// table is exported or named with why not, a business reads only its own rows, deleted
// clients are left out and nothing secret (a manage link's hash) is in it.

let database: TestDatabase;
let db: Database;
let slugs = 0;
/** Every manage link's hash the fixtures wrote: none may be in an export. */
const hashes: string[] = [];
const secret = () => {
  const hash = randomBytes(32).toString('hex');
  hashes.push(hash);
  return hash;
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

/** A business with a service, a staff member, two clients (one deleted) and a visit each. */
async function business(name: string): Promise<TenantId> {
  slugs += 1;
  const tenant = await createTenant(db, {
    name,
    slug: `${name.toLowerCase()}-export-${String(slugs)}`,
    timeZone: 'America/Chicago',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner = await insertUser(db, `${name} owner`);
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: owner, role: 'owner' }));
  // As the owner: deleting a client is a member's act (ADR-0051).
  await withMember(db, { tenantId, userId: owner }, async (tx) => {
    const service = await insertService(tx, {
      name: `${name} cut`,
      category: null,
      durationMinutes: 45,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 4000,
      priceToCents: null,
      active: true,
    });
    const staff = await insertStaffMember(tx, {
      displayName: `${name} Jess`,
      color: '#336699',
      active: true,
      membershipId: null,
    });
    const visit = async (clientId: string, startsAt: Date) =>
      insertBooking(tx, {
        clientId: ClientIdSchema.parse(clientId),
        serviceId: ServiceIdSchema.parse(service.id),
        staffMemberId: StaffMemberIdSchema.parse(staff.id),
        startsAt,
        endsAt: new Date(startsAt.getTime() + 45 * 60_000),
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        priceFromCents: 4000,
        priceToCents: null,
        source: 'team',
        overridden: true,
        idempotencyKey: null,
        createdBy: null,
        manageTokenHash: secret(),
      });
    const kept = await insertClient(tx, {
      name: `${name} Client`,
      email: `${name.toLowerCase()}@example.test`,
      phone: null,
      source: 'team',
      tags: ['vip'],
    });
    const gone = await insertClient(tx, {
      name: `${name} Gone`,
      email: `gone-${name.toLowerCase()}@example.test`,
      phone: null,
      source: 'team',
    });
    await visit(kept.id, new Date('2099-01-05T15:00:00Z'));
    await visit(gone.id, new Date('2099-01-06T15:00:00Z'));
    await deleteClientRow(tx, ClientIdSchema.parse(gone.id), new Date('2099-02-01T00:00:00Z'));
  });
  return tenantId;
}

describe('readBusinessExport (AC-W1-37)', () => {
  it('names every tenant table: exported, or why not', async () => {
    const { rows } = await db.execute<{ table_name: string }>(sql`
      SELECT DISTINCT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenant_id'
       ORDER BY table_name`);
    const tenantTables = ['tenants', ...rows.map((row) => row.table_name)].sort();
    expect(Object.keys(BUSINESS_EXPORT_TABLES).sort()).toEqual(tenantTables);
  });

  it('reads only the business’s own rows, without deleted clients or secrets', async () => {
    const fade = await business('Fade');
    await business('Other');
    const data = await withTenant(db, fade, readBusinessExport);
    expect(data.business).toMatchObject({ name: 'Fade', timeZone: 'America/Chicago' });
    expect(data.services.map((s) => s.name)).toEqual(['Fade cut']);
    expect(data.staff.map((s) => s.displayName)).toEqual(['Fade Jess']);
    expect(data.clients.map((c) => [c.name, c.email, c.tags])).toEqual([
      ['Fade Client', 'fade@example.test', ['vip']],
    ]);
    // Both visits stay (the deleted client's past visit is the business's history).
    expect(data.bookings).toHaveLength(2);
    expect(data.bookings.every((b) => b.serviceId === data.services[0]?.id)).toBe(true);
    const text = JSON.stringify(data);
    expect(text).not.toContain('Other');
    expect(text).not.toContain('gone-fade@example.test');
    for (const hash of hashes) expect(text).not.toContain(hash);
  });
});
