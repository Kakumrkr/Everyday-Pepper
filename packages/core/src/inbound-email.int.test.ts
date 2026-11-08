import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  appendSupportMessage,
  createDatabase,
  inboundEmails,
  insertSupportScreenshot,
  listAuditEntries,
  listDueOutboxMessages,
  newId,
  setSupportThreadStatus,
  supportThreads,
  withMember,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import type { InboundEmail, InboundMailSource } from './inbound-email.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import {
  inboundNoteText,
  processInboundEmails,
  recordInboundEmail,
  type InboundEmailOptions,
} from './services/inbound-email.js';
import { deliverOutboxMessage } from './services/outbox.js';
import type { ScreenshotStorage } from './services/support-screenshots.js';
import {
  answerSupportThread,
  openSupportThread,
  readSupportThread,
  SUPPORT_REPLY_ABOVE,
  type SupportOptions,
} from './services/support.js';
import {
  supportReplyAddress,
  supportReplyKeysFrom,
  supportThreadRootId,
} from './support-reply-address.js';
import {
  insertUser,
  loadInboundFixture,
  startTestDatabase,
  type TestDatabase,
} from './test-support.js';

// Replies by email against real Postgres (S59.3, ADR-0063, AC-X-32…39): each recorded client's
// reply lands in its thread as the member's; forged, unknown, unverified, automatic, looping,
// oversized and empty ones don't; the sender is told what didn't go through; images become
// screenshots under the upload's rules; a reply to an old solved request opens a follow-up.

let database: TestDatabase;
let db: Database;
// Reads inbound rows and threads as the owner (tests only): the services reach them only in
// their own contexts.
let admin: DatabaseHandle;
let tenant: TenantId;
// Ana owns Juniper, Jess and Ben are staff; Olga owns another business.
let ana: UserId;
let jess: UserId;
let ben: UserId;
let olga: UserId;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const DOMAIN = 'reply.pepper.test';
const SES = 'amazonses.com';
const replyKeys = supportReplyKeysFrom(key);
let clock: ManualClock;
let source: FakeSource;
let store: FakeScreenshots;
let options: InboundEmailOptions;

const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff', at = tenant): Actor => ({
  context: { tenantId: at, userId, role },
});

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    this.sent.push(message);
  }
}

/** The provider's API in memory: an id names an email; `failing` makes every fetch throw. */
class FakeSource implements InboundMailSource {
  readonly emails = new Map<string, InboundEmail>();
  failing = false;
  fetch(id: string): Promise<InboundEmail | null> {
    if (this.failing) return Promise.reject(new Error('provider down'));
    return Promise.resolve(this.emails.get(id) ?? null);
  }
}

/** The screenshot port in memory: PNG (0x89) kept, HEIC refused as `heic`, the rest refused. */
class FakeScreenshots implements ScreenshotStorage {
  readonly images = new Map<string, Uint8Array>();
  process(bytes: Uint8Array): ReturnType<ScreenshotStorage['process']> {
    if (bytes[0] === 0x89) {
      return Promise.resolve({
        kind: 'image',
        width: 800,
        height: 600,
        variants: [
          { width: 480, data: Uint8Array.of(1) },
          { width: 800, data: Uint8Array.of(2, 2) },
        ],
      });
    }
    const heic = Buffer.from(bytes.subarray(4, 12)).toString('latin1') === 'ftypheic';
    return Promise.resolve({
      kind: 'rejected',
      reason: heic ? 'heic' : 'unsupported_type',
      message: 'no',
    });
  }
  put(tenantId: string, id: string, width: number, data: Uint8Array): Promise<void> {
    this.images.set(`${tenantId}/${id}/${String(width)}`, data);
    return Promise.resolve();
  }
  get(tenantId: string, id: string, width: number): Promise<Uint8Array | null> {
    return Promise.resolve(this.images.get(`${tenantId}/${id}/${String(width)}`) ?? null);
  }
  delete(
    screenshots: readonly { tenantId: string; id: string; widths: readonly number[] }[],
  ): Promise<void> {
    for (const { tenantId, id, widths } of screenshots) {
      for (const width of widths) this.images.delete(`${tenantId}/${id}/${String(width)}`);
    }
    return Promise.resolve();
  }
}

