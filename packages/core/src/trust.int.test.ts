import {
  ActionProposalIdSchema,
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
  ProposalNotFoundError,
  ProposalNotPendingError,
  UndoRefusedError,
  UndoWindowClosedError,
} from './errors.js';
import { stateFingerprint } from './fingerprint.js';
import { outboxKeyFrom } from './outbox.js';
import {
  approveProposal,
  getAction,
  getProposal,
  listPendingProposals,
  listRecentActions,
  rejectProposal,
  requestAction,
  undoAction,
  type ActionRunner,
} from './services/ai-actions.js';
import { changeAutonomy, getAutonomy } from './services/autonomy.js';
import { createBusiness } from './services/business.js';
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
const NOW = '2026-10-21T15:00:00.000Z';

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
      undoUntil: '2026-10-28T15:00:00.000Z',
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
    // A double tap returns the same execution.
    expect(await approveProposal(db, jessActor(), proposal.id, approval)).toEqual(result);
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
    expect(a.kind).toBe('executed');
    expect(b).toEqual(a);
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
    const later = clockAt('2026-10-23T15:00:00.000Z');
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
      { clock: clockAt('2026-10-22T15:00:00.000Z') },
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
    const clock = clockAt('2026-10-21T16:00:00.000Z');
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
      undoAction(
        db,
        jessActor(),
        id,
        { runner: todoRunner },
        { clock: clockAt('2026-10-28T15:00:00.000Z') },
      ),
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
      { clock: clockAt('2026-10-22T15:00:00.000Z') },
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
