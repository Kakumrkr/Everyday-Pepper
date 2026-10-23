import {
  BookingRequestIdSchema,
  EMBEDDING_DIMENSIONS,
  MemoryFactIdSchema,
  OutboxDedupeKeySchema,
  ServiceIdSchema,
  TenantIdSchema,
  type BookingRequestId,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import {
  addMembership,
  createTenant,
  findOutboxMessage,
  insertBookingVerification,
  insertMemoryEpisode,
  insertMemoryFact,
  insertProposal,
  insertService,
  listAuditEntries,
  listMemoryEpisodes,
  lockBookingVerification,
  lockMemoryFact,
  newId,
  updateMemoryFact,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from './clock.js';
import { outboxKeyFrom, type Mailer } from './outbox.js';
import { BOOKING_REQUEST_RETENTION_MS, cleanUp, OUTBOX_RETENTION_MS } from './services/cleanup.js';
import { deliverOutboxMessage, queueEmail } from './services/outbox.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

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
    expect(today).toEqual({
      businesses: 3,
      bookingRequests: 3,
      outboxMessages: 0,
      expiredProposals: 0,
      conversations: 0,
      memoryPreviousValues: 0,
      memoryEpisodes: 0,
      memoryProposedFacts: 0,
    });
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
      expiredProposals: 0,
      conversations: 0,
      memoryPreviousValues: 0,
      memoryEpisodes: 0,
      memoryProposedFacts: 0,
    });
    for (const tenantId of businesses) {
      expect(await left(tenantId, rowsOf(tenantId))).toEqual({
        requests: [false, false, false],
        messages: [false, true],
      });
    }
  });

  it('marks the AI proposals whose time ran out as expired, with an audit entry (ADR-0028)', async () => {
    const proposals: string[] = [];
    for (const tenantId of businesses) {
      const requestedBy = await insertUser(db, 'Ana');
      proposals.push(
        ...(await withTenant(db, tenantId, async (tx) => {
          const ids: string[] = [];
          for (const hours of [1, 48]) {
            const row = await insertProposal(tx, {
              action: 'booking.cancel',
              tool: 'cancel_booking',
              targetKey: `booking:${newId()}`,
              idempotencyKey: `cleanup:${newId()}`,
              payload: { bookingId: newId() },
              preview: {},
              fingerprint: 'a'.repeat(64),
              explanation: {
                requestMessageId: null,
                steps: [],
                facts: [],
                alternatives: [],
                untrustedContext: false,
                decision: { outcome: 'propose', reason: 'setting' },
              },
              requestedBy,
              recordOwner: null,
              expiresAt: new Date(Date.now() + hours * 3_600_000),
            });
            if (row === undefined) throw new Error('not stored');
            ids.push(row.id);
          }
          return ids;
        })),
      );
    }
    const result = await cleanUp(db, {
      clock: new ManualClock(new Date(Date.now() + 2 * 3_600_000)),
    });
    expect(result.expiredProposals).toBe(3);
    for (const tenantId of businesses) {
      const [entry] = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
      expect(entry).toMatchObject({
        action: 'ai_proposal.decided',
        actor: { kind: 'system', userId: null },
        after: { status: 'expired' },
      });
    }
    // Run again: nothing more to expire.
    expect(
      (await cleanUp(db, { clock: new ManualClock(new Date(Date.now() + 2 * 3_600_000)) }))
        .expiredProposals,
    ).toBe(0);
    expect(proposals).toHaveLength(6);
  });

  it('clears replaced memory values after their Undo window and deletes year-old episodes (ADR-0034)', async () => {
    const [tenantId] = businesses;
    if (tenantId === undefined) throw new Error('no business');
    const member = await insertUser(db, 'Ana');
    const ids = await withTenant(db, tenantId, async (tx) => {
      await addMembership(tx, { userId: member, role: 'owner' });
      const fact = await insertMemoryFact(tx, {
        subject: { type: 'business' },
        key: 'opening',
        value: 'Open at 10',
        sensitive: false,
        status: 'active',
        source: 'screen',
        sourceTurnId: null,
        createdBy: null,
      });
      await updateMemoryFact(tx, MemoryFactIdSchema.parse(fact.id), {
        value: 'Open at 9',
        previousValue: 'Open at 10',
        previousUntil: new Date(Date.now() + DAY),
      });
      const episode = await insertMemoryEpisode(tx, {
        userId: member,
        conversationId: null,
        summary: 'Opening hours changed.',
        clientIds: [],
        embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)),
        embeddingModel: 'text-embedding-3-small',
      });
      return { fact: MemoryFactIdSchema.parse(fact.id), episode: episode.id };
    });
    const tomorrow = await cleanUp(db, { clock: new ManualClock(new Date(Date.now() + 2 * DAY)) });
    expect(tomorrow).toMatchObject({ memoryPreviousValues: 1, memoryEpisodes: 0 });
    const fact = await withTenant(db, tenantId, (tx) => lockMemoryFact(tx, ids.fact));
    expect(fact).toMatchObject({ value: 'Open at 9', previousValue: null, previousUntil: null });
    const nextYear = await cleanUp(db, {
      clock: new ManualClock(new Date(Date.now() + 366 * DAY)),
    });
    expect(nextYear.memoryEpisodes).toBe(1);
    expect(await withTenant(db, tenantId, (tx) => listMemoryEpisodes(tx, 10))).toEqual([]);
  });
});
