import {
  AI_EMAIL_GRACE_SECONDS,
  AUTONOMY_ACTIONS,
  ActionExecutionIdSchema,
  ActionExecutionSchema,
  ActionExplanationSchema,
  ActionIdempotencyKeySchema,
  ActionProposalIdSchema,
  ActionProposalSchema,
  AutonomyActionSchema,
  AutonomyOutcomeSchema,
  ExecutionStatusSchema,
  OutboxMessageIdSchema,
  ProposalStatusSchema,
  StateFingerprintSchema,
  UndoReasonSchema,
  UserIdSchema,
  UtcDateTimeSchema,
  type ActionExecution,
  type ActionExecutionId,
  type ActionExplanation,
  type ActionProposal,
  type ActionProposalId,
  type AuditActor,
  type AutonomyAction,
  type AutonomyDecision,
  type OutboxMessageId,
  type ProposalStatus,
  type RiskTier,
  type StateFingerprint,
  type TrustJson,
  type UndoReason,
  type UserId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  cancelOutboxMessages,
  decideProposal,
  expirePendingProposals,
  findExecutionByKey,
  findExecution,
  findExecutionOfProposal,
  findOutboxMessage,
  findProposal,
  findProposalByKey,
  insertExecution,
  insertProposal,
  listExecutions,
  listPendingProposals as listPendingProposalRows,
  lockExecution,
  lockPendingProposalFor,
  lockProposal,
  markExecutionUndone,
  repointFeedItems,
  settleFeedItemsOf,
  withMember,
  type AiActionExecutionRow,
  type AiActionProposalRow,
  type Database,
  type OutboxCancellation,
  type TenantTx,
} from '@pepper/db';
import { auditActorOf, requirePermission, type Actor } from '../actor.js';
import { decideAutonomy } from '../autonomy.js';
import { systemClock, type Clock } from '../clock.js';
import {
  ActionNotFoundError,
  ActionTooLateError,
  ConcurrentActionError,
  ForbiddenError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  UndoRefusedError,
  UndoWindowClosedError,
} from '../errors.js';
import { permissionScope } from '../permissions.js';
import { undoUntil } from '../undo-window.js';
import { loadAutonomy, type AutonomyDefaults } from './autonomy.js';

// The trust layer's actions (ADR-0028, playbook principles 1, 6, 7 and 8). Every write the AI
// makes goes through here: `requestAction` decides with the autonomy dial and either runs it
// (with a receipt and an undo) or stores a proposal; `approveProposal` runs a proposal after
// checking the approver's own permissions and that the world is still the one they were shown;
// `undoAction` runs the inverse through the domain. Each runs in one transaction under the
// member's scope (`withMember`), so a receipt never exists without its change, or the other way
// round, and a double tap or a retry finds the first result instead of acting twice.

/**
 * A tool's link to the trust layer (S24 tools implement it). Each method runs inside the
 * trust layer's transaction through the same domain functions the screens use, as `actor`
 * (whose `via` is `'ai'` for the AI's own preview and execution, unset for a member's undo).
 * They never commit, open their own transaction or call the model.
 */
export interface ActionRunner {
  /** The tool's name (`verb_noun`). */
  tool: string;
  /** Bumped whenever what the tool does changes; part of the fingerprint. */
  version: number;
  /** The dial actions it involves; the first is the one recorded (`booking.move`, then any message). */
  actions: readonly [AutonomyAction, ...AutonomyAction[]];
  /** The tier it declares; the actions' own tiers apply if stricter. */
  tier: RiskTier;
  /**
   * No dial setting decides it: it always waits for a person (forgetting a fact, S30 D-1).
   * Its `actions` still name who may approve and undo it.
   */
  alwaysAsks?: boolean;
  /**
   * A dry run: what would change, computed by the domain, and the fingerprint of it all. The
   * trust layer runs it in a savepoint it always rolls back, so a preview may make the real
   * change to see what it does (ADR-0029: preview = execution) and nothing of it stays.
   */
  preview(tx: TenantTx, actor: Actor, payload: TrustJson): Promise<ActionPreview>;
  /** Makes the change; queued messages are returned so Undo can take them back. */
  execute(tx: TenantTx, actor: Actor, payload: TrustJson): Promise<ActionEffect>;
  /**
   * Reverses an execution through the domain (rules apply). Throws `UndoRefusedError` when the
   * world has moved on; the trust layer then changes nothing.
   */
  undo(tx: TenantTx, actor: Actor, receipt: ActionReceipt): Promise<void>;
}

