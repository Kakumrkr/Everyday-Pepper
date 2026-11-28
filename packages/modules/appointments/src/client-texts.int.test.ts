import {
  ClientIdSchema,
  DEFAULT_REMINDER_SETTINGS,
  FeedItemIdSchema,
  OutboxMessageIdSchema,
  TenantIdSchema,
  type Booking,
  type Client,
  type FeedItem,
  type TenantId,
} from '@pepper/contracts';
import {
  createBusiness,
  createClient,
  deliverOutboxMessage,
  feedForAiIn,
  ForbiddenError,
  getClientTexts,
  getFeed,
  ManualClock,
  outboxKeyFrom,
  recordSmsConsent,
  type Actor,
  type Mailer,
  type SmsAccepted,
  type SmsMessage,
  type SmsSender,
} from '@pepper/core';
import {
  addMembership,
  closeFeedItem,
  insertBookingText,
  insertOutboxMessage,
  insertSmsKeywordEvent,
  listAuditEntries,
  listDueOutboxMessages,
  newId,
  setReminderSettings,
  withMember,
  withSmsInbound,
  withTenant,
  type Database,
  countOutboxMessagesByKey,
} from '@pepper/db';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClientTextNotSendableError } from './errors.js';
import { createBooking } from './services/bookings.js';
import {
  keepClientText,
  replyToClientText,
  undoClientTextReply,
  type InboundClientText,
} from './services/client-texts.js';
import { replaceWorkingHours } from './services/hours.js';
import { createService } from './services/services.js';
import { createStaffMember } from './services/staff.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Client texts kept (S80, ADR-0072, AC-X-229…236) through the domain services against real
// Postgres: a text routed to the one business that texted the number, its card for owners and
// managers with the next visit, Reply as a text from the business with Undo, and the profile's
// texts and consents.

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

const KEY = outboxKeyFrom('a-client-text-test-outbox-secret-32+chars');
// Monday 2 November 2026, 10:00 in New York (EST): inside the sending hours.
const NOW = '2026-11-02T15:00:00.000Z';
const MINUTE = 60_000;

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
const mailer: Mailer = { send: () => Promise.resolve() };

interface Business {
  tenantId: TenantId;
  owner: Actor;
  staff: Actor;
  maria: Client;
  /** The number Maria said yes on: one per business (a STOP opts out for all of Pepper). */
  phone: string;
  visit: Booking;
  clock: ManualClock;
  sms: RecordingSms;
}

