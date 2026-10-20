import {
  OUTBOX_MAX_ATTEMPTS,
  OutboxDedupeKeySchema,
  TenantIdSchema,
  UsagePeriodSchema,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import {
  claimOutboxMessage,
  createTenant,
  findOutboxMessage,
  listDueOutboxMessages,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { deliverOutboxMessage, OUTBOX_LEASE_MS, queueEmail } from './services/outbox.js';
import { usageFor } from './services/usage.js';
import { startTestDatabase, type TestDatabase } from './test-support.js';

// AC-W4-2 at the service level: each queued email reaches the mail server exactly once,
// whatever retries, duplicate deliveries and concurrent workers do, and only if the change
// that queued it committed. The worker's BullMQ wiring and a real SMTP server are proven in
// apps/worker.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let keys = 0;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const clock = new ManualClock('2026-10-20T15:00:00Z');

/** Records what it sends; fails while `failures` has entries (the next one is thrown). */
class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failures: Error[] = [];

  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    const failure = this.failures.shift();
    if (failure !== undefined) throw failure;
    this.sent.push(message);
  }
}

function email(to = 'ana@example.test') {
  return { to, subject: 'You are booked at Plum Salon', text: 'Hi Ana,\n\nSee you soon.' };
}

async function queue(to?: string): Promise<OutboxMessageId> {
  keys += 1;
  const id = await withTenant(db, tenant, (tx) =>
    queueEmail(tx, email(to), {
      key,
      dedupeKey: OutboxDedupeKeySchema.parse(`test.email:${String(keys)}`),
      now: clock.now(),
    }),
  );
  if (id === undefined) throw new Error('not queued');
  return id;
}

const deliver = (messageId: OutboxMessageId, mailer: Mailer) =>
  deliverOutboxMessage(db, { messageId, tenantId: tenant }, { key, mailer, clock });

const stored = (id: OutboxMessageId) => withTenant(db, tenant, (tx) => findOutboxMessage(tx, id));

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const created = await createTenant(db, {
    name: 'Plum Salon',
    slug: 'plum-salon',
    timeZone: 'America/Chicago',
  });
  tenant = TenantIdSchema.parse(created.id);
});

afterAll(async () => {
  await database.stop();
});

describe('queueing', () => {
  it('stores the email sealed, never in clear', async () => {
    const id = await queue('sealed@example.test');
    const row = await stored(id);
    expect(row?.payload?.includes(Buffer.from('sealed@example.test'))).toBe(false);
    expect(row?.payload?.includes(Buffer.from('Plum Salon'))).toBe(false);
  });

  it('queues nothing when the change rolls back', async () => {
    const before = await listDueOutboxMessages(db, clock.now(), 1000);
    await withTenant(db, tenant, async (tx) => {
      await queueEmail(tx, email(), {
        key,
        dedupeKey: OutboxDedupeKeySchema.parse('test.rolled-back'),
        now: clock.now(),
      });
      throw new Error('the booking failed');
    }).catch(() => undefined);
    expect(await listDueOutboxMessages(db, clock.now(), 1000)).toEqual(before);
  });

  it('queues one message per dedupe key', async () => {
    const queueOnce = () =>
      withTenant(db, tenant, (tx) =>
        queueEmail(tx, email(), {
          key,
          dedupeKey: OutboxDedupeKeySchema.parse('booking.confirmed:same'),
          now: clock.now(),
        }),
      );
    expect(await queueOnce()).toBeDefined();
    expect(await queueOnce()).toBeUndefined();
  });

  it('rejects an email that is not valid', async () => {
    await expect(queue('not an address')).rejects.toThrow();
  });
});

