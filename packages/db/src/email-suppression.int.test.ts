// Bounces and complaints (S59.3.2, ADR-0063 Part 2, AC-X-42/43): delivery problems are platform
// rows written in the inbound context, read and resumed only by a logged operator, kept by the
// services (no delete), and asked at delivery only through `support_mail_stopped`.
// Part of the isolation evidence with isolation.int.test.ts.
import { TenantIdSchema, type UserId } from '@pepper/contracts';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { grantOperator } from './operators.js';
import {
  countEmailSuppressions,
  findSupportMailStops,
  insertEmailSuppression,
  isSupportMailStopped,
  resumeSupportMail,
} from './repositories/email-suppression.js';
import { createTenant } from './repositories/tenants.js';
import { emailSuppressions, users } from './schema.js';
import { withInboundMail, withOperator, withTenant } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

let database: TestDatabase;
let db: Database;
let operator: UserId;
const T0 = new Date('2026-11-08T10:00:00Z');

let counter = 0;
function problem(address: string, kind: 'hard_bounce' | 'soft_bounce' | 'complaint') {
  counter += 1;
  return {
    provider: 'resend' as const,
    eventId: `evt_${String(counter)}`,
    address,
    kind,
    occurredAt: new Date(T0.getTime() + counter * 1000),
  };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  operator = await insertUser(db, 'Opal Operator');
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, operator));
  expect(await grantOperator(database.migrationUrl, { email: row?.email ?? '', note: 'tests' })).toBe(
    'granted',
  );
});

afterAll(async () => {
  await database.stop();
});

const asOperator = (action: 'mail.resume' | 'inbound.counts' | 'thread.read') => ({
  operatorUserId: operator,
  action,
  targetId: null,
});

describe('email suppressions (S59.3.2, ADR-0063 Part 2)', () => {
  it('records each event once and stops mail for a hard bounce or a complaint, not a soft bounce', async () => {
    const hard = problem('Bounced@Example.test', 'hard_bounce');
    expect(await withInboundMail(db, (tx) => insertEmailSuppression(tx, hard))).toBe(true);
    expect(await withInboundMail(db, (tx) => insertEmailSuppression(tx, hard))).toBe(false);
    expect(await isSupportMailStopped(db, 'bounced@example.test')).toBe(true);
    expect(await isSupportMailStopped(db, 'BOUNCED@example.test')).toBe(true);

    await withInboundMail(db, (tx) =>
      insertEmailSuppression(tx, problem('soft@example.test', 'soft_bounce')),
    );
    expect(await isSupportMailStopped(db, 'soft@example.test')).toBe(false);
    await withInboundMail(db, (tx) =>
      insertEmailSuppression(tx, problem('angry@example.test', 'complaint')),
    );
    expect(await isSupportMailStopped(db, 'angry@example.test')).toBe(true);
    expect(await isSupportMailStopped(db, 'fine@example.test')).toBe(false);
    expect(await isSupportMailStopped(db, 'not an address')).toBe(false);
  });

  it('shows stops to a logged operator, who can resume an address', async () => {
    const stops = await withOperator(db, asOperator('thread.read'), (tx) =>
      findSupportMailStops(tx, ['bounced@example.test', 'soft@example.test', 'Angry@example.test']),
    );
    expect([...stops.keys()].sort()).toEqual(['angry@example.test', 'bounced@example.test']);
    expect(stops.get('angry@example.test')?.kind).toBe('complaint');

    const now = new Date();
    expect(
      await withOperator(db, asOperator('mail.resume'), (tx) =>
        resumeSupportMail(tx, { address: 'bounced@example.test', operatorUserId: operator, now }),
      ),
    ).toBe(true);
    expect(await isSupportMailStopped(db, 'bounced@example.test')).toBe(false);
    expect(
      await withOperator(db, asOperator('mail.resume'), (tx) =>
        resumeSupportMail(tx, { address: 'bounced@example.test', operatorUserId: operator, now }),
      ),
    ).toBe(false);
    // A new bounce stops it again.
    await withInboundMail(db, (tx) =>
      insertEmailSuppression(tx, problem('bounced@example.test', 'hard_bounce')),
    );
    expect(await isSupportMailStopped(db, 'bounced@example.test')).toBe(true);
  });

  it('counts delivery problems by kind', async () => {
    const counts = await withOperator(db, asOperator('inbound.counts'), (tx) =>
      countEmailSuppressions(tx, new Date(0)),
    );
    expect(counts).toEqual({ hard_bounce: 2, soft_bounce: 1, complaint: 1 });
  });

  it('is unreachable in a business transaction or without a context, and never deleted', async () => {
    const tenant = TenantIdSchema.parse(
      (await createTenant(db, { name: 'S', slug: 'suppress-a', timeZone: 'UTC' })).id,
    );
    expect(await withTenant(db, tenant, (tx) => tx.select().from(emailSuppressions))).toEqual([]);
    expect(await db.select().from(emailSuppressions)).toEqual([]);
    const write = await withTenant(db, tenant, (tx) =>
      tx.insert(emailSuppressions).values(problem('x@example.test', 'complaint')),
    ).catch((error: unknown) => error);
    expect(sqlState(write)).toBe('42501');
    const removed = await withInboundMail(db, (tx) =>
      tx.execute(sql`DELETE FROM email_suppressions`),
    ).catch((error: unknown) => error);
    expect(sqlState(removed)).toBe('42501');
    const soft = await withOperator(db, asOperator('mail.resume'), (tx) =>
      tx.execute(
        sql`UPDATE email_suppressions SET resumed_at = now(), resumed_by = ${operator} WHERE kind = 'soft_bounce'`,
      ),
    ).catch((error: unknown) => error);
    expect(sqlState(soft)).toBe('23514');
  });
});
