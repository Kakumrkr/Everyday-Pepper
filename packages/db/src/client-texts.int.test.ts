// Client texts kept (S80, ADR-0072) against real Postgres: the lookup that routes a client's
// text to one business (`sms_reply_target`, ids only), the kept texts and replies, and their
// clean-up. Part of the isolation evidence with isolation.int.test.ts.
import {
  BookingIdSchema,
  ClientIdSchema,
  OutboxMessageIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type BookingId,
  type TenantId,
} from '@pepper/contracts';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBookingText } from './repositories/booking-texts.js';
import { insertBooking, insertWaitlistEntry } from './repositories/bookings.js';
import {
  countInboundClientTexts,
  findClientUpcomingVisits,
  deleteClientTextReply,
  deleteOldClientTexts,
  insertClientTextReply,
  insertInboundClientText,
  listClientTexts,
  markWaitlistEntryTexted,
  markWaitlistOfferTexted,
  smsReplyTarget,
} from './repositories/client-texts.js';
import { deleteClientRow, insertClient, mergeClientRows } from './repositories/clients.js';
import { scheduleCurrentTenantDeletion } from './repositories/deletion.js';
import { writeClientTextCard } from './repositories/feed.js';
import { insertOutboxMessage } from './repositories/outbox.js';
import { insertSmsConsent, revokeSmsConsent } from './repositories/sms.js';
import { createTenant } from './repositories/tenants.js';
import { insertWaitlistMatch, insertWaitlistOffer } from './repositories/waitlist.js';
import { addMembership } from './repositories/memberships.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

const SHOWN = 'Text me appointment confirmations and reminders from A at this number.';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'A', slug: 'client-texts-a', timeZone: 'America/New_York' }))
      .id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'B', slug: 'client-texts-b', timeZone: 'America/Chicago' })).id,
  );
});

afterAll(async () => {
  await database.stop();
});

