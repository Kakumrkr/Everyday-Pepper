// The operator console's access path (S59.2, ADR-0062, AC-X-19/21/22): who is an operator,
// that every cross-business read holds its access log row in the same transaction, and that
// members never see the team's notes. Part of the isolation evidence with isolation.int.test.ts.
import { randomBytes } from 'node:crypto';
import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { grantOperator, listOperators, revokeOperator } from './operators.js';
import {
  deleteSupportSavedReply,
  findPublicSupportRequest,
  insertSupportSavedReply,
  listSupportSavedReplies,
  sweepPublicSupportRequests,
  updateSupportSavedReply,
  insertPublicSupportRequest,
  insertSupportNote,
  insertSupportThread,
  listOperatorBusinessNames,
  listOperatorPublicRequests,
  listOperatorThreads,
  listSupportNotes,
  setPublicSupportRequestStatus,
} from './repositories/support.js';
import { createTenant } from './repositories/tenants.js';
import { isPlatformOperator, withOperator, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;
let operator: UserId;
let operatorEmail: string;
const threads: { a: string; b: string } = { a: '', b: '' };
let publicId: string;

function reference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `PEP-${[...randomBytes(6)].map((byte) => alphabet[byte % 32] ?? '0').join('')}`;
}

async function seedThread(tx: TenantTx): Promise<string> {
  const userId = await insertUser(db);
  const row = await insertSupportThread(tx, {
    reference: reference(),
    kind: 'problem',
    openedByUserId: userId,
    context: { appVersion: 'test' },
    body: 'The calendar is empty',
    now: new Date(),
  });
  if (row === null) throw new Error('reference taken');
  return row.id;
}

async function asAdmin<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function emailOf(userId: UserId): Promise<string> {
  const [row] = await asAdmin<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
  if (row === undefined) throw new Error('no user');
  return row.email;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Salon A', slug: 'op-a', timeZone: 'America/New_York' })).id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Barber B', slug: 'op-b', timeZone: 'America/Chicago' })).id,
  );
  threads.a = await withTenant(db, tenantA, seedThread);
  threads.b = await withTenant(db, tenantB, seedThread);
  operator = await insertUser(db, 'Olive Operator');
  operatorEmail = await emailOf(operator);
  expect(await grantOperator(database.migrationUrl, { email: operatorEmail, note: 'tests' })).toBe(
    'granted',
  );
  const sent = await insertPublicSupportRequest(db, {
    reference: reference(),
    email: 'locked-out@example.test',
    name: null,
    body: 'I can’t sign in',
    page: null,
    topic: null,
    now: new Date(),
  });
  if (sent === null) throw new Error('reference taken');
  publicId = sent.id;
});

afterAll(async () => {
  await database.stop();
});