async function deliverAll(): Promise<EmailMessage[]> {
  const mailer = new FakeMailer();
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    await deliverOutboxMessage(db, due, { key, mailer, clock });
  }
  return mailer.sent;
}

let counter = 0;

/** A request opened by `opener`, and what its emails carry. */
async function request(opener: UserId = jess, role: 'owner' | 'staff' = 'staff') {
  const created = await openSupportThread(
    db,
    actor(opener, role),
    { kind: 'problem', message: 'The calendar is empty' },
    { userAgent: null },
    options,
  );
  const id = created.id ?? '';
  return {
    id,
    reference: created.reference,
    reply: supportReplyAddress(replyKeys, created.reference, DOMAIN),
    root: supportThreadRootId(replyKeys, created.reference, DOMAIN),
  };
}

/** Announces an email as the webhook would, then runs one pass of the job. */
async function receive(email: InboundEmail, ids: { eventId?: string; messageId?: string } = {}) {
  counter += 1;
  const providerEmailId = `email_${String(counter)}`;
  source.emails.set(providerEmailId, email);
  const stored = await recordInboundEmail(db, {
    provider: 'resend',
    eventId: ids.eventId ?? `msg_${String(counter)}`,
    providerEmailId,
    messageId: ids.messageId ?? `<in${String(counter)}@mail.test>`,
    receivedAt: clock.now(),
  });
  return { stored, result: await processInboundEmails(db, options), providerEmailId };
}

async function fixture(
  name: string,
  thread: { reference: string; reply: string; root: string },
  from = 'jess@juniper.test',
) {
  return loadInboundFixture(name, {
    from,
    reply: thread.reply,
    root: thread.root,
    ref: thread.reference,
  });
}

/** The newest inbound row (ids are time-ordered). */
async function lastInbound() {
  const rows = await admin.db.select().from(inboundEmails);
  const row = rows.sort((a, b) => (a.id < b.id ? 1 : -1))[0];
  return row === undefined
    ? undefined
    : {
        status: row.status,
        reason: row.reason,
        from_address: row.fromAddress,
        held_text: row.heldText,
        tenant_id: row.tenantId,
      };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  admin = createDatabase({ url: database.migrationUrl, maxConnections: 1 });
  ana = await insertUser(db, 'Ana Ruiz', 'ana@juniper.test');
  jess = await insertUser(db, 'Jess Park', 'jess@juniper.test');
  ben = await insertUser(db, 'Ben Okafor', 'ben@juniper.test');
  olga = await insertUser(db, 'Olga', 'olga@fig.test');
  tenant = TenantIdSchema.parse(
    (
      await createBusiness(db, ana, {
        name: 'Juniper Hair Studio',
        slug: 'juniper-inbound',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  await createBusiness(db, olga, { name: 'Fig', slug: 'fig-inbound', timeZone: 'UTC' });
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: ben, role: 'staff' });
  });
});

// Each test a few days after the last, so a day's limits and earlier emails don't carry over.
let day = Date.UTC(2026, 10, 8, 15);

beforeEach(async () => {
  day += 3 * 24 * 60 * 60 * 1000;
  clock = new ManualClock(new Date(day));
  source = new FakeSource();
  store = new FakeScreenshots();
  options = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    release: '1.5.0+abc',
    inboundDomain: DOMAIN,
    authservId: SES,
    source,
    store,
    clock,
  };
  await deliverAll();
});

afterAll(async () => {
  await admin.close();
  await database.stop();
});

describe('emails to a member carry the request’s signed reply address (AC-X-32)', () => {
  it('answers with Reply-To the request, In-Reply-To and References, and the marker first', async () => {
    const thread = await request();
    await deliverAll();
    await answerSupportThread(db, tenant, thread.id, { message: 'Pull down to refresh.' }, options);
    const [answer] = await deliverAll();
    expect(answer).toMatchObject({
      to: 'jess@juniper.test',
      replyTo: thread.reply,
      inReplyTo: thread.root,
      references: [thread.root],
    });
    expect(answer?.text.split('\n')[0]).toBe(SUPPORT_REPLY_ABOVE);
    expect(answer?.text).toContain('Reply to this email, or read it and reply in the app');
  });

  it('keeps Reply-To the team without an inbound domain', async () => {
    const plain: SupportOptions = { ...options, inboundDomain: null };
    const thread = await request();
    await answerSupportThread(db, tenant, thread.id, { message: 'Hi' }, plain);
    const answer = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(answer).toMatchObject({ replyTo: 'support@pepper.test' });
    expect(answer?.inReplyTo).toBeUndefined();
    expect(answer?.text.startsWith('Hi Jess')).toBe(true);
  });
});