export interface ActionPreview {
  /** What the member is shown (the typed diff and would-be emails), ids only. */
  preview: TrustJson;
  /** `stateFingerprint` of the tool, payload, state read and would-be messages. */
  fingerprint: StateFingerprint;
  /** Clients a message would reach (0 when none): the bulk lock counts these. */
  recipients: number;
  /** Whose record it changes (a staff member's booking), for permission checks. */
  recordOwner: UserId | null;
  /** What it changes, e.g. `booking:<id>`: one pending proposal per target. */
  targetKey: string;
  /** The appointment it touches, if any: proposals expire and undo closes when it starts. */
  appointmentStartsAt: Date | null;
  /**
   * What the domain checked on the way (S26b: "the time was free", "2 bookings stay inside the
   * block"), for *Why?*. When given, they are the explanation's facts: a stale approval's fresh
   * preview brings its own.
   */
  facts?: ActionExplanation['facts'];
}

export interface ActionEffect {
  entity: { type: string; id: string };
  before: TrustJson;
  after: TrustJson;
  /** What `undo` needs; `null`: it cannot be undone. */
  inverse: TrustJson | null;
  outboxMessageIds: readonly OutboxMessageId[];
  appointmentStartsAt: Date | null;
  /** One sentence about what it did, in the tool's own words (the receipt shows it, S26). */
  summary?: string | null;
}

/** An execution as `undo` receives it. */
export interface ActionReceipt {
  entity: { type: string; id: string };
  before: TrustJson;
  after: TrustJson;
  inverse: TrustJson;
}

/** What the agent loop knows about the request, besides the tool and its payload. */
export interface ActionRequest {
  payload: TrustJson;
  /** `(conversation, turn, tool call)` from S25: a retry finds the first result. */
  idempotencyKey: string;
  /** The *Why?* trace so far; the trust layer adds the decision and the untrusted flag. */
  explanation: Omit<ActionExplanation, 'decision' | 'untrustedContext'>;
  /** The turn's context held untrusted text (tracked by the agent loop, never the model). */
  untrustedContext: boolean;
  /**
   * That untrusted text came from outside the team, not only from memory (S30): a memory save
   * then always asks. Not given: any untrusted text counts.
   */
  outsideText?: boolean;
}

export type ActionResult =
  { kind: 'executed'; execution: ActionExecution } | { kind: 'proposed'; proposal: ActionProposal };

/** A proposal waits at most this long; less when its appointment starts sooner. */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

interface ServiceOptions extends AutonomyDefaults {
  clock?: Clock;
}

/**
 * The AI wants to make a write: decides with the business's autonomy dial and either runs it
 * now (`execute`, `execute_and_notify`) or stores a proposal for the member (`propose`). The
 * decision is made here, from the domain's own preview, so no caller can skip the dial.
 * Refuses with `ForbiddenError` what the member may not do at all: the AI is limited to its
 * member's permissions (D-4).
 */
export async function requestAction(
  db: Database,
  actor: Actor,
  runner: ActionRunner,
  request: ActionRequest,
  options: ServiceOptions,
): Promise<ActionResult> {
  const idempotencyKey = ActionIdempotencyKeySchema.parse(request.idempotencyKey);
  const now = (options.clock ?? systemClock).now();
  const member = memberOf(actor);
  const ai: Actor = { ...member, via: 'ai' };
  for (const action of runner.actions) requirePermission(member, permissionFor(action));

  return withMember(db, actor.context, async (tx) => {
    const executed = await findExecutionByKey(tx, idempotencyKey);
    if (executed !== undefined) return { kind: 'executed', execution: toExecution(executed) };
    const proposed = await findProposalByKey(tx, idempotencyKey);
    if (proposed !== undefined) return { kind: 'proposed', proposal: toProposal(proposed) };

    const preview = await dryRun(tx, ai, runner, request.payload);
    checkRecordPermissions(member, runner, preview.recordOwner);
    const decision = decideAutonomy(
      {
        // A write that names no dial action always asks (`decideAutonomy`).
        actions: runner.alwaysAsks === true ? [] : [...runner.actions],
        tier: runner.tier,
        recipients: preview.recipients,
        untrustedContext: request.untrustedContext,
        ...(request.outsideText !== undefined && { outsideText: request.outsideText }),
      },
      await loadAutonomy(tx, options),
    );
    const explanation = ActionExplanationSchema.parse({
      ...request.explanation,
      facts: explanationFacts(preview.facts, request.explanation.facts),
      untrustedContext: request.untrustedContext,
      decision,
    });

    if (decision.outcome === 'propose') {
      const proposal = await storeProposal(tx, member, runner, {
        idempotencyKey,
        payload: request.payload,
        preview,
        explanation,
        now,
      });
      return { kind: 'proposed', proposal: toProposal(proposal) };
    }
    const execution = await runAndRecord(tx, ai, runner, {
      proposalId: null,
      requestedBy: member.context.userId,
      outcome: decision.outcome,
      idempotencyKey,
      payload: request.payload,
      explanation,
      recordOwner: preview.recordOwner,
      now,
    });
    return { kind: 'executed', execution: toExecution(execution) };
  });
}