describe('delivery (AC-W4-2: exactly one email per recipient even if the job retries)', () => {
  it('sends once, with the message id, and meters it', async () => {
    const period = UsagePeriodSchema.parse('2026-10');
    const before = (await usageFor(db, tenant, period)).emails_sent;
    const mailer = new FakeMailer();
    const id = await queue();
    expect(await deliver(id, mailer)).toBe('sent');
    expect(await deliver(id, mailer)).toBe('skipped');
    expect(mailer.sent).toEqual([{ ...email(), id }]);
    expect(await stored(id)).toMatchObject({ status: 'sent', payload: null, attempts: 1 });
    expect((await usageFor(db, tenant, period)).emails_sent).toBe(before + 1);
  });

  it('sends once when several workers get the same message at once', async () => {
    const mailer = new FakeMailer();
    const id = await queue();
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver(id, mailer)));
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('retries a failed send later, and sends once in total', async () => {
    const mailer = new FakeMailer();
    mailer.failures = [Object.assign(new Error('connect refused'), { code: 'ECONNECTION' })];
    const id = await queue();
    expect(await deliver(id, mailer)).toBe('retry');
    expect(await stored(id)).toMatchObject({ status: 'pending', lastError: 'ECONNECTION' });
    // Not due yet: a duplicate job does nothing.
    expect(await deliver(id, mailer)).toBe('skipped');
    clock.advanceBy(30_000);
    expect(await deliver(id, mailer)).toBe('sent');
    expect(await deliver(id, mailer)).toBe('skipped');
    expect(mailer.sent).toHaveLength(1);
    expect(await stored(id)).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
  });

  it('delivers once after a worker died while holding the message', async () => {
    const mailer = new FakeMailer();
    const id = await queue();
    // A worker claimed it and died before sending.
    const now = clock.now();
    await withTenant(db, tenant, (tx) =>
      claimOutboxMessage(tx, id, now, new Date(now.getTime() + OUTBOX_LEASE_MS)),
    );
    expect(await deliver(id, mailer)).toBe('skipped');
    clock.advanceBy(OUTBOX_LEASE_MS);
    const due = await listDueOutboxMessages(db, clock.now(), 1000);
    expect(due.map((d) => d.messageId)).toContain(id);
    expect(await deliver(id, mailer)).toBe('sent');
    expect(mailer.sent).toHaveLength(1);
  });

  it('gives up at once when the mail server refuses the address', async () => {
    const mailer = new FakeMailer();
    mailer.failures = [
      Object.assign(new Error('550 no such user'), { code: 'EENVELOPE', responseCode: 550 }),
    ];
    const id = await queue();
    expect(await deliver(id, mailer)).toBe('dead');
    clock.advanceBy(86_400_000);
    expect(await deliver(id, mailer)).toBe('skipped');
    expect(mailer.sent).toEqual([]);
    expect(await stored(id)).toMatchObject({ status: 'dead', payload: null, attempts: 1 });
  });

  it('gives up after the last attempt and never sends', async () => {
    const mailer = new FakeMailer();
    mailer.failures = Array.from({ length: OUTBOX_MAX_ATTEMPTS }, () => new Error('down'));
    const id = await queue();
    const results = [];
    for (let attempt = 0; attempt < OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      results.push(await deliver(id, mailer));
      clock.advanceBy(3_600_000);
    }
    expect(results.at(-1)).toBe('dead');
    expect(results.slice(0, -1).every((r) => r === 'retry')).toBe(true);
    expect(await deliver(id, mailer)).toBe('skipped');
    expect(mailer.sent).toEqual([]);
    expect(await stored(id)).toMatchObject({ status: 'dead', attempts: OUTBOX_MAX_ATTEMPTS });
    const due = await listDueOutboxMessages(db, clock.now(), 1000);
    expect(due.map((d) => d.messageId)).not.toContain(id);
  });

  it('gives up on content sealed with another key', async () => {
    const mailer = new FakeMailer();
    const id = await queue();
    const result = await deliverOutboxMessage(
      db,
      { messageId: id, tenantId: tenant },
      { key: outboxKeyFrom('another-outbox-secret-of-32-characters'), mailer, clock },
    );
    expect(result).toBe('dead');
    expect(await stored(id)).toMatchObject({ status: 'dead', lastError: 'OutboxContentError' });
  });

  it("skips a message of another business (the job's tenant is checked by RLS)", async () => {
    const mailer = new FakeMailer();
    const id = await queue();
    const other = await createTenant(db, { name: 'Fig', slug: 'fig', timeZone: 'UTC' });
    const result = await deliverOutboxMessage(
      db,
      { messageId: id, tenantId: TenantIdSchema.parse(other.id) },
      { key, mailer, clock },
    );
    expect(result).toBe('skipped');
    expect(mailer.sent).toEqual([]);
  });
});
