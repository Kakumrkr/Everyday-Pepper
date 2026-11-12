// Texts about bookings (S62, ADR-0065) against real Postgres: what each text was about and
// where it stands, the reminders' extra manage links, the client's "C", and the lookup behind it
// (`sms_confirm_target`, ids only). Part of the isolation evidence with isolation.int.test.ts.
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
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import {
  deleteOldBookingManageLinks,
  findBookingIdByManageLink,
  findLastBookingText,
  hasReminderText,
  insertBookingManageLink,
  insertBookingText,
  markBookingClientConfirmed,
  smsConfirmTarget,
} from './repositories/booking-texts.js';
import {
  findBookingByManageTokenHash,
  lockBookingByManageTokenHash,
} from './repositories/booking-verifications.js';
import { insertBooking, setBookingStatus } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import { scheduleCurrentTenantDeletion } from './repositories/deletion.js';
import {
  insertOutboxMessage,
  markOutboxMessageFailed,
  markOutboxMessageSent,
} from './repositories/outbox.js';
import { insertSmsConsent, insertSmsDelivery, revokeSmsConsent } from './repositories/sms.js';
import { createTenant } from './repositories/tenants.js';
import { withTenant, type TenantTx } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

const SHOWN = 'Text me appointment confirmations and reminders from A at this number.';
const HOUR = 3_600_000;
let database: TestDatabase;
let db: Database;
let tenantA: TenantId;
let tenantB: TenantId;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenantA = TenantIdSchema.parse(
    (await createTenant(db, { name: 'A', slug: 'texts-a', timeZone: 'America/New_York' })).id,
  );
  tenantB = TenantIdSchema.parse(
    (await createTenant(db, { name: 'B', slug: 'texts-b', timeZone: 'America/Chicago' })).id,
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

/** A client with a consent for `number`, a booking at `startsAt`, and a reminder sent at `at`. */
async function remindedBooking(
  tenantId: TenantId,
  number: string,
  startsAt: Date,
  at: Date,
): Promise<{ clientId: string; bookingId: BookingId }> {
  return withTenant(db, tenantId, async (tx) => {
    const clientId = await seedClient(tx);
    await insertSmsConsent(tx, {
      phone: number,
      source: 'booking_page',
      clientId,
      wordingVersion: 'sms-consent-v1',
      shownText: SHOWN,
      givenAt: new Date(at.getTime() - 10 * 24 * HOUR),
    });
    const bookingId = await seedBooking(tx, clientId, startsAt);
    await seedText(tx, { clientId, bookingId, kind: 'day_before', startsAt, at });
    return { clientId, bookingId };
  });
}

describe('booking texts', () => {
  it('answers the client’s last text with its message and delivery state (AC-X-76)', async () => {
    const now = new Date();
    const { clientId, bookingId, id } = await withTenant(db, tenantA, async (tx) => {
      const client = await seedClient(tx);
      const booking = await seedBooking(tx, client, new Date(now.getTime() + 48 * HOUR));
      expect(await findLastBookingText(tx, client)).toBeUndefined();
      expect(await hasReminderText(tx, client)).toBe(false);
      await seedText(tx, {
        clientId: client,
        bookingId: booking,
        kind: 'opt_in',
        startsAt: new Date(now.getTime() + 48 * HOUR),
        at: new Date(now.getTime() - HOUR),
      });
      // An opt-in text isn't a reminder.
      expect(await hasReminderText(tx, client)).toBe(false);
      const reminder = await seedText(tx, {
        clientId: client,
        bookingId: booking,
        kind: 'day_before',
        startsAt: new Date(now.getTime() + 48 * HOUR),
        at: now,
      });
      return { clientId: client, bookingId: booking, id: reminder };
    });
    expect(bookingId).toBeDefined();
    await withTenant(db, tenantA, async (tx) => {
      expect(await hasReminderText(tx, clientId)).toBe(true);
      expect(await findLastBookingText(tx, clientId)).toMatchObject({
        kind: 'day_before',
        messageStatus: 'pending',
        deliveryStatus: null,
      });
      await markOutboxMessageSent(tx, OutboxMessageIdSchema.parse(id), now);
      await insertSmsDelivery(tx, {
        id,
        provider: 'sandbox',
        providerMessageId: `SB${newId().replace(/-/g, '')}`,
        segments: 1,
        status: 'delivered',
      });
      expect(await findLastBookingText(tx, clientId)).toMatchObject({
        messageStatus: 'sent',
        sentAt: now,
        deliveryStatus: 'delivered',
      });
    });
    // Another business sees none of it.
    expect(
      await withTenant(db, tenantB, (tx) => findLastBookingText(tx, clientId)),
    ).toBeUndefined();
  });

  it('keeps a dropped text’s reason', async () => {
    const now = new Date();
    const clientId = await withTenant(db, tenantA, async (tx) => {
      const client = await seedClient(tx);
      const booking = await seedBooking(tx, client, new Date(now.getTime() + 48 * HOUR));
      const id = await seedText(tx, {
        clientId: client,
        bookingId: booking,
        kind: 'same_day',
        startsAt: new Date(now.getTime() + 48 * HOUR),
        at: now,
      });
      await markOutboxMessageFailed(tx, OutboxMessageIdSchema.parse(id), {
        errorName: 'SmsOptedOut',
        retryAt: null,
      });
      return client;
    });
    expect(await withTenant(db, tenantA, (tx) => findLastBookingText(tx, clientId))).toMatchObject({
      kind: 'same_day',
      messageStatus: 'dead',
      lastError: 'SmsOptedOut',
    });
  });

  it('refuses an unknown kind, and a text without its outbox message', async () => {
    const error = await withTenant(db, tenantA, async (tx) => {
      const client = await seedClient(tx);
      const booking = await seedBooking(tx, client, new Date(Date.now() + 48 * HOUR));
      return insertBookingText(tx, {
        id: newId(),
        clientId: client,
        bookingId: booking,
        kind: 'day_before',
        startsAt: new Date(),
        createdAt: new Date(),
      });
    }).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23503'); // foreign_key_violation
  });
});

describe('reminder links', () => {
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

  it('opens the booking through the manage lookup, its own business only', async () => {
    const token = randomBytes(32).toString('base64url');
    const bookingId = await withTenant(db, tenantA, async (tx) => {
      const client = await seedClient(tx);
      const booking = await seedBooking(tx, client, new Date(Date.now() + 48 * HOUR));
      await insertBookingManageLink(tx, {
        bookingId: booking,
        tokenHash: hashOf(token),
        createdAt: new Date(),
      });
      return booking;
    });
    await withTenant(db, tenantA, async (tx) => {
      expect((await findBookingByManageTokenHash(tx, hashOf(token)))?.id).toBe(bookingId);
      expect((await lockBookingByManageTokenHash(tx, hashOf(token)))?.id).toBe(bookingId);
      expect(await findBookingIdByManageLink(tx, hashOf(token))).toBe(bookingId);
      expect(await findBookingIdByManageLink(tx, 'not-a-hash')).toBeUndefined();
    });
    expect(
      await withTenant(db, tenantB, (tx) => findBookingByManageTokenHash(tx, hashOf(token))),
    ).toBeUndefined();
  });

  it('cleans up the links of bookings that started before the cut-off', async () => {
    const old = randomBytes(32).toString('base64url');
    const upcoming = randomBytes(32).toString('base64url');
    await withTenant(db, tenantA, async (tx) => {
      const client = await seedClient(tx);
      for (const [token, startsAt] of [
        [old, new Date(Date.now() - 40 * 24 * HOUR)],
        [upcoming, new Date(Date.now() + 48 * HOUR)],
      ] as const) {
        await insertBookingManageLink(tx, {
          bookingId: await seedBooking(tx, client, startsAt),
          tokenHash: hashOf(token),
          createdAt: new Date(),
        });
      }
    });
    expect(
      await withTenant(db, tenantA, (tx) =>
        deleteOldBookingManageLinks(tx, new Date(Date.now() - 30 * 24 * HOUR), 100),
      ),
    ).toBe(1);
    await withTenant(db, tenantA, async (tx) => {
      expect(await findBookingIdByManageLink(tx, hashOf(old))).toBeUndefined();
      expect(await findBookingIdByManageLink(tx, hashOf(upcoming))).toBeDefined();
    });
  });
});

describe('confirm by text (AC-X-74)', () => {
  it('finds the soonest upcoming booking reminded on the number, ids only', async () => {
    const number = phone();
    const now = new Date();
    const later = await remindedBooking(tenantA, number, new Date(now.getTime() + 30 * HOUR), now);
    const sooner = await remindedBooking(tenantB, number, new Date(now.getTime() + 20 * HOUR), now);
    expect(later).toBeDefined();
    expect(await smsConfirmTarget(db, number, now)).toEqual({
      tenantId: tenantB,
      bookingId: sooner.bookingId,
    });
    // The function's answer has the two ids and nothing else.
    const { rows } = await db.execute(
      sql`SELECT * FROM sms_confirm_target(${number}, ${now.toISOString()}::timestamptz)`,
    );
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['booking_id', 'tenant_id']);
  });

  it('skips cancelled, moved, started, stale and unconsented bookings', async () => {
    const now = new Date();
    const start = new Date(now.getTime() + 20 * HOUR);
    const cancelled = phone();
    const { bookingId } = await remindedBooking(tenantA, cancelled, start, now);
    await withTenant(db, tenantA, (tx) => setBookingStatus(tx, bookingId, 'cancelled'));
    expect(await smsConfirmTarget(db, cancelled, now)).toBeUndefined();

    const moved = phone();
    const m = await remindedBooking(tenantA, moved, start, now);
    await withTenant(db, tenantA, (tx) =>
      tx.execute(
        sql`UPDATE bookings SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' WHERE id = ${m.bookingId}`,
      ),
    );
    expect(await smsConfirmTarget(db, moved, now)).toBeUndefined();

    const started = phone();
    await remindedBooking(tenantA, started, new Date(now.getTime() + HOUR), now);
    expect(await smsConfirmTarget(db, started, new Date(now.getTime() + 2 * HOUR))).toBeUndefined();

    const stale = phone();
    await remindedBooking(tenantA, stale, new Date(now.getTime() + 80 * HOUR), now);
    expect(await smsConfirmTarget(db, stale, new Date(now.getTime() + 49 * HOUR))).toBeUndefined();

    const revoked = phone();
    await remindedBooking(tenantA, revoked, start, now);
    await withTenant(db, tenantA, (tx) => revokeSmsConsent(tx, revoked, now));
    expect(await smsConfirmTarget(db, revoked, now)).toBeUndefined();

    expect(await smsConfirmTarget(db, 'not a number', now)).toBeUndefined();
    expect(await smsConfirmTarget(db, phone(), now)).toBeUndefined();
  });

  it('leaves out a business being deleted', async () => {
    const tenant = TenantIdSchema.parse(
      (
        await createTenant(db, {
          name: 'C',
          slug: `texts-c-${newId().slice(0, 8)}`,
          timeZone: 'UTC',
        })
      ).id,
    );
    const number = phone();
    const now = new Date();
    await remindedBooking(tenant, number, new Date(now.getTime() + 20 * HOUR), now);
    expect(await smsConfirmTarget(db, number, now)).toBeDefined();
    await withTenant(db, tenant, (tx) =>
      scheduleCurrentTenantDeletion(tx, new Date(now.getTime() + 30 * 24 * HOUR)),
    );
    expect(await smsConfirmTarget(db, number, now)).toBeUndefined();
  });

  it('marks the booking confirmed by the client once', async () => {
    const now = new Date();
    const { bookingId } = await remindedBooking(
      tenantA,
      phone(),
      new Date(now.getTime() + 20 * HOUR),
      now,
    );
    const first = await withTenant(db, tenantA, (tx) =>
      markBookingClientConfirmed(tx, bookingId, now),
    );
    expect(first?.clientConfirmedAt).toEqual(now);
    expect(
      await withTenant(db, tenantA, (tx) => markBookingClientConfirmed(tx, bookingId, new Date())),
    ).toBeUndefined();
    expect(
      await withTenant(db, tenantB, (tx) => markBookingClientConfirmed(tx, bookingId, now)),
    ).toBeUndefined();
  });
});
