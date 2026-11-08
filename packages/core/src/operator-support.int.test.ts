import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  createDatabase,
  finishInboundEmail,
  grantOperator,
  inboundEmails,
  insertEmailSuppression,
  insertInboundEmail,
  listAuditEntries,
  listDueOutboxMessages,
  operatorAccessLog,
  supportNotes,
  withInboundMail,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  HeldEmailNotFoundError,
  OperatorAccessRefusedError,
  SupportThreadNotFoundError,
} from './errors.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  decideHeldEmail,
  isOperator,
  listHeldEmails,
  readInboundCounts,
  readPilotMetrics,
  resumePublicMail,
  resumeThreadMail,
  noteOnPublicRequest,
  noteOnThread,
  readOperatorInbox,
  readOperatorThread,
  readPublicRequest,
  replyAsOperator,
  setPublicStatusAsOperator,
  setThreadStatusAsOperator,
  type Operator,
} from './services/operator-support.js';
import {
  countSupportUnread,
  openSupportThread,
  readSupportThread,
  replyToSupportThread,
  submitPublicSupportRequest,
  type SupportOptions,
} from './services/support.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The operator console against real Postgres (S59.2, ADR-0062, AC-X-19…22): the inbox across
// businesses and the public form, oldest first; replies, notes, every status; every access in
// the access log and the business's audit log; "Seen by Pepper".

let database: TestDatabase;
let admin: DatabaseHandle;
let db: Database;
let juniper: TenantId;
let fig: TenantId;
let ana: UserId;
let jess: UserId;
let olga: UserId;
let operator: Operator;
let notOperator: Operator;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
let clock: ManualClock;
let options: SupportOptions;

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    this.sent.push(message);
  }
}

const actor = (userId: UserId, role: 'owner' | 'staff', at: TenantId): Actor => ({
  context: { tenantId: at, userId, role },
});
const meta = { userAgent: 'Test' };

async function deliverAll(): Promise<EmailMessage[]> {
  const mailer = new FakeMailer();
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    await deliverOutboxMessage(db, due, { key, mailer, clock });
  }
  return mailer.sent;
}

async function accessLog(): Promise<{ action: string; target: string | null }[]> {
  const rows = await admin.db.select().from(operatorAccessLog);
  return rows
    .filter((row) => row.operatorUserId === operator.userId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((row) => ({ action: row.action, target: row.targetId }));
}

function minutes(n: number): void {
  clock.set(new Date(clock.now().getTime() + n * 60_000));
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  admin = createDatabase({ url: database.migrationUrl, maxConnections: 1 });
  ana = await insertUser(db, 'Ana Ruiz', 'ana@juniper-ops.test');
  jess = await insertUser(db, 'Jess Park', 'jess@juniper-ops.test');
  olga = await insertUser(db, 'Olga', 'olga@fig-ops.test');
  const olive = await insertUser(db, 'Olive Ops', 'olive@pepper-ops.test');
  operator = { userId: olive };
  notOperator = { userId: ana };
  await grantOperator(database.migrationUrl, { email: 'olive@pepper-ops.test', note: 'tests' });
  juniper = TenantIdSchema.parse(
    (await createBusiness(db, ana, { name: 'Juniper', slug: 'juniper-ops', timeZone: 'UTC' })).id,
  );
  fig = TenantIdSchema.parse(
    (await createBusiness(db, olga, { name: 'Fig Nails', slug: 'fig-ops', timeZone: 'UTC' })).id,
  );
  await withTenant(db, juniper, (tx) => addMembership(tx, { userId: jess, role: 'staff' }));
});

beforeEach(async () => {
  clock = new ManualClock(new Date(Date.UTC(2026, 10, 9, 9)));
  options = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    release: '1.5.0',
    clock,
  };
  await deliverAll();
});

afterAll(async () => {
  await admin.close();
  await database.stop();
});

describe('the operator role (AC-X-19)', () => {
  it('opens for the granted account only; an owner gets nothing', async () => {
    expect(await isOperator(db, operator.userId)).toBe(true);
    expect(await isOperator(db, ana)).toBe(false);
    await expect(readOperatorInbox(db, notOperator, {})).rejects.toBeInstanceOf(
      OperatorAccessRefusedError,
    );
  });
});