describe('a verified reply lands in its thread (AC-X-34, AC-X-39)', () => {
  it.each(['gmail-reply', 'outlook-reply', 'apple-mail-reply'])(
    '%s: the member’s words only, "by email", waiting on Pepper, the team told',
    async (name) => {
      const thread = await request();
      await answerSupportThread(db, tenant, thread.id, { message: 'Pull down.' }, options);
      await deliverAll();
      const { email, expected } = await fixture(name, thread);
      const { result } = await receive(email);
      expect(result).toMatchObject({ landed: 1, held: 0, ignored: 0, refused: 0 });
      const read = await readSupportThread(db, actor(jess, 'staff'), thread.id);
      expect(read.status).toBe('waiting_on_pepper');
      expect(read.messages.at(-1)).toMatchObject({
        author: { kind: 'you' },
        body: expected,
        channel: 'email',
      });
      expect(read.messages[0]?.channel).toBe('app');
      const mail = await deliverAll();
      const team = mail.filter((message) => message.to === 'support@pepper.test');
      expect(team).toHaveLength(1);
      expect(team[0]?.text.split('\n')[0]).toContain('a new reply · by email');
      // Nothing went back to the sender: nothing was cut or left out.
      expect(mail.filter((message) => message.to === 'jess@juniper.test')).toEqual([]);
      expect(await lastInbound()).toMatchObject({
        status: 'landed',
        from_address: null,
        held_text: null,
      });
      const audit = await withTenant(db, tenant, (tx) => listAuditEntries(tx, { limit: 200 }));
      expect(
        audit.find(
          (entry) => entry.entity.id === thread.id && entry.action === 'support_thread.replied',
        ),
      ).toMatchObject({
        actor: { kind: 'user', userId: jess },
        after: { status: 'waiting_on_pepper', channel: 'email' },
      });
    },
  );

  it('lands a teammate who may read the request as theirs (an owner)', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread, 'Ana@Juniper.test');
    expect((await receive(email)).result.landed).toBe(1);
    const read = await readSupportThread(db, actor(jess, 'staff'), thread.id);
    expect(read.messages.at(-1)?.author).toEqual({ kind: 'teammate', name: 'Ana Ruiz' });
  });

  it('opens a solved request again within 30 days, as a reply in the app does', async () => {
    const thread = await request();
    await withTenant(db, tenant, (tx) =>
      setSupportThreadStatus(tx, thread.id, 'solved', clock.now(), { solvedBy: 'member' }),
    );
    clock.advanceBy(29 * 24 * 60 * 60 * 1000);
    const { email } = await fixture('gmail-reply', thread);
    expect((await receive(email)).result.landed).toBe(1);
    expect((await readSupportThread(db, actor(jess, 'staff'), thread.id)).status).toBe(
      'waiting_on_pepper',
    );
  });
});