describe('the grant (AC-X-19)', () => {
  it('is the script’s alone: the services can’t read or change grants or the access log', async () => {
    for (const statement of [
      'SELECT * FROM platform_operators',
      `INSERT INTO platform_operators (user_id, note) VALUES ('${operator}', 'me')`,
      'SELECT * FROM operator_access_log',
      `INSERT INTO operator_access_log (id, operator_user_id, action, txid) VALUES (gen_random_uuid(), '${operator}', 'inbox.read', txid_current())`,
    ]) {
      const error = await db.execute(sql.raw(statement)).catch((e: unknown) => e);
      expect(sqlState(error), statement).toBe('42501');
    }
  });

  it('is_platform_operator says who holds it', async () => {
    const someone = await insertUser(db);
    expect(await isPlatformOperator(db, operator)).toBe(true);
    expect(await isPlatformOperator(db, someone)).toBe(false);
    expect((await listOperators(database.migrationUrl)).map((g) => g.email)).toContain(
      operatorEmail,
    );
  });

  it('names an account that exists, and a revoked operator is refused at once', async () => {
    expect(
      await grantOperator(database.migrationUrl, { email: 'nobody@example.test', note: 'tests' }),
    ).toBe('no_account');
    const brief = await insertUser(db, 'Brief Operator');
    const email = await emailOf(brief);
    await grantOperator(database.migrationUrl, { email, note: 'for a day' });
    await withOperator(db, { operatorUserId: brief, action: 'inbox.read', targetId: null }, () =>
      Promise.resolve(),
    );
    expect(await revokeOperator(database.migrationUrl, email)).toBe('revoked');
    expect(await revokeOperator(database.migrationUrl, email)).toBe('not_an_operator');
    const error = await withOperator(
      db,
      { operatorUserId: brief, action: 'inbox.read', targetId: null },
      () => Promise.resolve(),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('refuses an account without it, and writes no access row', async () => {
    const owner = await insertUser(db);
    const error = await withOperator(
      db,
      { operatorUserId: owner, action: 'inbox.read', targetId: null },
      () => Promise.resolve(),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
    const rows = await asAdmin('SELECT 1 FROM operator_access_log WHERE operator_user_id = $1', [
      owner,
    ]);
    expect(rows).toEqual([]);
  });
});

describe('an operator transaction (AC-X-20/22)', () => {
  it('reads every business’s threads and the public requests, with its log row', async () => {
    const seen = await withOperator(
      db,
      { operatorUserId: operator, action: 'inbox.read', targetId: null },
      async (tx) => ({
        threads: await listOperatorThreads(tx, { statuses: ['waiting_on_pepper'], limit: 100 }),
        open: await listOperatorPublicRequests(tx, { statuses: ['open'], limit: 100 }),
        names: await listOperatorBusinessNames(tx, [tenantA, tenantB]),
        txid: (await tx.execute<{ txid: string }>(sql`SELECT txid_current()::text AS txid`)).rows[0]
          ?.txid,
      }),
    );
    expect(seen.threads.map((t) => t.id)).toEqual(expect.arrayContaining([threads.a, threads.b]));
    expect(seen.open.map((r) => r.id)).toContain(publicId);
    expect([...seen.names.values()].sort()).toEqual(['Barber B', 'Salon A']);
    const log = await asAdmin<{ action: string; target_id: string | null }>(
      'SELECT action, target_id FROM operator_access_log WHERE txid = $1 AND operator_user_id = $2',
      [seen.txid, operator],
    );
    expect(log).toEqual([{ action: 'inbox.read', target_id: null }]);
  });

  it('reaches support rows only: no clients, bookings, members or audit entries', async () => {
    const counts = await withOperator(
      db,
      { operatorUserId: operator, action: 'inbox.read', targetId: null },
      async (tx) => {
        const out: Record<string, number> = {};
        for (const table of [
          'tenants',
          'clients',
          'bookings',
          'memberships',
          'audit_log',
          'support_reads',
        ]) {
          const { rows } = await tx.execute<{ n: number }>(
            sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
          );
          out[table] = rows[0]?.n ?? -1;
        }
        return out;
      },
    );
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it('can’t change a business’s thread without binding to that business', async () => {
    const changed = await withOperator(
      db,
      { operatorUserId: operator, action: 'thread.status', targetId: threads.a },
      async (tx) =>
        (await tx.execute(sql`UPDATE support_threads SET status = 'solved', solved_at = now()`))
          .rowCount,
    );
    expect(changed).toBe(0);
  });

  it('shows nothing when app.operator_id is set by hand, without the logged access', async () => {
    const seen = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.operator_id', ${operator}, true)`);
      const rows: number[] = [];
      for (const table of [
        'support_threads',
        'support_messages',
        'support_notes',
        'public_support_requests',
      ]) {
        const { rows: found } = await tx.execute<{ n: number }>(
          sql.raw(`SELECT count(*)::int AS n FROM ${table}`),
        );
        rows.push(found[0]?.n ?? -1);
      }
      const names = await listOperatorBusinessNames(tx, [tenantA]);
      return { rows, names: names.size };
    });
    expect(seen).toEqual({ rows: [0, 0, 0, 0], names: 0 });
  });

  it('ends with its transaction on a pooled connection', async () => {
    await withOperator(db, { operatorUserId: operator, action: 'inbox.read', targetId: null }, () =>
      Promise.resolve(),
    );
    const after = await db.transaction(async (tx) => {
      const setting = await tx.execute<{ value: string | null }>(
        sql`SELECT current_setting('app.operator_id', true) AS value`,
      );
      const rows = await tx.execute(sql`SELECT * FROM support_threads`);
      return { value: setting.rows[0]?.value ?? '', rows: rows.rows.length };
    });
    expect(after).toEqual({ value: '', rows: 0 });
  });

  it('can’t be borrowed by a second operator id in the same transaction', async () => {
    const other = await insertUser(db, 'Other Operator');
    await grantOperator(database.migrationUrl, { email: await emailOf(other), note: 'tests' });
    const error = await withOperator(
      db,
      { operatorUserId: operator, action: 'inbox.read', targetId: null },
      (tx) =>
        tx.execute(
          sql`SELECT begin_operator_access(gen_random_uuid(), ${other}::uuid, 'inbox.read', NULL)`,
        ),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });
});

describe('notes (AC-X-21)', () => {
  it('an operator writes and reads them; no member transaction ever sees one', async () => {
    await withOperator(
      db,
      { operatorUserId: operator, action: 'thread.note', targetId: threads.a },
      (tx) =>
        insertSupportNote(tx, {
          threadId: threads.a,
          authorUserId: operator,
          body: 'Their calendar sync is off',
          now: new Date(),
        }),
    );
    const notes = await withOperator(
      db,
      { operatorUserId: operator, action: 'thread.read', targetId: threads.a },
      (tx) => listSupportNotes(tx, { threadId: threads.a }),
    );
    expect(notes.map((n) => [n.body, n.authorName])).toEqual([
      ['Their calendar sync is off', 'Olive Operator'],
    ]);
    const asMember = await withTenant(db, tenantA, (tx) =>
      tx.execute(sql`SELECT * FROM support_notes`),
    );
    expect(asMember.rows).toEqual([]);
    const written = await withTenant(db, tenantA, (tx) =>
      tx.execute(
        sql`INSERT INTO support_notes (id, thread_id, body) VALUES (gen_random_uuid(), ${threads.a}, 'x')`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(written)).toBe('42501');
  });

  it('are append-only for the services, and go with their request', async () => {
    const error = await withOperator(
      db,
      { operatorUserId: operator, action: 'thread.note', targetId: threads.a },
      (tx) => tx.execute(sql`UPDATE support_notes SET body = 'changed'`),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
    const doomed = await withTenant(db, tenantB, seedThread);
    await withOperator(
      db,
      { operatorUserId: operator, action: 'thread.note', targetId: doomed },
      (tx) =>
        insertSupportNote(tx, {
          threadId: doomed,
          authorUserId: operator,
          body: 'n',
          now: new Date(),
        }),
    );
    await withTenant(db, tenantB, (tx) =>
      tx.execute(sql`DELETE FROM support_threads WHERE id = ${doomed}`),
    );
    expect(await asAdmin('SELECT 1 FROM support_notes WHERE thread_id = $1', [doomed])).toEqual([]);
  });
});

describe('public requests (AC-X-17/21)', () => {
  it('the form inserts but can’t read, change or delete one', async () => {
    for (const statement of [
      'SELECT * FROM public_support_requests',
      "UPDATE public_support_requests SET status = 'solved'",
    ]) {
      const result = await db.execute(sql.raw(statement));
      expect(result.rows.length + (result.rowCount ?? 0), statement).toBe(0);
    }
    const error = await db
      .execute(sql`DELETE FROM public_support_requests`)
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('42501');
  });

  it('an operator moves one through every status', async () => {
    for (const status of ['answered', 'solved', 'open'] as const) {
      const after = await withOperator(
        db,
        { operatorUserId: operator, action: 'public.status', targetId: publicId },
        async (tx) => {
          await findPublicSupportRequest(tx, publicId, { lock: true });
          await setPublicSupportRequestStatus(tx, publicId, status, new Date());
          return findPublicSupportRequest(tx, publicId);
        },
      );
      expect(after?.status).toBe(status);
    }
  });
});

describe('saved replies (S59.2.2, AC-X-23)', () => {
  it('an operator adds, edits and deletes them, each access logged', async () => {
    const reply = await withOperator(
      db,
      { operatorUserId: operator, action: 'replies.write', targetId: null },
      (tx) =>
        insertSupportSavedReply(tx, {
          title: 'Calendar sync',
          body: 'Hi {first name}, reconnect Google Calendar in Settings.',
          updatedByUserId: operator,
          now: new Date(),
        }),
    );
    const edited = await withOperator(
      db,
      { operatorUserId: operator, action: 'replies.write', targetId: reply.id },
      (tx) =>
        updateSupportSavedReply(tx, reply.id, {
          title: 'Calendar sync',
          body: 'Hi {first name}, open Settings → Calendar.',
          updatedByUserId: operator,
        }),
    );
    expect(edited?.body).toContain('Settings → Calendar');
    const listed = await withOperator(
      db,
      { operatorUserId: operator, action: 'replies.read', targetId: null },
      listSupportSavedReplies,
    );
    expect(listed.map((row) => row.id)).toContain(reply.id);
    const deleted = await withOperator(
      db,
      { operatorUserId: operator, action: 'replies.write', targetId: reply.id },
      (tx) => deleteSupportSavedReply(tx, reply.id),
    );
    expect(deleted).toBe(true);
    const log = await asAdmin<{ action: string }>(
      `SELECT action FROM operator_access_log WHERE operator_user_id = $1 AND action LIKE 'replies.%'`,
      [operator],
    );
    expect(log.length).toBeGreaterThanOrEqual(4);
  });

  it('are out of reach of the services and of every business without the logged access', async () => {
    await withOperator(
      db,
      { operatorUserId: operator, action: 'replies.write', targetId: null },
      (tx) =>
        insertSupportSavedReply(tx, {
          title: 'Hidden',
          body: 'Only the team sees this.',
          updatedByUserId: operator,
          now: new Date(),
        }),
    );
    const [flags] = await asAdmin<{ forced: boolean }>(
      `SELECT relforcerowsecurity AS forced FROM pg_class WHERE oid = 'public.support_saved_replies'::regclass`,
    );
    expect(flags?.forced).toBe(true);
    for (const run of [
      (statement: string) => db.execute(sql.raw(statement)),
      (statement: string) => withTenant(db, tenantA, (tx) => tx.execute(sql.raw(statement))),
    ]) {
      for (const statement of [
        'SELECT * FROM support_saved_replies',
        "UPDATE support_saved_replies SET title = 'x'",
        'DELETE FROM support_saved_replies',
      ]) {
        const result = await run(statement);
        expect(result.rows.length + (result.rowCount ?? 0), statement).toBe(0);
      }
      const error = await run(
        `INSERT INTO support_saved_replies (id, title, body) VALUES (gen_random_uuid(), 't', 'b')`,
      ).catch((e: unknown) => e);
      expect(sqlState(error)).toBe('42501');
    }
  });
});

describe('the public sweep (S59.2.2, AC-X-24/25)', () => {
  async function publicRequest(at: Date): Promise<string> {
    const sent = await insertPublicSupportRequest(db, {
      reference: reference(),
      email: 'sweep@example.test',
      name: null,
      body: 'Locked out again',
      page: null,
      topic: null,
      now: at,
    });
    if (sent === null) throw new Error('reference taken');
    return sent.id;
  }
  const sweep = (now: Date) =>
    db.transaction((tx) =>
      sweepPublicSupportRequests(tx, {
        now,
        overdueBefore: new Date(now.getTime() - 4 * 3_600_000),
        quietBefore: new Date(now.getTime() - 7 * 86_400_000),
      }),
    );

  it('reminds an open request once a wait, closes a quiet answered one, and nothing else', async () => {
    const now = new Date('2031-03-10T15:00:00Z');
    const late = await publicRequest(new Date('2031-03-10T10:00:00Z'));
    const fresh = await publicRequest(new Date('2031-03-10T13:00:00Z'));
    const quiet = await publicRequest(new Date('2031-03-01T10:00:00Z'));
    await withOperator(
      db,
      { operatorUserId: operator, action: 'public.status', targetId: quiet },
      (tx) =>
        setPublicSupportRequestStatus(tx, quiet, 'answered', new Date('2031-03-02T10:00:00Z')),
    );
    const first = await sweep(now);
    const mine = (rows: typeof first) =>
      rows.filter((row) => [late, fresh, quiet].includes(row.id)).map((row) => [row.action, row.id]);
    expect(mine(first).sort()).toEqual(
      [
        ['closed', quiet],
        ['overdue', late],
      ].sort(),
    );
    // Twice side by side, then again: nothing more.
    const again = await Promise.all([sweep(now), sweep(now)]);
    expect(again.flatMap(mine)).toEqual([]);
    const status = await withOperator(
      db,
      { operatorUserId: operator, action: 'public.read', targetId: quiet },
      (tx) => findPublicSupportRequest(tx, quiet),
    );
    expect(status?.status).toBe('solved');
    // Reopened later: a new wait reminds again.
    await withOperator(
      db,
      { operatorUserId: operator, action: 'public.status', targetId: late },
      (tx) => setPublicSupportRequestStatus(tx, late, 'open', new Date('2031-03-11T08:00:00Z')),
    );
    const later = await sweep(new Date('2031-03-11T12:30:00Z'));
    expect(mine(later)).toContainEqual(['overdue', late]);
  });

  it('refuses a sweep that looks ahead', async () => {
    const now = new Date();
    const error = await db
      .transaction((tx) =>
        sweepPublicSupportRequests(tx, {
          now,
          overdueBefore: new Date(now.getTime() + 1000),
          quietBefore: now,
        }),
      )
      .catch((e: unknown) => e);
    expect(sqlState(error)).toBe('22023');
  });
});
