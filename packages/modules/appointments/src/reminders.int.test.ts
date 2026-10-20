import { randomBytes } from 'node:crypto';
import {
  BookingIdSchema,
  TenantIdSchema,
  type Booking,
  type BookingInput,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
  type TenantSlug,
  TenantSlugSchema,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deliverOutboxMessage,
  ManualClock,
  outboxKeyFrom,
  type Actor,
  type EmailMessage,
  type Mailer,
} from '@pepper/core';
import {
  addMembership,
  findBookingReminder,
  listDueOutboxMessages,
  planBookingReminder,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BookingNotFoundError } from './errors.js';
import { changeBooking, createBooking, listBookings } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { sendDueReminder, sendDueReminders } from './services/reminders.js';
import type { BookingNotice, BookingNotify } from './services/notices.js';
import {
  cancelManagedBooking,
  confirmBookingRequest,
  getManagedBooking,
  requestBooking,
  rescheduleManagedBooking,
} from './services/public-booking.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Reminders planned with every booking change, and the emails a team change tells the client
// about (W6, ADR-0025), through the domain services against real Postgres.

let database: TestDatabase;
let db: Database;
let slugs = 0;

const KEY = randomBytes(32);

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:00 in New York (EST).
const NOW = '2026-11-02T12:00:00.000Z';
const HOUR = 3_600_000;
/** `HH:MM` in New York (UTC-5) on Monday 2 (`day` 2) or Tuesday 3 (`day` 3) November. */
const at = (day: 2 | 3 | 4, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, (h ?? 0) + 5, m ?? 0)).toISOString();
};

interface Business {
  slug: TenantSlug;
  tenantId: TenantId;
  owner: Actor;
  /** Jess's login (staff). */
  staff: Actor;
  service: Service;
  jess: StaffMember;
  /** Maria, with an email address. */
  maria: Client;
  /** Bo, with a phone number only. */
  bo: Client;
  clock: ManualClock;
}

/** Juniper: Jess (linked to the staff login) offers a 60-minute haircut, Mon–Fri 09:00–17:00. */
async function newBusiness(): Promise<Business> {
  slugs += 1;
  const slug = `juniper-reminders-${String(slugs)}`;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const staffId = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffId, role: 'staff' }));
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    userId: staffId,
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '17:00' })),
  });
  const maria = await createClient(db, owner, { name: 'Maria Lopez', email: 'maria@example.test' });
  const bo = await createClient(db, owner, { name: 'Bo Chen', phone: '+12125550123' });
  return {
    slug: TenantSlugSchema.parse(slug),
    tenantId,
    owner,
    staff: { context: { tenantId, userId: staffId, role: 'staff' } },
    service,
    jess,
    maria,
    bo,
    clock: new ManualClock(NOW),
  };
}

function input(b: Business, startsAt: string, extra: Partial<BookingInput> = {}): BookingInput {
  return {
    clientId: b.maria.id,
    serviceId: b.service.id,
    staffMemberId: b.jess.id,
    startsAt,
    ...extra,
  };
}

/** Staff find Maria by her exact email address (ADR-0020), then book her. */
function staffInput(b: Business, startsAt: string): BookingInput {
  return input(b, startsAt, { clientContact: 'maria@example.test' });
}

/** A recorder of notices. */
function recorder(): { notices: BookingNotice[]; notify: BookingNotify } {
  const notices: BookingNotice[] = [];
  return {
    notices,
    notify: (_tx, notice) => {
      notices.push(notice);
      return Promise.resolve();
    },
  };
}

const reminderOf = (b: Business, booking: { id: string }) =>
  withTenant(db, b.tenantId, (tx) => findBookingReminder(tx, BookingIdSchema.parse(booking.id)));

const due = (startsAt: string) => new Date(Date.parse(startsAt) - 24 * HOUR);

