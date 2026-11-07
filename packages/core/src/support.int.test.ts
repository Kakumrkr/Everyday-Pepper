import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  listAuditEntries,
  listDueOutboxMessages,
  publicSupportRequests,
  readBusinessExport,
  scheduleAccountDeletion,
  deleteAccountIfDue,
  supportThreads,
  withTenant,
  createDatabase,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { SupportLimitReachedError, SupportThreadNotFoundError } from './errors.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  answerSupportThread,
  countSupportUnread,
  listSupportThreads,
  newSupportReference,
  openSupportThread,
  readSupportThread,
  replyToSupportThread,
  solveSupportThread,
  submitPublicSupportRequest,
  type SupportOptions,
} from './services/support.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Pepper's own support against real Postgres (S59, PCR-010, AC-X-14…18): who reads which
// thread, the statuses, the unread count, the emails to the team and to the requester, the
// daily limits, the audit entries without text, the public form, the export.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let other: TenantId;
// Ana owns Juniper, Cara manages it, Jess and Ben are staff; Olga owns another business.
let ana: UserId;
let cara: UserId;
let jess: UserId;
let ben: UserId;
let olga: UserId;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
let clock: ManualClock;
let options: SupportOptions;

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failing = false;
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    if (this.failing) throw new Error('connect refused');
    this.sent.push(message);
  }
}

const actor = (userId: UserId, role: 'owner' | 'manager' | 'staff', at = tenant): Actor => ({
  context: { tenantId: at, userId, role },
});
const meta = { userAgent: 'Mozilla/5.0 (iPhone) Test' };

// Only an operator's logged transaction reads public requests (S59.2): tests read as the owner.
let admin: DatabaseHandle;
const publicRequests = () => admin.db.select().from(publicSupportRequests);

/** Delivers every due email and returns them. */
async function deliverAll(): Promise<EmailMessage[]> {
  const mailer = new FakeMailer();
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    await deliverOutboxMessage(db, due, { key, mailer, clock });
  }
  return mailer.sent;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  admin = createDatabase({ url: database.migrationUrl, maxConnections: 1 });
  ana = await insertUser(db, 'Ana Ruiz', 'ana@juniper.test');
  cara = await insertUser(db, 'Cara Diaz', 'cara@juniper.test');
  jess = await insertUser(db, 'Jess Park', 'jess@juniper.test');
  ben = await insertUser(db, 'Ben Okafor', 'ben@juniper.test');
  olga = await insertUser(db, 'Olga', 'olga@fig.test');
  tenant = TenantIdSchema.parse(
    (
      await createBusiness(db, ana, {
        name: 'Juniper Hair Studio',
        slug: 'juniper-support',
        timeZone: 'America/New_York',
      })
    ).id,
  );
  other = TenantIdSchema.parse(
    (await createBusiness(db, olga, { name: 'Fig', slug: 'fig-support', timeZone: 'UTC' })).id,
  );
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: cara, role: 'manager' });
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: ben, role: 'staff' });
  });
});

// Each test a few days after the last, so a day's limits and earlier emails don't carry over.
let day = Date.UTC(2026, 10, 7, 15);

beforeEach(async () => {
  day += 3 * 24 * 60 * 60 * 1000;
  clock = new ManualClock(new Date(day));
  options = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    release: '1.4.0+abc',
    clock,
  };
  // Earlier tests' emails are not this test's.
  await deliverAll();
});

afterAll(async () => {
  await admin.close();
  await database.stop();
});