describe('what doesn’t land (AC-X-35)', () => {
  it('holds a staff member who may not read the request, and an outsider, telling no one', async () => {
    const thread = await request();
    const fromBen = await fixture('gmail-reply', thread, 'ben@juniper.test');
    expect((await receive(fromBen.email)).result.held).toBe(1);
    expect(await lastInbound()).toMatchObject({
      status: 'held',
      reason: 'unknown_sender',
      from_address: 'ben@juniper.test',
      tenant_id: tenant,
    });
    const outsider = await fixture('forward', thread);
    expect((await receive(outsider.email)).result.held).toBe(1);
    expect(await lastInbound()).toMatchObject({
      reason: 'unknown_sender',
      from_address: 'stranger@elsewhere.test',
      held_text: 'Hi, who are you? I got this forwarded.',
    });
    // Another business's owner, with a valid address: the same.
    const olgaMail = await fixture('gmail-reply', thread, 'olga@fig.test');
    expect((await receive(olgaMail.email)).result.held).toBe(1);
    const read = await readSupportThread(db, actor(jess, 'staff'), thread.id);
    expect(read.messages).toHaveLength(1);
    const mail = await deliverAll();
    expect(mail.map((message) => message.to)).not.toContain('stranger@elsewhere.test');
    expect(mail.map((message) => message.to)).not.toContain('ben@juniper.test');
    expect(mail.map((message) => message.to)).not.toContain('olga@fig.test');
  });

  it('holds a spoofed From, and every reply when no authserv-id is set', async () => {
    const thread = await request();
    const spoofed = await fixture('spoofed', thread);
    expect((await receive(spoofed.email)).result.held).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'unverified_sender' });
    options = { ...options, authservId: null };
    const gmail = await fixture('gmail-reply', thread);
    expect((await receive(gmail.email)).result.held).toBe(1);
    expect((await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages).toHaveLength(1);
    expect((await deliverAll()).filter((m) => m.to === 'jess@juniper.test')).toEqual([]);
  });

  it('ignores auto-replies, spam, and an address or root id that was changed', async () => {
    const thread = await request();
    expect((await receive((await fixture('auto-reply', thread)).email)).result.ignored).toBe(1);
    expect(await lastInbound()).toMatchObject({ status: 'ignored', reason: 'auto_reply' });
    expect((await receive((await fixture('spam', thread)).email)).result.ignored).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'spam' });
    const forged = {
      ...thread,
      reply: thread.reply.replace(/-[a-z2-7]{20}@/, '-aaaaaaaaaaaaaaaaaaaa@'),
      root: '<support.nothing@reply.pepper.test>',
    };
    expect((await receive((await fixture('gmail-reply', forged)).email)).result.ignored).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'no_request', tenant_id: null });
    expect((await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages).toHaveLength(1);
  });

  it('stores an email once, by its event and by its Message-ID', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    const first = await receive(email, { eventId: 'evt_dup', messageId: '<dup@mail.test>' });
    expect(first.stored).toBe(true);
    expect((await receive(email, { eventId: 'evt_dup' })).stored).toBe(false);
    expect((await receive(email, { messageId: '<dup@mail.test>' })).stored).toBe(false);
    expect((await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages).toHaveLength(2);
  });

  it('ignores more than 5 replies to one request in an hour (a loop)', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    for (let i = 0; i < 5; i += 1) {
      expect((await receive(email)).result.landed).toBe(1);
      clock.advanceBy(60_000);
    }
    expect((await receive(email)).result.ignored).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'loop' });
    clock.advanceBy(60 * 60_000);
    expect((await receive(email)).result.landed).toBe(1);
  });

  it('refuses a message over 40 MB without opening it', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    expect((await receive({ ...email, size: 41 * 1024 * 1024 })).result.refused).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'too_large', tenant_id: null });
  });
});

describe('telling a verified sender what didn’t go through (AC-X-36)', () => {
  it('cuts a long reply and says so', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    expect((await receive({ ...email, text: 'x'.repeat(5_000), html: null })).result.landed).toBe(
      1,
    );
    const body = (await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages.at(
      -1,
    )?.body;
    expect(body).toHaveLength(4_000);
    expect(body?.endsWith('…')).toBe(true);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.subject).toBe(`About your email to ${thread.reference}`);
    expect(note?.text).toContain('the end was cut');
    expect(note?.autoSubmitted).toBe(true);
  });

  it('refuses a reply with no words above the quote, and says so', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    const empty = { ...email, text: `${SUPPORT_REPLY_ABOVE}\nHi Jess`, html: null };
    expect((await receive(empty)).result.refused).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'empty' });
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('had no words we could find');
  });

  it('refuses a reply over the day’s messages, and says so', async () => {
    const thread = await request();
    await withMember(db, { tenantId: tenant, userId: jess }, async (tx) => {
      for (let i = 0; i < 49; i += 1) {
        await appendSupportMessage(tx, {
          threadId: thread.id,
          author: { kind: 'member', userId: jess },
          body: `note ${String(i)}`,
          status: 'waiting_on_pepper',
          now: clock.now(),
        });
      }
    });
    const { email } = await fixture('gmail-reply', thread);
    expect((await receive(email)).result.refused).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'limit' });
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('as many messages as we take in a day');
  });

  it('words each note so a person can act on it', () => {
    const link = 'https://app.pepper.test/support/x';
    const many = inboundNoteText(
      {
        reference: 'PEP-7K2M9Q',
        skipped: ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'g.pdf'],
      },
      '',
      link,
    );
    expect(many.text.startsWith('Hi,')).toBe(true);
    expect(many.text).toContain(
      'These files weren’t added: a.pdf; b.pdf; c.pdf; d.pdf; e.pdf; and 2 more.',
    );
    const one = inboundNoteText({ reference: 'PEP-7K2M9Q', skipped: ['a.pdf'] }, 'Jess', link);
    expect(one.text).toContain('This file wasn’t added: a.pdf.');
    expect(one.text).toContain(`See the request: ${link}`);
  });
});

