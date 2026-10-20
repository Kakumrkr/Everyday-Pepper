import {
  BookingRequestIdSchema,
  OutboxDedupeKeySchema,
  ServiceIdSchema,
  TenantIdSchema,
  type BookingRequestId,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import {
  createTenant,
  findOutboxMessage,
  insertBookingVerification,
  insertService,
  lockBookingVerification,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { outboxKeyFrom, type Mailer } from './outbox.js';
import { BOOKING_REQUEST_RETENTION_MS, cleanUp, OUTBOX_RETENTION_MS } from './services/cleanup.js';
import { deliverOutboxMessage, queueEmail } from './services/outbox.js';
import { startTestDatabase, type TestDatabase } from './test-support.js';

// The daily clean-up against real Postgres (ADR-0025, S18 L7): every business's expired
// booking requests and finished outbox messages go after their retention; nothing else does.

let database: TestDatabase;
let db: Database;
const businesses: TenantId[] = [];
let keys = 0;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const mailer: Mailer = { send: () => Promise.resolve() };
const NOW = Date.now();
const DAY = 86_400_000;

async function request(tenantId: TenantId, expiresAt: number): Promise<BookingRequestId> {
  return withTenant(db, tenantId, async (tx) => {
    const service = await insertService(tx, {
      name: `Cut ${String(expiresAt)}`,
      category: null,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: null,
      priceToCents: null,
      active: true,
    });
    const row = await insertBookingVerification(tx, {
      serviceId: ServiceIdSchema.parse(service.id),
      staffMemberId: null,
      startsAt: new Date(NOW + DAY),
      name: 'Ana Ruiz',
      email: 'ana@example.test',
      phone: null,
      codeHash: 'b'.repeat(64),
      expiresAt: new Date(expiresAt),
    });
    return BookingRequestIdSchema.parse(row.id);
  });
}

/** Queues an email; delivers it (sent now, by the database's clock) unless `pending`. */
async function message(tenantId: TenantId, pending = false): Promise<OutboxMessageId> {
  keys += 1;
  const clock = new ManualClock(new Date(NOW));
  const messageId = await withTenant(db, tenantId, (tx) =>
    queueEmail(
      tx,
      { to: 'ana@example.test', subject: 'Booked', text: 'See you.' },
      {
        key,
        dedupeKey: OutboxDedupeKeySchema.parse(`cleanup.test:${String(keys)}`),
        now: clock.now(),
      },
    ),
  );
  if (messageId === undefined) throw new Error('not queued');
  if (!pending) await deliverOutboxMessage(db, { messageId, tenantId }, { key, mailer, clock });
  return messageId;
}

/** Which of a business's rows still exist. */
async function left(tenantId: TenantId, rows: Rows) {
  return withTenant(db, tenantId, async (tx) => ({
    requests: await Promise.all(
      rows.requests.map(async (id) => (await lockBookingVerification(tx, id)) !== undefined),
    ),
    messages: await Promise.all(
      rows.messages.map(async (id) => (await findOutboxMessage(tx, id)) !== undefined),
    ),
  }));
}

interface Rows {
  /** Past retention, expired but kept, still open. */
  requests: BookingRequestId[];
  /** Sent now, pending. */
  messages: OutboxMessageId[];
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  for (const slug of ['plum', 'fig', 'quince']) {
    const tenant = await createTenant(db, { name: slug, slug, timeZone: 'UTC' });
    businesses.push(TenantIdSchema.parse(tenant.id));
  }
});

afterAll(async () => {
  await database.stop();
});

describe('cleanUp', () => {
  it("deletes every business's rows past their retention, and nothing else", async () => {
    const seeded = new Map<TenantId, Rows>();
    for (const tenantId of businesses) {
      seeded.set(tenantId, {
        requests: [
          await request(tenantId, NOW - BOOKING_REQUEST_RETENTION_MS - 60_000),
          await request(tenantId, NOW - BOOKING_REQUEST_RETENTION_MS + 60_000),
          await request(tenantId, NOW + 600_000),
        ],
        messages: [await message(tenantId), await message(tenantId, true)],
      });
    }
    const rowsOf = (tenantId: TenantId) => {
      const rows = seeded.get(tenantId);
      if (rows === undefined) throw new Error('not seeded');
      return rows;
    };

    const today = await cleanUp(db, { clock: new ManualClock(new Date(NOW)) });
    expect(today).toEqual({ businesses: 3, bookingRequests: 3, outboxMessages: 0 });
    for (const tenantId of businesses) {
      expect(await left(tenantId, rowsOf(tenantId))).toEqual({
        requests: [false, true, true],
        messages: [true, true],
      });
    }

    // A month later: the sent messages go; the pending ones never do.
    const later = new ManualClock(new Date(NOW + OUTBOX_RETENTION_MS + DAY));
    expect(await cleanUp(db, { clock: later })).toEqual({
      businesses: 3,
      bookingRequests: 6,
      outboxMessages: 3,
    });
    for (const tenantId of businesses) {
      expect(await left(tenantId, rowsOf(tenantId))).toEqual({
        requests: [false, false, false],
        messages: [false, true],
      });
    }
  });
});
