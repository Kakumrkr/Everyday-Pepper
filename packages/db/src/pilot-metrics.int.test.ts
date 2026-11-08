// The pilot metrics page's numbers (S59.4, ADR-0062, AC-X-47…49): every business together,
// counted once each, read only in a logged operator transaction. Rows are seeded as the
// container's superuser (triggers and foreign keys off) so every time is exact.
import { randomBytes } from 'node:crypto';
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { grantOperator } from './operators.js';
import { readPlatformMetrics, readSupportMetrics } from './repositories/pilot-metrics.js';
import { createTenant } from './repositories/tenants.js';
import { withOperator, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let operator: UserId;
const tenants: TenantId[] = [];

const NOW = new Date('2026-11-08T12:00:00Z');
const SINCE = new Date('2026-11-01T12:00:00Z');
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
const ahead = (n: number) => new Date(NOW.getTime() + n * 60_000);

async function seed(statements: [string, unknown[]][]): Promise<void> {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const [text, values] of statements) await client.query(text, values);
    await client.query('COMMIT');
  } finally {
    await client.end();
  }
}

function reference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `PEP-${[...randomBytes(6)].map((byte) => alphabet[byte % 32] ?? '0').join('')}`;
}

async function business(name: string): Promise<{ id: TenantId; owner: UserId }> {
  const owner = await insertUser(db);
  const tenant = await createTenant(
    db,
    { name, slug: `${name.toLowerCase()}-${newId().slice(0, 8)}`, timeZone: 'America/New_York' },
    { owner },
  );
  const id = TenantIdSchema.parse(tenant.id);
  tenants.push(id);
  return { id, owner };
}

