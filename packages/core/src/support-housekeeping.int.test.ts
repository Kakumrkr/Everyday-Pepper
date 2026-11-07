import { TenantIdSchema, type TenantId, type UserId } from '@pepper/contracts';
import {
  addMembership,
  grantOperator,
  listAuditEntries,
  listDueOutboxMessages,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  OperatorAccessRefusedError,
  SavedRepliesFullError,
  SavedReplyNotFoundError,
  SupportNotRatableError,
} from './errors.js';
import { outboxKeyFrom, type EmailMessage, type Mailer } from './outbox.js';
import { createBusiness } from './services/business.js';
import { deliverOutboxMessage } from './services/outbox.js';
import {
  addSavedReply,
  editSavedReply,
  listSavedReplies,
  readOperatorInbox,
  readOperatorThread,
  removeSavedReply,
  replyAsOperator,
  setPublicStatusAsOperator,
  setThreadStatusAsOperator,
  type Operator,
} from './services/operator-support.js';
import {
  runSupportHousekeeping,
  type SupportHousekeepingOptions,
} from './services/support-housekeeping.js';
import {
  openSupportThread,
  rateSupportThread,
  readSupportThread,
  replyToSupportThread,
  solveSupportThread,
  submitPublicSupportRequest,
  type SupportOptions,
} from './services/support.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The console, part 2, against real Postgres (S59.2.2, ADR-0062, AC-X-23…26): the support job's
// same-day reminder and 7-day auto-close, "Did this help?", and the team's saved replies.

let database: TestDatabase;
let db: Database;
let juniper: TenantId;
let ana: UserId;
let mia: UserId;
let operator: Operator;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
let clock: ManualClock;
let options: SupportOptions;
let jobOptions: SupportHousekeepingOptions;

class FakeMailer implements Mailer {
  readonly sent: EmailMessage[] = [];
  failing = false;
  async send(message: EmailMessage): Promise<void> {
    await Promise.resolve();
    if (this.failing) throw new Error('mail server refused');
    this.sent.push(message);
  }
}

const owner = (): Actor => ({ context: { tenantId: juniper, userId: ana, role: 'owner' } });
const manager = (): Actor => ({ context: { tenantId: juniper, userId: mia, role: 'manager' } });

async function deliverAll(): Promise<EmailMessage[]> {
  const mailer = new FakeMailer();
  for (const due of await listDueOutboxMessages(db, clock.now(), 100)) {
    await deliverOutboxMessage(db, due, { key, mailer, clock });
  }
  return mailer.sent;
}

function at(iso: string): void {
  clock.set(new Date(iso));
}

async function open(message = 'My calendar is empty'): Promise<{ id: string; reference: string }> {
  const created = await openSupportThread(
    db,
    owner(),
    { kind: 'problem', message, context: {} },
    { userAgent: 'Test' },
    options,
  );
  if (created.id === null) throw new Error('no thread');
  return { id: created.id, reference: created.reference };
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  ana = await insertUser(db, 'Ana Ruiz', 'ana@juniper-hk.test');
  mia = await insertUser(db, 'Mia Lopez', 'mia@juniper-hk.test');
  const olive = await insertUser(db, 'Olive Ops', 'olive@pepper-hk.test');
  operator = { userId: olive };
  await grantOperator(database.migrationUrl, { email: 'olive@pepper-hk.test', note: 'tests' });
  juniper = TenantIdSchema.parse(
    (await createBusiness(db, ana, { name: 'Juniper', slug: 'juniper-hk', timeZone: 'UTC' })).id,
  );
  await withTenant(db, juniper, (tx) => addMembership(tx, { userId: mia, role: 'manager' }));
});

beforeEach(async () => {
  clock = new ManualClock(new Date('2026-11-09T09:00:00Z'));
  options = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    release: '1.5.0',
    clock,
  };
  jobOptions = {
    outboxKey: key,
    supportEmail: 'support@pepper.test',
    baseUrl: 'https://app.pepper.test',
    mailer: null,
    clock,
  };
  await deliverAll();
});

afterAll(async () => {
  await database.stop();
});

