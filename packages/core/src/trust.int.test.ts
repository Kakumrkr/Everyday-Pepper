import {
  ActionProposalIdSchema,
  FeedItemIdSchema,
  type FeedItemId,
  OutboxMessageIdSchema,
  TaskIdSchema,
  TenantIdSchema,
  UserIdSchema,
  type ActionExecutionId,
  type MembershipRole,
  type OutboxMessageId,
  type TenantId,
  type TrustJson,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  appendAuditEntry,
  findFeedItem,
  insertStaffMember,
  linkFeedItemToProposal,
  listOpenFeedItems,
  listWaitingFeedItems,
  syncFeedItems,
  claimOutboxMessage,
  deleteTask,
  findOutboxMessage,
  insertTask,
  listAuditEntries,
  listTasks,
  lockTask,
  updateMembershipRole,
  updateTask,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditActorOf, requirePermission, type Actor } from './actor.js';
import { ManualClock } from './clock.js';
import {
  ActionNotFoundError,
  ForbiddenError,
  ProposalChangedError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  UndoRefusedError,
  UndoWindowClosedError,
} from './errors.js';
import { stateFingerprint } from './fingerprint.js';
import { outboxKeyFrom } from './outbox.js';
import {
  approveProposal,
  expireProposals,
  getAction,
  getProposal,
  listPendingProposals,
  listRecentActions,
  proposeForBusiness,
  rejectProposal,
  requestAction,
  reviseProposal,
  undoAction,
  type ActionRunner,
} from './services/ai-actions.js';
import { autonomyPresetOf } from './autonomy.js';
import { changeAutonomy, getAutonomy, getTrackRecord } from './services/autonomy.js';
import { createBusiness } from './services/business.js';
import { clientEmailAddresses, createClient, deleteClient } from './services/clients.js';
import { queueEmail } from './services/outbox.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The trust layer's services against real Postgres (ADR-0028), with two fake tools that write
// real rows through the same repositories a tool would: `add_todo` (an internal write with an
// inverse) and `send_note` (an email to clients through the outbox). Covers the autonomy dial,
// proposals and their approval (stale previews, the approver's own permissions, expiry),
// receipts and undo, and the races: approve twice at once, undo twice at once, undo against the
// worker sending.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let manager: UserId;
let jess: UserId;
let priya: UserId;

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const defaults = { templateDefaults: {} };
const clockAt = (iso: string) => new ManualClock(iso);
// The outbox tests share the worker's real clock: leases are real times.
const realTime = { now: () => new Date() };
const inAMinute = () => new ManualClock(new Date(Date.now() + 60_000));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Tomorrow at 15:00 UTC, always ahead of the real clock (S27: a fixed date here turned every
// approval made on the real clock into an expired one once that date had passed).
const NOW = new Date(Math.floor(Date.now() / DAY) * DAY + DAY + 15 * HOUR).toISOString();
/** `NOW` plus whole days and hours, as an ISO string. */
const after = (days: number, hours = 0) =>
  new Date(Date.parse(NOW) + days * DAY + hours * HOUR).toISOString();

const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const marco = () => as(manager, 'manager');
const jessActor = () => as(jess, 'staff');
const priyaActor = () => as(priya, 'staff');

let keys = 0;
/** A fresh `(conversation, turn, tool call)` key. */
const turnKey = () => `conv:test:turn:${String((keys += 1))}`;

const explanation = {
  requestMessageId: null,
  steps: [{ tool: 'add_todo', input: { title: 'Call Maria' } }],
  facts: [],
  alternatives: [],
};

// A fake `add_todo` tool. Its preview reads the assignee's open to-dos, so another to-do for
// them in between makes an approval stale.
interface TodoPayload {
  ref: string;
  title: string;
  assignee: string;
}
const todo = (assignee: UserId, ref = `r${String((keys += 1))}`): TrustJson => ({
  ref,
  title: 'Call Maria about Friday',
  assignee,
});

const todoRunner: ActionRunner = {
  tool: 'add_todo',
  version: 1,
  actions: ['task.create'],
  tier: 'internal_write',
  async preview(tx, _actor, payload) {
    const { ref, title, assignee } = payload as unknown as TodoPayload;
    const open = await listTasks(tx, {
      status: 'open',
      assigneeUserId: UserIdSchema.parse(assignee),
      limit: 200,
    });
    const state = open.map((task) => [task.id, task.updatedAt.toISOString()]);
    return {
      preview: { title, assignee },
      fingerprint: stateFingerprint({
        tool: 'add_todo',
        toolVersion: 1,
        payload,
        state,
        messages: [],
      }),
      recipients: 0,
      recordOwner: UserIdSchema.parse(assignee),
      targetKey: `todo:${ref}`,
      appointmentStartsAt: null,
    };
  },
  async execute(tx, actor, payload) {
    const { title, assignee } = payload as unknown as TodoPayload;
    const assigneeUserId = UserIdSchema.parse(assignee);
    requirePermission(actor, 'tasks.manage', { ownerUserId: assigneeUserId });
    const task = await insertTask(tx, {
      title,
      dueAt: null,
      assigneeUserId,
      source: 'ai',
      createdBy: actor.context.userId,
    });
    await appendAuditEntry(tx, {
      actor: auditActorOf(actor),
      change: {
        action: 'task.created',
        entity: { type: 'task', id: task.id },
        before: null,
        after: { status: 'open', dueAt: null, assigneeUserId, source: 'ai' },
      },
    });
    return {
      entity: { type: 'task', id: task.id },
      before: null,
      after: { status: 'open' },
      inverse: { taskId: task.id },
      outboxMessageIds: [],
      appointmentStartsAt: null,
    };
  },
  async undo(tx, _actor, receipt) {
    const taskId = TaskIdSchema.parse((receipt.inverse as { taskId: string }).taskId);
    const task = await lockTask(tx, taskId);
    // Done since: the member worked on it, so taking it away would lose that.
    if (task?.status !== 'open') throw new UndoRefusedError('changed_since');
    await deleteTask(tx, taskId);
  },
};

// A fake `send_note` tool: one email per client through the outbox, after the AI grace.
const noteRunner: ActionRunner = {
  tool: 'send_note',
  version: 1,
  actions: ['message.confirmation'],
  tier: 'external_or_irreversible',
  preview(_tx, _actor, payload) {
    const { clients } = payload as { clients: number; ref: string };
    return Promise.resolve({
      preview: { clients },
      fingerprint: stateFingerprint({
        tool: 'send_note',
        toolVersion: 1,
        payload,
        state: null,
        messages: clients,
      }),
      recipients: clients,
      recordOwner: null,
      targetKey: `note:${(payload as { ref: string }).ref}`,
      appointmentStartsAt: null,
    });
  },
  async execute(tx, _actor, payload) {
    const { clients, ref } = payload as { clients: number; ref: string };
    const ids: OutboxMessageId[] = [];
    for (let i = 0; i < clients; i += 1) {
      const id = await queueEmail(
        tx,
        { to: `client${String(i)}@example.test`, subject: 'See you soon', text: 'Hello' },
        { key, dedupeKey: `note:${ref}:${String(i)}`, now: new Date(Date.now() + 120_000) },
      );
      if (id !== undefined) ids.push(id);
    }
    return {
      entity: { type: 'note', id: '0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b' },
      before: null,
      after: { clients },
      inverse: {},
      outboxMessageIds: ids,
      appointmentStartsAt: null,
    };
  },
  async undo() {
    // Taking the emails back is all there is to undo.
  },
};

// A fake tool whose preview makes the real change, as the S24 tools do (ADR-0029): the trust
// layer must roll it back, so only the execution's to-do stays. `refusing` makes the domain
// refuse it, as a time booked meanwhile would.
let refusing = false;
const dryRunRunner: ActionRunner = {
  tool: 'dry_run_todo',
  version: 1,
  actions: ['booking.create'],
  tier: 'internal_write',
  async preview(tx, actor, payload) {
    if (refusing) throw new Error('The domain refuses it now');
    const { ref, assignee } = payload as unknown as TodoPayload;
    await insertTask(tx, {
      title: `preview ${ref}`,
      dueAt: null,
      assigneeUserId: UserIdSchema.parse(assignee),
      source: 'ai',
      createdBy: actor.context.userId,
    });
    return {
      preview: { ref },
      fingerprint: stateFingerprint({
        tool: 'dry_run_todo',
        toolVersion: 1,
        payload,
        state: null,
        messages: [],
      }),
      recipients: 0,
      recordOwner: UserIdSchema.parse(assignee),
      targetKey: `dry:${ref}`,
      appointmentStartsAt: null,
    };
  },
  async execute(tx, actor, payload) {
    const { ref, assignee } = payload as unknown as TodoPayload;
    const task = await insertTask(tx, {
      title: `executed ${ref}`,
      dueAt: null,
      assigneeUserId: UserIdSchema.parse(assignee),
      source: 'ai',
      createdBy: actor.context.userId,
    });
    return {
      entity: { type: 'task', id: task.id },
      before: null,
      after: { status: 'open' },
      inverse: null,
      outboxMessageIds: [],
      appointmentStartsAt: null,
    };
  },
  undo() {
    return Promise.resolve();
  },
};

const tasksOf = (assignee: UserId) =>
  withTenant(db, tenantId, (tx) =>
    listTasks(tx, { status: 'all', assigneeUserId: assignee, limit: 200 }),
  );

async function outboxStatus(id: string) {
  const row = await withTenant(db, tenantId, (tx) =>
    findOutboxMessage(tx, OutboxMessageIdSchema.parse(id)),
  );
  return row?.status;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: 'juniper-trust',
    timeZone: 'America/New_York',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  manager = await insertUser(db, 'Marco');
  jess = await insertUser(db, 'Jess');
  priya = await insertUser(db, 'Priya');
  await withTenant(db, tenantId, async (tx) => {
    await addMembership(tx, { userId: manager, role: 'manager' });
    await addMembership(tx, { userId: jess, role: 'staff' });
    await addMembership(tx, { userId: priya, role: 'staff' });
  });
});