describe('team bookings keep their reminder in step', () => {
  it('plans a reminder 24 hours before a booking made more than a day ahead', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    expect(await reminderOf(b, booking)).toMatchObject({
      dueAt: due(at(3, '10:00')),
      startsAt: new Date(at(3, '10:00')),
    });
  });

  it('plans none for a booking less than a day ahead', async () => {
    const b = await newBusiness();
    // Monday 16:00 is 9 hours ahead.
    const booking = await createBooking(db, b.owner, input(b, at(2, '16:00')), { clock: b.clock });
    expect(await reminderOf(b, booking)).toBeUndefined();
    // Exactly 24 hours ahead: the reminder would be due now, so none either.
    b.clock.set(new Date(Date.parse(at(3, '11:00')) - 24 * HOUR));
    const exact = await createBooking(db, b.owner, input(b, at(3, '11:00')), { clock: b.clock });
    expect(await reminderOf(b, exact)).toBeUndefined();
  });

  it('moves the reminder with the booking, and drops it when moved within a day', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    await changeBooking(db, b.owner, booking.id, { startsAt: at(4, '10:00') }, { clock: b.clock });
    expect(await reminderOf(b, booking)).toMatchObject({ dueAt: due(at(4, '10:00')) });
    await changeBooking(db, b.owner, booking.id, { startsAt: at(2, '15:00') }, { clock: b.clock });
    expect(await reminderOf(b, booking)).toBeUndefined();
  });

  it('removes the reminder when the booking is cancelled', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.staff, staffInput(b, at(3, '10:00')), {
      clock: b.clock,
    });
    expect(await reminderOf(b, booking)).toBeDefined();
    await changeBooking(db, b.staff, booking.id, { status: 'cancelled' }, { clock: b.clock });
    expect(await reminderOf(b, booking)).toBeUndefined();
  });

  it('removes a reminder not yet sent when the booking is completed', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    b.clock.set(new Date(at(3, '10:30')));
    await changeBooking(db, b.owner, booking.id, { status: 'completed' }, { clock: b.clock });
    expect(await reminderOf(b, booking)).toBeUndefined();
  });
});

describe('booking page bookings keep their reminder in step', () => {
  async function bookOnPage(b: Business, startsAt: string) {
    const asked = await requestBooking(
      db,
      b.slug,
      {
        serviceId: b.service.id,
        staffMemberId: b.jess.id,
        startsAt,
        name: 'Ana Ruiz',
        email: 'ana@example.test',
      },
      { codeKey: KEY, clock: b.clock },
    );
    return confirmBookingRequest(
      db,
      b.slug,
      asked.requestId,
      { code: asked.code },
      { codeKey: KEY, clock: b.clock },
    );
  }

  async function bookingId(b: Business): Promise<Booking> {
    const [booking] = await listBookings(db, b.owner, {
      from: at(2, '00:00'),
      to: '2026-11-10T00:00:00.000Z',
    });
    if (booking === undefined) throw new Error('no booking');
    return booking;
  }

  it('plans, moves and removes the reminder', async () => {
    const b = await newBusiness();
    const confirmed = await bookOnPage(b, at(3, '10:00'));
    const booking = await bookingId(b);
    expect(await reminderOf(b, booking)).toMatchObject({ dueAt: due(at(3, '10:00')) });

    await rescheduleManagedBooking(db, b.slug, confirmed.manageToken, at(4, '11:00'), {
      clock: b.clock,
    });
    expect(await reminderOf(b, booking)).toMatchObject({ dueAt: due(at(4, '11:00')) });

    await cancelManagedBooking(db, b.slug, confirmed.manageToken, { clock: b.clock });
    expect(await reminderOf(b, booking)).toBeUndefined();
  });

  it('plans none for a booking less than a day ahead', async () => {
    const b = await newBusiness();
    await bookOnPage(b, at(2, '16:00'));
    expect(await reminderOf(b, await bookingId(b))).toBeUndefined();
  });
});

