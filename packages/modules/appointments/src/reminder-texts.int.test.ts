import {
  BookingIdSchema,
  DEFAULT_REMINDER_SETTINGS,
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
import type * as Contracts from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deliverOutboxMessage,
  ForbiddenError,
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
  addMembership,
  countBookingManageLinks,
  findBookingReminder,
  findLastBookingText,
  insertSmsKeywordEvent,
  listAuditEntries,
  listBookings as listBookingRows,
  listBookingReminders,
  listDueOutboxMessages,
  markBookingClientConfirmed,
  newId,
  planBookingReminder,
  setReminderSettings,
  syncVisitRisks,
  withSmsInbound,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BookingNotFoundError } from './errors.js';
import { changeBooking, createBooking, listBookings } from './services/bookings.js';
import { confirmBookingByText } from './services/confirm-by-text.js';
import { getReminderSettings, updateReminderSettings } from './services/reminder-settings.js';
import { NOTHING_TO_CONFIRM_REPLY } from './texts.js';
import { replaceWorkingHours } from './services/hours.js';
import {
  confirmManagedBooking,
  getManagedBooking,
  rescheduleManagedBooking,
} from './services/public-booking.js';
import { sendDueReminder, sendDueReminders } from './services/reminders.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The holdback's share (S78.3) is a hash of the booking id; a test puts a visit in or out of it.
const inShare = vi.hoisted(() => new Map<string, boolean>());
vi.mock('@pepper/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  return {
    ...actual,
    inHoldbackShare: (id: string) => inShare.get(id) ?? actual.inHoldbackShare(id),
  };
});

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
        ...DEFAULT_REMINDER_SETTINGS,
        texts: false,
        dayBefore: true,
        sameDay: true,
        sameDayLeadHours: 2,
        askToConfirm: false,
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
        ...DEFAULT_REMINDER_SETTINGS,
        texts: true,
        dayBefore: false,
        sameDay: false,
        sameDayLeadHours: 2,
        askToConfirm: false,
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