afterAll(async () => {
  await database.stop();
});

describe('autonomy settings', () => {
  it('everyone sees them; owners and managers change them, with an audit entry', async () => {
    expect((await getAutonomy(db, jessActor(), defaults)).levels['task.create']).toBe('notify');
    const changed = await changeAutonomy(
      db,
      marco(),
      { levels: { 'booking.create': 'notify' } },
      { templateDefaults: { 'booking.move': 'ask' } },
    );
    expect(changed.levels).toMatchObject({ 'booking.create': 'notify', 'booking.move': 'ask' });
    const reset = await changeAutonomy(db, ana(), { levels: { 'booking.create': null } }, defaults);
    expect(reset.levels['booking.create']).toBe('ask');
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 5 }));
    expect(entries.filter((e) => e.action === 'autonomy.updated')).toHaveLength(2);
  });

  it('staff and the AI cannot change them', async () => {
    await expect(changeAutonomy(db, jessActor(), { askFirst: true }, defaults)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      changeAutonomy(db, { ...ana(), via: 'ai' }, { askFirst: false }, defaults),
    ).rejects.toThrow(ForbiddenError);
  });

  it('refuses "just do it" for bulk messages', async () => {
    await expect(
      changeAutonomy(db, ana(), { levels: { 'message.bulk': 'auto' } }, defaults),
    ).rejects.toThrow();
  });
});

describe('requestAction', () => {
  it('runs a write the dial allows, with a receipt, an undo window and the AI in the audit log', async () => {
    const clock = clockAt(NOW);
    const result = await requestAction(
      db,
      jessActor(),
      todoRunner,
      { payload: todo(jess), idempotencyKey: turnKey(), explanation, untrustedContext: false },
      { ...defaults, clock },
    );
    if (result.kind !== 'executed') throw new Error('expected an execution');
    expect(result.execution).toMatchObject({
      action: 'task.create',
      outcome: 'execute_and_notify',
      status: 'done',
      onBehalfOfUserId: jess,
      recordOwnerUserId: jess,
      undoUntil: after(7),
      explanation: {
        untrustedContext: false,
        decision: { outcome: 'execute_and_notify', reason: 'setting' },
      },
    });
    const task = (await tasksOf(jess)).find((t) => t.id === result.execution.entity.id);
    expect(task).toMatchObject({ source: 'ai', createdByUserId: jess });
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 2 }));
    expect(entries.map((e) => [e.action, e.actor.kind])).toEqual([
      ['ai_action.executed', 'ai_on_behalf_of'],
      ['task.created', 'ai_on_behalf_of'],
    ]);
  });

  it('a retried tool call returns the first result and writes nothing more', async () => {
    const request = {
      payload: todo(jess),
      idempotencyKey: turnKey(),
      explanation,
      untrustedContext: false,
    };
    const before = (await tasksOf(jess)).length;
    const first = await requestAction(db, jessActor(), todoRunner, request, defaults);
    const again = await requestAction(db, jessActor(), todoRunner, request, defaults);
    expect(again).toEqual(first);
    expect((await tasksOf(jess)).length).toBe(before + 1);
  });

  it('limits the AI to the member’s own permissions (D-4) and stores nothing', async () => {
    const before = (await tasksOf(priya)).length;
    await expect(
      requestAction(
        db,
        jessActor(),
        todoRunner,
        { payload: todo(priya), idempotencyKey: turnKey(), explanation, untrustedContext: false },
        defaults,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect((await tasksOf(priya)).length).toBe(before);
    expect(await listPendingProposals(db, jessActor())).toEqual([]);
  });

  it('asks instead when "Ask me first for everything" is on, and writes nothing until approved', async () => {
    await changeAutonomy(db, ana(), { askFirst: true }, defaults);
    try {
      const before = (await tasksOf(jess)).length;
      const result = await requestAction(
        db,
        jessActor(),
        todoRunner,
        { payload: todo(jess), idempotencyKey: turnKey(), explanation, untrustedContext: false },
        defaults,
      );
      expect(result).toMatchObject({
        kind: 'proposed',
        proposal: { status: 'pending', explanation: { decision: { reason: 'ask_first' } } },
      });
      expect((await tasksOf(jess)).length).toBe(before);
    } finally {
      await changeAutonomy(db, ana(), { askFirst: false }, defaults);
    }
  });

  it('asks before an email after untrusted text, and before one to more than ten clients', async () => {
    const untrusted = await requestAction(
      db,
      ana(),
      noteRunner,
      {
        payload: { clients: 1, ref: 'u1' },
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: true,
      },
      defaults,
    );
    expect(untrusted).toMatchObject({
      kind: 'proposed',
      proposal: {
        explanation: { decision: { reason: 'untrusted_context' }, untrustedContext: true },
      },
    });
    const bulk = await requestAction(
      db,
      ana(),
      noteRunner,
      {
        payload: { clients: 11, ref: 'b1' },
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: false,
      },
      defaults,
    );
    expect(bulk).toMatchObject({
      kind: 'proposed',
      proposal: { explanation: { decision: { reason: 'bulk_lock' } } },
    });
  });

  it('a newer request for the same thing replaces the pending proposal', async () => {
    await changeAutonomy(db, ana(), { levels: { 'task.create': 'ask' } }, defaults);
    try {
      const payload = todo(jess, 'same-target');
      const first = await requestAction(
        db,
        jessActor(),
        todoRunner,
        { payload, idempotencyKey: turnKey(), explanation, untrustedContext: false },
        defaults,
      );
      const second = await requestAction(
        db,
        jessActor(),
        todoRunner,
        { payload, idempotencyKey: turnKey(), explanation, untrustedContext: false },
        defaults,
      );
      if (first.kind !== 'proposed' || second.kind !== 'proposed')
        throw new Error('expected proposals');
      const pending = (await listPendingProposals(db, jessActor())).map((p) => p.id);
      expect(pending).toContain(second.proposal.id);
      expect(pending).not.toContain(first.proposal.id);
      await expect(
        approveProposal(db, jessActor(), first.proposal.id, {
          shownFingerprint: first.proposal.fingerprint,
          runner: todoRunner,
        }),
      ).rejects.toThrow(new ProposalNotPendingError('superseded'));
    } finally {
      await changeAutonomy(db, ana(), { levels: { 'task.create': null } }, defaults);
    }
  });
});