export type ApprovalResult =
  | { kind: 'executed'; execution: ActionExecution }
  /** The world changed since the member saw it: here is the fresh proposal to show. */
  | { kind: 'stale'; proposal: ActionProposal }
  /**
   * The domain now refuses it (the time was booked meanwhile, the member lost the right): the
   * proposal is superseded and `error` says why (the tool turns it into its answer).
   */
  | { kind: 'refused'; error: unknown }
  | { kind: 'expired' };

/**
 * A member approves a proposal they were shown, by its id and the fingerprint the card showed.
 * Only the member it was made for, or an owner or manager, may approve it, and only if their
 * own role allows the action on that record now. If the card is out of date or the world has
 * changed since the preview, nothing runs: the proposal is superseded by a fresh one to show.
 * A second approval (a double tap) returns the first one's execution.
 */
export async function approveProposal(
  db: Database,
  actor: Actor,
  proposalId: ActionProposalId,
  approval: { shownFingerprint: string; runner: ActionRunner },
  options: { clock?: Clock } = {},
): Promise<ApprovalResult> {
  const id = ActionProposalIdSchema.parse(proposalId);
  const shown = StateFingerprintSchema.parse(approval.shownFingerprint);
  const { runner } = approval;
  const now = (options.clock ?? systemClock).now();
  // Only a person approves: the AI can never approve its own (or any) proposal.
  if (actor.via === 'ai') throw new ForbiddenError();
  const member = memberOf(actor);
  const ai: Actor = { ...member, via: 'ai' };

  return withMember(db, actor.context, async (tx) => {
    const proposal = await lockProposal(tx, id);
    if (proposal === undefined) throw new ProposalNotFoundError();
    const action = AutonomyActionSchema.parse(proposal.action);
    checkDecider(member, action, proposal.requestedByUserId);
    if (proposal.status === 'approved') {
      const execution = await findExecutionOfProposal(tx, id);
      if (execution === undefined) throw new ProposalNotPendingError('approved');
      return { kind: 'executed', execution: toExecution(execution) };
    }
    if (proposal.status !== 'pending') throw new ProposalNotPendingError(settled(proposal.status));
    checkRunner(runner, proposal);
    requirePermission(member, permissionFor(action), { ownerUserId: proposalOwner(proposal) });

    // A proposal from an older version of the tool may not mean the same thing any more, and
    // its payload may not parse: it expires rather than reading as stale (ADR-0031).
    if (proposal.toolVersion !== runner.version || proposal.expiresAt.getTime() <= now.getTime()) {
      await decide(tx, member, proposal, 'expired', now);
      return { kind: 'expired' };
    }

    // The world as it is now, in this transaction: anything the member's decision rested on
    // (the payload, the rows the preview read, the messages) must be unchanged.
    let fresh: ActionPreview;
    try {
      fresh = await dryRun(tx, ai, runner, toJson(proposal.payload));
    } catch (error) {
      // The dry run rolled back to its savepoint, so the transaction can still record this.
      await decide(tx, member, proposal, 'superseded', now);
      await settleFeedItemsOf(tx, proposal.id, 'expired', now);
      return { kind: 'refused', error };
    }
    if (shown !== proposal.fingerprint || fresh.fingerprint !== proposal.fingerprint) {
      await decide(tx, member, proposal, 'superseded', now);
      checkRecordPermissions(member, runner, fresh.recordOwner);
      const shownWhy = ActionExplanationSchema.parse(proposal.explanation);
      const explanation = ActionExplanationSchema.parse({
        ...shownWhy,
        facts:
          fresh.facts === undefined
            ? shownWhy.facts
            : explanationFacts(
                fresh.facts,
                shownWhy.facts.filter((fact) => fact.kind === 'memory_recalled'),
              ),
      });
      const next = await storeProposal(tx, member, runner, {
        idempotencyKey: `${proposal.id}.refresh`,
        payload: toJson(proposal.payload),
        preview: fresh,
        explanation,
        now,
        requestedBy: proposal.requestedByUserId,
        // A pass's proposal stays the system's when the world changed under it (S36).
        ...(proposal.requestedByUserId === null && { auditActor: { kind: 'system' as const } }),
      });
      await repointFeedItems(tx, proposal.id, next.id);
      return { kind: 'stale', proposal: toProposal(next) };
    }
    checkRecordPermissions(member, runner, fresh.recordOwner);

    await decide(tx, member, proposal, 'approved', now);
    const execution = await runAndRecord(tx, ai, runner, {
      proposalId: id,
      requestedBy: userIdOrNull(proposal.requestedByUserId),
      outcome: 'propose',
      idempotencyKey: proposal.idempotencyKey,
      payload: toJson(proposal.payload),
      explanation: ActionExplanationSchema.parse(proposal.explanation),
      recordOwner: fresh.recordOwner,
      now,
    });
    return { kind: 'executed', execution: toExecution(execution) };
  });
}