describe('the confirm ask (S78, AC-X-201, AC-X-204, AC-X-205)', () => {
  /** Maria on Friday 14:00 (booked Monday): her ask is due Tuesday 14:00, 72 hours ahead. */
  async function askedVisit(
    b: Business,
    band: 'high' | 'medium' | null = 'high',
  ): Promise<Booking> {
    const booking = await book(b, at(6, '14:00'));
    // Turned on after the booking: the settings change plans its ask.
    await updateReminderSettings(db, b.owner, { askToConfirm: true }, { clock: b.clock });
    if (band !== null) {
      await withTenant(db, b.tenantId, (tx) =>
        syncVisitRisks(
          tx,
          [
            {
              bookingId: BookingIdSchema.parse(booking.id),
              band,
              points: band === 'high' ? 4 : 2,
              reasons: [
                { signal: 'missed_before', points: band === 'high' ? 4 : 2, misses: 3, visits: 4 },
              ],
            },
          ],
          b.clock.now(),
        ),
      );
    }
    return booking;
  }

  const askEmails = (b: Business) =>
    b.mailer.sent.filter((m) => m.subject.startsWith('Please confirm'));

  async function rowOf(b: Business, booking: Booking) {
    const rows = await withTenant(db, b.tenantId, (tx) =>
      listBookingRows(tx, { from: new Date(at(6, '00:00')), to: new Date(at(7, '00:00')) }),
    );
    return rows.find((row) => row.id === booking.id);
  }

  it('texts a high-band visit 72 hours ahead, once, records the ask, and a "C" answers it', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await askedVisit(b);
    await runAt(b, at(3, '13:59'));
    expect(b.sms.sent).toEqual([]);
    expect((await rowOf(b, booking))?.confirmAskedAt).toBeNull();
    await runAt(b, at(3, '14:00'));
    await runAt(b, at(3, '14:30'));
    expect(b.sms.sent).toHaveLength(1);
    expect(b.sms.sent[0]?.to).toBe(consentPhone(b));
    expect(b.sms.sent[0]?.body).toContain(
      'Juniper Hair Studio via Pepper: Please confirm Haircut with Jess on Fri, Nov 6 at 2:00 PM. Reply C by Thu, Nov 5 at 2:00 PM, or your time may be offered to others.',
    );
    expect((await rowOf(b, booking))?.confirmAskedAt?.toISOString()).toBe(at(3, '14:00'));
    const answer = await confirmBookingByText(db, {
      from: consentPhone(b),
      receivedAt: new Date(at(3, '15:00')),
    });
    expect(answer.outcome).toBe('confirmed');
    expect(await rowOf(b, booking)).toMatchObject({ clientConfirmedVia: 'text' });
  });

  it('emails the ask with the confirm link when the client can’t be texted', async () => {
    const b = await newBusiness();
    const booking = await askedVisit(b);
    await runAt(b, at(3, '14:00'));
    expect(b.sms.sent).toEqual([]);
    const [email] = askEmails(b);
    expect(askEmails(b)).toHaveLength(1);
    expect(email?.text).toContain(
      'Please confirm by Thursday, November 5 at 2:00 PM, or your time may be offered to others.',
    );
    const token = ManageTokenSchema.parse(tokenIn(email?.text ?? ''));
    const confirmed = await confirmManagedBooking(db, b.slug, token, at(6, '14:00'), {
      clock: b.clock,
    });
    expect(confirmed.confirm).toMatchObject({ confirmed: true });
    expect(await rowOf(b, booking)).toMatchObject({ clientConfirmedVia: 'link' });
  });

  it('names the business’s cut-off: 48 h before (S78.3, AC-X-218)', async () => {
    const b = await newBusiness();
    await askedVisit(b);
    await updateReminderSettings(db, b.owner, { confirmCutoffHours: 48 }, { clock: b.clock });
    await runAt(b, at(3, '14:00'));
    expect(askEmails(b)[0]?.text).toContain(
      'Please confirm by Wednesday, November 4 at 2:00 PM, or your time may be offered to others.',
    );
  });

  it('asks nobody else: a medium or unscored visit, a confirmed one, or with the ask off', async () => {
    const medium = await newBusiness();
    await consent(medium);
    await askedVisit(medium, 'medium');
    await runAt(medium, at(3, '14:00'));
    const unscored = await newBusiness();
    await askedVisit(unscored, null);
    await runAt(unscored, at(3, '14:00'));
    const confirmed = await newBusiness();
    await consent(confirmed);
    const visit = await askedVisit(confirmed);
    await withTenant(db, confirmed.tenantId, (tx) =>
      markBookingClientConfirmed(tx, BookingIdSchema.parse(visit.id), confirmed.clock.now()),
    );
    await runAt(confirmed, at(3, '14:00'));
    for (const b of [medium, unscored, confirmed]) {
      expect(b.sms.sent).toEqual([]);
      expect(askEmails(b)).toEqual([]);
    }
    // Off: nothing is even planned.
    const off = await newBusiness();
    const plain = await book(off, at(6, '14:00'));
    expect(
      await withTenant(db, off.tenantId, (tx) =>
        findBookingReminder(tx, BookingIdSchema.parse(plain.id), 'confirm_ask'),
      ),
    ).toBeUndefined();
  });

  it('the day-before email asks too while the business asks, and records it', async () => {
    const b = await newBusiness();
    const booking = await askedVisit(b, 'medium');
    await runAt(b, at(5, '14:00'));
    const [email] = reminderEmails(b);
    // It goes at the time to confirm by, so it asks without naming a time already gone.
    expect(email?.text).toContain('Please confirm your visit with the link below.');
    expect(email?.text).toContain('To confirm, reschedule or cancel');
    expect((await rowOf(b, booking))?.confirmAskedAt?.toISOString()).toBe(at(5, '14:00'));
  });
});

