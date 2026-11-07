import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  createDatabase,
  grantOperator,
  listAuditEntries,
  listDueOutboxMessages,
  operatorAccessLog,
  withTenant,
  type Database,
  type DatabaseHandle,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { OperatorAccessRefusedError, SupportThreadNotFoundError } from './errors.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  isOperator,
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