/** A number of its own for each test, so consents and lookups never meet. */
function phone(): string {
  return `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
}

async function seedClient(tx: TenantTx): Promise<string> {
  return (
    await insertClient(tx, {
      name: 'Maria Lopez',
      email: `maria-${newId()}@example.test`,
      phone: null,
      source: 'team',
    })
  ).id;
}

async function seedBooking(tx: TenantTx, clientId: string, startsAt: Date): Promise<BookingId> {
  const service = await insertService(tx, {
    name: `Haircut ${newId()}`,
    category: null,
    durationMinutes: 45,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    active: true,
  });
  const staff = await insertStaffMember(tx, {
    displayName: 'Jess',
    color: '#2a7230',
    active: true,
    membershipId: null,
  });
  const row = await insertBooking(tx, {
    clientId: ClientIdSchema.parse(clientId),
    serviceId: ServiceIdSchema.parse(service.id),
    staffMemberId: StaffMemberIdSchema.parse(staff.id),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 45 * 60_000),
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    priceFromCents: null,
    priceToCents: null,
    source: 'team',
    overridden: false,
    idempotencyKey: null,
    createdBy: null,
  });
  return BookingIdSchema.parse(row.id);
}

/** Queues a text (an outbox row) about a booking and records what it was about. */
async function seedText(
  tx: TenantTx,
  input: {
    clientId: string;
    bookingId: BookingId;
    kind: 'opt_in' | 'day_before' | 'same_day';
    startsAt: Date;
    at: Date;
  },
): Promise<string> {
  const id = OutboxMessageIdSchema.parse(newId());
  await insertOutboxMessage(tx, {
    id,
    type: 'sms',
    dedupeKey: `test.text:${id}`,
    payload: randomBytes(16),
    availableAt: input.at,
  });
  await insertBookingText(tx, { id, ...input, createdAt: input.at });
  return id;
}

/** A client of `tenantId` with a consent for `number` (given 30 days before `at`). */
async function consentedClient(tenantId: TenantId, number: string, at: Date): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    const clientId = await seedClient(tx);
    await insertSmsConsent(tx, {
      phone: number,
      source: 'booking_page',
      clientId,
      wordingVersion: 'sms-consent-v1',
      shownText: SHOWN,
      givenAt: new Date(at.getTime() - 30 * DAY),
    });
    return clientId;
  });
}

/** A booking text to the client sent at `at`. */
async function texted(tenantId: TenantId, clientId: string, at: Date): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const startsAt = new Date(at.getTime() + 2 * DAY);
    const bookingId = await seedBooking(tx, clientId, startsAt);
    await seedText(tx, { clientId, bookingId, kind: 'day_before', startsAt, at });
  });
}

function inbound(clientId: string, at: Date, body = 'Can I come at 3 instead?') {
  return {
    clientId,
    body,
    provider: 'sandbox',
    eventId: `SM${randomBytes(8).toString('hex')}`,
    receivedAt: at,
  };
}

describe('whose a text is (sms_reply_target, AC-X-229, AC-X-230)', () => {
  it('finds the one business and client that texted the number in the last 7 days, ids only', async () => {
    const number = phone();
    const now = new Date();
    const clientId = await consentedClient(tenantA, number, now);
    await texted(tenantA, clientId, new Date(now.getTime() - 6 * DAY));
    expect(await smsReplyTarget(db, number, now)).toEqual({
      tenantId: tenantA,
      clientId: ClientIdSchema.parse(clientId),
    });
    const { rows } = await db.execute(
      sql`SELECT * FROM sms_reply_target(${number}, ${now.toISOString()}::timestamptz)`,
    );
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['client_id', 'tenant_id']);
  });

  it('answers nothing after 7 days, before the text, or without a consent in force', async () => {
    const now = new Date();
    const stale = phone();
    const a = await consentedClient(tenantA, stale, now);
    await texted(tenantA, a, new Date(now.getTime() - 7 * DAY - 60_000));
    expect(await smsReplyTarget(db, stale, now)).toBeUndefined();

    const future = phone();
    const b = await consentedClient(tenantA, future, now);
    await texted(tenantA, b, new Date(now.getTime() + HOUR));
    expect(await smsReplyTarget(db, future, now)).toBeUndefined();

    const revoked = phone();
    const c = await consentedClient(tenantA, revoked, now);
    await texted(tenantA, c, new Date(now.getTime() - HOUR));
    await withTenant(db, tenantA, (tx) => revokeSmsConsent(tx, revoked, 'booking_page', now));
    expect(await smsReplyTarget(db, revoked, now)).toBeUndefined();

    expect(await smsReplyTarget(db, phone(), now)).toBeUndefined();
    expect(await smsReplyTarget(db, '+4420', now)).toBeUndefined();
  });

  it('answers nothing when two businesses texted the number', async () => {
    const number = phone();
    const now = new Date();
    await texted(
      tenantA,
      await consentedClient(tenantA, number, now),
      new Date(now.getTime() - DAY),
    );
    await texted(
      tenantB,
      await consentedClient(tenantB, number, now),
      new Date(now.getTime() - 2 * DAY),
    );
    expect(await smsReplyTarget(db, number, now)).toBeUndefined();
  });

  it('answers nothing when two clients of one business share the number', async () => {
    const number = phone();
    const now = new Date();
    const first = await consentedClient(tenantA, number, now);
    await texted(tenantA, first, new Date(now.getTime() - DAY));
    // A second client said yes on the same number under another source (S79's waitlist box).
    const second = await withTenant(db, tenantA, async (tx) => {
      const id = await seedClient(tx);
      await insertSmsConsent(tx, {
        phone: number,
        source: 'staff_recorded',
        clientId: id,
        wordingVersion: 'sms-consent-v3',
        shownText: "Text me when a time I'm waiting for opens up at A, at this number.",
        givenAt: new Date(now.getTime() - DAY),
      });
      return id;
    });
    await texted(tenantA, second, new Date(now.getTime() - HOUR));
    expect(await smsReplyTarget(db, number, now)).toBeUndefined();
  });

  it('counts a waitlist offer by text and a reply as texts to the number', async () => {
    const now = new Date();
    const offered = phone();
    const clientId = await consentedClient(tenantB, offered, now);
    await withTenant(db, tenantB, async (tx) => {
      const startsAt = new Date(now.getTime() + DAY);
      const bookingId = await seedBooking(tx, await seedClient(tx), startsAt);
      const [booking] = await tx
        .execute<{ staff: string; service: string }>(
          sql`SELECT staff_member_id::text AS staff, service_id::text AS service FROM bookings WHERE id = ${bookingId}`,
        )
        .then((r) => r.rows);
      const staffMemberId = StaffMemberIdSchema.parse(booking?.staff);
      const matchId = await insertWaitlistMatch(tx, {
        bookingId,
        staffMemberId,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
      });
      const offer = await insertWaitlistOffer(tx, {
        matchId,
        entryId: null,
        clientId: ClientIdSchema.parse(clientId),
        serviceId: ServiceIdSchema.parse(booking?.service),
        staffMemberId,
        startsAt,
        rank: 1,
        tokenHash: randomBytes(32).toString('hex'),
        expiresAt: new Date(now.getTime() + 2 * HOUR),
        offeredAt: new Date(now.getTime() - HOUR),
      });
      expect(await smsReplyTarget(tx, offered, now)).toBeUndefined();
      await markWaitlistOfferTexted(tx, offer.id, new Date(now.getTime() - HOUR));
    });
    expect((await smsReplyTarget(db, offered, now))?.clientId).toBe(clientId);

    // A waitlist opt-in text counts the same (the client who joined and texts back).
    const joined = phone();
    const waiting = await consentedClient(tenantA, joined, now);
    await withTenant(db, tenantA, async (tx) => {
      const entry = await insertWaitlistEntry(tx, {
        clientId: ClientIdSchema.parse(waiting),
        serviceId: ServiceIdSchema.parse(
          (
            await insertService(tx, {
              name: `Cut ${newId()}`,
              category: null,
              durationMinutes: 30,
              bufferBeforeMinutes: 0,
              bufferAfterMinutes: 0,
              priceFromCents: null,
              priceToCents: null,
              active: true,
            })
          ).id,
        ),
        staffMemberId: null,
        windows: [{ date: '2026-12-01', start: '09:00', end: '12:00' }],
        expiresAt: new Date(now.getTime() + 7 * DAY),
        createdBy: null,
      });
      expect(await smsReplyTarget(tx, joined, now)).toBeUndefined();
      await markWaitlistEntryTexted(tx, entry.id, new Date(now.getTime() - HOUR));
    });
    expect((await smsReplyTarget(db, joined, now))?.clientId).toBe(waiting);

    const replied = phone();
    const other = await consentedClient(tenantA, replied, now);
    const reply = await withTenant(db, tenantA, async (tx) => {
      const messageId = OutboxMessageIdSchema.parse(newId());
      await insertOutboxMessage(tx, {
        id: messageId,
        type: 'sms',
        dedupeKey: `test.reply:${messageId}`,
        payload: randomBytes(16),
        availableAt: now,
      });
      return insertClientTextReply(tx, {
        clientId: other,
        body: 'See you at 3',
        outboxMessageId: messageId,
        userId: newId(),
        feedItemId: null,
        at: new Date(now.getTime() - HOUR),
      });
    });
    expect((await smsReplyTarget(db, replied, now))?.tenantId).toBe(tenantA);
    // Taken back before it went: it no longer counts.
    expect(await withTenant(db, tenantA, (tx) => deleteClientTextReply(tx, reply.id))).toBe(true);
    expect(await smsReplyTarget(db, replied, now)).toBeUndefined();
  });

  it('leaves out a business being deleted', async () => {
    const number = phone();
    const now = new Date();
    const gone = TenantIdSchema.parse(
      (await createTenant(db, { name: 'Gone', slug: `gone-${newId()}`, timeZone: 'UTC' })).id,
    );
    await texted(gone, await consentedClient(gone, number, now), new Date(now.getTime() - HOUR));
    expect((await smsReplyTarget(db, number, now))?.tenantId).toBe(gone);
    await withTenant(db, gone, (tx) => scheduleCurrentTenantDeletion(tx, now));
    expect(await smsReplyTarget(db, number, now)).toBeUndefined();
  });
});

describe('kept texts (AC-X-229, AC-X-234, AC-X-235)', () => {
  it('keeps a text once per provider id and lists them newest first', async () => {
    const now = new Date();
    const clientId = await withTenant(db, tenantA, seedClient);
    const first = inbound(clientId, new Date(now.getTime() - HOUR), 'Running 10 late');
    await withTenant(db, tenantA, async (tx) => {
      expect(await insertInboundClientText(tx, first)).toBeDefined();
      // A replay of the same text.
      expect(await insertInboundClientText(tx, first)).toBeUndefined();
      await insertInboundClientText(tx, inbound(clientId, now));
      const texts = await listClientTexts(tx, clientId);
      expect(texts.map((t) => t.body)).toEqual(['Can I come at 3 instead?', 'Running 10 late']);
      expect(
        await countInboundClientTexts(tx, clientId, {
          from: new Date(now.getTime() - DAY),
          to: new Date(now.getTime() + 1),
        }),
      ).toBe(2);
    });
    // Another business never reads them.
    expect(await withTenant(db, tenantB, (tx) => listClientTexts(tx, clientId))).toEqual([]);
  });

  it('refuses a text that is empty or too long, and a reply without its message', async () => {
    const clientId = await withTenant(db, tenantA, seedClient);
    await expect(
      withTenant(db, tenantA, (tx) =>
        insertInboundClientText(tx, inbound(clientId, new Date(), '')),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, tenantA, (tx) =>
        insertInboundClientText(tx, inbound(clientId, new Date(), 'x'.repeat(1601))),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(db, tenantA, (tx) =>
        tx.execute(
          sql`INSERT INTO client_texts (client_id, direction, body) VALUES (${clientId}, 'out', 'hi')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it('deletes texts after the retention, with their cards, and with the client', async () => {
    const now = new Date();
    const clientId = await withTenant(db, tenantA, seedClient);
    const ownerId = await insertUser(db);
    await withTenant(db, tenantA, async (tx) => {
      const old = await insertInboundClientText(
        tx,
        inbound(clientId, new Date(now.getTime() - 91 * DAY)),
      );
      await insertInboundClientText(tx, inbound(clientId, now));
      await writeClientTextCard(tx, {
        clientId,
        day: '2026-01-01',
        textId: String(old?.id),
        receivedAt: now,
        count: 1,
        nextVisit: null,
        expiresAt: now,
      });
      expect(await deleteOldClientTexts(tx, new Date(now.getTime() - 90 * DAY), 100)).toBe(1);
      expect((await listClientTexts(tx, clientId)).length).toBe(1);
      await addMembership(tx, { userId: ownerId, role: 'owner' });
      const { rows } = await tx.execute(
        sql`SELECT id FROM feed_items WHERE client_id = ${clientId} AND kind = 'client_text'`,
      );
      expect(rows).toEqual([]);
    });
    // Only owners and managers delete clients; the texts go with them.
    await withMember(db, { tenantId: tenantA, userId: ownerId }, async (tx) => {
      expect(await deleteClientRow(tx, ClientIdSchema.parse(clientId), now)).toMatchObject({
        deleted: true,
      });
      expect(await listClientTexts(tx, clientId)).toEqual([]);
    });
  });

  it("lists a client's next confirmed visits, soonest first, at most the limit (AC-X-242)", async () => {
    const now = new Date();
    await withTenant(db, tenantA, async (tx) => {
      const clientId = await seedClient(tx);
      const past = await seedBooking(tx, clientId, new Date(now.getTime() - DAY));
      const later = await seedBooking(tx, clientId, new Date(now.getTime() + 3 * DAY));
      const soon = await seedBooking(tx, clientId, new Date(now.getTime() + DAY));
      const cancelled = await seedBooking(tx, clientId, new Date(now.getTime() + 2 * DAY));
      await tx.execute(sql`UPDATE bookings SET status = 'cancelled' WHERE id = ${cancelled}`);
      const visits = await findClientUpcomingVisits(tx, clientId, now, 5);
      expect(visits.map((v) => v.bookingId)).toEqual([soon, later]);
      expect(visits.map((v) => v.bookingId)).not.toContain(past);
      expect((await findClientUpcomingVisits(tx, clientId, now, 1)).map((v) => v.bookingId)).toEqual(
        [soon],
      );
      await expect(findClientUpcomingVisits(tx, clientId, now, 0)).rejects.toThrow();
    });
    // Another business sees none of them.
    const other = await withTenant(db, tenantA, seedClient);
    expect(await withTenant(db, tenantB, (tx) => findClientUpcomingVisits(tx, other, now, 5))).toEqual(
      [],
    );
  });

  it('moves texts to the kept client when two are merged', async () => {
    const now = new Date();
    const ownerId = await insertUser(db);
    const [keep, other] = await withTenant(db, tenantA, async (tx) => {
      await addMembership(tx, { userId: ownerId, role: 'owner' });
      const ids = [await seedClient(tx), await seedClient(tx)] as const;
      await insertInboundClientText(tx, inbound(ids[1], now, 'From the duplicate'));
      return ids;
    });
    await withMember(db, { tenantId: tenantA, userId: ownerId }, async (tx) => {
      await mergeClientRows(tx, ClientIdSchema.parse(keep), ClientIdSchema.parse(other), now);
      expect((await listClientTexts(tx, keep)).map((t) => t.body)).toEqual(['From the duplicate']);
    });
  });
});