describe('the holdback (S78.3, AC-X-214, AC-X-215)', () => {
  /** Maria's Friday 14:00, in or out of the held-back share. */
  async function visitOf(b: Business, held: boolean, startsAt = at(6, '14:00')) {
    const booking = await book(b, startsAt);
    inShare.set(booking.id, held);
    return booking;
  }

  /** Scores `visits` high-band, in one pass (a pass replaces the business's scores). */
  async function scoreHigh(b: Business, visits: Booking[]) {
    await withTenant(db, b.tenantId, (tx) =>
      syncVisitRisks(
        tx,
        visits.map((visit) => ({
          bookingId: BookingIdSchema.parse(visit.id),
          band: 'high' as const,
          points: 4,
          reasons: [{ signal: 'missed_before' as const, points: 4, misses: 3, visits: 4 }],
        })),
        b.clock.now(),
      ),
    );
  }

  /** One high-band visit. */
  async function highVisit(b: Business, held: boolean) {
    const booking = await visitOf(b, held);
    await scoreHigh(b, [booking]);
    return booking;
  }

  const rowOf = async (b: Business, booking: Booking) =>
    (
      await withTenant(db, b.tenantId, (tx) =>
        listBookingRows(tx, { from: new Date(at(1, '00:00')), to: new Date(at(30, '00:00')) }),
      )
    ).find((row) => row.id === booking.id);

  /** The reminder job with the release check wired: the visits it would put a card up for. */
  async function releaseRun(b: Business, when: string) {
    b.clock.set(new Date(when));
    const carded: string[] = [];
    await sendDueReminders(db, {
      key: KEY,
      clock: b.clock,
      baseUrl: BASE,
      texts: true,
      onReleaseDue: (_tx, visit) => {
        // The job runs over every business; this one's only.
        if (visit.tenantId === b.tenantId) carded.push(visit.bookingId);
        return Promise.resolve(true);
      },
    });
    return carded;
  }

  it('holds nothing back while it is off, its default', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await highVisit(b, true);
    await updateReminderSettings(db, b.owner, { askToConfirm: true }, { clock: b.clock });
    expect((await getReminderSettings(db, b.owner)).settings.holdback).toBe(false);
    await runAt(b, at(3, '14:00'));
    expect(b.sms.sent).toHaveLength(1);
    expect(await rowOf(b, booking)).toMatchObject({ confirmHeldBackAt: null });
    expect((await rowOf(b, booking))?.confirmAskedAt?.toISOString()).toBe(at(3, '14:00'));
  });

  it('while on, a visit in the share gets no ask and no card and is marked; the rest are asked', async () => {
    const b = await newBusiness();
    await consent(b);
    const held = await visitOf(b, true);
    const asked = await visitOf(b, false, at(6, '16:00'));
    await scoreHigh(b, [held, asked]);
    await updateReminderSettings(
      db,
      b.owner,
      { askToConfirm: true, holdback: true },
      { clock: b.clock },
    );
    await runAt(b, at(3, '14:00'));
    await runAt(b, at(3, '16:00'));
    // One ask, for 4:00 PM only.
    expect(b.sms.sent).toHaveLength(1);
    expect(b.sms.sent[0]?.body).toContain('Fri, Nov 6 at 4:00 PM');
    expect(await rowOf(b, held)).toMatchObject({ confirmAskedAt: null });
    expect((await rowOf(b, held))?.confirmHeldBackAt?.toISOString()).toBe(at(3, '14:00'));
    expect(await rowOf(b, asked)).toMatchObject({ confirmHeldBackAt: null });
    // At the cut-off, a card for the asked visit only.
    expect(await releaseRun(b, at(5, '16:00'))).toEqual([asked.id]);
  });

  it('keeps the mark through a move, and no card even when a later reminder asks in time', async () => {
    const b = await newBusiness();
    await consent(b);
    const held = await highVisit(b, true);
    await updateReminderSettings(
      db,
      b.owner,
      { askToConfirm: true, holdback: true, confirmCutoffHours: 12 },
      { clock: b.clock },
    );
    await runAt(b, at(3, '14:00'));
    const marked = (await rowOf(b, held))?.confirmHeldBackAt?.toISOString();
    expect(marked).toBe(at(3, '14:00'));
    // Moved to Saturday: its new early ask is held back too, the first mark kept.
    b.clock.set(new Date(at(3, '15:00')));
    await changeBooking(db, b.owner, held.id, { startsAt: at(7, '14:00') }, { clock: b.clock });
    await runAt(b, at(4, '14:00'));
    expect(b.sms.sent).toEqual([]);
    expect((await rowOf(b, held))?.confirmHeldBackAt?.toISOString()).toBe(marked);
    // The day-before text asks "C" 12 h before the 12 h cut-off: early enough, still no card.
    await runAt(b, at(6, '14:00'));
    expect(b.sms.sent).toHaveLength(1);
    expect((await rowOf(b, held))?.confirmAskedAt?.toISOString()).toBe(at(6, '14:00'));
    expect(await releaseRun(b, at(7, '02:00'))).toEqual([]);
  });

  it('turned off, a visit marked earlier is asked and carded like any other (review)', async () => {
    const b = await newBusiness();
    await consent(b);
    const held = await highVisit(b, true);
    await updateReminderSettings(
      db,
      b.owner,
      { askToConfirm: true, holdback: true },
      { clock: b.clock },
    );
    await runAt(b, at(3, '14:00'));
    expect((await rowOf(b, held))?.confirmHeldBackAt).not.toBeNull();
    await updateReminderSettings(db, b.owner, { holdback: false }, { clock: b.clock });
    // Moved to Saturday: its new early ask goes, and the card comes at the cut-off.
    b.clock.set(new Date(at(3, '15:00')));
    await changeBooking(db, b.owner, held.id, { startsAt: at(7, '14:00') }, { clock: b.clock });
    await runAt(b, at(4, '14:00'));
    expect(b.sms.sent).toHaveLength(1);
    expect(await releaseRun(b, at(6, '14:00'))).toEqual([held.id]);
  });

  it('a 12 h cut-off cards a visit the day-before text asked (AC-X-218)', async () => {
    const b = await newBusiness();
    await consent(b);
    const visit = await book(b, at(6, '14:00'));
    await updateReminderSettings(
      db,
      b.owner,
      { askToConfirm: true, confirmCutoffHours: 12 },
      { clock: b.clock },
    );
    await runAt(b, at(5, '14:00'));
    expect(await releaseRun(b, at(6, '01:59'))).toEqual([]);
    expect(await releaseRun(b, at(6, '02:00'))).toEqual([visit.id]);
  });
});

