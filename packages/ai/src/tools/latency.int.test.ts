import type { StaffMember } from '@pepper/contracts';
import { createService, createStaffMember, replaceWorkingHours } from '@pepper/appointments';
import { changeAutonomy } from '@pepper/core';
import { insertBooking, withTenant, type Database } from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validArguments } from './hostile.js';
import {
  bookOnScreen,
  callTool,
  depsFor,
  newWorld,
  startTestDatabase,
  TUESDAY,
  type TestDatabase,
  type World,
} from './test-support.js';

// Per-tool budgets (playbook §2 and §9's queue): a tool must answer in ≤ 300 ms p95 (voice will
// need fast reads). Timing on shared CI runners is noisy, so the gate is twofold: the number of
// statements each call runs (deterministic: a new N+1 fails at once) and the p95 at 3× the
// target, which catches only a real regression. The measured numbers are printed for the
// session log.

const QUERY_BUDGET: Record<string, number> = {
  find_availability: 25,
  find_clients: 10,
  get_day: 20,
  get_booking: 15,
  find_client_bookings: 15,
  list_services_and_staff: 12,
  create_booking: 60,
  move_booking: 70,
  cancel_booking: 60,
  block_time: 40,
  add_todo: 40,
};
const P95_TARGET_MS = 300;
const P95_GATE_MS = 3 * P95_TARGET_MS;
const RUNS = 15;

let database: TestDatabase;
let db: Database;
let world: World;
let queries = 0;
let bookingId = '';

const STAFF = 10;
const DAYS = 20;
const PER_DAY = 10;

beforeAll(async () => {
  database = await startTestDatabase({ onQuery: () => (queries += 1) });
  db = database.app.db;
  world = await newWorld(db);
  // A busy business: 10 more staff members with 10 bookings a weekday for 4 weeks (2,000).
  const trim = await createService(db, world.owner, { name: 'Trim', durationMinutes: 40 });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '18:00' })),
  };
  const staff: StaffMember[] = [];
  for (let i = 0; i < STAFF; i += 1) {
    const member = await createStaffMember(db, world.owner, {
      displayName: `Stylist ${String(i + 1)}`,
      serviceIds: [trim.id, world.haircut.id],
    });
    await replaceWorkingHours(db, world.owner, member.id, week);
    staff.push(member);
  }
  const start = Date.parse('2026-11-02T14:00:00.000Z');
  await withTenant(db, world.tenantId, async (tx) => {
    for (let day = 0; day < DAYS + 8; day += 1) {
      const date = new Date(start + day * 86_400_000);
      if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
      for (const member of staff) {
        for (let slot = 0; slot < PER_DAY; slot += 1) {
          const startsAt = new Date(date.getTime() + slot * 45 * 60_000);
          await insertBooking(tx, {
            clientId: world.maria.id,
            serviceId: trim.id,
            staffMemberId: member.id,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 40 * 60_000),
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            priceFromCents: null,
            priceToCents: null,
            source: 'team',
            overridden: false,
            idempotencyKey: null,
            createdBy: world.owner.context.userId,
          });
        }
      }
    }
  });
  bookingId = (await bookOnScreen(world, world.jessStaff, world.maria, '10:00')).id;
  // Writes stop at a proposal, so every run measures the same dry run.
  await changeAutonomy(db, world.owner, { askFirst: true }, { templateDefaults: {} });
}, 300_000);

afterAll(async () => {
  await database.stop();
});

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

describe('per-tool budgets on a busy business', () => {
  const report: string[] = [];

  afterAll(() => {
    // eslint-disable-next-line no-console -- the measured numbers go into the session log
    console.info(`Tool budgets (${String(RUNS)} runs each):\n${report.join('\n')}`);
  });

  it.each(Object.keys(QUERY_BUDGET))('%s', async (name) => {
    const args = validArguments(
      {
        serviceId: world.haircut.id,
        staffMemberId: world.jessStaff.id,
        clientId: world.maria.id,
        bookingId,
      },
      TUESDAY,
    )[name];
    const deps = depsFor(world, world.owner);
    const times: number[] = [];
    const counts: number[] = [];
    // One warm-up call, then the measured ones.
    await callTool(deps, name, args);
    for (let run = 0; run < RUNS; run += 1) {
      queries = 0;
      const started = performance.now();
      const outcome = await callTool(deps, name, args);
      times.push(performance.now() - started);
      counts.push(queries);
      expect(outcome.status === 'refused' ? outcome.code : 'ok', name).not.toBe('internal');
    }
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    const most = Math.max(...counts);
    report.push(
      `  ${name.padEnd(24)} p50 ${p50.toFixed(0).padStart(4)} ms  p95 ${p95.toFixed(0).padStart(4)} ms  statements ${String(most)} (budget ${String(QUERY_BUDGET[name])})`,
    );
    expect(most, `${name} statements`).toBeLessThanOrEqual(QUERY_BUDGET[name] ?? 0);
    expect(p95, `${name} p95 ms`).toBeLessThanOrEqual(P95_GATE_MS);
  });
});