/** A member turns a proposal down (people only). Rejecting it again is a no-op. */
export async function rejectProposal(
  db: Database,
  actor: Actor,
  proposalId: ActionProposalId,
  options: { clock?: Clock } = {},
): Promise<ActionProposal> {
  const id = ActionProposalIdSchema.parse(proposalId);
  const now = (options.clock ?? systemClock).now();
  if (actor.via === 'ai') throw new ForbiddenError();
  const member = memberOf(actor);
  return withMember(db, actor.context, async (tx) => {
    const proposal = await lockProposal(tx, id);
    if (proposal === undefined) throw new ProposalNotFoundError();
    checkDecider(member, AutonomyActionSchema.parse(proposal.action), proposal.requestedByUserId);
    if (proposal.status === 'rejected') return toProposal(proposal);
    if (proposal.status !== 'pending') throw new ProposalNotPendingError(settled(proposal.status));
    return toProposal(await decide(tx, member, proposal, 'rejected', now));
  });
}

export interface UndoResult {
  execution: ActionExecution;
  /** The messages it took back, and those that had already left (or were leaving). */
  messages: OutboxCancellation;
}

/**
 * A member undoes an AI action within its window: its unsent messages are taken back and its
 * inverse runs through the domain, as the member (rules apply). Only the member it was done
 * for, or an owner or manager, may undo it, and only if their role allows the action now. If
 * the domain refuses (the slot was rebooked) or a message that was the whole action already
 * left, nothing changes. Undoing it again returns the first undo.
 */
export async function undoAction(
  db: Database,
  actor: Actor,
  executionId: ActionExecutionId,
  undo: { runner: ActionRunner; reason?: UndoReason | null },
  options: { clock?: Clock } = {},
): Promise<UndoResult> {
  const id = ActionExecutionIdSchema.parse(executionId);
  const reason = UndoReasonSchema.nullable().parse(undo.reason ?? null);
  const { runner } = undo;
  const now = (options.clock ?? systemClock).now();
  // An undo is a write of its own (it can cancel a booking): only a person may ask for it, so
  // the AI can't use it to get around the dial.
  if (actor.via === 'ai') throw new ForbiddenError();
  const member = memberOf(actor);

  return withMember(db, actor.context, async (tx) => {
    const row = await lockExecution(tx, id);
    if (row === undefined) throw new ActionNotFoundError();
    const action = AutonomyActionSchema.parse(row.action);
    // The member it was done for, or whose request it answered (a lead approved it for them).
    checkDecider(member, action, row.onBehalfOfUserId, row.requestedByUserId);
    if (row.status === 'undone') {
      return { execution: toExecution(row), messages: { cancelled: [], tooLate: [] } };
    }
    if (row.tool !== runner.tool) throw new Error(`Runner ${runner.tool} cannot undo ${row.tool}`);
    requirePermission(member, permissionFor(action), {
      ownerUserId: userIdOrNull(row.recordOwnerUserId),
    });
    if (
      row.inverse === null ||
      row.undoUntil === null ||
      now.getTime() >= row.undoUntil.getTime()
    ) {
      throw new UndoWindowClosedError();
    }

    const messages = await cancelOutboxMessages(
      tx,
      row.outboxMessageIds.map((message) => OutboxMessageIdSchema.parse(message)),
      now,
    );
    // A message that is the action itself can't be undone once it left.
    if (AUTONOMY_ACTIONS[action].undo.kind === 'until_sent' && messages.tooLate.length > 0) {
      throw new UndoRefusedError('already_sent');
    }
    await runner.undo(tx, member, {
      entity: { type: row.entityType, id: row.entityId },
      before: toJson(row.before),
      after: toJson(row.after),
      inverse: toJson(row.inverse),
    });
    const undone = await markExecutionUndone(tx, id, {
      by: member.context.userId,
      at: now,
      reason,
    });
    // The row is locked and was done; it can't have changed under us.
    if (undone === undefined) throw new ActionNotFoundError();
    await appendAuditEntry(tx, {
      actor: auditActorOf(member),
      change: {
        action: 'ai_action.undone',
        entity: { type: 'ai_action_execution', id: row.id },
        before: executionValues(row),
        after: { ...executionValues(undone), undoReason: reason },
      },
      requestId: member.requestId,
    });
    return { execution: toExecution(undone), messages };
  });
}

/**
 * The business proposes an action no member asked for (S36: the morning pass's rebooking
 * nudges), in the caller's tenant transaction: the tool's dry run runs as `ai` (the business's
 * AI acting for an owner, so the domain's checks pass), and the proposal waits for whoever may
 * decide it (`requestedBy` and `recordOwner` none: owners and managers). It never runs without
 * a person: whatever the dial says, a pass's action is a proposal. Idempotent by key.
 */