describe('"C" to confirm (AC-X-74)', () => {
  /** Maria booked on Tuesday 14:00, her day-before reminder texted on Monday 14:00. */
  async function reminded(b: Business): Promise<Booking> {
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    await runAt(b, at(2, '14:00'));
    expect(b.sms.sent).toHaveLength(1);
    return booking;
  }

  it('confirms the reminded booking once, audited, and answers with its time', async () => {
    const b = await newBusiness();
    const booking = await reminded(b);
    const from = consentPhone(b);
    const requests = async () =>
      withTenant(db, b.tenantId, async (tx) => {
        const { rows } = await tx.execute<{ n: number }>(
          'SELECT count(*)::int AS n FROM insight_requests',
        );
        return rows[0]?.n ?? 0;
      });
    const before = await requests();
    const first = await confirmBookingByText(db, { from, receivedAt: new Date(at(2, '14:05')) });
    // The visit's risk is rescored on the next pass (S77).
    expect(await requests()).toBe(before + 1);
    expect(first).toEqual({
      outcome: 'confirmed',
      reply:
        "Juniper Hair Studio via Pepper: Thanks, you're confirmed for Haircut with Jess on Tue, Nov 3 at 2:00 PM. See you then!",
    });
    const [row] = await listBookings(db, b.owner, { from: at(3, '00:00'), to: at(4, '00:00') });
    expect(row).toMatchObject({ id: booking.id, clientConfirmedAt: at(2, '14:05') });
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(audit[0]).toMatchObject({
      action: 'booking.client_confirmed',
      actor: { kind: 'system' },
      entity: { type: 'booking', id: booking.id },
    });
    expect(JSON.stringify(audit[0])).not.toContain(from);
    // A second "C" (or Twilio's replay) changes nothing more.
    const again = await confirmBookingByText(db, { from, receivedAt: new Date(at(2, '15:00')) });
    expect(again.outcome).toBe('already');
    expect(again.reply).toContain("You're already confirmed");
    const audits = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 10 }));
    expect(audits.filter((e) => e.action === 'booking.client_confirmed')).toHaveLength(1);
    // The same-day text stops asking.
    await runAt(b, at(3, '12:00'));
    expect(b.sms.sent[1]?.body).toContain('See you today at 2:00 PM');
    expect(b.sms.sent[1]?.body).not.toContain('Reply C');
  });

  it('answers that there is nothing to confirm: no reminder, a cancelled or a started booking', async () => {
    const b = await newBusiness();
    await consent(b);
    await book(b, at(3, '14:00'));
    // No reminder has gone yet.
    expect(
      await confirmBookingByText(db, {
        from: consentPhone(b),
        receivedAt: new Date(at(2, '09:00')),
      }),
    ).toEqual({ outcome: 'nothing', reply: NOTHING_TO_CONFIRM_REPLY });

    const c = await newBusiness();
    const booking = await reminded(c);
    await changeBooking(db, c.owner, booking.id, { status: 'cancelled' }, { clock: c.clock });
    expect(
      (
        await confirmBookingByText(db, {
          from: consentPhone(c),
          receivedAt: new Date(at(2, '15:00')),
        })
      ).outcome,
    ).toBe('nothing');

    const d = await newBusiness();
    await reminded(d);
    expect(
      (
        await confirmBookingByText(db, {
          from: consentPhone(d),
          receivedAt: new Date(at(3, '14:30')),
        })
      ).outcome,
    ).toBe('nothing');
    expect(
      await confirmBookingByText(db, { from: 'not a number', receivedAt: new Date() }),
    ).toEqual({ outcome: 'nothing', reply: null });
  });

  it('confirms the soonest of two businesses’ reminded bookings on the number', async () => {
    const a = await newBusiness();
    const later = await newBusiness();
    const phone = consentPhone(a);
    await consent(a, phone);
    await consent(later, phone);
    const soon = await book(a, at(3, '14:00'));
    await book(later, at(3, '16:00'));
    await runAt(a, at(2, '14:00'));
    await runAt(later, at(2, '16:00'));
    const result = await confirmBookingByText(db, {
      from: phone,
      receivedAt: new Date(at(2, '16:05')),
    });
    expect(result.outcome).toBe('confirmed');
    const [row] = await listBookings(db, a.owner, { from: at(3, '00:00'), to: at(4, '00:00') });
    expect(row).toMatchObject({ id: soon.id, clientConfirmedAt: at(2, '16:05') });
    const [other] = await listBookings(db, later.owner, {
      from: at(3, '00:00'),
      to: at(4, '00:00'),
    });
    expect(other?.clientConfirmedAt).toBeNull();
  });

  it('confirms after a STOP but sends no reply', async () => {
    const b = await newBusiness();
    await reminded(b);
    await withSmsInbound(db, (tx) =>
      insertSmsKeywordEvent(tx, {
        provider: 'sandbox',
        eventId: `stop-${newId()}`,
        phone: consentPhone(b),
        keyword: 'stop',
        origin: 'keyword',
        receivedAt: new Date(at(2, '14:01')),
      }),
    );
    expect(
      await confirmBookingByText(db, {
        from: consentPhone(b),
        receivedAt: new Date(at(2, '14:05')),
      }),
    ).toEqual({ outcome: 'confirmed', reply: null });
  });
});