/** A pending `add_todo` proposal for `assignee`, made by `by`. */
async function propose(by: Actor, assignee: UserId, clock = clockAt(NOW)) {
  await changeAutonomy(db, ana(), { levels: { 'task.create': 'ask' } }, defaults);
  try {
    const result = await requestAction(
      db,
      by,
      todoRunner,
      { payload: todo(assignee), idempotencyKey: turnKey(), explanation, untrustedContext: false },
      { ...defaults, clock },
    );
    if (result.kind !== 'proposed') throw new Error('expected a proposal');
    return result.proposal;
  } finally {
    await changeAutonomy(db, ana(), { levels: { 'task.create': null } }, defaults);
  }
}

describe('previews are dry runs (ADR-0029)', () => {
  it('rolls back whatever the preview wrote, on request and on approval', async () => {
    const payload = todo(jess, 'dry-1');
    const asked = await requestAction(
      db,
      jessActor(),
      dryRunRunner,
      { payload, idempotencyKey: turnKey(), explanation, untrustedContext: false },
      defaults,
    );
    if (asked.kind !== 'proposed') throw new Error('expected a proposal');
    const titles = async () => (await tasksOf(jess)).map((task) => task.title);
    expect(await titles()).not.toContain('preview dry-1');

    const approved = await approveProposal(db, jessActor(), asked.proposal.id, {
      shownFingerprint: asked.proposal.fingerprint,
      runner: dryRunRunner,
    });
    expect(approved.kind).toBe('executed');
    expect(await titles()).toContain('executed dry-1');
    expect(await titles()).not.toContain('preview dry-1');
  });

  it('supersedes a proposal the domain refuses at approval and says why', async () => {
    const asked = await requestAction(
      db,
      jessActor(),
      dryRunRunner,
      {
        payload: todo(jess, 'dry-2'),
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: false,
      },
      defaults,
    );
    if (asked.kind !== 'proposed') throw new Error('expected a proposal');
    refusing = true;
    try {
      const result = await approveProposal(db, jessActor(), asked.proposal.id, {
        shownFingerprint: asked.proposal.fingerprint,
        runner: dryRunRunner,
      });
      expect(result).toEqual({ kind: 'refused', error: new Error('The domain refuses it now') });
    } finally {
      refusing = false;
    }
    expect((await listPendingProposals(db, jessActor())).map((p) => p.id)).not.toContain(
      asked.proposal.id,
    );
  });
});

describe('the facts a preview found (S26b)', () => {
  // The fake to-do tool, also telling *Why?* how many to-dos the assignee had open.
  const factsRunner: ActionRunner = {
    ...todoRunner,
    async preview(tx, actor, payload) {
      const shown = await todoRunner.preview(tx, actor, payload);
      const open = await listTasks(tx, {
        status: 'open',
        assigneeUserId: UserIdSchema.parse((payload as unknown as TodoPayload).assignee),
        limit: 200,
      });
      return {
        ...shown,
        facts: [{ kind: 'open_todos', ref: null, value: { count: open.length } }],
      };
    },
  };
  const ask = async (runner: ActionRunner, facts: unknown[] = []) => {
    await changeAutonomy(db, ana(), { levels: { 'task.create': 'ask' } }, defaults);
    try {
      const result = await requestAction(
        db,
        jessActor(),
        runner,
        {
          payload: todo(jess),
          idempotencyKey: turnKey(),
          explanation: { ...explanation, facts: facts as typeof explanation.facts },
          untrustedContext: false,
        },
        defaults,
      );
      if (result.kind !== 'proposed') throw new Error('expected a proposal');
      return result.proposal;
    } finally {
      await changeAutonomy(db, ana(), { levels: { 'task.create': null } }, defaults);
    }
  };
  const count = (facts: readonly { value: unknown }[]) =>
    (facts[0]?.value as { count?: number } | undefined)?.count;

  it('stores them with the proposal, refreshes them when it is stale, and keeps them on the receipt', async () => {
    const proposal = await ask(factsRunner);
    const open = (await tasksOf(jess)).filter((t) => t.status === 'open').length;
    expect(proposal.explanation.facts).toEqual([
      { kind: 'open_todos', ref: null, value: { count: open } },
    ]);
    await withTenant(db, tenantId, (tx) =>
      insertTask(tx, {
        title: 'Sweep',
        dueAt: null,
        assigneeUserId: jess,
        source: 'manual',
        createdBy: owner,
      }),
    );
    const stale = await approveProposal(db, jessActor(), proposal.id, {
      shownFingerprint: proposal.fingerprint,
      runner: factsRunner,
    });
    if (stale.kind !== 'stale') throw new Error('expected a stale result');
    expect(count(stale.proposal.explanation.facts)).toBe(open + 1);
    const done = await approveProposal(db, jessActor(), stale.proposal.id, {
      shownFingerprint: stale.proposal.fingerprint,
      runner: factsRunner,
    });
    if (done.kind !== 'executed') throw new Error('expected an execution');
    expect(count(done.execution.explanation.facts)).toBe(open + 1);
  });

  it("keeps the request's own facts when the preview has none", async () => {
    const given = [{ kind: 'asked_for', ref: null, value: 'a call' }];
    expect((await ask(todoRunner, given)).explanation.facts).toEqual(given);
  });
});