describe('team changes tell the client (notifyClient)', () => {
  it('confirms a new booking with a link that works on the booking page', async () => {
    const b = await newBusiness();
    const { notices, notify } = recorder();
    const booking = await createBooking(db, b.staff, staffInput(b, at(3, '10:00')), {
      clock: b.clock,
      notify,
    });
    expect(notices).toHaveLength(1);
    const [notice] = notices;
    if (notice?.kind !== 'confirmed') throw new Error('expected a confirmation');
    expect(notice.email).toEqual({
      businessName: 'Juniper Hair Studio',
      slug: b.slug,
      timeZone: 'America/New_York',
      serviceName: 'Haircut',
      staffName: 'Jess',
      startsAt: at(3, '10:00'),
      email: 'maria@example.test',
      clientName: 'Maria Lopez',
    });
    expect(notice.change.bookingId).toBe(booking.id);
    const managed = await getManagedBooking(db, b.slug, notice.manageToken, { clock: b.clock });
    expect(managed).toMatchObject({ startsAt: at(3, '10:00'), changeable: true });
  });

  it('sends a new link with a move; the old link stops working', async () => {
    const b = await newBusiness();
    const { notices, notify } = recorder();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), {
      clock: b.clock,
      notify,
    });
    await changeBooking(
      db,
      b.owner,
      booking.id,
      { startsAt: at(3, '14:00') },
      { clock: b.clock, notify },
    );
    const [confirmed, moved] = notices;
    if (confirmed?.kind !== 'confirmed' || moved?.kind !== 'rescheduled') {
      throw new Error('expected a confirmation and a move');
    }
    expect(moved.email.startsAt).toBe(at(3, '14:00'));
    expect(moved.manageToken).not.toBe(confirmed.manageToken);
    expect(moved.change.at.getTime()).not.toBe(confirmed.change.at.getTime());
    await expect(getManagedBooking(db, b.slug, confirmed.manageToken)).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
    expect(await getManagedBooking(db, b.slug, moved.manageToken)).toMatchObject({
      startsAt: at(3, '14:00'),
    });
  });

  it('tells the client about a cancellation, and about no other status', async () => {
    const b = await newBusiness();
    const { notices, notify } = recorder();
    const first = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    const second = await createBooking(db, b.owner, input(b, at(3, '13:00')), {
      clock: b.clock,
    });
    await changeBooking(db, b.owner, first.id, { status: 'cancelled' }, { clock: b.clock, notify });
    b.clock.set(new Date(at(3, '13:30')));
    await changeBooking(db, b.owner, second.id, { status: 'no_show' }, { clock: b.clock, notify });
    expect(notices.map((n) => [n.kind, n.change.bookingId, 'manageToken' in n])).toEqual([
      ['cancelled', first.id, false],
    ]);
  });

  it('tells nobody when notifyClient is false', async () => {
    const b = await newBusiness();
    const { notices, notify } = recorder();
    const booking = await createBooking(
      db,
      b.owner,
      input(b, at(3, '10:00'), { notifyClient: false }),
      { clock: b.clock, notify },
    );
    await changeBooking(
      db,
      b.owner,
      booking.id,
      { startsAt: at(3, '14:00'), notifyClient: false },
      { clock: b.clock, notify },
    );
    await changeBooking(
      db,
      b.owner,
      booking.id,
      { status: 'cancelled', notifyClient: false },
      { clock: b.clock, notify },
    );
    expect(notices).toEqual([]);
  });

  it('tells nobody when the client has no email address', async () => {
    const b = await newBusiness();
    const { notices, notify } = recorder();
    const booking = await createBooking(
      db,
      b.owner,
      input(b, at(3, '10:00'), { clientId: b.bo.id }),
      {
        clock: b.clock,
        notify,
      },
    );
    await changeBooking(
      db,
      b.owner,
      booking.id,
      { status: 'cancelled' },
      { clock: b.clock, notify },
    );
    expect(notices).toEqual([]);
  });

  it('rolls the booking back when notify fails', async () => {
    const b = await newBusiness();
    const failing: BookingNotify = () => Promise.reject(new Error('could not queue'));
    await expect(
      createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock, notify: failing }),
    ).rejects.toThrow('could not queue');
    expect(await listBookings(db, b.owner, { from: at(3, '00:00'), to: at(4, '00:00') })).toEqual(
      [],
    );
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    await expect(
      changeBooking(
        db,
        b.owner,
        booking.id,
        { startsAt: at(3, '14:00') },
        { clock: b.clock, notify: failing },
      ),
    ).rejects.toThrow('could not queue');
    expect(await reminderOf(b, booking)).toMatchObject({ dueAt: due(at(3, '10:00')) });
  });
});

