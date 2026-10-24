import { TenantIdSchema, type TenantId } from '@pepper/contracts';
import { createBusiness, ManualClock, type Actor } from '@pepper/core';
import { listOpenFeedItems, withTenant, type Database } from '@pepper/db';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replaceWorkingHours } from './services/hours.js';
import { runInsightsFor, type InsightsOptions } from './services/insights.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The insights pass's latency gate (Phase 8 playbook §2): ≤ 2 s p95 for one business with a
// year of bookings and 2,000 clients, each run whole (lock, snapshot, providers, feed sync,
// commit). The gate is read from a run of this file alone (printed for the session log). The
// suites run side by side in CI and in `pnpm test:integration`, which made one run 13× slower
// (S35: p95 8.9 s against 0.33 s alone), so the test fails only at 10× the target: a real
// regression (a scan per client, a missing index), not a busy machine.

const TARGET_MS = 2_000;
const RUNS = 10;
const CLIENTS = 2_000;
const STAFF = 6;
const SLOTS_PER_DAY = 7; // 09:00–16:00 starts, an hour each: one free hour a day
const PAST_DAYS = 365;
const FUTURE_DAYS = 14;

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let bookingCount = 0;

const NOW = '2026-11-02T12:00:00.000Z';
const options: InsightsOptions = {
  clock: new ManualClock(NOW),
  insightsOf: () => ({
    enabled: ['schedule_gaps', 'rebooking_due', 'no_show_pattern', 'staff_overload'],
    minGapMinutes: 60,
  }),
};

async function asAdmin(text: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const ownerId = await insertUser(db, 'Ana');
  tenant = TenantIdSchema.parse(
    (
      await createBusiness(db, ownerId, {
        name: 'Busy Salon',
        slug: 'busy-salon-latency',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  const owner: Actor = { context: { tenantId: tenant, userId: ownerId, role: 'owner' } };
  const cut = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const color = await createService(db, owner, { name: 'Color', durationMinutes: 60 });
  await asAdmin('UPDATE services SET rebook_after_days = 42 WHERE id = $1', [color.id]);
  const staff: string[] = [];
  for (let i = 0; i < STAFF; i += 1) {
    const member = await createStaffMember(db, owner, {
      displayName: `Stylist ${String(i + 1)}`,
      userId: null,
      serviceIds: [cut.id, color.id],
    });
    await replaceWorkingHours(db, owner, member.id, {
      intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        start: '09:00',
        end: '17:00',
      })),
    });
    staff.push(member.id);
  }
  await asAdmin(
    `INSERT INTO clients (id, tenant_id, name, source)
     SELECT gen_random_uuid(), $1, 'Client ' || g, 'import' FROM generate_series(1, $2::int) g`,
    [tenant, CLIENTS],
  );
  // Every staff member, every day from a year ago to two weeks ahead, seven one-hour slots
  // (14:00 UTC is 09:00 EST; on EDT days the slots sit an hour later, still inside the day).
  // Clients rotate through the slots; past visits are completed, with no-shows and
  // cancellations sprinkled in.
  const inserted = await asAdmin(
    `WITH c AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM clients WHERE tenant_id = $1),
          s AS (SELECT id, ordinality - 1 AS n FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinality)),
          slots AS (
            SELECT d, s.id AS staff_id, s.n AS staff_n, k,
                   (date '2026-11-02' + d) + time '14:00' + k * interval '1 hour' AS starts_at
              FROM generate_series(-$4::int, $5::int - 1) d, s, generate_series(0, $6::int - 1) k)
     INSERT INTO bookings (id, tenant_id, client_id, service_id, staff_member_id, starts_at, ends_at,
                           buffer_before_minutes, buffer_after_minutes, status, source)
     SELECT gen_random_uuid(), $1, c.id,
            CASE WHEN (slots.d + slots.k) % 3 = 0 THEN $3::uuid ELSE $7::uuid END,
            slots.staff_id, slots.starts_at AT TIME ZONE 'UTC', (slots.starts_at + interval '1 hour') AT TIME ZONE 'UTC', 0, 0,
            CASE WHEN slots.starts_at >= timestamp '2026-11-02 12:00' THEN 'confirmed'
                 WHEN (slots.d * 7 + slots.k) % 20 = 0 THEN 'no_show'
                 WHEN (slots.d * 7 + slots.k) % 25 = 0 THEN 'cancelled'
                 ELSE 'completed' END,
            'team'
       FROM slots JOIN c ON c.n = ((slots.d + $4) * $8 + slots.staff_n * $6 + slots.k) % $9`,
    [
      tenant,
      staff,
      color.id,
      PAST_DAYS,
      FUTURE_DAYS,
      SLOTS_PER_DAY,
      cut.id,
      STAFF * SLOTS_PER_DAY,
      CLIENTS,
    ],
  );
  bookingCount = inserted.rowCount ?? 0;
  await asAdmin('ANALYZE', []);
}, 300_000);

afterAll(async () => {
  await database.stop();
});

describe('insights pass latency', () => {
  it(`runs a busy business in ≤ ${String(TARGET_MS)} ms p95`, async () => {
    expect(bookingCount).toBeGreaterThan(15_000);
    const timings: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      const started = performance.now();
      const result = await runInsightsFor(db, tenant, options);
      timings.push(performance.now() - started);
      expect(result.outcome).toBe('ran');
    }
    const items = await withTenant(db, tenant, (tx) => listOpenFeedItems(tx, new Date(NOW), 200));
    const kinds = new Set(items.map((item) => item.kind));
    const p50 = percentile(timings, 50);
    const p95 = percentile(timings, 95);
    // eslint-disable-next-line no-console -- the measured numbers go into the session log
    console.info(
      `Insights pass latency (${String(RUNS)} runs, ${String(bookingCount)} bookings, ${String(CLIENTS)} clients, ${String(items.length)} open items of ${[...kinds].sort().join(', ')}): p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms (target ${String(TARGET_MS)} ms)`,
    );
    expect(kinds).toContain('rebooking_due');
    expect(p95).toBeLessThan(TARGET_MS * 10);
  }, 300_000);
});