describe('the same-day reminder (AC-X-25)', () => {
  it('reminds the team once a wait, at 4 h, and again after a new wait', async () => {
    at('2026-11-10T09:00:00Z');
    const thread = await open();
    const reminders = async () =>
      (await deliverAll()).filter(
        (mail) => mail.to === 'support@pepper.test' && mail.subject.includes('Waiting'),
      );
    at('2026-11-10T12:59:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect((await reminders()).filter((mail) => mail.subject.includes(thread.reference))).toEqual(
      [],
    );
    at('2026-11-10T13:00:00Z');
    // Two workers side by side, then again: one reminder.
    await Promise.all([
      runSupportHousekeeping(db, jobOptions),
      runSupportHousekeeping(db, jobOptions),
    ]);
    await runSupportHousekeeping(db, jobOptions);
    const sent = (await reminders()).filter((mail) => mail.subject.includes(thread.reference));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe(`[${thread.reference}] Waiting 4 h: answer it today — Juniper`);
    expect(sent[0]?.text).toContain(`https://app.pepper.test/ops/threads/${thread.id}`);
    // Never the request's own text.
    expect(sent[0]?.text).not.toContain('calendar is empty');
    // Answered: no reminder however long it waits on the business.
    at('2026-11-10T14:00:00Z');
    await replyAsOperator(
      db,
      operator,
      thread.id,
      { message: 'Reconnect it in Settings.' },
      options,
    );
    at('2026-11-10T20:00:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect((await reminders()).filter((mail) => mail.subject.includes(thread.reference))).toEqual(
      [],
    );
    // Their reply starts a new wait: reminded again 4 h later.
    await replyToSupportThread(db, owner(), thread.id, { message: 'Still empty.' }, options);
    at('2026-11-11T00:00:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect(
      (await reminders()).filter((mail) => mail.subject.includes(thread.reference)),
    ).toHaveLength(1);
  });

  it('reminds of a public request by the mailer, once, and tries again if it refused', async () => {
    at('2026-11-12T09:00:00Z');
    const request = await submitPublicSupportRequest(
      db,
      null,
      { email: 'locked@example.test', message: 'I can’t sign in' },
      { supportEmail: null, release: '1.5.0', clock, userAgent: null },
    );
    const mailer = new FakeMailer();
    mailer.failing = true;
    at('2026-11-12T13:30:00Z');
    const failed = await runSupportHousekeeping(db, { ...jobOptions, mailer });
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    mailer.failing = false;
    await runSupportHousekeeping(db, { ...jobOptions, mailer });
    await runSupportHousekeeping(db, { ...jobOptions, mailer });
    const mine = mailer.sent.filter((mail) => mail.subject.includes(request.reference));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      to: 'support@pepper.test',
      subject: `[${request.reference}] Waiting 4 h: answer it today — Signed-out`,
    });
    expect(mine[0]?.text).not.toContain('sign in');
  });
});