function activation(tenant: string, kind: string, at: Date, account: string | null = null) {
  return [
    `INSERT INTO activation_events (id, tenant_id, kind, account_id, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [newId(), tenant, kind, account, at],
  ] as [string, unknown[]];
}

function signup(account: string, at: Date) {
  return [
    'INSERT INTO signup_events (id, account_id, occurred_at) VALUES ($1, $2, $3)',
    [newId(), account, at],
  ] as [string, unknown[]];
}

function funnel(tenant: string, visit: string, step: string, at: Date) {
  return [
    `INSERT INTO booking_funnel_events (id, tenant_id, visit_id, step, occurred_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [newId(), tenant, visit, step, at],
  ] as [string, unknown[]];
}

function booking(
  tenant: string,
  values: {
    id?: string;
    staff: string;
    startsAt: Date;
    status: string;
    source?: string;
    createdAt?: Date;
    updatedAt?: Date;
  },
) {
  const created = values.createdAt ?? minutes(60 * 24 * 10);
  return [
    `INSERT INTO bookings (id, tenant_id, client_id, service_id, staff_member_id, starts_at,
                           ends_at, buffer_before_minutes, buffer_after_minutes, status, source,
                           import_batch_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, 0, 0, $7, $8, $9, $10, $11)`,
    [
      values.id ?? newId(),
      tenant,
      newId(),
      values.staff,
      values.startsAt,
      new Date(values.startsAt.getTime() + 45 * 60_000),
      values.status,
      values.source ?? 'team',
      values.source === 'import' ? newId() : null,
      created,
      values.updatedAt ?? created,
    ],
  ] as [string, unknown[]];
}

function offer(tenant: string, status: string, at: Date, bookingId: string | null = null) {
  return [
    `INSERT INTO waitlist_offers (id, tenant_id, match_id, entry_id, client_id, service_id,
                                  staff_member_id, starts_at, rank, token_hash, status,
                                  expires_at, booking_id, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $3, $3, $3, $4, 1, $5, $6, $4, $7, $8, $8)`,
    [newId(), tenant, newId(), ahead(600), randomBytes(32).toString('hex'), status, bookingId, at],
  ] as [string, unknown[]];
}

function thread(tenant: string, id: string, opener: string, at: Date) {
  return [
    `INSERT INTO support_threads (id, tenant_id, reference, kind, opened_by_user_id, context,
                                  last_message_at)
     VALUES ($1, $2, $3, 'problem', $4, '{}', $5)`,
    [id, tenant, reference(), opener, at],
  ] as [string, unknown[]];
}

function message(
  tenant: string,
  threadId: string,
  author: 'member' | 'pepper',
  at: Date,
  channel: 'app' | 'email' = 'app',
) {
  return [
    `INSERT INTO support_messages (id, tenant_id, thread_id, author_kind, body, channel,
                                   created_at)
     VALUES ($1, $2, $3, $4, 'Hello', $5, $6)`,
    [newId(), tenant, threadId, author, channel, at],
  ] as [string, unknown[]];
}

function publicRequest(channel: 'form' | 'email', status: string, at: Date) {
  return [
    `INSERT INTO public_support_requests (id, reference, email, body, channel, status,
                                          created_at)
     VALUES ($1, $2, 'someone@example.test', 'Hello', $3, $4, $5)`,
    [newId(), reference(), channel, status, at],
  ] as [string, unknown[]];
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  operator = await insertUser(db, 'Pepper Operator');
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  const email = (
    await client.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [operator])
  ).rows[0]?.email;
  await client.end();
  if (email === undefined) throw new Error('no operator account');
  expect(await grantOperator(database.migrationUrl, { email, note: 'pilot metrics' })).toBe(
    'granted',
  );

  const a = await business('Alpha');
  const b = await business('Bravo');
  // A third business that never got anywhere: counted, not bookable.
  await business('Charlie');
  const staff = newId();
  const refill = newId();
  const edited = newId();
  const other = newId();
  const claimed = newId();
  const t1 = newId();
  const t2 = newId();
  const t3 = newId();
  const t4 = newId();
  await seed([
    // Alpha's owner signed up 2 h ago: bookable after 8 min, first booking after 20.
    signup(a.owner, minutes(120)),
    activation(a.id, 'business_created', minutes(118), a.owner),
    activation(a.id, 'bookable', minutes(112)),
    activation(a.id, 'first_booking', minutes(100)),
    // Bravo's owner signed up 3 h ago: bookable after 12 min, no booking yet.
    signup(b.owner, minutes(180)),
    activation(b.id, 'business_created', minutes(179), b.owner),
    activation(b.id, 'bookable', minutes(168)),
    // A sign-up who made no business, and one from before the period.
    signup(await insertUser(db), minutes(30)),
    signup(await insertUser(db), minutes(60 * 24 * 9)),

    // Funnel: Alpha 3 visits (one booked, one left at the code, one at the time step), Bravo 1
    // waitlisted after the code; one visit that started before the period.
    ...((visit) => [
      funnel(a.id, visit, 'service', minutes(50)),
      funnel(a.id, visit, 'verify', minutes(45)),
      funnel(a.id, visit, 'done', minutes(44)),
    ])(newId()),
    ...((visit) => [
      funnel(a.id, visit, 'service', minutes(40)),
      funnel(a.id, visit, 'verify', minutes(38)),
    ])(newId()),
    funnel(a.id, newId(), 'time', minutes(20)),
    ...((visit) => [
      funnel(b.id, visit, 'service', minutes(10)),
      funnel(b.id, visit, 'verify', minutes(9)),
      funnel(b.id, visit, 'waitlisted', minutes(8)),
    ])(newId()),
    funnel(a.id, newId(), 'service', minutes(60 * 24 * 8)),
    // Started in the period, booked after its end: a start, not (yet) a booking.
    ...((visit) => [
      funnel(b.id, visit, 'service', minutes(5)),
      funnel(b.id, visit, 'done', ahead(5)),
    ])(newId()),

    // Past visits: 3 kept and 1 no-show at Alpha, 1 no-show at Bravo; an imported no-show, a
    // cancelled past one, a future one and one before the period are left out.
    booking(a.id, { staff, startsAt: minutes(60 * 24), status: 'completed' }),
    booking(a.id, { staff, startsAt: minutes(60 * 30), status: 'completed' }),
    booking(a.id, { staff, startsAt: minutes(60 * 2), status: 'confirmed' }),
    booking(a.id, { staff, startsAt: minutes(60 * 3), status: 'no_show' }),
    booking(b.id, { staff, startsAt: minutes(60 * 5), status: 'no_show' }),
    booking(a.id, { staff, startsAt: minutes(60 * 4), status: 'no_show', source: 'import' }),
    booking(a.id, {
      staff,
      startsAt: minutes(60 * 6),
      status: 'cancelled',
      updatedAt: minutes(60 * 7),
    }),
    booking(a.id, { staff, startsAt: ahead(60), status: 'confirmed' }),
    booking(a.id, { staff, startsAt: minutes(60 * 24 * 8), status: 'no_show' }),

    // Cancelled ahead of time (with the past one above, an hour before it): one refilled by an
    // overlapping visit booked after, the others not
    // (Bravo's); the refill itself is a future booking.
    booking(a.id, {
      staff,
      startsAt: ahead(60 * 24),
      status: 'cancelled',
      updatedAt: minutes(60),
    }),
    booking(a.id, {
      id: refill,
      staff,
      startsAt: ahead(60 * 24 + 15),
      status: 'confirmed',
      createdAt: minutes(30),
    }),
    booking(b.id, {
      staff,
      startsAt: ahead(60 * 48),
      status: 'cancelled',
      updatedAt: minutes(90),
    }),

    // Cancelled 2 h ago by its audit entry, changed again since (updated_at 10 min ago), and
    // refilled an hour ago: refilled, timed from the cancellation.
    booking(a.id, {
      id: edited,
      staff: other,
      startsAt: ahead(60 * 72),
      status: 'cancelled',
      updatedAt: minutes(10),
    }),
    [
      `INSERT INTO audit_log (id, tenant_id, actor_kind, action, entity_type, entity_id, before,
                              after, created_at)
       VALUES ($1, $2, 'user', 'booking.updated', 'booking', $3, '{"status":"confirmed"}',
               '{"status":"cancelled"}', $4)`,
      [newId(), a.id, edited, minutes(120)],
    ],
    booking(a.id, {
      staff: other,
      startsAt: ahead(60 * 72 + 15),
      status: 'confirmed',
      createdAt: minutes(60),
    }),

    // Offers: Alpha 2 answered (1 claimed) and 1 still waiting (left out), Bravo 1 expired;
    // one before the period.
    offer(a.id, 'claimed', minutes(55), claimed),
    offer(a.id, 'taken', minutes(54)),
    offer(a.id, 'offered', minutes(52)),
    offer(b.id, 'expired', minutes(53)),
    offer(b.id, 'claimed', minutes(60 * 24 * 8), refill),

    // Support: t1 answered after 30 min, t2 after 2 h (by email, the owner wrote again by
    // email), t3 answered after 26 h, t4 waits since 30 h; one from before the period.
    thread(a.id, t1, a.owner, minutes(90)),
    message(a.id, t1, 'member', minutes(90)),
    message(a.id, t1, 'pepper', minutes(60)),
    message(a.id, t1, 'pepper', minutes(50)),
    thread(b.id, t2, b.owner, minutes(300)),
    message(b.id, t2, 'member', minutes(300), 'email'),
    message(b.id, t2, 'pepper', minutes(180)),
    message(b.id, t2, 'member', minutes(170), 'email'),
    message(b.id, t2, 'member', minutes(160)),
    thread(a.id, t3, a.owner, minutes(60 * 30)),
    message(a.id, t3, 'member', minutes(60 * 30)),
    message(a.id, t3, 'pepper', minutes(60 * 4)),
    thread(b.id, t4, b.owner, minutes(60 * 30)),
    message(b.id, t4, 'member', minutes(60 * 30), 'email'),
    ...((old) => [
      thread(a.id, old, a.owner, minutes(60 * 24 * 9)),
      message(a.id, old, 'member', minutes(60 * 24 * 9)),
    ])(newId()),
    publicRequest('form', 'open', minutes(30)),
    publicRequest('email', 'answered', minutes(40)),
    publicRequest('email', 'solved', minutes(60 * 24 * 2)),
    publicRequest('form', 'open', minutes(60 * 24 * 9)),
  ]);
});