async function newBusiness(): Promise<Business> {
  slugs += 1;
  const ownerId = await insertUser(db, 'Ana');
  const staffId = await insertUser(db, 'Jess');
  const tenant = await createBusiness(db, ownerId, {
    name: 'Juniper Hair Studio',
    slug: `juniper-client-texts-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: staffId, role: 'staff' }));
  const owner: Actor = { context: { tenantId, userId: ownerId, role: 'owner' } };
  const staff: Actor = { context: { tenantId, userId: staffId, role: 'staff' } };
  const clock = new ManualClock(NOW);
  const service = await createService(db, owner, { name: 'Haircut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })),
  });
  const phone = `+1212556${String(slugs).padStart(4, '0')}`;
  const maria = await createClient(db, owner, {
    name: 'Maria Lopez',
    email: 'maria@example.test',
    phone,
  });
  await withTenant(db, tenantId, (tx) =>
    recordSmsConsent(
      tx,
      {
        phone,
        source: 'booking_page',
        clientId: maria.id,
        wordingVersion: 'sms-consent-v1',
        givenAt: clock.now(),
      },
      { actor: { kind: 'system' } },
    ),
  );
  const visit = await createBooking(
    db,
    owner,
    {
      clientId: maria.id,
      serviceId: service.id,
      staffMemberId: jess.id,
      startsAt: '2026-11-05T19:00:00.000Z',
      notifyClient: false,
    },
    { clock },
  );
  // The business texted Maria's number an hour ago (a confirmation).
  await withTenant(db, tenantId, async (tx) => {
    const id = OutboxMessageIdSchema.parse(newId());
    await insertOutboxMessage(tx, {
      id,
      type: 'sms',
      dedupeKey: `test.text:${id}`,
      payload: randomBytes(16),
      availableAt: clock.now(),
    });
    await insertBookingText(tx, {
      id,
      clientId: maria.id,
      bookingId: visit.id,
      kind: 'confirmation',
      startsAt: new Date(visit.startsAt),
      createdAt: new Date(clock.now().getTime() - 60 * MINUTE),
    });
  });
  return { tenantId, owner, staff, maria, phone, visit, clock, sms: new RecordingSms() };
}

function text(b: Business, body: string, at = b.clock.now()): InboundClientText {
  return {
    provider: 'sandbox',
    eventId: `SM${randomBytes(8).toString('hex')}`,
    from: b.phone,
    body,
    receivedAt: at,
  };
}

async function cards(b: Business, actor = b.owner): Promise<FeedItem[]> {
  const feed = await getFeed(db, actor, { clock: b.clock });
  return feed.suggestions.filter((item) => item.kind === 'client_text');
}

/** This business's due outbox delivered at `when`. */
async function deliverAt(b: Business, when: Date): Promise<void> {
  b.clock.set(when);
  for (const due of await listDueOutboxMessages(db, when, 1000)) {
    if (due.tenantId !== b.tenantId) continue;
    await deliverOutboxMessage(db, due, { key: KEY, mailer, sms: b.sms, clock: b.clock });
  }
}

const options = (b: Business) => ({ texts: true, outboxKey: KEY, clock: b.clock });

describe('a client’s text kept (AC-X-229, AC-X-232)', () => {
  it('is kept by the business that texted the number, on one card a day with the next visit', async () => {
    const b = await newBusiness();
    expect(await keepClientText(db, text(b, '  Can I bring my daughter?  '))).toEqual({
      outcome: 'kept',
      replay: false,
    });
    const [card] = await cards(b);
    expect(card).toMatchObject({
      kind: 'client_text',
      day: '2026-11-02',
      subjects: { clientId: b.maria.id, bookingId: b.visit.id },
      names: { client: 'Maria Lopez', service: 'Haircut', staff: 'Jess' },
      payload: {
        body: 'Can I bring my daughter?',
        count: 1,
        nextVisitStartsAt: b.visit.startsAt,
      },
    });

    // A second text that day updates the same card; a replay is kept once.
    const second = text(b, 'Running 10 late', new Date(b.clock.now().getTime() + MINUTE));
    await keepClientText(db, second);
    expect(await keepClientText(db, second)).toEqual({ outcome: 'kept', replay: true });
    const after = await cards(b);
    expect(after).toHaveLength(1);
    expect(after[0]?.payload).toMatchObject({ body: 'Running 10 late', count: 2 });

    // Audited as the system, without the words.
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 20 }));
    const received = audit.filter((entry) => entry.action === 'client_text.received');
    expect(received).toHaveLength(2);
    expect(JSON.stringify(received)).not.toContain('late');
  });

  it('queues one reading per kept text when a model is configured (AC-X-242)', async () => {
    const b = await newBusiness();
    const readings = async () =>
      withTenant(db, b.tenantId, (tx) => countOutboxMessagesByKey(tx, 'client_text:'));
    // Without a model: the card alone.
    await keepClientText(db, text(b, 'See you then'));
    expect(await readings()).toBe(0);
    const sent = text(b, 'Running 10 late', new Date(b.clock.now().getTime() + MINUTE));
    expect(await keepClientText(db, sent, { read: { key: KEY } })).toEqual({
      outcome: 'kept',
      replay: false,
    });
    // A replay queues nothing more.
    await keepClientText(db, sent, { read: { key: KEY } });
    expect(await readings()).toBe(1);
    // A text no business fits queues nothing.
    await keepClientText(db, { ...text(b, 'Hello'), from: '+15550000000' }, { read: { key: KEY } });
    expect(await readings()).toBe(1);
  });

  it('shows the card to owners only, never to staff or in the AI’s feed read', async () => {
    const b = await newBusiness();
    await keepClientText(db, text(b, 'Hi there'));
    expect(await cards(b)).toHaveLength(1);
    expect(await cards(b, b.staff)).toEqual([]);
    const ai = await withMember(db, b.owner.context, (tx) =>
      feedForAiIn(tx, b.owner, b.clock.now()),
    );
    expect(ai.suggestions.map((item) => item.kind)).not.toContain('client_text');
  });

  it('keeps nothing when two businesses texted the number', async () => {
    const a = await newBusiness();
    const other = await newBusiness();
    // The other business texted Maria's number in A too.
    await withTenant(db, other.tenantId, (tx) =>
      recordSmsConsent(
        tx,
        {
          phone: a.phone,
          source: 'booking_page',
          clientId: other.maria.id,
          wordingVersion: 'sms-consent-v1',
          givenAt: other.clock.now(),
        },
        { actor: { kind: 'system' } },
      ),
    );
    expect(await keepClientText(db, text(a, 'Which one?'))).toEqual({ outcome: 'unrouted' });
    expect(await cards(a)).toEqual([]);
    expect(await cards(other)).toEqual([]);
  });
});

describe('Reply (AC-X-233)', () => {
  it('queues the words as a text from the business, closes the card and sends after the hold', async () => {
    const b = await newBusiness();
    await keepClientText(db, text(b, 'Can I come at 3?'));
    const [card] = await cards(b);
    const reply = await replyToClientText(
      db,
      b.owner,
      b.maria.id,
      { body: 'Yes, 3 works. See you then', feedItemId: card?.id },
      options(b),
    );
    expect(Date.parse(reply.sendsAt)).toBe(b.clock.now().getTime() + 10_000);
    expect(await cards(b)).toEqual([]);
    await deliverAt(b, new Date(Date.parse(reply.sendsAt)));
    expect(b.sms.sent).toEqual([
      expect.objectContaining({
        to: b.phone,
        body: 'Juniper Hair Studio via Pepper: Yes, 3 works. See you then',
      }),
    ]);
    const audit = await withTenant(db, b.tenantId, (tx) => listAuditEntries(tx, { limit: 20 }));
    const replied = audit.find((entry) => entry.action === 'client_text.replied');
    expect(replied?.actor).toMatchObject({ kind: 'user', userId: b.owner.context.userId });
    expect(JSON.stringify(replied)).not.toContain('3 works');
    // The profile shows both, newest first.
    const profile = await getClientTexts(db, b.owner, b.maria.id);
    expect(profile.messages.map((m) => [m.from, m.body])).toEqual([
      ['team', 'Yes, 3 works. See you then'],
      ['client', 'Can I come at 3?'],
    ]);
    expect(profile.canReply).toBe(true);
    // A text back from the client comes to this business again (a reply counts as a text).
    expect((await keepClientText(db, text(b, 'Great'))).outcome).toBe('kept');
  });

  it('holds a reply written after 8 pm until 8 am', async () => {
    const b = await newBusiness();
    b.clock.set(new Date('2026-11-03T02:30:00.000Z')); // 9:30 pm in New York
    const reply = await replyToClientText(db, b.owner, b.maria.id, { body: 'Sure' }, options(b));
    expect(reply.sendsAt).toBe('2026-11-03T13:00:00.000Z');
  });

  it('Undo takes it back before it goes, and opens the card again', async () => {
    const b = await newBusiness();
    await keepClientText(db, text(b, 'Can I come at 3?'));
    const [card] = await cards(b);
    const reply = await replyToClientText(
      db,
      b.owner,
      b.maria.id,
      { body: 'Oops', feedItemId: card?.id },
      options(b),
    );
    expect(await undoClientTextReply(db, b.owner, b.maria.id, reply.replyId, options(b))).toEqual({
      outcome: 'taken_back',
    });
    expect(await cards(b)).toHaveLength(1);
    await deliverAt(b, new Date(b.clock.now().getTime() + MINUTE));
    expect(b.sms.sent).toEqual([]);
    expect((await getClientTexts(db, b.owner, b.maria.id)).messages).toHaveLength(1);
    await expect(
      undoClientTextReply(db, b.owner, b.maria.id, reply.replyId, options(b)),
    ).rejects.toBeInstanceOf(ClientTextNotSendableError);
  });

  it('Undo of a reply from the profile leaves a card the owner closed closed', async () => {
    const b = await newBusiness();
    await keepClientText(db, text(b, 'Thanks'));
    const [card] = await cards(b);
    await withMember(db, b.owner.context, (tx) =>
      closeFeedItem(tx, FeedItemIdSchema.parse(card?.id), 'done', b.clock.now()),
    );
    const reply = await replyToClientText(db, b.owner, b.maria.id, { body: 'Anytime' }, options(b));
    expect(await undoClientTextReply(db, b.owner, b.maria.id, reply.replyId, options(b))).toEqual({
      outcome: 'taken_back',
    });
    expect(await cards(b)).toEqual([]);
  });

  it('is too late once sent', async () => {
    const b = await newBusiness();
    const reply = await replyToClientText(db, b.owner, b.maria.id, { body: 'Hi' }, options(b));
    await deliverAt(b, new Date(Date.parse(reply.sendsAt)));
    expect(b.sms.sent).toHaveLength(1);
    expect(await undoClientTextReply(db, b.owner, b.maria.id, reply.replyId, options(b))).toEqual({
      outcome: 'too_late',
    });
  });

  it('is refused to staff, with texts off, without a consent, after a STOP and when too long', async () => {
    const b = await newBusiness();
    const reason = async (work: Promise<unknown>) =>
      work.then(
        () => 'sent',
        (error: unknown) =>
          error instanceof ClientTextNotSendableError ? error.reason : (error as Error).name,
      );
    expect(
      await reason(replyToClientText(db, b.staff, b.maria.id, { body: 'Hi' }, options(b))),
    ).toBe(new ForbiddenError().name);
    expect(
      await reason(
        replyToClientText(db, b.owner, b.maria.id, { body: 'Hi' }, { ...options(b), texts: false }),
      ),
    ).toBe('texts_off');
    await withTenant(db, b.tenantId, (tx) =>
      setReminderSettings(tx, { ...DEFAULT_REMINDER_SETTINGS, texts: false }),
    );
    expect(
      await reason(replyToClientText(db, b.owner, b.maria.id, { body: 'Hi' }, options(b))),
    ).toBe('texts_off');
    await withTenant(db, b.tenantId, (tx) =>
      setReminderSettings(tx, { ...DEFAULT_REMINDER_SETTINGS, texts: true }),
    );
    const noConsent = await createClient(db, b.owner, {
      name: 'Sam Lee',
      email: 'sam@example.test',
    });
    expect(
      await reason(
        replyToClientText(
          db,
          b.owner,
          ClientIdSchema.parse(noConsent.id),
          { body: 'Hi' },
          options(b),
        ),
      ),
    ).toBe('no_consent');
    // Emoji make a text UCS-2: 300 of them never fit three segments.
    expect(
      await reason(
        replyToClientText(db, b.owner, b.maria.id, { body: '🙂'.repeat(150) }, options(b)),
      ),
    ).toBe('too_long');
    await withSmsInbound(db, (tx) =>
      insertSmsKeywordEvent(tx, {
        provider: 'sandbox',
        eventId: `SM${randomBytes(8).toString('hex')}`,
        phone: b.phone,
        keyword: 'stop',
        origin: 'keyword',
        receivedAt: b.clock.now(),
      }),
    );
    expect(
      await reason(replyToClientText(db, b.owner, b.maria.id, { body: 'Hi' }, options(b))),
    ).toBe('no_consent');
    expect((await getClientTexts(db, b.owner, b.maria.id)).canReply).toBe(false);
  });
});

describe('the profile’s consents (AC-X-236)', () => {
  it('lists each consent in force with its purpose', async () => {
    const b = await newBusiness();
    await withTenant(db, b.tenantId, (tx) =>
      recordSmsConsent(
        tx,
        {
          phone: b.phone,
          source: 'staff_recorded',
          clientId: b.maria.id,
          wordingVersion: 'sms-consent-v3',
          givenAt: new Date(b.clock.now().getTime() + MINUTE),
        },
        { actor: { kind: 'system' } },
      ),
    );
    const profile = await getClientTexts(db, b.owner, b.maria.id);
    expect(profile.consents.map((c) => [c.purpose, c.source, c.optedOut])).toEqual([
      ['waitlist_offer', 'staff_recorded', false],
      ['appointments', 'booking_page', false],
    ]);
    expect(profile.consents[0]?.words).toContain("Text me when a time I'm waiting for opens up");
    // Staff who may see the client see the same, without Reply.
    expect(
      (await getClientTexts(db, b.staff, b.maria.id).catch(() => null))?.canReply ?? false,
    ).toBe(false);
  });
});
