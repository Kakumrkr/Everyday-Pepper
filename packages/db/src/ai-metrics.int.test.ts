// The pilot metrics page, part 2 (S59.4.2, ADR-0062 Part 4, AC-X-50…53): engagement, the AI's
// cards and the rebook rate, every business together, read only in a logged operator
// transaction. Rows are seeded as the container's superuser (triggers and foreign keys off) so
// every time is exact.
import { randomBytes } from 'node:crypto';
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { grantOperator } from './operators.js';
import { readAiMetrics } from './repositories/pilot-metrics.js';
import { createTenant } from './repositories/tenants.js';
import { withOperator, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

type Statement = [string, unknown[]];

let database: TestDatabase;
let db: Database;
let operator: UserId;
const tenants: TenantId[] = [];

// A Sunday, 07:00 in New York: the businesses' days end at their own midnight.
const NOW = new Date('2026-11-08T12:00:00Z');
const DAY = 24 * 60;
const minutes = (n: number) => new Date(NOW.getTime() - n * 60_000);
const days = (n: number) => minutes(n * DAY);
const ahead = (n: number) => new Date(NOW.getTime() + n * DAY * 60_000);

async function seed(statements: Statement[]): Promise<void> {
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

function memberSince(tenant: string, at: Date): Statement {
  return ['UPDATE memberships SET created_at = $2 WHERE tenant_id = $1', [tenant, at]];
}

function staffMember(tenant: string, user: string, at: Date): Statement {
  return [
    `INSERT INTO memberships (id, tenant_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'staff', $4, $4)`,
    [newId(), tenant, user, at],
  ];
}

function turn(
  tenant: string,
  user: string,
  at: Date,
  tokens: [input: number, cached: number, output: number] = [0, 0, 0],
): Statement {
  return [
    `INSERT INTO conversation_turns (id, tenant_id, conversation_id, user_id, client_turn_id,
                                     status, stop_reason, input_tokens, cached_input_tokens,
                                     output_tokens, deadline_at, finished_at, created_at,
                                     updated_at)
     VALUES ($1, $2, $3, $4, $5, 'completed', 'answered', $6, $7, $8, $9, $9, $9, $9)`,
    [newId(), tenant, newId(), user, newId(), ...tokens, at],
  ];
}

function audit(
  tenant: string,
  values: { kind: 'user' | 'ai_on_behalf_of' | 'system'; user: string | null; action: string },
  at: Date,
): Statement {
  return [
    `INSERT INTO audit_log (id, tenant_id, actor_kind, actor_user_id, action, entity_type,
                            entity_id, created_at)
     VALUES ($1, $2, $3, $4, $5, 'tenant', $2, $6)`,
    [newId(), tenant, values.kind, values.user, values.action, at],
  ];
}

function proposal(
  tenant: string,
  values: {
    id?: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';
    action?: string;
    requestedBy?: string | null;
    decidedBy?: string | null;
    createdAt: Date;
    decidedAt?: Date;
  },
): Statement {
  return [
    `INSERT INTO ai_action_proposals (id, tenant_id, action, tool, target_key, idempotency_key,
                                      status, payload, preview, fingerprint, explanation,
                                      requested_by_user_id, decided_by_user_id, decided_at,
                                      expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, 'move_booking', $4, $5, $6, '{}', '{}', $7, '{}', $8, $9, $10, $11,
             $12, $12)`,
    [
      values.id ?? newId(),
      tenant,
      values.action ?? 'booking.move',
      `booking:${newId()}`,
      `key-${newId()}`,
      values.status,
      randomBytes(32).toString('hex'),
      values.requestedBy ?? null,
      values.decidedBy ?? null,
      values.decidedAt ?? null,
      new Date(values.createdAt.getTime() + DAY * 60_000),
      values.createdAt,
    ],
  ];
}

function execution(
  tenant: string,
  values: {
    proposal?: string;
    createdAt: Date;
    undone?: { by: string; at: Date; reason: 'wrong' | 'changed_mind' | 'other' };
  },
): Statement {
  return [
    `INSERT INTO ai_action_executions (id, tenant_id, proposal_id, action, tool, outcome,
                                       idempotency_key, status, entity_type, entity_id,
                                       explanation, undone_by_user_id, undone_at, undo_reason,
                                       created_at, updated_at)
     VALUES ($1, $2, $3, 'booking.move', 'move_booking', $4, $5, $6, 'booking', $1, '{}', $7, $8,
             $9, $10, $10)`,
    [
      newId(),
      tenant,
      values.proposal ?? null,
      values.proposal === undefined ? 'execute' : 'propose',
      `key-${newId()}`,
      values.undone === undefined ? 'done' : 'undone',
      values.undone?.by ?? null,
      values.undone?.at ?? null,
      values.undone?.reason ?? null,
      values.createdAt,
    ],
  ];
}

function dismissed(tenant: string, at: Date, actionProposal: string | null = null): Statement {
  const subject = `staff:${newId()}`;
  const day = '2026-11-07';
  return [
    `INSERT INTO feed_items (id, tenant_id, kind, status, subject_key, day, dedupe_key, payload,
                             action_proposal_id, expires_at, acted_at, created_at, updated_at)
     VALUES ($1, $2, 'schedule_gaps', 'dismissed', $3, $4, $5, '{}', $6, $7, $8, $8, $8)`,
    [newId(), tenant, subject, day, `schedule_gaps:${subject}:${day}`, actionProposal, NOW, at],
  ];
}

function service(tenant: string, id: string, rebookAfterDays: number | null): Statement {
  return [
    `INSERT INTO services (id, tenant_id, name, duration_minutes, rebook_after_days)
     VALUES ($1, $2, $3, 45, $4)`,
    [id, tenant, `Cut ${String(rebookAfterDays ?? 'by the client')}`, rebookAfterDays],
  ];
}

function visit(
  tenant: string,
  values: {
    client: string;
    service: string;
    startsAt: Date;
    status?: string;
    source?: string;
    createdAt?: Date;
  },
): Statement {
  const created = values.createdAt ?? new Date(values.startsAt.getTime() - DAY * 60_000);
  return [
    `INSERT INTO bookings (id, tenant_id, client_id, service_id, staff_member_id, starts_at,
                           ends_at, buffer_before_minutes, buffer_after_minutes, status, source,
                           import_batch_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9, $10, $11, $11)`,
    [
      newId(),
      tenant,
      values.client,
      values.service,
      newId(),
      values.startsAt,
      new Date(values.startsAt.getTime() + 45 * 60_000),
      values.status ?? 'completed',
      values.source ?? 'team',
      values.source === 'import' ? newId() : null,
      created,
    ],
  ];
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
  expect(await grantOperator(database.migrationUrl, { email, note: 'ai metrics' })).toBe('granted');

  const a = await business('Alpha');
  const b = await business('Bravo');
  // Joined 3 days ago: no whole week as an owner yet, and nothing done.
  const c = await business('Charlie');
  const staff = await insertUser(db);
  const p1 = newId();
  const p2 = newId();
  const interval = newId();
  const noInterval = newId();
  const [c1, c2, c3, c4, c5, c6] = [newId(), newId(), newId(), newId(), newId(), newId()];
  await seed([
    memberSince(a.id, days(40)),
    memberSince(b.id, days(40)),
    memberSince(c.id, days(3)),
    staffMember(a.id, staff, days(40)),

    // Alpha's owner: active on 4 days of the week (Nov 8, 7, 6 and 5 in New York), by chat and
    // by their own changes; a third entry on Nov 8 and the AI's entry for them on Nov 4 add no
    // day. Active.
    turn(a.id, a.owner, minutes(60), [1000, 200, 100]),
    turn(a.id, a.owner, minutes(DAY + 60), [3000, 1000, 500]),
    audit(a.id, { kind: 'user', user: a.owner, action: 'booking.updated' }, minutes(2 * DAY + 60)),
    audit(a.id, { kind: 'user', user: a.owner, action: 'booking.created' }, minutes(3 * DAY + 60)),
    audit(
      a.id,
      { kind: 'ai_on_behalf_of', user: a.owner, action: 'booking.updated' },
      minutes(4 * DAY + 60),
    ),
    // A staff member's turn: a chat turn, not an owner's day.
    turn(a.id, staff, minutes(30)),
    // Bravo's owner: 2 days. Not active, but the business is.
    turn(b.id, b.owner, minutes(120), [500, 0, 50]),
    turn(b.id, b.owner, minutes(2 * DAY), [500, 0, 50]),
    // Before the period: nothing counted.
    turn(a.id, a.owner, days(8), [9000, 0, 900]),
    audit(a.id, { kind: 'user', user: a.owner, action: 'booking.updated' }, days(9)),

    // Proposals at Alpha. Approved (card), declined and asked again 5 minutes later (card,
    // corrected), declined and asked again after 15 minutes (card), expired (shown, no card),
    // edited by the owner (card, corrected; superseded, not shown), one settled before the
    // period.
    proposal(a.id, {
      id: p1,
      status: 'approved',
      requestedBy: a.owner,
      decidedBy: a.owner,
      createdAt: minutes(110),
      decidedAt: minutes(100),
    }),
    proposal(a.id, {
      id: p2,
      status: 'rejected',
      requestedBy: a.owner,
      decidedBy: a.owner,
      createdAt: minutes(210),
      decidedAt: minutes(200),
    }),
    proposal(a.id, { status: 'pending', requestedBy: a.owner, createdAt: minutes(195) }),
    proposal(a.id, {
      status: 'rejected',
      requestedBy: a.owner,
      decidedBy: a.owner,
      createdAt: minutes(310),
      decidedAt: minutes(300),
    }),
    proposal(a.id, {
      status: 'expired',
      requestedBy: a.owner,
      createdAt: minutes(285),
      decidedAt: minutes(250),
    }),
    // Another action from the same owner soon after a decline is not that one asked again.
    proposal(a.id, {
      status: 'pending',
      action: 'time.block',
      requestedBy: a.owner,
      createdAt: minutes(298),
    }),
    proposal(a.id, { status: 'superseded', createdAt: minutes(410), decidedAt: minutes(400) }),
    proposal(a.id, { status: 'pending', createdAt: minutes(400) }),
    audit(a.id, { kind: 'user', user: a.owner, action: 'ai_proposal.created' }, minutes(400)),
    audit(a.id, { kind: 'system', user: null, action: 'ai_proposal.created' }, minutes(500)),
    proposal(a.id, {
      status: 'approved',
      requestedBy: a.owner,
      decidedBy: a.owner,
      createdAt: days(8),
      decidedAt: days(8),
    }),
    // A feed card dismissed by itself (a card action), and one closed by p2's decline (not again).
    dismissed(a.id, minutes(50)),
    dismissed(a.id, minutes(200), p2),

    // Executions: p1's, one undone as wrong, one undone as a change of mind (both card actions);
    // one from before the period undone in it (a card action, not executed in the period).
    execution(a.id, { proposal: p1, createdAt: minutes(100) }),
    execution(a.id, {
      createdAt: minutes(80),
      undone: { by: a.owner, at: minutes(70), reason: 'wrong' },
    }),
    execution(a.id, {
      createdAt: minutes(60),
      undone: { by: a.owner, at: minutes(55), reason: 'changed_mind' },
    }),
    execution(a.id, {
      createdAt: days(8),
      undone: { by: a.owner, at: minutes(30), reason: 'wrong' },
    }),

    // Rebooking at Alpha: a service every 28 days, and one without an interval.
    service(a.id, interval, 28),
    service(a.id, noInterval, null),
    // c1 due 2 days ago, booked again 5 days ago: rebooked.
    visit(a.id, { client: c1, service: interval, startsAt: days(30) }),
    visit(a.id, {
      client: c1,
      service: interval,
      startsAt: ahead(3),
      status: 'confirmed',
      createdAt: days(5),
    }),
    // c2 due 3 days ago, nothing since: not rebooked.
    visit(a.id, { client: c2, service: interval, startsAt: days(31) }),
    // c3 due 2.5 days ago, booked again only yesterday: not rebooked (late).
    visit(a.id, { client: c3, service: interval, startsAt: minutes(30.5 * DAY) }),
    visit(a.id, {
      client: c3,
      service: interval,
      startsAt: ahead(5),
      status: 'confirmed',
      createdAt: days(1),
    }),
    // c4 by their own median (gaps 10 and 13 days: 12), due 3 days ago, nothing since.
    visit(a.id, { client: c4, service: noInterval, startsAt: days(38), source: 'import' }),
    visit(a.id, { client: c4, service: noInterval, startsAt: days(28), source: 'import' }),
    visit(a.id, { client: c4, service: noInterval, startsAt: days(15) }),
    // c5 imported: due 4 days ago, came back 6 days ago (imported yesterday): rebooked.
    visit(a.id, { client: c5, service: interval, startsAt: days(32), source: 'import' }),
    visit(a.id, {
      client: c5,
      service: interval,
      startsAt: days(6),
      source: 'import',
      createdAt: days(1),
    }),
    // c6: a no-show is no visit, and one visit without an interval has no due date.
    visit(a.id, { client: c6, service: interval, startsAt: days(30), status: 'no_show' }),
    visit(a.id, { client: c6, service: noInterval, startsAt: days(20) }),
  ]);
});

afterAll(async () => {
  await database.stop();
});

const week = { since: days(7), until: NOW };
const asOperator = <T>(work: Parameters<typeof withOperator<T>>[2]) =>
  withOperator(db, { operatorUserId: operator, action: 'metrics.read', targetId: null }, work);

describe('AI and engagement metrics (S59.4.2, AC-X-50…53)', () => {
  it('counts owners, cards, chat, proposals, undo, tokens and rebooking once each', async () => {
    const metrics = await asOperator((tx) => readAiMetrics(tx, week));
    expect(metrics).toEqual({
      ownerWeeks: 2,
      activeOwnerWeeks: 1,
      activeBusinesses: 2,
      cardActions: 8,
      chatTurns: 5,
      proposalsShown: 4,
      proposalsApproved: 1,
      proposalsEdited: 1,
      proposalsAskedAgain: 1,
      actionsExecuted: 3,
      actionsUndoneWrong: 1,
      inputTokens: 5000,
      cachedInputTokens: 1200,
      outputTokens: 700,
      rebookDue: 5,
      rebooked: 2,
    });
  });

  it('cuts 30 days into 4 whole weeks for each owner who held them', async () => {
    const metrics = await asOperator((tx) => readAiMetrics(tx, { since: days(30), until: NOW }));
    expect(metrics.ownerWeeks).toBe(8);
    expect(metrics.activeOwnerWeeks).toBe(1);
    expect(metrics.chatTurns).toBe(6);
  });

  it('is refused outside a logged operator transaction, and in a business', async () => {
    const tenant = tenants[0];
    if (tenant === undefined) throw new Error('no business');
    const asMember = await withTenant(db, tenant, (tx) =>
      readAiMetrics(tx, week).then(
        () => 'read',
        (error: unknown) => sqlState(error),
      ),
    );
    expect(asMember).toBe('42501');
    const plain = await db.transaction((tx) =>
      readAiMetrics(tx, week).then(
        () => 'read',
        (error: unknown) => sqlState(error),
      ),
    );
    expect(plain).toBe('42501');
  });

  it('leaves the transaction as it found it', async () => {
    const settings = await asOperator(async (tx) => {
      await readAiMetrics(tx, week);
      const { rows } = await tx.execute<{ tenant: string | null; member: string | null }>(
        sql`SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.user_id', true) AS member`,
      );
      return rows[0];
    });
    expect(settings?.tenant ?? '').toBe('');
    expect(settings?.member ?? '').toBe('');
  });
});