describe('auto-close after 7 quiet days (AC-X-24)', () => {
  it('solves an answered request once, tells its requester once, and audits it as the system', async () => {
    at('2026-11-13T09:00:00Z');
    const thread = await open('Where is my booking page?');
    at('2026-11-13T10:00:00Z');
    await replyAsOperator(db, operator, thread.id, { message: 'Under More.' }, options);
    await deliverAll();
    at('2026-11-20T09:59:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect((await readSupportThread(db, owner(), thread.id, { clock })).status).toBe(
      'pepper_replied',
    );
    at('2026-11-20T10:00:00Z');
    await Promise.all([
      runSupportHousekeeping(db, jobOptions),
      runSupportHousekeeping(db, jobOptions),
    ]);
    await runSupportHousekeeping(db, jobOptions);
    const read = await readSupportThread(db, owner(), thread.id, { clock });
    expect(read).toMatchObject({ status: 'solved', solvedBy: 'auto' });
    const closed = (await deliverAll()).filter((mail) =>
      mail.subject.startsWith(`We closed ${thread.reference}`),
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({ to: 'ana@juniper-hk.test', replyTo: 'support@pepper.test' });
    expect(closed[0]?.text).toContain('after 7 quiet days');
    expect(closed[0]?.text).toContain(`https://app.pepper.test/support/${thread.id}`);
    const audit = await withTenant(db, juniper, (tx) => listAuditEntries(tx, { limit: 100 }));
    expect(
      audit.filter(
        (entry) => entry.entity.id === thread.id && entry.action === 'support_thread.solved',
      ),
    ).toEqual([expect.objectContaining({ actor: { kind: 'system', userId: null } })]);
  });

  it('never closes a request waiting on Pepper; a status set by the team counts as activity', async () => {
    at('2026-11-21T09:00:00Z');
    const waiting = await open('Nobody answered');
    const moved = await open('Moved by the team');
    at('2026-11-25T09:00:00Z');
    await setThreadStatusAsOperator(
      db,
      operator,
      moved.id,
      { status: 'pepper_replied' },
      { clock },
    );
    at('2026-11-30T09:00:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect((await readSupportThread(db, owner(), waiting.id, { clock })).status).toBe(
      'waiting_on_pepper',
    );
    expect((await readSupportThread(db, owner(), moved.id, { clock })).status).toBe(
      'pepper_replied',
    );
    at('2026-12-02T09:00:00Z');
    await runSupportHousekeeping(db, jobOptions);
    expect((await readSupportThread(db, owner(), moved.id, { clock })).status).toBe('solved');
  });

  it('closes a public request marked answered once it is quiet', async () => {
    at('2026-12-03T09:00:00Z');
    const request = await submitPublicSupportRequest(
      db,
      null,
      { email: 'quiet@example.test', message: 'Reset my account' },
      { supportEmail: null, release: '1.5.0', clock, userAgent: null },
    );
    const inbox = await readOperatorInbox(db, operator, { view: 'waiting' });
    const item = inbox.items.find((row) => row.reference === request.reference);
    if (item === undefined) throw new Error('not in the inbox');
    await setPublicStatusAsOperator(db, operator, item.id, { status: 'answered' }, { clock });
    at('2026-12-10T09:00:00Z');
    await runSupportHousekeeping(db, jobOptions);
    const solved = await readOperatorInbox(db, operator, { view: 'solved' });
    expect(solved.items.map((row) => row.reference)).toContain(request.reference);
  });
});

describe('"Did this help?" (AC-X-26)', () => {
  it('is the opener’s, once solved; a reopen clears it; the console sees it', async () => {
    at('2026-12-11T09:00:00Z');
    const thread = await open('Can I change my hours?');
    await expect(
      rateSupportThread(db, owner(), thread.id, { rating: 'helpful' }, { clock }),
    ).rejects.toBeInstanceOf(SupportNotRatableError);
    await replyAsOperator(db, operator, thread.id, { message: 'Yes, in Hours.' }, options);
    const solved = await solveSupportThread(db, owner(), thread.id, { clock });
    expect(solved).toMatchObject({ solvedBy: 'member', rating: { canRate: true, value: null } });
    // A manager reads it but isn't asked.
    const asManager = await readSupportThread(db, manager(), thread.id, { clock });
    expect(asManager.rating).toEqual({ canRate: false, value: null });
    await expect(
      rateSupportThread(db, manager(), thread.id, { rating: 'not_helpful' }, { clock }),
    ).rejects.toBeInstanceOf(SupportNotRatableError);
    const rated = await rateSupportThread(db, owner(), thread.id, { rating: 'helpful' }, { clock });
    expect(rated.rating).toEqual({ canRate: true, value: 'helpful' });
    await rateSupportThread(db, owner(), thread.id, { rating: 'helpful' }, { clock });
    await rateSupportThread(db, owner(), thread.id, { rating: 'not_helpful' }, { clock });
    const audit = await withTenant(db, juniper, (tx) => listAuditEntries(tx, { limit: 100 }));
    expect(
      audit
        .filter((entry) => entry.entity.id === thread.id && entry.action === 'support_thread.rated')
        .map((entry) => ('after' in entry ? entry.after : null)),
    ).toEqual([{ rating: 'not_helpful' }, { rating: 'helpful' }]);
    const console = await readOperatorThread(db, operator, thread.id, { clock });
    expect(console).toMatchObject({ rating: 'not_helpful', solvedBy: 'member' });
    const solvedView = await readOperatorInbox(db, operator, { view: 'solved' });
    expect(solvedView.items.find((item) => item.id === thread.id)).toMatchObject({
      rating: 'not_helpful',
    });
    // Reopened by a reply: the answer goes, and so does the question.
    const reopened = await replyToSupportThread(
      db,
      owner(),
      thread.id,
      { message: 'It came back.' },
      options,
    );
    expect(reopened).toMatchObject({
      status: 'waiting_on_pepper',
      solvedBy: null,
      rating: { canRate: false, value: null },
    });
  });
});

describe('saved replies (AC-X-23)', () => {
  it('an operator adds, edits and deletes them; no one else reaches them', async () => {
    const added = await addSavedReply(
      db,
      operator,
      { title: '  Calendar  ', body: 'Hi {first name}, reconnect Google in Settings.' },
      { clock },
    );
    expect(added.title).toBe('Calendar');
    const edited = await editSavedReply(db, operator, added.id, {
      title: 'Calendar sync',
      body: 'Hi {first name}, open Settings → Calendar.',
    });
    expect(edited).toMatchObject({ title: 'Calendar sync' });
    expect((await listSavedReplies(db, operator)).replies.map((reply) => reply.id)).toContain(
      added.id,
    );
    await expect(listSavedReplies(db, { userId: ana })).rejects.toBeInstanceOf(
      OperatorAccessRefusedError,
    );
    await removeSavedReply(db, operator, added.id);
    await expect(removeSavedReply(db, operator, added.id)).rejects.toBeInstanceOf(
      SavedReplyNotFoundError,
    );
    await expect(
      editSavedReply(db, operator, 'not-an-id', { title: 'x', body: 'y' }),
    ).rejects.toBeInstanceOf(SavedReplyNotFoundError);
  });

  it('stops at 100', async () => {
    const have = (await listSavedReplies(db, operator)).replies.length;
    for (let i = have; i < 100; i += 1) {
      await addSavedReply(db, operator, { title: `Reply ${String(i)}`, body: 'Text' }, { clock });
    }
    await expect(
      addSavedReply(db, operator, { title: 'One more', body: 'Text' }, { clock }),
    ).rejects.toBeInstanceOf(SavedRepliesFullError);
  });
});