describe('the inbox (AC-X-20)', () => {
  it('lists every business’s waiting requests and the public ones, the longest waiting first', async () => {
    const first = await openSupportThread(
      db,
      actor(jess, 'staff', juniper),
      { kind: 'problem', message: 'The calendar is empty', context: {} },
      meta,
      options,
    );
    minutes(30);
    const second = await submitPublicSupportRequest(
      db,
      null,
      { email: 'locked@out.test', message: 'Can’t sign in' },
      { supportEmail: null, release: '1', userAgent: null, clock },
    );
    minutes(30);
    const third = await openSupportThread(
      db,
      actor(olga, 'owner', fig),
      { kind: 'idea', message: 'Dark mode on the booking page', context: {} },
      meta,
      options,
    );
    const inbox = await readOperatorInbox(db, operator, { view: 'waiting' });
    const ours = inbox.items.filter((item) =>
      [first.reference, second.reference, third.reference].includes(item.reference),
    );
    expect(ours.map((item) => [item.reference, item.source])).toEqual([
      [first.reference, 'thread'],
      [second.reference, 'public'],
      [third.reference, 'thread'],
    ]);
    expect(ours[0]).toMatchObject({
      business: 'Juniper',
      kind: 'problem',
      preview: 'The calendar is empty',
      waitingSince: '2026-11-09T09:00:00.000Z',
    });
    expect(ours[2]).toMatchObject({ business: 'Fig Nails' });
    expect(inbox.waiting).toBe(inbox.items.length);
    expect((await accessLog()).at(-1)).toEqual({ action: 'inbox.read', target: null });
  });

  it('waits from the member’s oldest unanswered message, and moves between the views', async () => {
    const created = await openSupportThread(
      db,
      actor(ana, 'owner', juniper),
      { kind: 'question', message: 'How do deposits work?', context: {} },
      meta,
      options,
    );
    const id = created.id ?? '';
    minutes(60);
    await replyAsOperator(db, operator, id, { message: 'Coming in the spring.' }, options);
    let answered = await readOperatorInbox(db, operator, { view: 'answered' });
    expect(answered.items.map((item) => item.id)).toContain(id);
    minutes(60);
    await replyToSupportThread(
      db,
      actor(ana, 'owner', juniper),
      id,
      { message: 'Thanks! And refunds?' },
      options,
    );
    minutes(5);
    const waiting = await readOperatorInbox(db, operator, { view: 'waiting' });
    expect(waiting.items.find((item) => item.id === id)?.waitingSince).toBe(
      '2026-11-09T11:00:00.000Z',
    );
    answered = await readOperatorInbox(db, operator, { view: 'answered' });
    expect(answered.items.map((item) => item.id)).not.toContain(id);
    expect(answered.waiting).toBe(waiting.waiting);

    // Moved back to waiting by the team, with nothing new from them: waiting since our reply.
    minutes(60);
    await replyAsOperator(db, operator, id, { message: 'Refunds are in Settings.' }, options);
    minutes(30);
    await setThreadStatusAsOperator(db, operator, id, { status: 'waiting_on_pepper' }, { clock });
    const again = await readOperatorInbox(db, operator, { view: 'waiting' });
    expect(again.items.find((item) => item.id === id)?.waitingSince).toBe(
      '2026-11-09T12:05:00.000Z',
    );
  });

  it('lists the answered and solved views latest first', async () => {
    const ids: string[] = [];
    for (const message of ['First solved', 'Second solved']) {
      const created = await openSupportThread(
        db,
        actor(olga, 'owner', fig),
        { kind: 'question', message, context: {} },
        meta,
        options,
      );
      minutes(10);
      await setThreadStatusAsOperator(
        db,
        operator,
        created.id ?? '',
        { status: 'solved' },
        { clock },
      );
      ids.push(created.id ?? '');
    }
    const solved = await readOperatorInbox(db, operator, { view: 'solved' });
    const order = solved.items.map((item) => item.id).filter((id) => ids.includes(id));
    expect(order).toEqual([...ids].reverse());
  });
});