describe('openSupportThread (AC-X-14)', () => {
  it('keeps the request with its context, audits it without text and emails the team once', async () => {
    const created = await openSupportThread(
      db,
      actor(jess, 'staff'),
      {
        kind: 'problem',
        message: 'The import stops at row 12.\r\nIt says "unreadable".',
        context: {
          page: '/clients/import',
          viewport: { width: 375, height: 812 },
          errorRef: 'req-1',
        },
      },
      meta,
      options,
    );
    expect(created.reference).toMatch(/^PEP-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(created.replyTo).toBe('jess@juniper.test');

    const thread = await readSupportThread(db, actor(jess, 'staff'), created.id ?? '');
    expect(thread).toMatchObject({
      kind: 'problem',
      status: 'waiting_on_pepper',
      openedBy: { kind: 'you' },
      unread: false,
      replyTo: 'jess@juniper.test',
      messages: [
        { author: { kind: 'you' }, body: 'The import stops at row 12.\nIt says "unreadable".' },
      ],
    });
    const [context] = await withTenant(db, tenant, async (tx) =>
      (await tx.select().from(supportThreads))
        .filter((row) => row.id === created.id)
        .map((row) => row.context),
    );
    expect(context).toEqual({
      page: '/clients/import',
      viewport: { width: 375, height: 812 },
      errorRef: 'req-1',
      appVersion: '1.4.0+abc',
      userAgent: 'Mozilla/5.0 (iPhone) Test',
      role: 'staff',
      setup: { bookable: false, firstBooking: false },
    });

    const entries = await withTenant(db, tenant, (tx) => listAuditEntries(tx, { limit: 100 }));
    const opened = entries.find((entry) => entry.entity.id === created.id);
    expect(opened).toMatchObject({
      action: 'support_thread.opened',
      actor: { kind: 'user', userId: jess },
      after: { kind: 'problem', status: 'waiting_on_pepper' },
    });
    expect(JSON.stringify(opened)).not.toContain('row 12');

    const sent = await deliverAll();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'support@pepper.test',
      replyTo: 'jess@juniper.test',
      subject: `[${created.reference}] Something’s not working — Juniper Hair Studio`,
    });
    expect(sent[0]?.text).toContain('Jess Park <jess@juniper.test>, staff at Juniper Hair Studio');
    expect(sent[0]?.text).toContain('It says "unreadable".');
    expect(sent[0]?.text).toContain('Page: /clients/import');
    expect(sent[0]?.text).toContain('Error reference: req-1');
    expect(sent[0]?.text).toContain('Screen: 375×812');
    expect(sent[0]?.text).toContain('Setup: not bookable yet, no booking yet');
  });

  it('keeps the request without emailing when no team address is set', async () => {
    const created = await openSupportThread(
      db,
      actor(ana, 'owner'),
      { kind: 'idea', message: 'A dark calendar would be nice.' },
      meta,
      { ...options, supportEmail: null },
    );
    expect(created.id).not.toBeNull();
    expect(await deliverAll()).toEqual([]);
  });

  it('refuses a sixth request in a day from one person, and takes one again a day later', async () => {
    const lucy = await insertUser(db, 'Lucy');
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: lucy, role: 'staff' }));
    for (let i = 0; i < 5; i += 1) {
      await openSupportThread(
        db,
        actor(lucy, 'staff'),
        { kind: 'question', message: `Q${String(i)}` },
        meta,
        options,
      );
    }
    await expect(
      openSupportThread(
        db,
        actor(lucy, 'staff'),
        { kind: 'question', message: 'Q5' },
        meta,
        options,
      ),
    ).rejects.toBeInstanceOf(SupportLimitReachedError);
    clock.advanceBy(24 * 60 * 60 * 1000 + 1);
    await expect(
      openSupportThread(
        db,
        actor(lucy, 'staff'),
        { kind: 'question', message: 'Q6' },
        meta,
        options,
      ),
    ).resolves.toMatchObject({ id: expect.any(String) as string });
  });

  it('refuses an empty message or hidden characters before anything is written', async () => {
    await expect(
      openSupportThread(
        db,
        actor(ana, 'owner'),
        { kind: 'question', message: '   ' },
        meta,
        options,
      ),
    ).rejects.toThrow();
    await expect(
      openSupportThread(
        db,
        actor(ana, 'owner'),
        { kind: 'question', message: 'a\u0007b' },
        meta,
        options,
      ),
    ).rejects.toThrow();
  });
});

describe('who reads which request (AC-X-15)', () => {
  it('staff read their own, owners and managers all, another business none', async () => {
    const jessThread = await openSupportThread(
      db,
      actor(jess, 'staff'),
      { kind: 'question', message: 'Where do I see my week?' },
      meta,
      options,
    );
    const id = jessThread.id ?? '';
    expect((await listSupportThreads(db, actor(jess, 'staff'))).threads.map((t) => t.id)).toContain(
      id,
    );
    const forAna = await listSupportThreads(db, actor(ana, 'owner'));
    expect(forAna.threads.find((t) => t.id === id)).toMatchObject({
      openedBy: { kind: 'teammate', name: 'Jess Park' },
      unread: false,
    });
    expect(
      (await listSupportThreads(db, actor(cara, 'manager'))).threads.map((t) => t.id),
    ).toContain(id);
    expect(
      (await listSupportThreads(db, actor(ben, 'staff'))).threads.map((t) => t.id),
    ).not.toContain(id);
    await expect(readSupportThread(db, actor(ben, 'staff'), id)).rejects.toBeInstanceOf(
      SupportThreadNotFoundError,
    );
    await expect(
      replyToSupportThread(db, actor(ben, 'staff'), id, { message: 'me too' }, options),
    ).rejects.toBeInstanceOf(SupportThreadNotFoundError);
    await expect(readSupportThread(db, actor(olga, 'owner', other), id)).rejects.toBeInstanceOf(
      SupportThreadNotFoundError,
    );
    await expect(
      answerSupportThread(db, other, id, { message: 'wrong business' }, options),
    ).rejects.toBeInstanceOf(SupportThreadNotFoundError);
    await expect(readSupportThread(db, actor(ana, 'owner'), 'not-a-uuid')).rejects.toBeInstanceOf(
      SupportThreadNotFoundError,
    );
    // The owner reading it shows them the thread, with Jess's reply address hidden.
    expect((await readSupportThread(db, actor(ana, 'owner'), id)).replyTo).toBeNull();
  });
});

