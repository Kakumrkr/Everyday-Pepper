import {
  BookingIdSchema,
  ManageTokenSchema,
  TenantIdSchema,
  TenantSlugSchema,
  type Booking,
  type Client,
  type Service,
  type StaffMember,
  type TenantId,
  type TenantSlug,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deliverOutboxMessage,
  getClientTexts,
  ManualClock,
  outboxKeyFrom,
  recordSmsConsent,
  type Actor,
  type EmailMessage,
  type Mailer,
  type SmsAccepted,
  type SmsMessage,
  type SmsSender,
} from '@pepper/core';
import {
  findBookingReminder,
  findLastBookingText,
  insertSmsKeywordEvent,
  listBookingReminders,
  listDueOutboxMessages,
  newId,
  planBookingReminder,
  setReminderSettings,
  withSmsInbound,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeBooking, createBooking } from './services/bookings.js';
import { replaceWorkingHours } from './services/hours.js';
import { getManagedBooking, rescheduleManagedBooking } from './services/public-booking.js';
import { sendDueReminder, sendDueReminders } from './services/reminders.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Reminders by text (S62, AC-X-70…72): to the number on the client's consent, the email when
// they can't be texted, the same-day text, the reminder's own link, "Reply STOP" on the first,
// and exactly one of each, through the domain services and the outbox against real Postgres.

let database: TestDatabase;
let db: Database;
let slugs = 0;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

const KEY = outboxKeyFrom('a-reminder-text-test-outbox-secret-32+chars');
const BASE = 'https://app.example.com';
// Monday 2 November 2026, 07:00 in New York (EST).
const NOW = '2026-11-02T12:00:00.000Z';
/** `HH:MM` in New York (UTC-5) on `day` November 2026. */
const at = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, day, (h ?? 0) + 5, m ?? 0)).toISOString();
};
/**
 * The number Maria said yes on (her profile has another): one per business, as a STOP opts a
 * number out for all of Pepper.
 */
const consentPhone = (b: { slug: string }) =>
  `+1212555${String(Number(b.slug.split('-').at(-1))).padStart(4, '0')}`;

class RecordingSms implements SmsSender {
  readonly sent: SmsMessage[] = [];
  send(message: SmsMessage): Promise<SmsAccepted> {
    this.sent.push(message);
    return Promise.resolve({
      provider: 'sandbox',
      providerMessageId: `SB${newId().replace(/-/g, '')}`,
      segments: 1,
      status: 'delivered',
    });
  }
}

class RecordingMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

interface Business {
  slug: TenantSlug;
  tenantId: TenantId;
  owner: Actor;
  service: Service;
  jess: StaffMember;
  /** Maria: an email, a phone on her profile, and a consent for another number. */
  maria: Client;
  clock: ManualClock;
  sms: RecordingSms;
  mailer: RecordingMailer;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const slug = `juniper-texts-${String(slugs)}`;
  const ownerId = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })),
  });
  const maria = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria@example.test',
    phone: '+12125550100',
  });
  return {
    slug: TenantSlugSchema.parse(slug),
    tenantId,
    owner,
    service,
    jess,
    maria,
    clock: new ManualClock(NOW),
    sms: new RecordingSms(),
    mailer: new RecordingMailer(),
  };
}

async function consent(b: Business, phone = consentPhone(b)): Promise<void> {
  await withTenant(db, b.tenantId, (tx) =>
    recordSmsConsent(
      tx,
      {
        phone,
        source: 'booking_page',
        clientId: b.maria.id,
        wordingVersion: 'sms-consent-v1',
        givenAt: b.clock.now(),
      },
      { actor: { kind: 'system' } },
    ),
  );
}

/** Books Maria; `override` past the booking rules (a visit within the minimum notice). */
function book(b: Business, startsAt: string, override = false): Promise<Booking> {
  return createBooking(
    db,
    b.owner,
    {
      clientId: b.maria.id,
      serviceId: b.service.id,
      staffMemberId: b.jess.id,
      startsAt,
      notifyClient: false,
      ...(override && { override: true }),
    },
    { clock: b.clock },
  );
}

/** One pass of the reminder job at `when`, then this business's outbox delivered. */
async function runAt(b: Business, when: string | Date, texts = true) {
  b.clock.set(new Date(when));
  const pass = await sendDueReminders(db, { key: KEY, clock: b.clock, baseUrl: BASE, texts });
  for (const due of await listDueOutboxMessages(db, b.clock.now(), 1000)) {
    if (due.tenantId === b.tenantId) {
      await deliverOutboxMessage(db, due, {
        key: KEY,
        mailer: b.mailer,
        sms: b.sms,
        clock: b.clock,
      });
    }
  }
  return pass;
}