describe('a business’s request (AC-X-21/22)', () => {
  it('opens with context and notes, marks "Seen by Pepper" and audits as operator', async () => {
    const created = await openSupportThread(
      db,
      actor(jess, 'staff', juniper),
      { kind: 'problem', message: 'Reminders didn’t go out', context: { page: '/calendar' } },
      meta,
      options,
    );
    const id = created.id ?? '';
    minutes(10);
    const opened = await readOperatorThread(db, operator, id, { clock });
    expect(opened).toMatchObject({
      business: 'Juniper',
      openedBy: { name: 'Jess Park', role: 'staff' },
      status: 'waiting_on_pepper',
      notes: [],
    });
    expect(opened.context?.page).toBe('/calendar');
    expect(opened.messages.map((m) => m.author)).toEqual([{ kind: 'member', name: 'Jess Park' }]);
    const asJess = await readSupportThread(db, actor(jess, 'staff', juniper), id, { clock });
    expect(asJess.seenByPepperAt).toBe('2026-11-09T09:10:00.000Z');
    const withNote = await noteOnThread(
      db,
      operator,
      id,
      { note: 'Their SMS is off; check reminders job' },
      { clock },
    );
    expect(withNote.notes.map((n) => [n.author, n.body])).toEqual([
      ['Olive Ops', 'Their SMS is off; check reminders job'],
    ]);
    const asOwner = await readSupportThread(db, actor(ana, 'owner', juniper), id, { clock });
    expect(JSON.stringify(asOwner)).not.toContain('check reminders job');
    expect((await accessLog()).slice(-2)).toEqual([
      { action: 'thread.read', target: id },
      { action: 'thread.note', target: id },
    ]);
    // Opened again within the hour: logged for Pepper, not news for the business.
    minutes(5);
    await readOperatorThread(db, operator, id, { clock });
    const audit = await withTenant(db, juniper, (tx) => listAuditEntries(tx, { limit: 20 }));
    const seen = audit.filter((e) => e.action === 'support_thread.seen' && e.entity.id === id);
    expect(seen.map((e) => e.actor)).toEqual([{ kind: 'operator', userId: null }]);
    expect((await accessLog()).at(-1)).toEqual({ action: 'thread.read', target: id });
  });

  it('a reply reaches the requester once, and every status is reachable', async () => {
    const created = await openSupportThread(
      db,
      actor(jess, 'staff', juniper),
      { kind: 'question', message: 'Can I add a second location?', context: {} },
      meta,
      options,
    );
    const id = created.id ?? '';
    await deliverAll();
    minutes(15);
    const replied = await replyAsOperator(db, operator, id, { message: 'Not yet.' }, options);
    expect(replied.status).toBe('pepper_replied');
    expect(replied.messages.at(-1)?.author).toEqual({ kind: 'pepper' });
    const mails = await deliverAll();
    // Earlier tests ran later in the day: only this request's mail counts.
    expect(
      mails.filter((m) => m.subject.includes(created.reference)).map((m) => [m.to, m.subject]),
    ).toEqual([['jess@juniper-ops.test', `Pepper replied to ${created.reference}`]]);
    expect(await countSupportUnread(db, actor(jess, 'staff', juniper))).toBe(1);
    for (const status of ['solved', 'waiting_on_pepper', 'pepper_replied', 'solved'] as const) {
      const moved = await setThreadStatusAsOperator(db, operator, id, { status }, { clock });
      expect(moved.status).toBe(status);
    }
    const audit = await withTenant(db, juniper, (tx) => listAuditEntries(tx, { limit: 50 }));
    const ours = audit
      .filter((e) => e.entity.id === id && e.actor.kind === 'operator')
      .map((e) => e.action)
      .reverse();
    expect(ours).toEqual([
      'support_thread.replied',
      'support_thread.status_changed',
      'support_thread.status_changed',
      'support_thread.status_changed',
      'support_thread.status_changed',
    ]);
  });

  it('a missing or malformed id is not found, and leaves no access behind', async () => {
    const before = (await accessLog()).length;
    await expect(
      readOperatorThread(db, operator, '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192'),
    ).rejects.toBeInstanceOf(SupportThreadNotFoundError);
    await expect(readOperatorThread(db, operator, 'nope')).rejects.toBeInstanceOf(
      SupportThreadNotFoundError,
    );
    expect((await accessLog()).length).toBe(before);
  });
});

describe('a public request (AC-X-21)', () => {
  it('opens with its notes and moves through every status', async () => {
    const sent = await submitPublicSupportRequest(
      db,
      null,
      { email: 'Who@Example.test', name: 'Who', message: 'Locked out again' },
      { supportEmail: null, release: '1', userAgent: null, clock },
    );
    const inbox = await readOperatorInbox(db, operator, {});
    const item = inbox.items.find((i) => i.reference === sent.reference);
    expect(item?.source).toBe('public');
    const id = item?.id ?? '';
    const opened = await readPublicRequest(db, operator, id);
    expect(opened).toMatchObject({ status: 'open', name: 'Who', body: 'Locked out again' });
    const noted = await noteOnPublicRequest(db, operator, id, { note: 'Emailed reset steps' });
    expect(noted.notes.map((n) => n.body)).toEqual(['Emailed reset steps']);
    for (const status of ['answered', 'solved', 'open'] as const) {
      expect((await setPublicStatusAsOperator(db, operator, id, { status })).status).toBe(status);
    }
    await expect(readPublicRequest(db, operator, 'nope')).rejects.toBeInstanceOf(
      SupportThreadNotFoundError,
    );
    expect((await accessLog()).slice(-5).map((row) => row.action)).toEqual([
      'public.read',
      'public.note',
      'public.status',
      'public.status',
      'public.status',
    ]);
  });
});