describe('approveProposal', () => {
  it('runs exactly what was shown, as the approver, once', async () => {
    const proposal = await propose(jessActor(), jess);
    const before = (await tasksOf(jess)).length;
    const approval = { shownFingerprint: proposal.fingerprint, runner: todoRunner };
    const result = await approveProposal(db, jessActor(), proposal.id, approval, {
      clock: clockAt(NOW),
    });
    if (result.kind !== 'executed') throw new Error('expected an execution');
    expect(result.execution).toMatchObject({
      proposalId: proposal.id,
      outcome: 'propose',
      onBehalfOfUserId: jess,
    });
    expect(result.replayed).toBeUndefined();
    // A double tap returns the same execution, marked as a replay (a text reply says so, S63.2).
    expect(await approveProposal(db, jessActor(), proposal.id, approval)).toEqual({
      ...result,
      replayed: true,
    });
    expect((await tasksOf(jess)).length).toBe(before + 1);
  });

  it('two approvals at the same moment run it once (concurrent double tap)', async () => {
    const proposal = await propose(jessActor(), jess);
    const before = (await tasksOf(jess)).length;
    const approval = { shownFingerprint: proposal.fingerprint, runner: todoRunner };
    const [a, b] = await Promise.all([
      approveProposal(db, jessActor(), proposal.id, approval),
      approveProposal(db, ana(), proposal.id, approval),
    ]);
    if (a.kind !== 'executed' || b.kind !== 'executed') throw new Error('expected executions');
    expect(b.execution).toEqual(a.execution);
    // Exactly one of them ran it.
    expect([a.replayed, b.replayed].filter((replayed) => replayed === true)).toHaveLength(1);
    expect((await tasksOf(jess)).length).toBe(before + 1);
  });

  it('does not run a stale proposal: it is superseded by a fresh one to show', async () => {
    const proposal = await propose(jessActor(), jess);
    // Jess's to-do list changes after the preview.
    await withTenant(db, tenantId, (tx) =>
      insertTask(tx, {
        title: 'Sweep',
        dueAt: null,
        assigneeUserId: jess,
        source: 'manual',
        createdBy: owner,
      }),
    );
    const before = (await tasksOf(jess)).length;
    const result = await approveProposal(db, jessActor(), proposal.id, {
      shownFingerprint: proposal.fingerprint,
      runner: todoRunner,
    });
    if (result.kind !== 'stale') throw new Error('expected a stale result');
    expect(result.proposal.fingerprint).not.toBe(proposal.fingerprint);
    expect(result.proposal).toMatchObject({
      status: 'pending',
      payload: proposal.payload,
      requestedByUserId: jess,
    });
    expect((await tasksOf(jess)).length).toBe(before);
    // The fresh one runs once approved as shown.
    const fresh = await approveProposal(db, jessActor(), result.proposal.id, {
      shownFingerprint: result.proposal.fingerprint,
      runner: todoRunner,
    });
    expect(fresh.kind).toBe('executed');
  });

  it('does not run a proposal approved from an out-of-date card', async () => {
    const proposal = await propose(jessActor(), jess);
    const result = await approveProposal(db, jessActor(), proposal.id, {
      shownFingerprint: 'f'.repeat(64),
      runner: todoRunner,
    });
    expect(result.kind).toBe('stale');
  });

  it('expires, and then runs nothing', async () => {
    const proposal = await propose(jessActor(), jess);
    const before = (await tasksOf(jess)).length;
    const later = clockAt(after(2));
    // The fake clock is past the 24-hour window of a proposal made now, too.
    later.set(new Date(Date.parse(proposal.expiresAt) + 1000));
    const result = await approveProposal(
      db,
      jessActor(),
      proposal.id,
      { shownFingerprint: proposal.fingerprint, runner: todoRunner },
      { clock: later },
    );
    expect(result).toEqual({ kind: 'expired' });
    expect((await tasksOf(jess)).length).toBe(before);
    await expect(rejectProposal(db, jessActor(), proposal.id)).rejects.toThrow(
      new ProposalNotPendingError('expired'),
    );
  });

  it('the AI can never approve a proposal, not even its own member’s', async () => {
    const proposal = await propose(jessActor(), jess);
    await expect(
      approveProposal(db, { ...jessActor(), via: 'ai' }, proposal.id, {
        shownFingerprint: proposal.fingerprint,
        runner: todoRunner,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect((await listPendingProposals(db, jessActor())).map((p) => p.id)).toContain(proposal.id);
  });

  it('staff cannot approve a colleague’s proposal; a manager can', async () => {
    const proposal = await propose(jessActor(), jess);
    const approval = { shownFingerprint: proposal.fingerprint, runner: todoRunner };
    // Priya can't even see it (RLS), let alone approve it.
    await expect(approveProposal(db, priyaActor(), proposal.id, approval)).rejects.toThrow(
      ProposalNotFoundError,
    );
    expect((await approveProposal(db, marco(), proposal.id, approval)).kind).toBe('executed');
  });

  it("re-checks the approver's own role at approval time", async () => {
    const lead = await insertUser(db, 'Lee');
    await withTenant(db, tenantId, (tx) => addMembership(tx, { userId: lead, role: 'manager' }));
    // As a manager, Lee's AI proposed a to-do for Jess.
    const proposal = await propose(as(lead, 'manager'), jess);
    // Then Lee became staff: Jess's to-dos are no longer Lee's to approve.
    await withTenant(db, tenantId, (tx) => updateMembershipRole(tx, lead, 'staff'));
    await expect(
      approveProposal(db, as(lead, 'staff'), proposal.id, {
        shownFingerprint: proposal.fingerprint,
        runner: todoRunner,
      }),
    ).rejects.toThrow(ForbiddenError);
    expect((await listPendingProposals(db, ana())).map((p) => p.id)).toContain(proposal.id);
  });

  it('a rejected proposal cannot be approved', async () => {
    const proposal = await propose(jessActor(), jess);
    expect(await rejectProposal(db, jessActor(), proposal.id)).toMatchObject({
      status: 'rejected',
      decidedByUserId: jess,
    });
    expect((await rejectProposal(db, jessActor(), proposal.id)).status).toBe('rejected');
    await expect(
      approveProposal(db, jessActor(), proposal.id, {
        shownFingerprint: proposal.fingerprint,
        runner: todoRunner,
      }),
    ).rejects.toThrow(new ProposalNotPendingError('rejected'));
  });

  it('rejects from a text only as shown, and only the first time (S64, AC-X-93)', async () => {
    const proposal = await propose(jessActor(), jess);
    // A card that moved since the text stays pending.
    await expect(
      rejectProposal(db, jessActor(), proposal.id, { shownFingerprint: 'f'.repeat(64) }),
    ).rejects.toThrow(ProposalChangedError);
    expect((await listPendingProposals(db, jessActor())).map((p) => p.id)).toContain(proposal.id);
    expect(
      await rejectProposal(db, jessActor(), proposal.id, {
        shownFingerprint: proposal.fingerprint,
        firstOnly: true,
      }),
    ).toMatchObject({ status: 'rejected', decidedByUserId: jess });
    // Rejected already (in the app, say): the text is told, not handed the rejection again.
    await expect(
      rejectProposal(db, jessActor(), proposal.id, {
        shownFingerprint: proposal.fingerprint,
        firstOnly: true,
      }),
    ).rejects.toThrow(new ProposalNotPendingError('rejected'));
  });

  it('refuses an unknown proposal', async () => {
    await expect(
      approveProposal(
        db,
        ana(),
        ActionProposalIdSchema.parse('0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a70'),
        {
          shownFingerprint: 'a'.repeat(64),
          runner: todoRunner,
        },
      ),
    ).rejects.toThrow(ProposalNotFoundError);
  });
});

/** An executed `add_todo` for Jess, at `NOW`. */
async function executedTodo(): Promise<ActionExecutionId> {
  const result = await requestAction(
    db,
    jessActor(),
    todoRunner,
    { payload: todo(jess), idempotencyKey: turnKey(), explanation, untrustedContext: false },
    { ...defaults, clock: clockAt(NOW) },
  );
  if (result.kind !== 'executed') throw new Error('expected an execution');
  return result.execution.id;
}

describe('undoAction', () => {
  it('runs the inverse through the domain within the window, with the reason', async () => {
    const id = await executedTodo();
    const taskCount = (await tasksOf(jess)).length;
    const { execution } = await undoAction(
      db,
      jessActor(),
      id,
      { runner: todoRunner, reason: 'wrong' },
      { clock: clockAt(after(1)) },
    );
    expect(execution).toMatchObject({
      status: 'undone',
      undoneByUserId: jess,
      undoReason: 'wrong',
    });
    expect((await tasksOf(jess)).length).toBe(taskCount - 1);
    const [entry] = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1 }));
    expect(entry).toMatchObject({
      action: 'ai_action.undone',
      actor: { kind: 'user', userId: jess },
    });
  });

  it('two undos at the same moment undo it once', async () => {
    const id = await executedTodo();
    const clock = clockAt(after(0, 1));
    const [a, b] = await Promise.all([
      undoAction(db, jessActor(), id, { runner: todoRunner }, { clock }),
      undoAction(db, ana(), id, { runner: todoRunner }, { clock }),
    ]);
    expect(a.execution.status).toBe('undone');
    expect(b.execution).toEqual(a.execution);
  });

  it('refuses once the window has closed', async () => {
    const id = await executedTodo();
    await expect(
      undoAction(db, jessActor(), id, { runner: todoRunner }, { clock: clockAt(after(7)) }),
    ).rejects.toThrow(UndoWindowClosedError);
  });

  it('changes nothing when the domain refuses the inverse (the world moved on)', async () => {
    const id = await executedTodo();
    const [receipt] = await listRecentActions(db, jessActor(), { limit: 1 });
    await withTenant(db, tenantId, (tx) =>
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- the receipt above is this execution
      updateTaskDone(tx, receipt!.entity.id),
    );
    await expect(
      undoAction(db, jessActor(), id, { runner: todoRunner }, { clock: clockAt(NOW) }),
    ).rejects.toThrow(new UndoRefusedError('changed_since'));
    const [after] = await listRecentActions(db, jessActor(), { limit: 1 });
    expect(after).toMatchObject({ id, status: 'done' });
  });

  it('the AI cannot undo or reject on its own: only a person decides', async () => {
    const id = await executedTodo();
    await expect(
      undoAction(
        db,
        { ...jessActor(), via: 'ai' },
        id,
        { runner: todoRunner },
        { clock: clockAt(NOW) },
      ),
    ).rejects.toThrow(ForbiddenError);
    const proposal = await propose(jessActor(), jess);
    await expect(rejectProposal(db, { ...jessActor(), via: 'ai' }, proposal.id)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('staff cannot undo what the AI did for a colleague', async () => {
    const id = await executedTodo();
    await expect(
      undoAction(db, priyaActor(), id, { runner: todoRunner }, { clock: clockAt(NOW) }),
    ).rejects.toThrow(ActionNotFoundError);
  });

  it('takes back an AI email during its grace (undo send)', async () => {
    const result = await requestAction(
      db,
      ana(),
      noteRunner,
      {
        payload: { clients: 2, ref: 'grace' },
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: false,
      },
      { ...defaults, clock: realTime },
    );
    if (result.kind !== 'executed') throw new Error('expected an execution');
    const undoUntil = Date.parse(result.execution.undoUntil ?? '');
    expect(undoUntil - Date.now()).toBeGreaterThan(100_000);
    expect(undoUntil - Date.now()).toBeLessThanOrEqual(120_000);
    const undone = await undoAction(
      db,
      ana(),
      result.execution.id,
      { runner: noteRunner, reason: 'changed_mind' },
      { clock: inAMinute() },
    );
    expect(undone.messages.cancelled).toHaveLength(2);
    for (const id of result.execution.outboxMessageIds)
      expect(await outboxStatus(id)).toBe('cancelled');
  });

  it('refuses to undo an email the worker is already sending, and changes nothing', async () => {
    const result = await requestAction(
      db,
      ana(),
      noteRunner,
      {
        payload: { clients: 1, ref: 'leaving' },
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: false,
      },
      { ...defaults, clock: realTime },
    );
    if (result.kind !== 'executed') throw new Error('expected an execution');
    const message = OutboxMessageIdSchema.parse(result.execution.outboxMessageIds[0]);
    // The worker claims it once its grace is over (its own clock).
    const now = new Date(Date.now() + 130_000);
    await withTenant(db, tenantId, (tx) =>
      claimOutboxMessage(tx, message, now, new Date(now.getTime() + 60_000)),
    );
    await expect(
      undoAction(db, ana(), result.execution.id, { runner: noteRunner }, { clock: inAMinute() }),
    ).rejects.toThrow(new UndoRefusedError('already_sent'));
    expect(await outboxStatus(message)).toBe('pending');
  });

  it('an undo racing the worker either cancels the email or reports it sent, never both', async () => {
    for (let round = 0; round < 5; round += 1) {
      const result = await requestAction(
        db,
        ana(),
        noteRunner,
        {
          payload: { clients: 1, ref: `race${String(round)}` },
          idempotencyKey: turnKey(),
          explanation,
          untrustedContext: false,
        },
        { ...defaults, clock: realTime },
      );
      if (result.kind !== 'executed') throw new Error('expected an execution');
      const message = OutboxMessageIdSchema.parse(result.execution.outboxMessageIds[0]);
      // The worker claims it once its grace is over (its own clock).
      const now = new Date(Date.now() + 130_000);
      const [claimed, undone] = await Promise.allSettled([
        withTenant(db, tenantId, (tx) =>
          claimOutboxMessage(tx, message, now, new Date(now.getTime() + 60_000)),
        ),
        undoAction(db, ana(), result.execution.id, { runner: noteRunner }, { clock: inAMinute() }),
      ]);
      const status = await outboxStatus(message);
      if (undone.status === 'fulfilled') {
        expect(status).toBe('cancelled');
        expect(claimed).toMatchObject({ status: 'fulfilled', value: undefined });
      } else {
        expect(undone.reason).toEqual(new UndoRefusedError('already_sent'));
        expect(status).toBe('pending');
        expect(claimed.status === 'fulfilled' && claimed.value !== undefined).toBe(true);
      }
    }
  });
});

describe('the receipt’s outbox links', () => {
  const sloppy = (queueAt: () => Date, link?: OutboxMessageId): ActionRunner => ({
    ...noteRunner,
    async execute(tx, actor, payload) {
      const effect = await noteRunner.execute(tx, actor, payload);
      if (link !== undefined) return { ...effect, outboxMessageIds: [link] };
      const id = await queueEmail(
        tx,
        { to: 'client@example.test', subject: 'Hi', text: 'Hello' },
        { key, dedupeKey: `sloppy:${String((keys += 1))}`, now: queueAt() },
      );
      return { ...effect, outboxMessageIds: id === undefined ? [] : [id] };
    },
  });

  it('refuses a message action whose email skips the undo-send grace, and writes nothing', async () => {
    const before = (await listRecentActions(db, ana(), { limit: 500 })).length;
    await expect(
      requestAction(
        db,
        ana(),
        sloppy(() => new Date()),
        {
          payload: { clients: 0, ref: 'nograce' },
          idempotencyKey: turnKey(),
          explanation,
          untrustedContext: false,
        },
        { ...defaults, clock: realTime },
      ),
    ).rejects.toThrow(/must wait/);
    expect((await listRecentActions(db, ana(), { limit: 500 })).length).toBe(before);
  });

  it('refuses a link to a message that is not this business’s pending one', async () => {
    await expect(
      requestAction(
        db,
        ana(),
        sloppy(
          () => new Date(),
          OutboxMessageIdSchema.parse('0190f5b2-7c1a-7d3e-9a1b-2c3d4e5f6a7b'),
        ),
        {
          payload: { clients: 0, ref: 'badlink' },
          idempotencyKey: turnKey(),
          explanation,
          untrustedContext: false,
        },
        { ...defaults, clock: realTime },
      ),
    ).rejects.toThrow(/not a pending message/);
  });
});

describe('listing', () => {
  it('staff see only their own proposals and receipts', async () => {
    const forJess = await propose(jessActor(), jess);
    const forAna = await propose(ana(), owner);
    const jessPending = (await listPendingProposals(db, jessActor())).map((p) => p.id);
    expect(jessPending).toContain(forJess.id);
    expect(jessPending).not.toContain(forAna.id);
    const receipts = await listRecentActions(db, jessActor(), { limit: 200 });
    expect(receipts.every((r) => r.onBehalfOfUserId === jess || r.requestedByUserId === jess)).toBe(
      true,
    );
  });
});

describe('S26: receipts of approved proposals, tool versions and summaries (ADR-0031)', () => {
  it('a staff member sees, and may undo, the receipt of their proposal a lead approved', async () => {
    const proposal = await propose(jessActor(), jess);
    const result = await approveProposal(db, marco(), proposal.id, {
      shownFingerprint: proposal.fingerprint,
      runner: todoRunner,
    });
    if (result.kind !== 'executed') throw new Error('expected an execution');
    expect(result.execution).toMatchObject({ onBehalfOfUserId: manager, requestedByUserId: jess });
    // Jess sees it (S23 log: the receipt used to be the lead's only); Priya does not.
    expect((await getAction(db, jessActor(), result.execution.id)).id).toBe(result.execution.id);
    expect((await listRecentActions(db, jessActor(), { limit: 200 })).map((r) => r.id)).toContain(
      result.execution.id,
    );
    await expect(getAction(db, priyaActor(), result.execution.id)).rejects.toThrow(
      ActionNotFoundError,
    );
    await expect(
      undoAction(db, priyaActor(), result.execution.id, { runner: todoRunner }),
    ).rejects.toThrow(ActionNotFoundError);
    const before = (await tasksOf(jess)).length;
    const { execution } = await undoAction(
      db,
      jessActor(),
      result.execution.id,
      { runner: todoRunner, reason: 'changed_mind' },
      { clock: clockAt(after(1)) },
    );
    expect(execution).toMatchObject({ status: 'undone', undoneByUserId: jess });
    expect((await tasksOf(jess)).length).toBe(before - 1);
  });

  it('a direct action answers the member it was done for', async () => {
    const execution = await getAction(db, jessActor(), await executedTodo());
    expect(execution).toMatchObject({ onBehalfOfUserId: jess, requestedByUserId: jess });
  });

  it('a proposal from another version of the tool expires instead of running', async () => {
    const proposal = await propose(jessActor(), jess);
    expect(proposal.toolVersion).toBe(1);
    const before = (await tasksOf(jess)).length;
    const result = await approveProposal(db, jessActor(), proposal.id, {
      shownFingerprint: proposal.fingerprint,
      runner: { ...todoRunner, version: 2 },
    });
    expect(result).toEqual({ kind: 'expired' });
    expect((await tasksOf(jess)).length).toBe(before);
    expect((await getProposal(db, jessActor(), proposal.id)).status).toBe('expired');
  });

  it('keeps the tool’s one-sentence summary on the receipt', async () => {
    const summarised: ActionRunner = {
      ...todoRunner,
      async execute(tx, actor, payload) {
        return { ...(await todoRunner.execute(tx, actor, payload)), summary: 'To-do for Jess.' };
      },
    };
    const result = await requestAction(
      db,
      jessActor(),
      summarised,
      { payload: todo(jess), idempotencyKey: turnKey(), explanation, untrustedContext: false },
      { ...defaults, clock: clockAt(NOW) },
    );
    if (result.kind !== 'executed') throw new Error('expected an execution');
    expect(result.execution.summary).toBe('To-do for Jess.');
  });
});

async function updateTaskDone(tx: TenantTx, id: string) {
  await updateTask(tx, TaskIdSchema.parse(id), { status: 'done', completedAt: new Date() });
}

describe('S36: proposals of the business, revisions and the feed (ADR-0040)', () => {
  const nudge = (ref: string, text = 'Hello'): TrustJson => ({ clients: 1, ref, text });
  const business = () => ({ ...ana(), via: 'ai' as const });
  const passRequest = (ref: string, payload = nudge(ref)) => ({
    payload,
    idempotencyKey: `nudge.pass.${ref}`,
    explanation: { ...explanation, steps: [] },
    untrustedContext: true,
  });
  const propose = (ref: string, payload?: TrustJson) =>
    withTenant(db, tenantId, (tx) =>
      proposeForBusiness(tx, business(), noteRunner, passRequest(ref, payload), {
        clock: clockAt(NOW),
      }),
    );

  it('waits for an owner or manager, whatever the dial, once per key, audited as the system', async () => {
    await changeAutonomy(db, ana(), { levels: { 'message.confirmation': 'auto' } }, defaults);
    const proposal = await propose('p1');
    expect(proposal).toMatchObject({
      status: 'pending',
      requestedByUserId: null,
      recordOwnerUserId: null,
    });
    expect(proposal.explanation.decision).toEqual({ outcome: 'propose', reason: 'setting' });
    expect((await propose('p1')).id).toBe(proposal.id);
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 50 }));
    expect(
      entries.find(
        (entry) => entry.action === 'ai_proposal.created' && entry.entity.id === proposal.id,
      )?.actor,
    ).toEqual({ kind: 'system', userId: null });
    // Staff neither see nor decide it; a manager does.
    expect((await listPendingProposals(db, jessActor())).map((p) => p.id)).not.toContain(
      proposal.id,
    );
    await expect(rejectProposal(db, jessActor(), proposal.id)).rejects.toThrow();
    await changeAutonomy(db, ana(), { levels: { 'message.confirmation': null } }, defaults);
  });

  it('a revision replaces the proposal with a new fingerprint; the old card can no longer run', async () => {
    const proposal = await propose('p2');
    const revised = await reviseProposal(
      db,
      marco(),
      proposal.id,
      {
        shownFingerprint: proposal.fingerprint,
        payload: nudge('p2', 'Hi there'),
        runner: noteRunner,
      },
      { clock: clockAt(after(0, 1)) },
    );
    expect(revised.kind).toBe('revised');
    expect(revised.proposal.fingerprint).not.toBe(proposal.fingerprint);
    expect(revised.proposal.payload).toEqual(nudge('p2', 'Hi there'));
    expect(revised.proposal.requestedByUserId).toBeNull();
    // The new words are the manager's own, in the audit.
    const audit = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 50 }));
    expect(
      audit.find(
        (entry) =>
          entry.action === 'ai_proposal.created' && entry.entity.id === revised.proposal.id,
      )?.actor,
    ).toEqual({ kind: 'user', userId: manager });
    expect((await getProposal(db, ana(), proposal.id)).status).toBe('superseded');
    await expect(
      approveProposal(db, ana(), proposal.id, {
        shownFingerprint: proposal.fingerprint,
        runner: noteRunner,
      }),
    ).rejects.toThrow(ProposalNotPendingError);
    // An out-of-date card changes nothing.
    const stale = await reviseProposal(
      db,
      ana(),
      revised.proposal.id,
      {
        shownFingerprint: proposal.fingerprint,
        payload: nudge('p2', 'Other'),
        runner: noteRunner,
      },
      { clock: clockAt(after(0, 1)) },
    );
    expect(stale).toMatchObject({ kind: 'stale', proposal: { id: revised.proposal.id } });
    // Staff may not revise it (they can't even see it); the AI may not either.
    await expect(
      reviseProposal(db, jessActor(), revised.proposal.id, {
        shownFingerprint: revised.proposal.fingerprint,
        payload: nudge('p2', 'x'),
        runner: noteRunner,
      }),
    ).rejects.toThrow(ProposalNotFoundError);
    await expect(
      reviseProposal(db, { ...ana(), via: 'ai' }, revised.proposal.id, {
        shownFingerprint: revised.proposal.fingerprint,
        payload: nudge('p2', 'x'),
        runner: noteRunner,
      }),
    ).rejects.toThrow(ForbiddenError);
    // A revision must keep its target.
    await expect(
      reviseProposal(
        db,
        ana(),
        revised.proposal.id,
        {
          shownFingerprint: revised.proposal.fingerprint,
          payload: nudge('other-target'),
          runner: noteRunner,
        },
        { clock: clockAt(after(0, 1)) },
      ),
    ).rejects.toThrow(/keep its target/);
  });

  it('a revision past its time expires the proposal instead', async () => {
    const proposal = await propose('p3');
    const result = await reviseProposal(
      db,
      ana(),
      proposal.id,
      { shownFingerprint: proposal.fingerprint, payload: nudge('p3', 'Late'), runner: noteRunner },
      { clock: clockAt(after(2)) },
    );
    expect(result).toMatchObject({ kind: 'expired', proposal: { status: 'expired' } });
  });

  it('the feed item waiting on it follows edits and closes with the decision', async () => {
    const staffId = await withTenant(db, tenantId, async (tx) => {
      const staff = await insertStaffMember(tx, {
        displayName: 'Jess',
        color: '#2a7230',
        active: true,
        membershipId: null,
      });
      await syncFeedItems(
        tx,
        ['2030-01-07', '2030-01-08', '2030-01-09'].map((day) => ({
          kind: 'schedule_gaps' as const,
          subjectKey: `staff:${staff.id}`,
          day,
          audienceStaffId: null,
          subjects: { staffMemberId: staff.id, clientId: null, bookingId: null, serviceId: null },
          payload: {
            gapCount: 1,
            openMinutes: 60,
            longestStartsAt: `${day}T15:00:00.000Z`,
            longestEndsAt: `${day}T16:00:00.000Z`,
          },
          expiresAt: new Date('2030-01-10T00:00:00Z'),
        })),
        new Date(NOW),
      );
      return staff.id;
    });
    const itemFor = async (day: string) => {
      const items = await withTenant(db, tenantId, (tx) =>
        listOpenFeedItems(tx, new Date(NOW), 200),
      );
      const item = items.find((each) => each.dedupeKey === `schedule_gaps:staff:${staffId}:${day}`);
      if (item === undefined) throw new Error('no item');
      return FeedItemIdSchema.parse(item.id);
    };
    const items = new Map<string, FeedItemId>();
    const statusOf = async (day: string) => {
      const id = items.get(day);
      if (id === undefined) throw new Error('not linked');
      return (await withTenant(db, tenantId, (tx) => findFeedItem(tx, id)))?.status;
    };
    const linked = async (day: string, ref: string) => {
      const item = await itemFor(day);
      items.set(day, item);
      const proposal = await propose(ref);
      await withTenant(db, tenantId, (tx) => linkFeedItemToProposal(tx, item, proposal.id));
      return proposal;
    };

    // Edited, then approved: done.
    const first = await linked('2030-01-07', 'f1');
    const edited = await reviseProposal(
      db,
      ana(),
      first.id,
      {
        shownFingerprint: first.fingerprint,
        payload: nudge('f1', 'Edited'),
        runner: noteRunner,
      },
      { clock: clockAt(NOW) },
    );
    const waiting = await withTenant(db, tenantId, (tx) => listWaitingFeedItems(tx));
    expect(waiting.find((each) => each.day === '2030-01-07')?.actionProposalId).toBe(
      edited.proposal.id,
    );
    const approved = await approveProposal(
      db,
      ana(),
      edited.proposal.id,
      {
        shownFingerprint: edited.proposal.fingerprint,
        runner: noteRunner,
      },
      // The fake tool queues its email on the real clock, after the undo-send grace.
      { clock: realTime },
    );
    expect(approved.kind).toBe('executed');
    expect(await statusOf('2030-01-07')).toBe('done');

    // Turned down: dismissed.
    const second = await linked('2030-01-08', 'f2');
    await rejectProposal(db, marco(), second.id, { clock: clockAt(NOW) });
    expect(await statusOf('2030-01-08')).toBe('dismissed');

    // Expired by the clean-up: expired, so the pass may open it again.
    const third = await linked('2030-01-09', 'f3');
    const expired = await withTenant(db, tenantId, (tx) =>
      expireProposals(tx, new Date(after(3)), 100),
    );
    expect(expired).toBeGreaterThanOrEqual(1);
    expect((await getProposal(db, ana(), third.id)).status).toBe('expired');
    expect(await statusOf('2030-01-09')).toBe('expired');
  });
});