export async function proposeForBusiness(
  tx: TenantTx,
  ai: Actor,
  runner: ActionRunner,
  request: Omit<ActionRequest, 'outsideText'>,
  options: { clock?: Clock } = {},
): Promise<ActionProposal> {
  const idempotencyKey = ActionIdempotencyKeySchema.parse(request.idempotencyKey);
  const now = (options.clock ?? systemClock).now();
  const proposed = await findProposalByKey(tx, idempotencyKey);
  if (proposed !== undefined) return toProposal(proposed);
  const preview = await dryRun(tx, { ...ai, via: 'ai' }, runner, request.payload);
  const explanation = ActionExplanationSchema.parse({
    ...request.explanation,
    facts: explanationFacts(preview.facts, request.explanation.facts),
    untrustedContext: request.untrustedContext,
    decision: { outcome: 'propose', reason: 'setting' },
  });
  const row = await storeProposal(tx, memberOf(ai), runner, {
    idempotencyKey,
    payload: request.payload,
    preview,
    explanation,
    now,
    requestedBy: null,
    auditActor: { kind: 'system' },
  });
  return toProposal(row);
}

/**
 * A member who may decide a proposal changes what it would do before approving (S36: a
 * nudge's words), on the card whose fingerprint they saw: the tool's dry run runs on the new
 * payload and replaces the proposal (same target, new fingerprint), with its explanation and
 * whom it was for. Nothing runs; the member then approves the new card. A card out of date
 * (`shownFingerprint` differs) changes nothing and gets the current proposal back (`stale`);
 * one past its time or from an older tool version expires.
 */
export async function reviseProposal(
  db: Database,
  actor: Actor,
  proposalId: ActionProposalId,
  revision: { shownFingerprint: string; payload: TrustJson; runner: ActionRunner },
  options: { clock?: Clock } = {},
): Promise<{ kind: 'revised' | 'stale' | 'expired'; proposal: ActionProposal }> {
  const id = ActionProposalIdSchema.parse(proposalId);
  const shown = StateFingerprintSchema.parse(revision.shownFingerprint);
  const { runner } = revision;
  const now = (options.clock ?? systemClock).now();
  if (actor.via === 'ai') throw new ForbiddenError();
  const member = memberOf(actor);
  const ai: Actor = { ...member, via: 'ai' };
  return withMember(db, actor.context, async (tx) => {
    const proposal = await lockProposal(tx, id);
    if (proposal === undefined) throw new ProposalNotFoundError();
    const action = AutonomyActionSchema.parse(proposal.action);
    checkDecider(member, action, proposal.requestedByUserId);
    if (proposal.status !== 'pending') throw new ProposalNotPendingError(settled(proposal.status));
    checkRunner(runner, proposal);
    requirePermission(member, permissionFor(action), { ownerUserId: proposalOwner(proposal) });
    if (proposal.toolVersion !== runner.version || proposal.expiresAt.getTime() <= now.getTime()) {
      return {
        kind: 'expired',
        proposal: toProposal(await decide(tx, member, proposal, 'expired', now)),
      };
    }
    if (shown !== proposal.fingerprint) return { kind: 'stale', proposal: toProposal(proposal) };
    const preview = await dryRun(tx, ai, runner, revision.payload);
    checkRecordPermissions(member, runner, preview.recordOwner);
    if (preview.targetKey !== proposal.targetKey) {
      throw new Error(`${runner.tool}: a revision must keep its target`);
    }
    const next = await storeProposal(tx, member, runner, {
      idempotencyKey: `${proposal.id}.edit`,
      payload: revision.payload,
      preview,
      explanation: ActionExplanationSchema.parse(proposal.explanation),
      now,
      requestedBy: proposal.requestedByUserId,
      // The new words are the member's own.
      auditActor: auditActorOf(member),
    });
    return { kind: 'revised', proposal: toProposal(next) };
  });
}

/** Proposals waiting for the member (staff: theirs; owners and managers: all), oldest first. */
export async function listPendingProposals(
  db: Database,
  actor: Actor,
  options: { clock?: Clock } = {},
): Promise<ActionProposal[]> {
  requirePermission(actor, 'business.read');
  const now = (options.clock ?? systemClock).now();
  // Expired ones (marked by the daily clean-up or on approval) are not offered.
  const rows = await withMember(db, actor.context, (tx) => listPendingProposalRows(tx, now, 200));
  return rows.map(toProposal);
}

/**
 * One proposal as stored (staff: theirs), so a card's Approve runs what was stored, never a
 * payload the caller sends. `ProposalNotFoundError` for one the member can't see.
 */
export async function getProposal(
  db: Database,
  actor: Actor,
  proposalId: ActionProposalId,
): Promise<ActionProposal> {
  requirePermission(actor, 'business.read');
  const id = ActionProposalIdSchema.parse(proposalId);
  const row = await withMember(db, actor.context, (tx) => findProposal(tx, id));
  if (row === undefined) throw new ProposalNotFoundError();
  return toProposal(row);
}

/** One AI action's receipt as stored (staff: those done for them). */
export async function getAction(
  db: Database,
  actor: Actor,
  executionId: ActionExecutionId,
): Promise<ActionExecution> {
  requirePermission(actor, 'business.read');
  const id = ActionExecutionIdSchema.parse(executionId);
  const row = await withMember(db, actor.context, (tx) => findExecution(tx, id));
  if (row === undefined) throw new ActionNotFoundError();
  return toExecution(row);
}