describe('a thread from question to solved (AC-X-15, AC-X-16)', () => {
  it('moves through the statuses, counts unread answers and emails each answer once', async () => {
    const created = await openSupportThread(
      db,
      actor(jess, 'staff'),
      { kind: 'question', message: 'How do I move a booking?' },
      meta,
      options,
    );
    const id = created.id ?? '';
    await deliverAll();
    const before = await countSupportUnread(db, actor(jess, 'staff'));

    clock.advanceBy(60_000);
    await answerSupportThread(db, tenant, id, { message: 'Tap it, then Move.' }, options);
    expect(await countSupportUnread(db, actor(jess, 'staff'))).toBe(before + 1);
    // An owner sees the answer, but it is not their unread request.
    const anaUnread = await countSupportUnread(db, actor(ana, 'owner'));
    expect(
      (await listSupportThreads(db, actor(ana, 'owner'))).threads.find((t) => t.id === id)?.unread,
    ).toBe(false);

    const toJess = await deliverAll();
    expect(toJess).toHaveLength(1);
    expect(toJess[0]).toMatchObject({
      to: 'jess@juniper.test',
      replyTo: 'support@pepper.test',
      subject: `Pepper replied to ${created.reference}`,
    });
    expect(toJess[0]?.text).toContain('Hi Jess,');
    expect(toJess[0]?.text).toContain('Tap it, then Move.');
    expect(toJess[0]?.text).toContain(`https://app.pepper.test/support/${id}`);
    expect(await deliverAll()).toEqual([]);

    const listed = (await listSupportThreads(db, actor(jess, 'staff'))).threads.find(
      (t) => t.id === id,
    );
    expect(listed).toMatchObject({ status: 'pepper_replied', unread: true });
    clock.advanceBy(60_000);
    const opened = await readSupportThread(db, actor(jess, 'staff'), id, { clock });
    expect(opened.messages.map((m) => m.author.kind)).toEqual(['you', 'pepper']);
    expect(await countSupportUnread(db, actor(jess, 'staff'))).toBe(before);
    expect(await countSupportUnread(db, actor(ana, 'owner'))).toBe(anaUnread);

    clock.advanceBy(60_000);
    const solved = await solveSupportThread(db, actor(jess, 'staff'), id, { clock });
    expect(solved.status).toBe('solved');
    // Solving twice changes nothing more.
    await solveSupportThread(db, actor(jess, 'staff'), id, { clock });

    clock.advanceBy(60_000);
    const reopened = await replyToSupportThread(
      db,
      actor(jess, 'staff'),
      id,
      { message: 'Actually, it did not move.' },
      options,
    );
    expect(reopened.status).toBe('waiting_on_pepper');
    expect(reopened.messages).toHaveLength(3);
    const toTeam = await deliverAll();
    expect(toTeam).toHaveLength(1);
    expect(toTeam[0]).toMatchObject({
      to: 'support@pepper.test',
      replyTo: 'jess@juniper.test',
      subject: `Re: [${created.reference}] A question — Juniper Hair Studio`,
    });
    expect(toTeam[0]?.text).toContain('Actually, it did not move.');

    const entries = (
      await withTenant(db, tenant, (tx) => listAuditEntries(tx, { limit: 200 }))
    ).filter((entry) => entry.entity.id === id);
    expect(entries.map((entry) => [entry.action, entry.actor.kind, entry.after])).toEqual([
      ['support_thread.replied', 'user', { status: 'waiting_on_pepper' }],
      ['support_thread.solved', 'user', { status: 'solved' }],
      ['support_thread.replied', 'system', { status: 'pepper_replied' }],
      ['support_thread.opened', 'user', { kind: 'question', status: 'waiting_on_pepper' }],
    ]);
  });

  it('shows a deleted account as a former member and emails no one for an answer', async () => {
    const tom = await insertUser(db, 'Tom', 'tom@juniper.test');
    await withTenant(db, tenant, (tx) => addMembership(tx, { userId: tom, role: 'staff' }));
    const created = await openSupportThread(
      db,
      actor(tom, 'staff'),
      { kind: 'idea', message: 'Colour per service?' },
      meta,
      options,
    );
    await deliverAll();
    // The account's deletion, as its scheduled day comes (ADR-0054).
    await scheduleAccountDeletion(db, tom, new Date(0), '00000000-0000-4000-8000-000000000000');
    expect(await deleteAccountIfDue(db, tom, clock.now())).toBe(true);
    await answerSupportThread(db, tenant, created.id ?? '', { message: 'Thanks!' }, options);
    expect(await deliverAll()).toEqual([]);
    const thread = await readSupportThread(db, actor(ana, 'owner'), created.id ?? '');
    expect(thread.openedBy).toEqual({ kind: 'former_member' });
    expect(thread.messages.map((m) => m.author)).toEqual([
      { kind: 'former_member' },
      { kind: 'pepper' },
    ]);
  });
});