afterAll(async () => {
  await database.stop();
});

const period = { since: SINCE, until: NOW };
const asOperator = <T>(work: Parameters<typeof withOperator<T>>[2]) =>
  withOperator(db, { operatorUserId: operator, action: 'metrics.read', targetId: null }, work);

describe('platform metrics (S59.4, AC-X-47)', () => {
  it('counts every business once, from sign-up to booking, funnel, visits and offers', async () => {
    const metrics = await asOperator((tx) => readPlatformMetrics(tx, period));
    expect(metrics).toEqual({
      businesses: 3,
      bookableBusinesses: 2,
      signups: 3,
      reachedBookable: 2,
      reachedFirstBooking: 1,
      minutesToBookable: 10,
      minutesToFirstBooking: 20,
      funnelStarts: 5,
      funnelConfirmed: 1,
      funnelReachedCode: 3,
      funnelLeftAtCode: 1,
      pastBookings: 5,
      noShows: 2,
      cancelledSlots: 4,
      refilledSlots: 2,
      offersSent: 3,
      offersClaimed: 1,
    });
  });

  it('is refused outside a logged operator transaction, and in a business', async () => {
    const tenant = tenants[0];
    if (tenant === undefined) throw new Error('no business');
    const asMember = await withTenant(db, tenant, (tx) =>
      readPlatformMetrics(tx, period).then(
        () => 'read',
        (error: unknown) => sqlState(error),
      ),
    );
    expect(asMember).toBe('42501');
    const plain = await db.transaction((tx) =>
      readPlatformMetrics(tx, period).then(
        () => 'read',
        (error: unknown) => sqlState(error),
      ),
    );
    expect(plain).toBe('42501');
  });

  it('leaves the transaction as it found it', async () => {
    const settings = await asOperator(async (tx) => {
      await readPlatformMetrics(tx, period);
      const { rows } = await tx.execute<{ tenant: string | null; member: string | null }>(
        // Both unset before the read: they come back empty, never another business.
        sql`SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.user_id', true) AS member`,
      );
      return rows[0];
    });
    expect(settings?.tenant ?? '').toBe('');
    expect(settings?.member ?? '').toBe('');
  });
});

describe('support metrics (S59.4, AC-X-48, AC-X-49)', () => {
  it('times the first reply and splits requests by channel', async () => {
    const metrics = await asOperator((tx) => readSupportMetrics(tx, period));
    expect(metrics).toEqual({
      requests: 4,
      answered: 3,
      answeredWithinDay: 2,
      waiting: 1,
      waitingOverDay: 1,
      medianMinutes: 120,
      slowestMinutes: 60 * 26,
      requestsInApp: 2,
      requestsByEmail: 2,
      repliesInApp: 1,
      repliesByEmail: 1,
      publicByForm: 1,
      publicByEmail: 2,
      publicAnswered: 2,
      publicOpen: 1,
    });
  });

  it('reads no business requests without the operator', async () => {
    const metrics = await db.transaction((tx) => readSupportMetrics(tx, period));
    expect(metrics.requests).toBe(0);
    expect(metrics.publicByForm + metrics.publicByEmail).toBe(0);
  });
});
