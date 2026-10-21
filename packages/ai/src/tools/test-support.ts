// Integration-test helpers for the tools (not built into dist): a migrated Postgres and a small
// seeded business (a "world") per test file, and a way to call tools as a member.
import {
  createBooking,
  createService,
  createStaffMember,
  replaceWorkingHours,
} from '@pepper/appointments';
import {
  TenantIdSchema,
  UserIdSchema,
  type Client,
  type LlmToolCall,
  type MembershipRole,
  type Service,
  type StaffMember,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { createBusiness, createClient, ManualClock, outboxKeyFrom, type Actor } from '@pepper/core';
import {
  addMembership,
  createDatabase,
  newId,
  prepareDatabase,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { postgresUrlAs, startPostgres } from '@pepper/testing';
import { dispatchToolCall, type ToolOutcome, type ToolTurn } from './registry.js';
import type { ToolDeps } from './tool.js';

export interface TestDatabase {
  app: DatabaseHandle;
  stop(): Promise<void>;
}

/** A migrated Postgres with the services' login role provisioned. */
export async function startTestDatabase(
  options: { onQuery?: () => void } = {},
): Promise<TestDatabase> {
  const postgres = await startPostgres();
  const appUrl = postgresUrlAs(postgres.url, 'pepper_service', 'service-test-password');
  await prepareDatabase(postgres.url, appUrl);
  const app = createDatabase({
    url: appUrl,
    maxConnections: 8,
    connectionTimeoutMs: 30_000,
    ...options,
  });
  return {
    app,
    stop: async () => {
      await app.close();
      await postgres.stop();
    },
  };
}

async function insertUser(db: Database, name: string): Promise<UserId> {
  const id = newId();
  await db.insert(users).values({ id, name, email: `user-${id}@example.test` });
  return UserIdSchema.parse(id);
}

/** Monday 2 November 2026, 07:00 in New York (EST, the day after the DST change). */
export const NOW = '2026-11-02T12:00:00.000Z';
export const TUESDAY = '2026-11-03';
export const OUTBOX_KEY = outboxKeyFrom('a-tools-integration-test-outbox-secret');

/**
 * Juniper Hair Studio in New York: Ana (owner), Cara (manager), Jess (staff, her own staff
 * member) and Priya (staff, linked to Marco's staff member). Haircut (60 min + 10 clean-up) and
 * Colour (90 min); Jess and Marco both cut, Jess also colours; both work Mon–Fri 09:00–17:00.
 * Clients: Maria Lopez (with email and phone), Sara Kim and Sarah Park.
 */
export interface World {
  db: Database;
  tenantId: TenantId;
  clock: ManualClock;
  owner: Actor;
  manager: Actor;
  jess: Actor;
  priya: Actor;
  haircut: Service;
  colour: Service;
  jessStaff: StaffMember;
  marcoStaff: StaffMember;
  maria: Client;
  sara: Client;
  sarah: Client;
}

let worlds = 0;

export async function newWorld(db: Database): Promise<World> {
  worlds += 1;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-tools-${String(worlds)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const actor = (userId: UserId, role: MembershipRole): Actor => ({
    context: { tenantId, userId, role },
    requestId: `req-${role}-${String(worlds)}`,
  });
  const managerId = await insertUser(db, 'Cara');
  const jessId = await insertUser(db, 'Jess');
  const priyaId = await insertUser(db, 'Priya');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: managerId, role: 'manager' });
    await addMembership(tx, { userId: jessId, role: 'staff' });
    await addMembership(tx, { userId: priyaId, role: 'staff' });
  });
  const owner = actor(ownerId, 'owner');
  const haircut = await createService(db, owner, {
    name: 'Haircut',
    durationMinutes: 60,
    bufferAfterMinutes: 10,
  });
  const colour = await createService(db, owner, { name: 'Colour', durationMinutes: 90 });
  const jessStaff = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: jessId,
    serviceIds: [haircut.id, colour.id],
  });
  const marcoStaff = await createStaffMember(db, owner, {
    displayName: 'Marco',
    userId: priyaId,
    serviceIds: [haircut.id],
  });
  const week = {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  };
  await replaceWorkingHours(db, owner, jessStaff.id, week);
  await replaceWorkingHours(db, owner, marcoStaff.id, week);
  const maria = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria.lopez@example.test',
    phone: '+12125550143',
  });
  const sara = await createClient(db, owner, { name: 'Sara Kim', email: 'sara@example.test' });
  const sarah = await createClient(db, owner, { name: 'Sarah Park' });
  return {
    db,
    tenantId,
    clock: new ManualClock(NOW),
    owner,
    manager: actor(managerId, 'manager'),
    jess: actor(jessId, 'staff'),
    priya: actor(priyaId, 'staff'),
    haircut,
    colour,
    jessStaff,
    marcoStaff,
    maria,
    sara,
    sarah,
  };
}

/** Tuesday 3 November at `HH:MM` in New York (UTC-5), as an instant. */
export function tuesdayAt(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 3, h + 5, m)).toISOString();
}

/** A booking made on the calendar screen (no email). */
export function bookOnScreen(
  world: World,
  staff: StaffMember,
  client: Client,
  time: string,
  service: Service = world.haircut,
) {
  return createBooking(
    world.db,
    world.owner,
    {
      clientId: client.id,
      serviceId: service.id,
      staffMemberId: staff.id,
      startsAt: tuesdayAt(time),
      notifyClient: false,
    },
    { clock: world.clock },
  );
}

export function depsFor(world: World, actor: Actor): ToolDeps {
  return {
    db: world.db,
    actor,
    clock: world.clock,
    autonomy: { templateDefaults: {} },
    emails: { baseUrl: 'http://localhost:3000', outboxKey: OUTBOX_KEY },
  };
}

let calls = 0;

/** A fresh turn (a new conversation turn per call unless one is given). */
export function turn(overrides: Partial<ToolTurn> = {}): ToolTurn {
  calls += 1;
  return {
    turnKey: `conv:test:turn:${String(calls)}`,
    step: 1,
    requestMessageId: null,
    untrustedContext: false,
    ...overrides,
  };
}

/** Calls a tool as the model would. */
export function callTool(
  deps: ToolDeps,
  name: string,
  args: unknown,
  inTurn: ToolTurn = turn(),
): Promise<ToolOutcome> {
  calls += 1;
  const call: LlmToolCall = {
    id: `call_${String(calls)}`,
    name,
    arguments: JSON.stringify(args),
  };
  return dispatchToolCall(deps, inTurn, call);
}