describe('a reply to an old solved request opens a follow-up (AC-X-37)', () => {
  it('opens a new request that names the old one, and tells the sender its reference', async () => {
    const thread = await request();
    await withTenant(db, tenant, (tx) =>
      setSupportThreadStatus(tx, thread.id, 'solved', clock.now(), { solvedBy: 'auto' }),
    );
    clock.advanceBy(31 * 24 * 60 * 60 * 1000);
    const { email, expected } = await fixture('gmail-reply', thread);
    expect((await receive(email)).result.landed).toBe(1);
    expect((await readSupportThread(db, actor(jess, 'staff'), thread.id)).status).toBe('solved');
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    const newReference = /opened a new request: (PEP-[0-9A-Z]{6})/.exec(note?.text ?? '')?.[1];
    expect(newReference).toBeDefined();
    expect(note?.subject).toBe(`About your email to ${String(newReference)}`);
    const follow = (await admin.db.select().from(supportThreads)).find(
      (row) => row.reference === newReference,
    );
    const read = await readSupportThread(db, actor(jess, 'staff'), follow?.id ?? '');
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]).toMatchObject({
      body: `Follow-up to ${thread.reference}.\n\n${String(expected)}`,
      channel: 'email',
    });
  });
});

describe('later replies to an old request land in its follow-up (AC-X-37)', () => {
  it('opens one follow-up, then lands there, with its routing in the note', async () => {
    const thread = await request();
    await withTenant(db, tenant, (tx) =>
      setSupportThreadStatus(tx, thread.id, 'solved', clock.now(), { solvedBy: 'auto' }),
    );
    clock.advanceBy(31 * 24 * 60 * 60 * 1000);
    const { email } = await fixture('gmail-reply', thread);
    expect((await receive(email)).result.landed).toBe(1);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    const reference = /opened a new request: (PEP-[0-9A-Z]{6})/.exec(note?.text ?? '')?.[1] ?? '';
    // The note answers to the new request, so a reply to it lands there.
    expect(note?.replyTo).toBe(supportReplyAddress(replyKeys, reference, DOMAIN));
    // More replies to the old request's email in the hour land in that follow-up (the one that
    // opened it counts), the sixth is a loop; no other request is opened.
    for (let i = 0; i < 4; i += 1) {
      clock.advanceBy(60_000);
      expect((await receive(email)).result.landed).toBe(1);
    }
    expect((await receive(email)).result.ignored).toBe(1);
    expect(await lastInbound()).toMatchObject({ reason: 'loop' });
    const opened = (await admin.db.select().from(supportThreads)).filter(
      (row) => row.followUpOf === thread.id,
    );
    expect(opened.map((row) => row.reference)).toEqual([reference]);
    const read = await readSupportThread(db, actor(jess, 'staff'), opened[0]?.id ?? '');
    expect(read.messages).toHaveLength(5);
  });
});