/**
 * What the tool call with this idempotency key came to, if it reached the trust layer: its
 * receipt, its proposal, or `null` (it never ran). Recovering an abandoned turn reads this
 * instead of calling the tool again, so nothing runs twice or late (ADR-0030).
 */
export async function findToolCallResult(
  db: Database,
  actor: Actor,
  idempotencyKey: string,
): Promise<
  | { kind: 'executed'; execution: ActionExecution }
  | { kind: 'proposed'; proposal: ActionProposal }
  | null
> {
  requirePermission(actor, 'business.read');
  return withMember(db, actor.context, async (tx) => {
    const execution = await findExecutionByKey(tx, idempotencyKey);
    if (execution !== undefined) return { kind: 'executed', execution: toExecution(execution) };
    const proposal = await findProposalByKey(tx, idempotencyKey);
    if (proposal !== undefined) return { kind: 'proposed', proposal: toProposal(proposal) };
    return null;
  });
}

/** The AI's recent actions with their receipts (staff: those done for them), newest first. */
export async function listRecentActions(
  db: Database,
  actor: Actor,
  options: { limit?: number } = {},
): Promise<ActionExecution[]> {
  requirePermission(actor, 'business.read');
  const rows = await withMember(db, actor.context, (tx) =>
    listExecutions(tx, { limit: options.limit ?? 50 }),
  );
  return rows.map(toExecution);
}

/**
 * Marks the transaction's tenant's proposals that expired at `now` as expired, with an audit
 * entry each (the daily clean-up). Returns how many.
 */
export async function expireProposals(tx: TenantTx, now: Date, limit: number): Promise<number> {
  const expired = await expirePendingProposals(tx, now, limit);
  for (const row of expired) {
    const action = AutonomyActionSchema.parse(row.action);
    await settleFeedItemsOf(tx, row.id, 'expired', now);
    await appendAuditEntry(tx, {
      actor: { kind: 'system' },
      change: {
        action: 'ai_proposal.decided',
        entity: { type: 'ai_action_proposal', id: row.id },
        before: { action, status: 'pending' },
        after: { action, status: 'expired' },
      },
    });
  }
  return expired.length;
}

// ---------------------------------------------------------------------------------------------

/** Ends a dry run: carries its preview out of the savepoint it rolls back. */
class DryRunDone extends Error {
  constructor(readonly preview: ActionPreview) {
    super('Dry run done');
    this.name = 'DryRunDone';
  }
}

/**
 * Runs the tool's preview in a savepoint that is always rolled back (playbook principle 6):
 * whatever the preview did to see the outcome, nothing of it stays in the transaction.
 */
async function dryRun(
  tx: TenantTx,
  ai: Actor,
  runner: ActionRunner,
  payload: TrustJson,
): Promise<ActionPreview> {
  try {
    await tx.transaction(async (savepoint) => {
      throw new DryRunDone(await runner.preview(savepoint, ai, payload));
    });
  } catch (error) {
    if (error instanceof DryRunDone) return error.preview;
    throw error;
  }
  // The savepoint above always ends by throwing.
  throw new Error('The dry run did not end');
}

/** The member themselves, as the person deciding (callers refuse an AI actor first). */
function memberOf(actor: Actor): Actor {
  return { context: actor.context, requestId: actor.requestId };
}

function permissionFor(action: AutonomyAction) {
  return AUTONOMY_ACTIONS[action].permission;
}

/** Every action the tool involves must be allowed on the record it changes. */
function checkRecordPermissions(
  member: Actor,
  runner: ActionRunner,
  recordOwner: UserId | null,
): void {
  for (const action of runner.actions) {
    requirePermission(member, permissionFor(action), { ownerUserId: recordOwner });
  }
}

/**
 * Who may approve, reject or undo: the member it was made for, or one whose role reaches every
 * record of this kind (owners and managers). Staff can't decide on a colleague's proposal.
 */
function checkDecider(
  member: Actor,
  action: AutonomyAction,
  ...madeFor: readonly (string | null)[]
): void {
  if (madeFor.includes(member.context.userId)) return;
  if (permissionScope(member.context.role, permissionFor(action)) === 'all') return;
  throw new ForbiddenError(permissionFor(action));
}

/**
 * The explanation's facts: what the domain checked in the preview, when it said, then what the
 * request brought (the facts recalled in the turn, S30), at most 20.
 */
function explanationFacts(
  preview: ActionExplanation['facts'] | undefined,
  requested: ActionExplanation['facts'],
): ActionExplanation['facts'] {
  if (preview === undefined) return requested;
  return [...preview, ...requested].slice(0, 20);
}

function checkRunner(runner: ActionRunner, proposal: AiActionProposalRow): void {
  if (runner.tool !== proposal.tool || runner.actions[0] !== proposal.action) {
    throw new Error(`Runner ${runner.tool} cannot run a ${proposal.tool} proposal`);
  }
}