describe('texts and reminders settings (AC-X-75)', () => {
  it('answers the defaults, changes what a patch names, audited, and re-plans upcoming texts', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    expect(await getReminderSettings(db, b.owner)).toEqual({
      settings: {
        texts: true,
        dayBefore: true,
        sameDay: true,
        sameDayLeadHours: 2,
        askToConfirm: false,
        confirmCutoffHours: 24,
        holdback: false,
      },
      canChange: true,
    });
    const changed = await updateReminderSettings(
      db,
      b.owner,
      { sameDayLeadHours: 3 },
      { clock: b.clock },
    );
    expect(changed.settings).toMatchObject({ sameDayLeadHours: 3, dayBefore: true });
    expect(
      await withTenant(db, b.tenantId, (tx) =>
        findBookingReminder(tx, BookingIdSchema.parse(booking.id), 'same_day'),
      ),
    ).toMatchObject({ dueAt: new Date(at(3, '11:00')) });
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(audit[0]).toMatchObject({
      action: 'reminders.settings_updated',
      actor: { kind: 'user', userId: b.owner.context.userId },
      before: { sameDayLeadHours: 2 },
      after: { sameDayLeadHours: 3 },
    });
    // Turned off: the planned reminders go; on again: they come back.
    await updateReminderSettings(
      db,
      b.owner,
      { dayBefore: false, sameDay: false },
      { clock: b.clock },
    );
    expect(
      await withTenant(db, b.tenantId, (tx) =>
        listBookingReminders(tx, BookingIdSchema.parse(booking.id)),
      ),
    ).toEqual([]);
    await updateReminderSettings(db, b.owner, { dayBefore: true }, { clock: b.clock });
    expect(
      (
        await withTenant(db, b.tenantId, (tx) =>
          listBookingReminders(tx, BookingIdSchema.parse(booking.id)),
        )
      ).map((r) => r.kind),
    ).toEqual(['day_before']);
    // The same settings again change nothing and audit nothing.
    const before = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 50 }));
    await updateReminderSettings(db, b.owner, { dayBefore: true }, { clock: b.clock });
    const after = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 50 }));
    expect(after).toHaveLength(before.length);
  });

  it('lets staff read but not change them', async () => {
    const b = await newBusiness();
    const staffId = await insertUser(db, 'Jess');
    await withTenant(db, b.tenantId, (tx) => addMembership(tx, { userId: staffId, role: 'staff' }));
    const staff: Actor = { context: { tenantId: b.tenantId, userId: staffId, role: 'staff' } };
    expect((await getReminderSettings(db, staff)).canChange).toBe(false);
    await expect(updateReminderSettings(db, staff, { texts: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await getReminderSettings(db, b.owner)).settings.texts).toBe(true);
  });
});

