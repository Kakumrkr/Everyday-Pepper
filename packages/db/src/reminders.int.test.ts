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
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBookingVerification } from './repositories/booking-verifications.js';
import { insertBooking } from './repositories/bookings.js';
import {
  deleteExpiredBookingVerifications,
  deleteFinishedOutboxMessages,
  listTenantIdsForCleanup,
} from './repositories/cleanup.js';
import { insertClient } from './repositories/clients.js';
import {
  insertOutboxMessage,
  markOutboxMessageFailed,
  markOutboxMessageSent,
} from './repositories/outbox.js';
import {
  findBookingReminder,
  findReminderSettings,
  listBookingReminders,
  listDueBookingReminders,
  planBookingReminder,
  removeBookingReminder,
  setReminderSettings,
  takeDueBookingReminder,
} from './repositories/reminders.js';
import { createTenant } from './repositories/tenants.js';
import { outboxMessages } from './schema.js';
import { withTenant, type TenantTx } from './tenant.js';
import { sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// The booking reminder and clean-up repositories against real Postgres (ADR-0025). The
// isolation of both tables and the job scans are in isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let other: TenantId;

const START = new Date('2026-11-03T15:00:00Z');
const DUE = new Date('2026-11-02T15:00:00Z');
const at = (ms: number) => new Date(DUE.getTime() + ms);

async function seedBooking(tx: TenantTx, startsAt = START): Promise<BookingId> {
  const client = await insertClient(tx, {
    name: 'Maria Lopez',
    email: `maria-${newId()}@example.test`,
    phone: null,
    source: 'team',
  });
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
    clientId: ClientIdSchema.parse(client.id),
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

async function plannedBooking(tenantId: TenantId, dueAt = DUE): Promise<BookingId> {
  return withTenant(db, tenantId, async (tx) => {
    const bookingId = await seedBooking(tx);
    await planBookingReminder(tx, { bookingId, dueAt, startsAt: START });
    return bookingId;
  });
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  const a = await createTenant(db, { name: 'Plum', slug: 'plum', timeZone: 'America/Chicago' });
  const b = await createTenant(db, { name: 'Fig', slug: 'fig', timeZone: 'America/New_York' });
  tenant = TenantIdSchema.parse(a.id);
  other = TenantIdSchema.parse(b.id);
});

afterAll(async () => {
  await database.stop();
});

describe('booking reminders', () => {
  it('plans, re-plans and removes a booking reminder', async () => {
    const bookingId = await plannedBooking(tenant);
    const find = () => withTenant(db, tenant, (tx) => findBookingReminder(tx, bookingId));
    expect(await find()).toMatchObject({ id: bookingId, tenantId: tenant, dueAt: DUE });

    const moved = new Date('2026-11-05T15:00:00Z');
    await withTenant(db, tenant, (tx) =>
      planBookingReminder(tx, {
        bookingId,
        dueAt: new Date('2026-11-04T15:00:00Z'),
        startsAt: moved,
      }),
    );
    expect(await find()).toMatchObject({ startsAt: moved });

    await withTenant(db, tenant, (tx) => removeBookingReminder(tx, bookingId));
    expect(await find()).toBeUndefined();
  });

  it('refuses a reminder due at or after the start', async () => {
    const error = await withTenant(db, tenant, async (tx) => {
      const bookingId = await seedBooking(tx);
      await planBookingReminder(tx, { bookingId, dueAt: START, startsAt: START });
    }).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
  });

  it('refuses a reminder for a booking that does not exist', async () => {
    const error = await withTenant(db, tenant, (tx) =>
      planBookingReminder(tx, {
        bookingId: BookingIdSchema.parse(newId()),
        dueAt: DUE,
        startsAt: START,
      }),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23503'); // foreign_key_violation
  });

  it('lists due reminders across businesses, earliest first, ids only', async () => {
    const early = await plannedBooking(tenant, at(-60_000));
    const late = await plannedBooking(other, at(0));
    const notYet = await plannedBooking(tenant, at(1));
    const due = await listDueBookingReminders(db, at(0), 1000);
    const ids = due.map((d) => d.bookingId);
    expect(ids).toEqual(expect.arrayContaining([early, late]));
    expect(ids).not.toContain(notYet);
    expect(ids.indexOf(early)).toBeLessThan(ids.indexOf(late));
    expect(due.find((d) => d.bookingId === late)).toEqual({
      bookingId: late,
      kind: 'day_before',
      tenantId: other,
    });
    expect(await listDueBookingReminders(db, at(0), 1)).toHaveLength(1);
  });

  it('takes a due reminder once', async () => {
    const bookingId = await plannedBooking(tenant);
    expect(
      await withTenant(db, tenant, (tx) =>
        takeDueBookingReminder(tx, bookingId, 'day_before', at(-1)),
      ),
    ).toBeUndefined();
    const takes = await Promise.all(
      [1, 2, 3].map(() =>
        withTenant(db, tenant, (tx) => takeDueBookingReminder(tx, bookingId, 'day_before', at(0))),
      ),
    );
    expect(takes.filter((t) => t !== undefined)).toEqual([
      expect.objectContaining({ id: bookingId, startsAt: START }),
    ]);
  });

  it('keeps one reminder per booking and kind, taken and removed by kind (S62)', async () => {
    const bookingId = await plannedBooking(tenant);
    const sameDue = new Date(START.getTime() - 2 * 3_600_000);
    await withTenant(db, tenant, async (tx) => {
      await planBookingReminder(tx, {
        bookingId,
        kind: 'same_day',
        dueAt: sameDue,
        startsAt: START,
      });
      // Re-planned, not duplicated.
      await planBookingReminder(tx, {
        bookingId,
        kind: 'same_day',
        dueAt: sameDue,
        startsAt: START,
      });
    });
    const kinds = await withTenant(db, tenant, (tx) => listBookingReminders(tx, bookingId));
    expect(kinds.map((r) => r.kind)).toEqual(['day_before', 'same_day']);
    const due = await listDueBookingReminders(db, sameDue, 1000);
    expect(due.filter((d) => d.bookingId === bookingId).map((d) => d.kind)).toEqual([
      'day_before',
      'same_day',
    ]);
    expect(
      await withTenant(db, tenant, (tx) =>
        takeDueBookingReminder(tx, bookingId, 'same_day', sameDue),
      ),
    ).toEqual(expect.objectContaining({ kind: 'same_day' }));
    expect(
      await withTenant(db, tenant, (tx) => findBookingReminder(tx, bookingId, 'day_before')),
    ).toBeDefined();
    await withTenant(db, tenant, (tx) => removeBookingReminder(tx, bookingId, 'day_before'));
    expect(await withTenant(db, tenant, (tx) => listBookingReminders(tx, bookingId))).toEqual([]);
  });

  it('refuses an unknown kind', async () => {
    const bookingId = await plannedBooking(tenant);
    const error = await withTenant(db, tenant, (tx) =>
      tx.execute(
        sql`INSERT INTO booking_reminders (id, kind, due_at, starts_at) VALUES (${bookingId}, 'weekly', ${DUE.toISOString()}::timestamptz, ${START.toISOString()}::timestamptz)`,
      ),
    ).catch((e: unknown) => e);
    expect(sqlState(error)).toBe('23514'); // check_violation
  });

  it('stores reminder settings per business, defaults for missing fields (S62)', async () => {
    expect(await withTenant(db, tenant, (tx) => findReminderSettings(tx))).toEqual({
      texts: true,
      dayBefore: true,
      sameDay: true,
      sameDayLeadHours: 2,
      askToConfirm: false,
    });
    await withTenant(db, tenant, (tx) =>
      setReminderSettings(tx, {
        texts: false,
        dayBefore: true,
        sameDay: false,
        sameDayLeadHours: 3,
        askToConfirm: true,
      }),
    );
    expect(await withTenant(db, tenant, (tx) => findReminderSettings(tx))).toMatchObject({
      texts: false,
      sameDay: false,
      sameDayLeadHours: 3,
      askToConfirm: true,
    });
    // Another business keeps its own.
    expect(await withTenant(db, other, (tx) => findReminderSettings(tx))).toMatchObject({
      texts: true,
    });
    await withTenant(db, tenant, (tx) =>
      tx.execute(sql`UPDATE tenants SET reminder_settings = '{"texts": false}'::jsonb`),
    );
    expect(await withTenant(db, tenant, (tx) => findReminderSettings(tx))).toEqual({
      texts: false,
      dayBefore: true,
      sameDay: true,
      sameDayLeadHours: 2,
      askToConfirm: false,
    });
  });

  it("does not take another business's reminder", async () => {
    const bookingId = await plannedBooking(other);
    expect(
      await withTenant(db, tenant, (tx) =>
        takeDueBookingReminder(tx, bookingId, 'day_before', at(0)),
      ),
    ).toBeUndefined();
    expect(await withTenant(db, other, (tx) => findBookingReminder(tx, bookingId))).toBeDefined();
  });

  it('goes with its booking', async () => {
    const bookingId = await plannedBooking(tenant);
    await database.app.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenant}, true)`);
      await tx.execute(sql`DELETE FROM bookings WHERE id = ${bookingId}`);
    });
    expect(
      await withTenant(db, tenant, (tx) => findBookingReminder(tx, bookingId)),
    ).toBeUndefined();
  });
});

describe('clean-up', () => {
  async function seedService(tx: TenantTx) {
    const service = await insertService(tx, {
      name: `Trim ${newId()}`,
      category: null,
      durationMinutes: 30,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: null,
      priceToCents: null,
      active: true,
    });
    return ServiceIdSchema.parse(service.id);
  }

  async function seedRequest(tenantId: TenantId, expiresAt: Date): Promise<string> {
    return withTenant(db, tenantId, async (tx) => {
      const row = await insertBookingVerification(tx, {
        serviceId: await seedService(tx),
        staffMemberId: null,
        startsAt: START,
        name: 'Ana Ruiz',
        email: `ana-${newId()}@example.test`,
        phone: null,
        codeHash: 'a'.repeat(64),
        expiresAt,
      });
      return row.id;
    });
  }

  const ids = (tenantId: TenantId, table: string) =>
    withTenant(db, tenantId, async (tx) => {
      const { rows } = await tx.execute<{ id: string }>(sql.raw(`SELECT id::text FROM ${table}`));
      return rows.map((row) => row.id);
    });

  it('pages through every business', async () => {
    const all = await listTenantIdsForCleanup(db, null, 1000);
    expect(all).toEqual(expect.arrayContaining([tenant, other]));
    expect(all).toEqual([...all].sort());
    const [first] = await listTenantIdsForCleanup(db, null, 1);
    const rest = await listTenantIdsForCleanup(db, first ?? null, 1000);
    expect([first, ...rest]).toEqual(all);
  });

  it('deletes booking requests that expired before the cut-off, in batches', async () => {
    const cutOff = new Date('2026-10-19T12:00:00Z');
    const old = [];
    for (let i = 1; i <= 3; i += 1) {
      old.push(await seedRequest(tenant, new Date(cutOff.getTime() - i * 1000)));
    }
    const kept = await seedRequest(tenant, cutOff);
    const otherOld = await seedRequest(other, new Date(cutOff.getTime() - 60_000));

    const deleteBatch = () =>
      withTenant(db, tenant, (tx) => deleteExpiredBookingVerifications(tx, cutOff, 2));
    expect([await deleteBatch(), await deleteBatch(), await deleteBatch()]).toEqual([2, 1, 0]);
    const left = await ids(tenant, 'booking_verifications');
    expect(left).toContain(kept);
    for (const id of old) expect(left).not.toContain(id);
    // The other business's old request waits for its own pass.
    expect(await ids(other, 'booking_verifications')).toContain(otherOld);
  });

  it('deletes sent and dead outbox messages finished before the cut-off, never pending ones', async () => {
    const queue = async () => {
      const row = await withTenant(db, tenant, (tx) =>
        insertOutboxMessage(tx, {
          id: OutboxMessageIdSchema.parse(newId()),
          type: 'email',
          dedupeKey: `cleanup:${newId()}`,
          payload: Buffer.from('ciphertext'),
          availableAt: new Date(),
        }),
      );
      return OutboxMessageIdSchema.parse(row?.id);
    };
    const [sent, dead, pending, fresh] = [
      await queue(),
      await queue(),
      await queue(),
      await queue(),
    ];
    await withTenant(db, tenant, (tx) => markOutboxMessageSent(tx, sent, new Date()));
    await withTenant(db, tenant, (tx) =>
      markOutboxMessageFailed(tx, dead, { errorName: 'EENVELOPE', retryAt: null }),
    );
    await withTenant(db, tenant, (tx) => markOutboxMessageSent(tx, fresh, new Date()));
    // The cut-off is when `fresh` finished (the database's clock, a later transaction).
    const cutOff = await withTenant(db, tenant, async (tx) => {
      const [row] = await tx
        .select({ at: outboxMessages.updatedAt })
        .from(outboxMessages)
        .where(eq(outboxMessages.id, fresh));
      if (row === undefined) throw new Error('fresh message missing');
      return row.at;
    });

    expect(
      await withTenant(db, tenant, (tx) => deleteFinishedOutboxMessages(tx, cutOff, 100)),
    ).toBe(2);
    const left = await ids(tenant, 'outbox_messages');
    expect(left).toEqual(expect.arrayContaining([pending, fresh]));
    expect(left).not.toContain(sent);
    expect(left).not.toContain(dead);
    const later = new Date(cutOff.getTime() + 60_000);
    expect(await withTenant(db, tenant, (tx) => deleteFinishedOutboxMessages(tx, later, 100))).toBe(
      1,
    );
    expect(await ids(tenant, 'outbox_messages')).toContain(pending);
  });
});