function proposalOwner(proposal: AiActionProposalRow): UserId | null {
  return userIdOrNull(proposal.recordOwnerUserId);
}

function userIdOrNull(value: string | null): UserId | null {
  return value === null ? null : UserIdSchema.parse(value);
}

function settled(status: string): Exclude<ProposalStatus, 'pending'> {
  return ProposalStatusSchema.exclude(['pending']).parse(status);
}

async function storeProposal(
  tx: TenantTx,
  member: Actor,
  runner: ActionRunner,
  input: {
    idempotencyKey: string;
    payload: TrustJson;
    preview: ActionPreview;
    explanation: ActionExplanation;
    now: Date;
    requestedBy?: string | null;
    /**
     * Who the audit names for the new proposal: by default the AI for the member; the system for
     * a pass of the business, the member themselves for their own edit (S36).
     */
    auditActor?: AuditActor;
  },
): Promise<AiActionProposalRow> {
  const startsAt = input.preview.appointmentStartsAt?.getTime() ?? Infinity;
  const expiresAt = new Date(Math.min(input.now.getTime() + PROPOSAL_TTL_MS, startsAt));
  // An appointment that already started can't be proposed for: nothing could approve it.
  if (expiresAt.getTime() <= input.now.getTime()) throw new ActionTooLateError();
  const requestedBy =
    input.requestedBy === undefined ? member.context.userId : userIdOrNull(input.requestedBy);
  // At most one pending proposal per target: a newer one replaces it. Two requests racing for
  // the same target meet at the unique index; the loser replaces the winner's proposal.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const pending = await lockPendingProposalFor(tx, input.preview.targetKey);
    if (pending !== undefined) await decide(tx, member, pending, 'superseded', input.now);
    const row = await insertProposal(tx, {
      action: runner.actions[0],
      tool: runner.tool,
      toolVersion: runner.version,
      targetKey: input.preview.targetKey,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      preview: input.preview.preview,
      fingerprint: input.preview.fingerprint,
      explanation: input.explanation,
      requestedBy,
      recordOwner: input.preview.recordOwner,
      expiresAt,
      // On the service's clock, like `expiresAt`, so the two can never disagree.
      createdAt: input.now,
    });
    if (row === undefined) {
      // The same key was stored meanwhile (a concurrent retry): that one is the answer.
      const same = await findProposalByKey(tx, input.idempotencyKey);
      if (same !== undefined) return same;
      continue;
    }
    if (pending !== undefined) await repointFeedItems(tx, pending.id, row.id);
    await appendAuditEntry(tx, {
      actor: input.auditActor ?? auditActorOf({ ...member, via: 'ai' }),
      change: {
        action: 'ai_proposal.created',
        entity: { type: 'ai_action_proposal', id: row.id },
        before: null,
        after: {
          action: runner.actions[0],
          status: 'pending',
          expiresAt: UtcDateTimeSchema.parse(expiresAt.toISOString()),
        },
      },
      requestId: member.requestId,
    });
    return row;
  }
  throw new Error('Could not store the proposal: its target kept changing');
}

/** What a decided proposal makes of the feed item waiting on it (S36). */
const FEED_OUTCOME: Partial<
  Record<Exclude<ProposalStatus, 'pending'>, 'done' | 'dismissed' | 'expired'>
> = { approved: 'done', rejected: 'dismissed', expired: 'expired' };

async function decide(
  tx: TenantTx,
  member: Actor,
  proposal: AiActionProposalRow,
  status: Exclude<ProposalStatus, 'pending'>,
  now: Date,
): Promise<AiActionProposalRow> {
  const by = status === 'expired' || status === 'superseded' ? null : member.context.userId;
  const decided = await decideProposal(tx, ActionProposalIdSchema.parse(proposal.id), {
    status,
    by,
    at: now,
  });
  // Callers hold the row lock on a pending proposal.
  if (decided === undefined) throw new ProposalNotPendingError(settled(proposal.status));
  const action = AutonomyActionSchema.parse(proposal.action);
  // A feed item waiting on it (S36) closes with it; a superseded one's item follows its
  // replacement (the callers repoint it) or, refused, expires.
  const itemOutcome = FEED_OUTCOME[status];
  if (itemOutcome !== undefined) await settleFeedItemsOf(tx, proposal.id, itemOutcome, now);
  await appendAuditEntry(tx, {
    actor: by === null ? { kind: 'system' } : auditActorOf(member),
    change: {
      action: 'ai_proposal.decided',
      entity: { type: 'ai_action_proposal', id: proposal.id },
      before: { action, status: 'pending' },
      after: { action, status },
    },
    requestId: member.requestId,
  });
  return decided;
}