describe('the reminder job (AC-W6-1)', () => {
  const OUTBOX_KEY = outboxKeyFrom('a-reminder-test-outbox-secret-32+chars');

  class RecordingMailer implements Mailer {
    readonly sent: EmailMessage[] = [];
    send(message: EmailMessage): Promise<void> {
      this.sent.push(message);
      return Promise.resolve();
    }
  }

  /** One pass of the reminder job, then the outbox delivered as the worker does. */
  async function runJobs(b: Business, mailer: RecordingMailer) {
    const pass = await sendDueReminders(db, { key: OUTBOX_KEY, clock: b.clock });
    const options = { key: OUTBOX_KEY, mailer, clock: b.clock };
    for (const due of await listDueOutboxMessages(db, b.clock.now(), 1000)) {
      if (due.tenantId === b.tenantId) await deliverOutboxMessage(db, due, options);
    }
    return pass;
  }

  /** Emails sent to this business's clients (the outbox is shared by the test's businesses). */
  const remindersIn = (mailer: RecordingMailer) =>
    mailer.sent.filter((m) => m.subject.startsWith('Reminder:'));

  it('emails the client when the reminder is due, once, in the business time zone', async () => {
    const b = await newBusiness();
    const mailer = new RecordingMailer();
    await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });

    b.clock.set(new Date(due(at(3, '10:00')).getTime() - 60_000));
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toEqual([]);

    b.clock.set(due(at(3, '10:00')));
    const pass = await runJobs(b, mailer);
    expect(pass.queued).toBeGreaterThanOrEqual(1);
    expect(remindersIn(mailer)).toEqual([
      expect.objectContaining({
        to: 'maria@example.test',
        subject: 'Reminder: your booking at Juniper Hair Studio',
        text: expect.stringContaining(
          'Haircut with Jess, Tuesday, November 3 at 10:00 AM.',
        ) as string,
      }),
    ]);

    b.clock.advanceBy(10 * 60_000);
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toHaveLength(1);
  });

  it('never reminds about a cancelled booking', async () => {
    const b = await newBusiness();
    const mailer = new RecordingMailer();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    await changeBooking(db, b.owner, booking.id, { status: 'cancelled' }, { clock: b.clock });
    b.clock.set(due(at(3, '10:00')));
    await runJobs(b, mailer);
    b.clock.set(new Date(at(3, '09:59')));
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toEqual([]);
  });

  it('reminds about a moved booking at its new time only', async () => {
    const b = await newBusiness();
    const mailer = new RecordingMailer();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    await changeBooking(db, b.owner, booking.id, { startsAt: at(4, '14:00') }, { clock: b.clock });
    b.clock.set(due(at(3, '10:00')));
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toEqual([]);
    b.clock.set(due(at(4, '14:00')));
    await runJobs(b, mailer);
    expect(remindersIn(mailer).map((m) => m.text)).toEqual([
      expect.stringContaining('Wednesday, November 4 at 2:00 PM'),
    ]);
  });

  it('skips, and forgets, a reminder whose booking changed behind its back', async () => {
    const b = await newBusiness();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    const reminder = { bookingId: BookingIdSchema.parse(booking.id), tenantId: b.tenantId };
    // A reminder planned for another start (as if a move had not re-planned it).
    await withTenant(db, b.tenantId, (tx) =>
      planBookingReminder(tx, {
        bookingId: reminder.bookingId,
        dueAt: due(at(3, '11:00')),
        startsAt: new Date(at(3, '11:00')),
      }),
    );
    b.clock.set(new Date(due(at(3, '11:00'))));
    expect(await sendDueReminder(db, reminder, { key: OUTBOX_KEY, clock: b.clock })).toBe(
      'skipped',
    );
    expect(await reminderOf(b, booking)).toBeUndefined();
  });

  it('skips a client without an email address, and a booking that has started', async () => {
    const b = await newBusiness();
    const mailer = new RecordingMailer();
    const bos = await createBooking(db, b.owner, input(b, at(3, '10:00'), { clientId: b.bo.id }), {
      clock: b.clock,
    });
    const late = await createBooking(db, b.owner, input(b, at(3, '13:00')), { clock: b.clock });
    // The job was down for a day: Bo's reminder is due, Maria's booking has started.
    b.clock.set(new Date(at(3, '13:30')));
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toEqual([]);
    expect(await reminderOf(b, bos)).toBeUndefined();
    expect(await reminderOf(b, late)).toBeUndefined();
  });

  it('queues one email when several workers handle the same reminder at once', async () => {
    const b = await newBusiness();
    const mailer = new RecordingMailer();
    const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), { clock: b.clock });
    b.clock.set(due(at(3, '10:00')));
    const reminder = { bookingId: BookingIdSchema.parse(booking.id), tenantId: b.tenantId };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => sendDueReminder(db, reminder, { key: OUTBOX_KEY, clock: b.clock })),
    );
    expect(results.filter((r) => r === 'queued')).toHaveLength(1);
    await runJobs(b, mailer);
    expect(remindersIn(mailer)).toHaveLength(1);
  });

  it('a cancellation racing the job: the job either sends before it or not at all', async () => {
    for (let round = 0; round < 5; round += 1) {
      const b = await newBusiness();
      const mailer = new RecordingMailer();
      const booking = await createBooking(db, b.owner, input(b, at(3, '10:00')), {
        clock: b.clock,
      });
      b.clock.set(due(at(3, '10:00')));
      const reminder = { bookingId: BookingIdSchema.parse(booking.id), tenantId: b.tenantId };
      const order: string[] = [];
      await Promise.all([
        sendDueReminder(db, reminder, { key: OUTBOX_KEY, clock: b.clock }).then((r) =>
          order.push(`reminder:${r}`),
        ),
        changeBooking(db, b.owner, booking.id, { status: 'cancelled' }, { clock: b.clock }).then(
          () => order.push('cancelled'),
        ),
      ]);
      await runJobs(b, mailer);
      // Queued only if the job committed first; never after the cancellation.
      if (remindersIn(mailer).length > 0) expect(order[0]).toBe('reminder:queued');
      else expect(order).toContain('reminder:skipped');
    }
  });
});