describe('review fixes (S62)', () => {
  const linksOf = (b: Business, bookingId: string) =>
    withTenant(db, b.tenantId, (tx) =>
      countBookingManageLinks(tx, BookingIdSchema.parse(bookingId)),
    );

  it('a team move ends the reminder’s link, and clears the client’s "C"', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    await runAt(b, at(2, '14:00'));
    const token = ManageTokenSchema.parse(tokenIn(b.sms.sent[0]?.body ?? ''));
    await confirmBookingByText(db, { from: consentPhone(b), receivedAt: new Date(at(2, '14:05')) });
    await changeBooking(
      db,
      b.owner,
      booking.id,
      { startsAt: at(3, '17:00') },
      { clock: b.clock, notify: () => Promise.resolve() },
    );
    await expect(getManagedBooking(db, b.slug, token, { clock: b.clock })).rejects.toBeInstanceOf(
      BookingNotFoundError,
    );
    const [row] = await listBookings(db, b.owner, { from: at(3, '00:00'), to: at(4, '00:00') });
    expect(row?.clientConfirmedAt).toBeNull();
    // A "C" now finds nothing: the reminder was about 2:00 PM.
    expect(
      (
        await confirmBookingByText(db, {
          from: consentPhone(b),
          receivedAt: new Date(at(2, '15:00')),
        })
      ).outcome,
    ).toBe('nothing');
  });

  it('a "C" reaches the second reminded booking once the first is confirmed', async () => {
    const b = await newBusiness();
    await consent(b);
    const first = await book(b, at(3, '14:00'));
    const second = await book(b, at(3, '16:00'));
    await runAt(b, at(2, '14:00'));
    await confirmBookingByText(db, { from: consentPhone(b), receivedAt: new Date(at(2, '14:05')) });
    await runAt(b, at(2, '16:00'));
    await confirmBookingByText(db, { from: consentPhone(b), receivedAt: new Date(at(2, '16:05')) });
    const rows = await listBookings(db, b.owner, { from: at(3, '00:00'), to: at(4, '00:00') });
    expect(rows.map((r) => [r.id, r.clientConfirmedAt])).toEqual([
      [first.id, at(2, '14:05')],
      [second.id, at(2, '16:05')],
    ]);
  });

  it('a settings change keeps a reminder that is due but not yet sent', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    // The job hasn't run since Monday 14:00 fell due.
    b.clock.set(new Date(at(2, '14:03')));
    await updateReminderSettings(db, b.owner, { sameDayLeadHours: 1 }, { clock: b.clock });
    expect(
      await withTenant(db, b.tenantId, (tx) =>
        findBookingReminder(tx, BookingIdSchema.parse(booking.id), 'day_before'),
      ),
    ).toBeDefined();
    await runAt(b, at(2, '14:04'));
    expect(b.sms.sent.map((m) => m.body)).toEqual([expect.stringContaining('Reminder: Haircut')]);
  });

  it('keeps no link for a reminder that was queued already', async () => {
    const b = await newBusiness();
    await consent(b);
    const booking = await book(b, at(3, '14:00'));
    await runAt(b, at(2, '14:00'));
    expect(await linksOf(b, booking.id)).toBe(1);
    // Planned again for the same start: the text is deduped, and so is its new link.
    await withTenant(db, b.tenantId, (tx) =>
      planBookingReminder(tx, {
        bookingId: BookingIdSchema.parse(booking.id),
        dueAt: new Date(at(2, '14:10')),
        startsAt: new Date(at(3, '14:00')),
      }),
    );
    await runAt(b, at(2, '14:10'));
    expect(b.sms.sent).toHaveLength(1);
    expect(await linksOf(b, booking.id)).toBe(1);
  });
});