async function runAndRecord(
  tx: TenantTx,
  ai: Actor,
  runner: ActionRunner,
  input: {
    proposalId: ActionProposalId | null;
    /** Whose request it answers (a lead may approve a staff member's proposal). */
    requestedBy: UserId | null;
    outcome: AutonomyDecision['outcome'];
    idempotencyKey: string;
    payload: TrustJson;
    explanation: ActionExplanation;
    recordOwner: UserId | null;
    now: Date;
  },
): Promise<AiActionExecutionRow> {
  const action = runner.actions[0];
  const effect = await runner.execute(tx, ai, input.payload);
  await checkQueuedMessages(tx, action, effect.outboxMessageIds, input.now);
  const until = undoUntil(action, input.now, {
    hasInverse: effect.inverse !== null,
    appointmentStartsAt: effect.appointmentStartsAt,
  });
  const row = await insertExecution(tx, {
    proposalId: input.proposalId,
    action,
    tool: runner.tool,
    outcome: input.outcome,
    idempotencyKey: input.idempotencyKey,
    entity: effect.entity,
    before: effect.before,
    after: effect.after,
    undo: effect.inverse === null || until === null ? null : { inverse: effect.inverse, until },
    explanation: input.explanation,
    outboxMessageIds: effect.outboxMessageIds,
    onBehalfOf: ai.context.userId,
    requestedBy: input.requestedBy,
    recordOwner: input.recordOwner,
    summary: effect.summary ?? null,
  });
  // The key was checked at the start of this transaction and the proposal is locked; a
  // concurrent retry with the same key meets the unique constraint and rolls back instead.
  if (row === undefined) throw new ConcurrentActionError();
  await appendAuditEntry(tx, {
    actor: auditActorOf(ai),
    change: {
      action: 'ai_action.executed',
      entity: { type: 'ai_action_execution', id: row.id },
      before: null,
      after: executionValues(row),
    },
    requestId: ai.requestId,
  });
  return row;
}

/**
 * The messages a tool says it queued must be this business's, just queued, and (for a message
 * action) held for the "undo send" grace: otherwise Undo could not take them back. A tool that
 * breaks this is a bug, so the whole action is refused.
 */
async function checkQueuedMessages(
  tx: TenantTx,
  action: AutonomyAction,
  ids: readonly OutboxMessageId[],
  now: Date,
): Promise<void> {
  const graceEnds = now.getTime() + AI_EMAIL_GRACE_SECONDS * 1000;
  for (const id of ids) {
    const message = await findOutboxMessage(tx, OutboxMessageIdSchema.parse(id));
    if (message?.status !== 'pending') {
      throw new Error(`${action}: linked outbox message ${id} is not a pending message here`);
    }
    if (
      AUTONOMY_ACTIONS[action].undo.kind === 'until_sent' &&
      message.availableAt.getTime() < graceEnds
    ) {
      throw new Error(`${action}: AI messages must wait ${String(AI_EMAIL_GRACE_SECONDS)} s`);
    }
  }
}

function executionValues(row: AiActionExecutionRow) {
  return {
    action: AutonomyActionSchema.parse(row.action),
    outcome: AutonomyOutcomeSchema.parse(row.outcome),
    status: ExecutionStatusSchema.parse(row.status),
    proposalId: row.proposalId === null ? null : ActionProposalIdSchema.parse(row.proposalId),
    undoUntil: row.undoUntil === null ? null : UtcDateTimeSchema.parse(row.undoUntil.toISOString()),
  };
}

/** Stored JSON, as the contracts type it (it was validated on the way in). */
function toJson(value: unknown): TrustJson {
  return value as TrustJson;
}

function iso(value: Date | null) {
  return value === null ? null : value.toISOString();
}

export function toProposal(row: AiActionProposalRow): ActionProposal {
  return ActionProposalSchema.parse({
    id: row.id,
    action: row.action,
    tool: row.tool,
    toolVersion: row.toolVersion,
    targetKey: row.targetKey,
    status: row.status,
    payload: row.payload,
    preview: row.preview,
    fingerprint: row.fingerprint,
    explanation: row.explanation,
    requestedByUserId: row.requestedByUserId,
    recordOwnerUserId: row.recordOwnerUserId,
    decidedByUserId: row.decidedByUserId,
    decidedAt: iso(row.decidedAt),
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  });
}

export function toExecution(row: AiActionExecutionRow): ActionExecution {
  return ActionExecutionSchema.parse({
    id: row.id,
    proposalId: row.proposalId,
    action: row.action,
    tool: row.tool,
    outcome: row.outcome,
    status: row.status,
    entity: { type: row.entityType, id: row.entityId },
    before: row.before,
    after: row.after,
    explanation: row.explanation,
    outboxMessageIds: row.outboxMessageIds,
    onBehalfOfUserId: row.onBehalfOfUserId,
    requestedByUserId: row.requestedByUserId,
    recordOwnerUserId: row.recordOwnerUserId,
    summary: row.summary,
    undoUntil: iso(row.undoUntil),
    undoneByUserId: row.undoneByUserId,
    undoneAt: iso(row.undoneAt),
    undoReason: row.undoReason,
    createdAt: row.createdAt.toISOString(),
  });
}