describe('held mail, stopped mail and counts in the console (AC-X-43…46)', () => {
  let counter = 0;

  /** A held email as the inbound job leaves one. */
  async function held(input: {
    reason: 'unknown_sender' | 'unverified_sender';
    tenantId: string | null;
    threadId: string | null;
    from: string;
    text: string;
    subject?: string;
  }): Promise<string> {
    counter += 1;
    const row = await withInboundMail(db, (tx) =>
      insertInboundEmail(tx, {
        provider: 'resend',
        eventId: `held_${String(counter)}`,
        providerEmailId: `held_email_${String(counter)}`,
        messageId: null,
        receivedAt: clock.now(),
      }),
    );
    const id = row?.id ?? '';
    await withInboundMail(db, (tx) =>
      finishInboundEmail(
        tx,
        id,
        {
          status: 'held',
          reason: input.reason,
          tenantId: input.tenantId,
          threadId: input.threadId,
          fromAddress: input.from,
          heldText: input.text,
          heldSubject: input.subject ?? null,
        },
        clock.now(),
      ),
    );
    minutes(1);
    return id;
  }

  async function stop(address: string, kind: 'hard_bounce' | 'complaint') {
    counter += 1;
    await withInboundMail(db, (tx) =>
      insertEmailSuppression(tx, {
        provider: 'resend',
        eventId: `stop_${String(counter)}`,
        address,
        kind,
        occurredAt: clock.now(),
      }),
    );
  }

  it('lists held mail with the inbox’s count, accepts and discards each, all in the access log', async () => {
    const opened = await openSupportThread(
      db,
      actor(jess, 'staff', juniper),
      { kind: 'problem', message: 'Bookings vanished' },
      meta,
      options,
    );
    const thread = opened.id ?? '';
    const before = (await readOperatorInbox(db, operator, {})).held;
    const forward = await held({
      reason: 'unknown_sender',
      tenantId: juniper,
      threadId: thread,
      from: 'assistant@else.test',
      text: 'Forwarding for Jess: <script>x</script>',
    });
    const stranger = await held({
      reason: 'unverified_sender',
      tenantId: null,
      threadId: null,
      from: 'someone@else.test',
      text: 'Help',
      subject: 'Locked out',
    });
    const member = await held({
      reason: 'unverified_sender',
      tenantId: fig,
      threadId: null,
      from: 'olga@fig-ops.test',
      text: 'Is it down?',
    });
    expect((await readOperatorInbox(db, operator, {})).held).toBe(before + 3);
    const list = await listHeldEmails(db, operator);
    const byId = new Map(list.items.map((item) => [item.id, item]));
    expect(byId.get(forward)).toMatchObject({
      kind: 'reply',
      reason: 'unknown_sender',
      business: 'Juniper',
      reference: opened.reference,
      text: 'Forwarding for Jess: <script>x</script>',
    });
    expect(byId.get(stranger)).toMatchObject({
      kind: 'new_request',
      business: null,
      reference: null,
      subject: 'Locked out',
    });
    expect(byId.get(member)).toMatchObject({ kind: 'new_request', business: 'Fig Nails' });
    const ids = list.items.map((item) => item.id);
    expect(ids.indexOf(forward)).toBeLessThan(ids.indexOf(stranger));

    // Someone outside the business: the team's note on its request, never a member's message.
    await decideHeldEmail(db, operator, forward, { decision: 'accept' }, { clock });
    const notes = (await admin.db.select().from(supportNotes)).filter((n) => n.threadId === thread);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toBe(
      'Email from assistant@else.test, accepted from held mail:\n\nForwarding for Jess: <script>x</script>',
    );
    expect(
      (await readSupportThread(db, actor(jess, 'staff', juniper), thread)).messages,
    ).toHaveLength(1);
    // Anything else goes back to the inbound job with the operator's word.
    await decideHeldEmail(db, operator, member, { decision: 'accept' }, { clock });
    const rows = await admin.db.select().from(inboundEmails);
    expect(rows.find((r) => r.id === forward)).toMatchObject({
      status: 'landed',
      reason: 'accepted_note',
      fromAddress: null,
    });
    expect(rows.find((r) => r.id === member)).toMatchObject({
      status: 'received',
      acceptedBy: operator.userId,
    });
    const after = await decideHeldEmail(db, operator, stranger, { decision: 'discard' }, { clock });
    expect(after.items.map((item) => item.id)).not.toContain(stranger);
    expect(
      (await admin.db.select().from(inboundEmails)).find((r) => r.id === stranger),
    ).toMatchObject({
      status: 'ignored',
      reason: 'discarded',
      heldText: null,
    });
    // Reviewed once: a second look is "not found", and so is a made-up id.
    await expect(
      decideHeldEmail(db, operator, stranger, { decision: 'accept' }, { clock }),
    ).rejects.toBeInstanceOf(HeldEmailNotFoundError);
    await expect(
      decideHeldEmail(db, operator, 'not-an-id', { decision: 'discard' }, { clock }),
    ).rejects.toBeInstanceOf(HeldEmailNotFoundError);
    await expect(listHeldEmails(db, notOperator)).rejects.toBeInstanceOf(
      OperatorAccessRefusedError,
    );
    const log = (await accessLog()).filter((row) => row.action.startsWith('held.'));
    expect(log).toEqual(
      expect.arrayContaining([
        { action: 'held.accept', target: forward },
        { action: 'held.accept', target: member },
        { action: 'held.discard', target: stranger },
        { action: 'held.read', target: null },
      ]),
    );
  });

  it('says when mail to a requester is stopped, and resumes it in a logged transaction', async () => {
    const opened = await openSupportThread(
      db,
      actor(jess, 'staff', juniper),
      { kind: 'question', message: 'Can I export?' },
      meta,
      options,
    );
    const thread = opened.id ?? '';
    expect((await readOperatorThread(db, operator, thread)).mailStopped).toBeNull();
    await stop('jess@juniper-ops.test', 'hard_bounce');
    expect((await readOperatorThread(db, operator, thread)).mailStopped).toMatchObject({
      reason: 'bounced',
    });
    const resumed = await resumeThreadMail(db, operator, thread, { clock });
    expect(resumed.mailStopped).toBeNull();
    expect(await accessLog()).toContainEqual({ action: 'mail.resume', target: thread });

    const submitted = await submitPublicSupportRequest(
      db,
      null,
      { email: 'Spammy@Example.test', message: 'I can’t sign in' },
      { ...options, userAgent: null },
    );
    const inbox = await readOperatorInbox(db, operator, {});
    const row = inbox.items.find((item) => item.reference === submitted.reference);
    expect(row).toMatchObject({ source: 'public', channel: 'form' });
    await stop('spammy@example.test', 'complaint');
    const request = await readPublicRequest(db, operator, row?.id ?? '');
    expect(request).toMatchObject({ channel: 'form', mailStopped: { reason: 'complaint' } });
    expect((await resumePublicMail(db, operator, row?.id ?? '', { clock })).mailStopped).toBeNull();
  });

  it('counts inbound mail and delivery problems over 7 and 30 days', async () => {
    const counts = await readInboundCounts(db, operator, { clock });
    expect(counts.last7Days.outcomes).toEqual(
      expect.arrayContaining([
        { status: 'ignored', reason: 'discarded', count: 1 },
        { status: 'landed', reason: 'accepted_note', count: 1 },
      ]),
    );
    expect(counts.last30Days.problems).toEqual({ hardBounces: 1, softBounces: 0, complaints: 1 });
    expect(await accessLog()).toContainEqual({ action: 'inbound.counts', target: null });
  });
});

describe('the pilot metrics page (S59.4, AC-X-47…49)', () => {
  it('reads every business together behind one access log row; others are refused', async () => {
    const before = (await accessLog()).filter((row) => row.action === 'metrics.read').length;
    const metrics = await readPilotMetrics(db, operator, { days: 30, clock });
    expect(metrics.days).toBe(30);
    expect(metrics.businesses).toBeGreaterThanOrEqual(2);
    expect(metrics.metrics.map((metric) => metric.key)).toContain('first_reply_time');
    // This suite's requests: some opened and answered in the app, the inbound ones by email.
    expect(metrics.firstReply.requests).toBeGreaterThan(0);
    expect(metrics.channels.requestsInApp).toBeGreaterThan(0);
    expect(metrics.channels.inboundIgnored).toBeGreaterThan(0);
    const after = (await accessLog()).filter((row) => row.action === 'metrics.read');
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toEqual({ action: 'metrics.read', target: null });
    await expect(readPilotMetrics(db, notOperator, { days: 7, clock })).rejects.toBeInstanceOf(
      OperatorAccessRefusedError,
    );
  });
});