describe('presets and the track record (S53)', () => {
  // A business of its own, so the other tests' receipts and mistakes don't count here.
  let lena: Actor;
  let sam: Actor;

  beforeAll(async () => {
    const lenaId = await insertUser(db, 'Lena');
    const samId = await insertUser(db, 'Sam');
    const tenant = await createBusiness(db, lenaId, {
      name: 'Lena Nails',
      slug: 'lena-trust-record',
      timeZone: 'America/New_York',
    });
    const id = TenantIdSchema.parse(tenant.id);
    await withTenant(db, id, (tx) => addMembership(tx, { userId: samId, role: 'staff' }));
    lena = { context: { tenantId: id, userId: lenaId, role: 'owner' } };
    sam = { context: { tenantId: id, userId: samId, role: 'staff' } };
  });

  // The run is measured in the database's own times; the windows by the clock (real here).
  /** One to-do the AI adds for `actor`. */
  async function addTodo(actor: Actor) {
    const result = await requestAction(
      db,
      actor,
      todoRunner,
      {
        payload: todo(actor.context.userId),
        idempotencyKey: turnKey(),
        explanation,
        untrustedContext: false,
      },
      { ...defaults, clock: realTime },
    );
    return result;
  }
  const record = async (actor: Actor) => {
    const { actions } = await getTrackRecord(db, actor, { ...defaults, clock: realTime });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- every action has a row
    return actions.find((row) => row.action === 'task.create')!;
  };

  it('a preset sets every action; balanced goes back to the defaults', async () => {
    await changeAutonomy(db, lena, { askFirst: true }, defaults);
    // A preset is a whole choice: "Ask me first for everything" goes off with it.
    expect((await changeAutonomy(db, lena, { preset: 'careful' }, defaults)).askFirst).toBe(false);
    const careful = await changeAutonomy(db, lena, { preset: 'careful' }, defaults);
    expect(new Set(Object.values(careful.levels))).toEqual(new Set(['ask']));
    expect(autonomyPresetOf(careful, {})).toBe('careful');
    const handsOff = await changeAutonomy(db, lena, { preset: 'hands_off' }, defaults);
    expect(handsOff.levels).toMatchObject({ 'booking.move': 'auto', 'message.bulk': 'ask' });
    expect(autonomyPresetOf(handsOff, {})).toBe('hands_off');
    const mixed = await changeAutonomy(db, lena, { levels: { 'task.create': 'ask' } }, defaults);
    expect(autonomyPresetOf(mixed, {})).toBeNull();
    const balanced = await changeAutonomy(db, lena, { preset: 'balanced' }, defaults);
    expect(balanced).toEqual(await getAutonomy(db, lena, defaults));
    expect(balanced.levels['booking.move']).toBe('ask');
    expect(autonomyPresetOf(balanced, {})).toBe('balanced');
    await expect(changeAutonomy(db, sam, { preset: 'hands_off' }, defaults)).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('counts the last 30 days and the run since the last mistake', async () => {
    expect(await record(lena)).toEqual({
      action: 'task.create',
      doneLast30Days: 0,
      correctInARow: 0,
      offer: null,
    });
    const first = await addTodo(lena);
    if (first.kind !== 'executed') throw new Error('expected an execution');
    await addTodo(lena);
    await addTodo(sam);
    expect(await record(lena)).toMatchObject({ doneLast30Days: 3, correctInARow: 3 });
    // Staff see their own records only.
    expect(await record(sam)).toMatchObject({ doneLast30Days: 1, correctInARow: 1 });

    // An Undo marked "wrong" is a mistake: the run starts again after the wrong one.
    await undoAction(
      db,
      lena,
      first.execution.id,
      { runner: todoRunner, reason: 'wrong' },
      { clock: realTime },
    );
    await addTodo(lena);
    expect(await record(lena)).toMatchObject({ doneLast30Days: 4, correctInARow: 3 });

    // A card turned down is a mistake too.
    await changeAutonomy(db, lena, { levels: { 'task.create': 'ask' } }, defaults);
    const asked = await addTodo(lena);
    if (asked.kind !== 'proposed') throw new Error('expected a proposal');
    await rejectProposal(db, lena, asked.proposal.id, { clock: realTime });
    expect(await record(lena)).toMatchObject({ doneLast30Days: 4, correctInARow: 0 });
    await changeAutonomy(db, lena, { levels: { 'task.create': null } }, defaults);

    // Older than 30 days: no longer counted.
    const later = await getTrackRecord(db, lena, {
      ...defaults,
      clock: { now: () => new Date(Date.now() + 31 * DAY) },
    });
    expect(later.actions.find((row) => row.action === 'task.create')).toMatchObject({
      doneLast30Days: 0,
    });
  });

  it('names the addresses a card emails, only for clients the member may see (S53)', async () => {
    const ana = await createClient(db, lena, { name: 'Ana', email: 'ana@example.test' });
    const noEmail = await createClient(db, lena, { name: 'Bo' });
    const gone = await createClient(db, lena, { name: 'Cy', email: 'cy@example.test' });
    await deleteClient(db, lena, gone.id);
    const ids = [ana.id, noEmail.id, gone.id, ana.id];
    expect([...(await clientEmailAddresses(db, lena, ids))]).toEqual([
      [ana.id, 'ana@example.test'],
    ]);
    // Staff reach only their own clients: none here.
    expect((await clientEmailAddresses(db, sam, ids)).size).toBe(0);
    expect((await clientEmailAddresses(db, lena, [])).size).toBe(0);
  });

  it('after 20 correct in a row, offers owners one step more room, never staff', async () => {
    for (let i = 0; i < 20; i += 1) await addTodo(lena);
    expect(await record(lena)).toMatchObject({ correctInARow: 20, offer: 'auto' });
    expect((await record(sam)).offer).toBeNull();
    await changeAutonomy(db, lena, { askFirst: true }, defaults);
    expect((await record(lena)).offer).toBeNull();
    await changeAutonomy(
      db,
      lena,
      { askFirst: false, levels: { 'task.create': 'auto' } },
      defaults,
    );
    expect((await record(lena)).offer).toBeNull();
  });
});