describe('emailed images become screenshots (AC-X-38, the top-up)', () => {
  it('keeps the pasted and attached images, names the rest, drops signature icons', async () => {
    const thread = await request();
    const { email } = await fixture('with-images', thread);
    expect((await receive(email)).result.landed).toBe(1);
    const message = (await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages.at(-1);
    expect(message?.screenshots).toHaveLength(2);
    expect(store.images.size).toBe(4);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('invoice.pdf (not an image)');
    expect(note?.text).toContain('IMG_0412.HEIC (HEIC: send it as JPEG)');
    expect(note?.text).not.toContain('logo.png');
  });

  it('shares the day’s 20 screenshots with uploads', async () => {
    const thread = await request();
    // 19 sent today already (as uploads would be).
    await withMember(db, { tenantId: tenant, userId: jess }, async (tx) => {
      for (let i = 0; i < 19; i += 1) {
        await insertSupportScreenshot(tx, {
          id: newId(),
          uploadedBy: jess,
          width: 10,
          height: 10,
          widths: [10],
          bytes: 1,
          now: clock.now(),
        });
      }
    });
    const { email } = await fixture('with-images', thread);
    expect((await receive(email)).result.landed).toBe(1);
    const message = (await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages.at(-1);
    expect(message?.screenshots).toHaveLength(1);
    expect(store.images.size).toBe(2);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('calendar.png (over the limit)');
  });

  it('leaves out a file that can’t be read, and lands the reply', async () => {
    const thread = await request();
    const { email } = await fixture('with-images', thread);
    const broken = {
      ...email,
      attachments: email.attachments.map((attachment, index) =>
        index === 0
          ? { ...attachment, content: () => Promise.reject(new Error('link expired')) }
          : attachment,
      ),
    };
    expect((await receive(broken)).result.landed).toBe(1);
    const message = (await readSupportThread(db, actor(jess, 'staff'), thread.id)).messages.at(-1);
    expect(message?.screenshots).toHaveLength(1);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('Screenshot.png (couldn’t be read)');
  });

  it('takes back what it stored when the store fails, and retries', async () => {
    const thread = await request();
    const { email } = await fixture('with-images', thread);
    let puts = 0;
    const put = store.put.bind(store);
    store.put = (tenantId, id, width, data) => {
      puts += 1;
      // The second image's first width fails.
      return puts === 3 ? Promise.reject(new Error('store down')) : put(tenantId, id, width, data);
    };
    expect((await receive(email)).result.retried).toBe(1);
    expect(store.images.size).toBe(0);
    // The store back: the next attempt, after the lease, lands it with its images.
    store.put = put;
    clock.advanceBy(6 * 60_000);
    expect((await processInboundEmails(db, options)).landed).toBe(1);
    expect(store.images.size).toBe(4);
  });

  it('names every image when screenshots are off', async () => {
    options = { ...options, store: null };
    const thread = await request();
    const { email } = await fixture('with-images', thread);
    expect((await receive(email)).result.landed).toBe(1);
    const note = (await deliverAll()).find((mail) => mail.to === 'jess@juniper.test');
    expect(note?.text).toContain('Screenshot.png (screenshots are off)');
  });
});

describe('the job’s retries and housekeeping', () => {
  it('leaves an email for later when the provider fails, and gives up after 5 attempts', async () => {
    const thread = await request();
    const { email } = await fixture('gmail-reply', thread);
    source.failing = true;
    const { result } = await receive(email);
    expect(result).toMatchObject({ retried: 1, landed: 0 });
    expect(await lastInbound()).toMatchObject({ status: 'received' });
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      clock.advanceBy(6 * 60_000);
      expect((await processInboundEmails(db, options)).retried).toBe(1);
    }
    clock.advanceBy(6 * 60_000);
    expect((await processInboundEmails(db, options)).failed).toBe(1);
    expect(await lastInbound()).toMatchObject({ status: 'failed', reason: 'gave_up' });
  });

  it('fails an email the provider doesn’t know', async () => {
    counter += 1;
    await recordInboundEmail(db, {
      provider: 'resend',
      eventId: `msg_${String(counter)}`,
      providerEmailId: 'missing',
      messageId: null,
      receivedAt: clock.now(),
    });
    // Retried (the provider may not serve it yet), given up on the last attempt.
    for (let attempt = 1; attempt < 5; attempt += 1) {
      expect(await processInboundEmails(db, options)).toMatchObject({
        retried: 1,
        errors: ['InboundEmailNotFoundError'],
      });
      expect(await lastInbound()).toMatchObject({ status: 'received' });
      clock.advanceBy(6 * 60_000);
    }
    expect((await processInboundEmails(db, options)).failed).toBe(1);
    expect(await lastInbound()).toMatchObject({ status: 'failed', reason: 'not_found' });
  });

  it('empties a held email after 7 days', async () => {
    const thread = await request();
    const { email } = await fixture('forward', thread);
    const { providerEmailId } = await receive(email);
    clock.advanceBy(8 * 24 * 60 * 60 * 1000);
    expect((await processInboundEmails(db, options)).emptied).toBeGreaterThanOrEqual(1);
    const row = (await admin.db.select().from(inboundEmails)).find(
      (candidate) => candidate.providerEmailId === providerEmailId,
    );
    expect(row).toMatchObject({ status: 'held', fromAddress: null, heldText: null });
  });
});