const reminderEmails = (b: Business) =>
  b.mailer.sent.filter((m) => m.subject.startsWith('Reminder:'));

/** The token in a text's or email's manage link. */
function tokenIn(text: string): string {
  const match = /\/book\/[a-z0-9-]+\/manage#([A-Za-z0-9_-]{43})/.exec(text);
  if (match?.[1] === undefined) throw new Error(`no link in: ${text}`);
  return match[1];
}

describe('reminder texts', () => {
  it('texts the day-before reminder to the consent’s number, once, with a working link', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    await runAt(b, at(2, '13:59'));
    expect(b.sms.sent).toEqual([]);
    await runAt(b, at(2, '14:00'));
    expect(b.sms.sent).toHaveLength(1);
    const [text] = b.sms.sent;
    expect(text?.to).toBe(consentPhone(b));
    expect(text?.body).toContain(
      'Juniper Hair Studio via Pepper: Reminder: Haircut with Jess on Tue, Nov 3 at 2:00 PM. Reply C to confirm.',
    );
    // The first reminder says how to stop (S62 top-up).
    expect(text?.body.endsWith('\nReply STOP to opt out.')).toBe(true);
    expect(reminderEmails(b)).toEqual([]);
    // The link opens this booking's manage page, and can move it.
    const token = ManageTokenSchema.parse(tokenIn(text?.body ?? ''));
    expect(await getManagedBooking(db, b.slug, token, { clock: b.clock })).toMatchObject({
      startsAt: at(3, '14:00'),
      changeable: true,
    });
    await runAt(b, at(2, '14:10'));
    expect(b.sms.sent).toHaveLength(1);
    // What the profile says (AC-X-76).
    expect((await getClientTexts(db, b.owner, b.maria.id)).lastText).toEqual({
      kind: 'day_before',
      at: at(2, '14:00'),
      state: 'delivered',
      reason: null,
    });
    expect(booking.id).toBeDefined();
  });

  it('says how to stop on the first reminder only', async () => {
    const b = await newBusiness();
    await consent(b);
    await book(b, at(3, '14:00'));
    await book(b, at(4, '14:00'));
    await runAt(b, at(2, '14:00'));
    await runAt(b, at(3, '12:00'));
    await runAt(b, at(3, '14:00'));
    const bodies = b.sms.sent.map((m) => m.body);
    expect(bodies).toHaveLength(3);
    expect(bodies.filter((body) => body.includes('Reply STOP'))).toHaveLength(1);
    expect(bodies[0]).toContain('Reply STOP to opt out.');
  });

  it('texts the same day at the lead, and a booking made under 24 hours ahead gets it', async () => {
    const b = await newBusiness();
    await consent(b);
    // Monday 16:00, made at 07:00: no day-before reminder, the same-day one at 14:00.
    const soon = await book(b, at(2, '16:00'));
    const reminders = await withTenant(db, b.tenantId, (tx) =>
      listBookingReminders(tx, BookingIdSchema.parse(soon.id)),
    );
    expect(reminders.map((r) => [r.kind, r.dueAt.toISOString()])).toEqual([
      ['same_day', at(2, '14:00')],
    ]);
    await runAt(b, at(2, '14:00'));
    expect(b.sms.sent.map((m) => m.body)).toEqual([
      expect.stringContaining(
        'See you today at 4:00 PM for Haircut with Jess. Reply C to confirm.',
      ),
    ]);
  });

  it('plans nothing for a booking made under the lead', async () => {
    const b = await newBusiness();
    await consent(b);
    // 08:00, 1 hour ahead of a 2-hour lead.
    const now = await book(b, at(2, '08:00'), true);
    expect(
      await withTenant(db, b.tenantId, (tx) =>
        listBookingReminders(tx, BookingIdSchema.parse(now.id)),
      ),
    ).toEqual([]);
  });

  it('moves the same-day text with the booking', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    await changeBooking(db, b.owner, booking.id, { startsAt: at(3, '17:00') }, { clock: b.clock });
    expect(
      await withTenant(db, b.tenantId, (tx) =>
        findBookingReminder(tx, BookingIdSchema.parse(booking.id), 'same_day'),
      ),
    ).toMatchObject({ dueAt: new Date(at(3, '15:00')), startsAt: new Date(at(3, '17:00')) });
  });

  it('emails the day-before reminder, with its own link, when the client can’t be texted', async () => {
    const b = await newBusiness();
    // No consent: the profile's phone is never texted.
    const booking = await book(b, at(3, '14:00'));
    await runAt(b, at(2, '14:00'));
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent).toEqual([]);
    const [email] = reminderEmails(b);
    expect(reminderEmails(b)).toHaveLength(1);
    const token = ManageTokenSchema.parse(tokenIn(email?.text ?? ''));
    const moved = await rescheduleManagedBooking(db, b.slug, token, at(4, '10:00'), {
      clock: b.clock,
    });
    expect(moved.booking.startsAt).toBe(at(4, '10:00'));
    expect(booking.id).toBeDefined();
  });

  it('falls back to email after a STOP, and drops the same-day text', async () => {
    const b = await newBusiness();
    await consent(b);
    await book(b, at(3, '14:00'));
    await withSmsInbound(db, (tx) =>
      insertSmsKeywordEvent(tx, {
        provider: 'sandbox',
        eventId: `stop-${newId()}`,
        phone: consentPhone(b),
        keyword: 'stop',
        origin: 'keyword',
        receivedAt: b.clock.now(),
      }),
    );
    await runAt(b, at(2, '14:00'));
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent).toEqual([]);
    expect(reminderEmails(b)).toHaveLength(1);
  });

  it('emails when the deployment doesn’t send texts, or the business turned texts off', async () => {
    const off = await newBusiness();
    await consent(off);
    await book(off, at(3, '14:00'));
    await runAt(off, at(2, '14:00'), false);
    expect(off.sms.sent).toEqual([]);
    expect(reminderEmails(off)).toHaveLength(1);

    const b = await newBusiness();
    await consent(b);
    await book(b, at(3, '14:00'));
    await withTenant(db, b.tenantId, (tx) =>
      setReminderSettings(tx, {
        texts: false,
        dayBefore: true,
        sameDay: true,
        sameDayLeadHours: 2,
      }),
    );
    await runAt(b, at(2, '14:00'));
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent).toEqual([]);
    expect(reminderEmails(b)).toHaveLength(1);
  });

  it('drops a kind turned off after it was planned', async () => {
    const b = await newBusiness();
    await consent(b);
    await book(b, at(3, '14:00'));
    await withTenant(db, b.tenantId, (tx) =>
      setReminderSettings(tx, {
        texts: true,
        dayBefore: false,
        sameDay: false,
        sameDayLeadHours: 2,
      }),
    );
    await runAt(b, at(2, '14:00'));
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent).toEqual([]);
    expect(reminderEmails(b)).toEqual([]);
  });

  it('queues one text when several workers take the same reminder at once', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    b.clock.set(new Date(at(3, '12:00')));
    const due = {
      bookingId: BookingIdSchema.parse(booking.id),
      kind: 'same_day' as const,
      tenantId: b.tenantId,
    };
    const results = await Promise.all(
      [1, 2, 3, 4].map(() =>
        sendDueReminder(db, due, { key: KEY, clock: b.clock, baseUrl: BASE, texts: true }),
      ),
    );
    expect(results.filter((r) => r === 'queued')).toHaveLength(1);
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent.filter((m) => m.body.includes('See you today'))).toHaveLength(1);
  });

  it('holds a text queued in the quiet hours; the profile shows when it will go', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    // A backlog: the job was down, and takes the day-before reminder at 21:00.
    await withTenant(db, b.tenantId, (tx) =>
      planBookingReminder(tx, {
        bookingId: BookingIdSchema.parse(booking.id),
        dueAt: new Date(at(2, '21:00')),
        startsAt: new Date(at(3, '14:00')),
      }),
    );
    await runAt(b, at(2, '21:00'));
    expect(b.sms.sent).toEqual([]);
    expect(
      await withTenant(db, b.tenantId, (tx) => findLastBookingText(tx, b.maria.id)),
    ).toMatchObject({
      kind: 'day_before',
      messageStatus: 'pending',
      availableAt: new Date(at(3, '08:00')),
    });
    await runAt(b, at(3, '08:00'));
    expect(b.sms.sent.map((m) => m.body)).toEqual([
      // Written out, never "tomorrow": it went the next morning.
      expect.stringContaining('Reminder: Haircut with Jess on Tue, Nov 3 at 2:00 PM.'),
    ]);
  });
});