describe('support in the export (AC-X-18)', () => {
  it("holds the business's threads and messages, the team's included, and none of another's", async () => {
    const created = await openSupportThread(
      db,
      actor(olga, 'owner', other),
      { kind: 'question', message: 'Fig’s question' },
      meta,
      options,
    );
    await answerSupportThread(db, other, created.id ?? '', { message: 'Fig’s answer' }, options);
    const data = await withTenant(db, other, readBusinessExport);
    expect(data.support.threads.map((t) => t.reference)).toEqual([created.reference]);
    expect(data.support.messages.map((m) => [m.authorKind, m.body])).toEqual([
      ['member', 'Fig’s question'],
      ['pepper', 'Fig’s answer'],
    ]);
    const juniper = await withTenant(db, tenant, readBusinessExport);
    expect(juniper.support.messages.map((m) => m.body)).not.toContain('Fig’s question');
  });
});

describe('submitPublicSupportRequest (AC-X-17)', () => {
  it('keeps it and sends it to the team only, Reply-To the typed address', async () => {
    const mailer = new FakeMailer();
    const result = await submitPublicSupportRequest(
      db,
      mailer,
      { email: 'locked@out.test', name: 'Mo', message: 'I can’t sign in.', page: '/sign-in' },
      { supportEmail: 'support@pepper.test', release: '1.4.0', clock, userAgent: 'UA' },
    );
    expect(result).toMatchObject({ id: null, replyTo: 'locked@out.test', sent: true });
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]).toMatchObject({
      to: 'support@pepper.test',
      replyTo: 'locked@out.test',
      subject: `[${result.reference}] Signed-out request`,
    });
    expect(mailer.sent.map((m) => m.to)).not.toContain('locked@out.test');
    expect(
      (await publicRequests())
        .filter((row) => row.reference === result.reference)
        .map(({ email, body }) => ({ email, body })),
    ).toEqual([{ email: 'locked@out.test', body: 'I can’t sign in.' }]);
  });

  it('accepts a filled honeypot silently and keeps or sends nothing', async () => {
    const mailer = new FakeMailer();
    const result = await submitPublicSupportRequest(
      db,
      mailer,
      { email: 'bot@spam.test', message: 'Buy now', website: 'https://spam.test' },
      { supportEmail: 'support@pepper.test', release: '1.4.0', clock, userAgent: null },
    );
    expect(result.reference).toMatch(/^PEP-/);
    expect(mailer.sent).toEqual([]);
    expect((await publicRequests()).filter((row) => row.email === 'bot@spam.test')).toEqual([]);
  });

  it('keeps the request when the mail server refuses it', async () => {
    const mailer = new FakeMailer();
    mailer.failing = true;
    const result = await submitPublicSupportRequest(
      db,
      mailer,
      { email: 'later@out.test', message: 'Help' },
      { supportEmail: 'support@pepper.test', release: '1.4.0', clock, userAgent: null },
    );
    expect(result.sent).toBe(false);
    expect(
      (await publicRequests()).filter((row) => row.reference === result.reference),
    ).toHaveLength(1);
  });
});

describe('newSupportReference', () => {
  it('draws "PEP-" and 6 characters that read back unambiguously', () => {
    for (let i = 0; i < 200; i += 1)
      expect(newSupportReference()).toMatch(/^PEP-[0-9A-HJKMNP-TV-Z]{6}$/);
  });
});
