import {
  ActionExecutionIdSchema,
  ActionExplanationSchema,
  ActionIdempotencyKeySchema,
  ActionProposalIdSchema,
  ActionTargetKeySchema,
  AutonomyActionSchema,
  AutonomyOutcomeSchema,
  AutonomySettingsSchema,
  ProposalStatusSchema,
  StateFingerprintSchema,
  TrustCodeSchema,
  TrustJsonSchema,
  UndoReasonSchema,
  type ActionExecutionId,
  type ActionExplanation,
  type ActionProposalId,
  type AutonomyAction,
  type AutonomyOutcome,
  type AutonomySettings,
  type OutboxMessageId,
  type ProposalStatus,
  type TrustJson,
  type UndoReason,
  type UserId,
} from '@pepper/contracts';
import { and, asc, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  aiActionExecutions,
  aiActionProposals,
  autonomySettings,
  type AiActionExecutionRow,
  type AiActionProposalRow,
  type AutonomySettingsRow,
} from '../schema.js';
import type { TenantTx } from '../tenant.js';

// The trust layer's records (ADR-0028), for the transaction's tenant. Run inside `withMember`
// for a member's request: the `member_scope` policies limit staff to their own proposals and
// executions, and keep them from changing the autonomy settings. What is stored is validated
// here against the contracts (ids-only JSON), and the database checks it again.

const Id = z.uuid();
const LimitSchema = z.number().int().min(1).max(500);

/** The business's own autonomy choices, or `undefined`: all defaults. */
export async function findAutonomySettings(
  tx: TenantTx,
  options: { lock?: boolean } = {},
): Promise<AutonomySettingsRow | undefined> {
  const query = tx.select().from(autonomySettings);
  const [row] = await (options.lock === true ? query.for('update') : query);
  return row;
}

/** Writes the business's autonomy choices (one row per business). */
export async function saveAutonomySettings(
  tx: TenantTx,
  input: { askFirst: boolean; levels: AutonomySettings; updatedBy: UserId },
): Promise<AutonomySettingsRow> {
  const values = {
    askFirst: z.boolean().parse(input.askFirst),
    levels: AutonomySettingsSchema.parse(input.levels),
    updatedByUserId: Id.parse(input.updatedBy),
  };
  const [row] = await tx
    .insert(autonomySettings)
    .values(values)
    .onConflictDoUpdate({ target: autonomySettings.tenantId, set: values })
    .returning();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- an upsert of one row returns one row
  return row!;
}

export interface NewProposal {
  action: AutonomyAction;
  tool: string;
  targetKey: string;
  idempotencyKey: string;
  payload: TrustJson;
  preview: TrustJson;
  fingerprint: string;
  explanation: ActionExplanation;
  /** `null` only for a refreshed proposal whose member's account was deleted meanwhile. */
  requestedBy: UserId | null;
  recordOwner: UserId | null;
  expiresAt: Date;
  /**
   * When it was proposed, on the same clock as `expiresAt` (S27: the database's own clock could
   * disagree with the service's and break "expires after created"). Default: the database's.
   */
  createdAt?: Date;
  /** The tool's version (S26: a proposal from an older version expires). Default 1. */
  toolVersion?: number;
}

/**
 * Stores a pending proposal. Returns `undefined` when the business already has one with this
 * idempotency key (a retried tool call), or a pending one for the same target: the caller looks
 * those up instead.
 */
export async function insertProposal(
  tx: TenantTx,
  input: NewProposal,
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .insert(aiActionProposals)
    .values({
      action: AutonomyActionSchema.parse(input.action),
      tool: TrustCodeSchema.parse(input.tool),
      toolVersion: z
        .int()
        .min(1)
        .parse(input.toolVersion ?? 1),
      targetKey: ActionTargetKeySchema.parse(input.targetKey),
      idempotencyKey: ActionIdempotencyKeySchema.parse(input.idempotencyKey),
      payload: TrustJsonSchema.parse(input.payload),
      preview: TrustJsonSchema.parse(input.preview),
      fingerprint: StateFingerprintSchema.parse(input.fingerprint),
      explanation: ActionExplanationSchema.parse(input.explanation),
      requestedByUserId: input.requestedBy === null ? null : Id.parse(input.requestedBy),
      recordOwnerUserId: input.recordOwner === null ? null : Id.parse(input.recordOwner),
      expiresAt: input.expiresAt,
      ...(input.createdAt !== undefined && {
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      }),
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** The proposal with this id, if the transaction may see it. */
export async function findProposal(
  tx: TenantTx,
  id: ActionProposalId,
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionProposals)
    .where(eq(aiActionProposals.id, ActionProposalIdSchema.parse(id)));
  return row;
}

/** The proposal with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockProposal(
  tx: TenantTx,
  id: ActionProposalId,
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionProposals)
    .where(eq(aiActionProposals.id, ActionProposalIdSchema.parse(id)))
    .for('update');
  return row;
}

/** The proposal a tool call with this idempotency key made, if any. */
export async function findProposalByKey(
  tx: TenantTx,
  idempotencyKey: string,
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionProposals)
    .where(eq(aiActionProposals.idempotencyKey, ActionIdempotencyKeySchema.parse(idempotencyKey)));
  return row;
}

/** The pending proposal for `targetKey`, if any (not locked; S78.2's release card check). */
export async function findPendingProposalFor(
  tx: TenantTx,
  targetKey: string,
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionProposals)
    .where(
      and(
        eq(aiActionProposals.targetKey, ActionTargetKeySchema.parse(targetKey)),
        eq(aiActionProposals.status, 'pending'),
      ),
    )
    .limit(1);
  return row;
}

/**
 * The pending proposal for `targetKey`, locked, if any. With `skipLocked` (S78.2) one another
 * transaction holds (being approved this moment) reads as none instead of waiting for it.
 */
export async function lockPendingProposalFor(
  tx: TenantTx,
  targetKey: string,
  options: { skipLocked?: boolean } = {},
): Promise<AiActionProposalRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionProposals)
    .where(
      and(
        eq(aiActionProposals.targetKey, ActionTargetKeySchema.parse(targetKey)),
        eq(aiActionProposals.status, 'pending'),
      ),
    )
    .for('update', options.skipLocked === true ? { skipLocked: true } : {});
  return row;
}

/**
 * Decides a pending proposal: approved, rejected, expired or superseded, by a member or (for
 * expiry) nobody. Returns `undefined` if it was no longer pending.
 */
export async function decideProposal(
  tx: TenantTx,
  id: ActionProposalId,
  decision: { status: Exclude<ProposalStatus, 'pending'>; by: UserId | null; at: Date },
): Promise<AiActionProposalRow | undefined> {
  const status = ProposalStatusSchema.exclude(['pending']).parse(decision.status);
  const [row] = await tx
    .update(aiActionProposals)
    .set({
      status,
      decidedByUserId: decision.by === null ? null : Id.parse(decision.by),
      decidedAt: decision.at,
    })
    .where(
      and(
        eq(aiActionProposals.id, ActionProposalIdSchema.parse(id)),
        eq(aiActionProposals.status, 'pending'),
      ),
    )
    .returning();
  return row;
}

/** Up to `limit` pending proposals not yet expired at `now`, oldest first. */
export async function listPendingProposals(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<AiActionProposalRow[]> {
  return tx
    .select()
    .from(aiActionProposals)
    .where(and(eq(aiActionProposals.status, 'pending'), gt(aiActionProposals.expiresAt, now)))
    .orderBy(asc(aiActionProposals.createdAt), asc(aiActionProposals.id))
    .limit(LimitSchema.parse(limit));
}

/**
 * Marks up to `limit` of the transaction's tenant's pending proposals that expired at `now`
 * as expired. Returns them (the caller audits each).
 */
export async function expirePendingProposals(
  tx: TenantTx,
  now: Date,
  limit: number,
): Promise<AiActionProposalRow[]> {
  const due = tx
    .select({ id: aiActionProposals.id })
    .from(aiActionProposals)
    .where(and(eq(aiActionProposals.status, 'pending'), lte(aiActionProposals.expiresAt, now)))
    .orderBy(asc(aiActionProposals.expiresAt))
    .limit(LimitSchema.parse(limit))
    .for('update', { skipLocked: true });
  const ids = (await due).map((row) => row.id);
  if (ids.length === 0) return [];
  const rows: AiActionProposalRow[] = [];
  for (const id of ids) {
    const row = await decideProposal(tx, ActionProposalIdSchema.parse(id), {
      status: 'expired',
      by: null,
      at: now,
    });
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/** A receipt's summary: one sentence of the tool's own words, never a contact (TrustJson). */
const ExecutionSummarySchema = z
  .string()
  .max(600)
  .refine(
    (text) => TrustJsonSchema.safeParse(text).success,
    'Holds an email address or phone number',
  );

export interface NewExecution {
  proposalId: ActionProposalId | null;
  action: AutonomyAction;
  tool: string;
  outcome: AutonomyOutcome;
  idempotencyKey: string;
  entity: { type: string; id: string };
  before: TrustJson;
  after: TrustJson;
  /** What the tool's inverse needs, and until when; `null`: it cannot be undone. */
  undo: { inverse: TrustJson; until: Date } | null;
  explanation: ActionExplanation;
  outboxMessageIds: readonly OutboxMessageId[];
  onBehalfOf: UserId;
  /** The member whose request it answered (S26); defaults to `onBehalfOf`. */
  requestedBy?: UserId | null;
  recordOwner: UserId | null;
  /** The tool's one-sentence summary, at most 600 characters and never a contact (S26). */
  summary?: string | null;
}

/**
 * Records an executed action. Returns `undefined` when the business already has an execution
 * with this idempotency key or for this proposal (a retry): the caller looks it up instead.
 */
export async function insertExecution(
  tx: TenantTx,
  input: NewExecution,
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .insert(aiActionExecutions)
    .values({
      proposalId: input.proposalId === null ? null : ActionProposalIdSchema.parse(input.proposalId),
      action: AutonomyActionSchema.parse(input.action),
      tool: TrustCodeSchema.parse(input.tool),
      outcome: AutonomyOutcomeSchema.parse(input.outcome),
      idempotencyKey: ActionIdempotencyKeySchema.parse(input.idempotencyKey),
      entityType: TrustCodeSchema.parse(input.entity.type),
      entityId: Id.parse(input.entity.id),
      before: TrustJsonSchema.parse(input.before),
      after: TrustJsonSchema.parse(input.after),
      inverse: input.undo === null ? null : TrustJsonSchema.parse(input.undo.inverse),
      undoUntil: input.undo === null ? null : input.undo.until,
      explanation: ActionExplanationSchema.parse(input.explanation),
      outboxMessageIds: z.array(Id).max(100).parse(input.outboxMessageIds),
      onBehalfOfUserId: Id.parse(input.onBehalfOf),
      requestedByUserId:
        input.requestedBy === undefined
          ? Id.parse(input.onBehalfOf)
          : input.requestedBy === null
            ? null
            : Id.parse(input.requestedBy),
      recordOwnerUserId: input.recordOwner === null ? null : Id.parse(input.recordOwner),
      summary: ExecutionSummarySchema.nullable().parse(input.summary ?? null),
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

/** The execution a tool call with this idempotency key made, if any. */
export async function findExecutionByKey(
  tx: TenantTx,
  idempotencyKey: string,
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionExecutions)
    .where(eq(aiActionExecutions.idempotencyKey, ActionIdempotencyKeySchema.parse(idempotencyKey)));
  return row;
}

/** The execution of an approved proposal, if any. */
export async function findExecutionOfProposal(
  tx: TenantTx,
  proposalId: ActionProposalId,
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionExecutions)
    .where(eq(aiActionExecutions.proposalId, ActionProposalIdSchema.parse(proposalId)));
  return row;
}

/** The execution with this id, if the transaction may see it. */
export async function findExecution(
  tx: TenantTx,
  id: ActionExecutionId,
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionExecutions)
    .where(eq(aiActionExecutions.id, ActionExecutionIdSchema.parse(id)));
  return row;
}

/** The execution with this id, locked until the transaction ends (`FOR UPDATE`). */
export async function lockExecution(
  tx: TenantTx,
  id: ActionExecutionId,
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .select()
    .from(aiActionExecutions)
    .where(eq(aiActionExecutions.id, ActionExecutionIdSchema.parse(id)))
    .for('update');
  return row;
}

/** Marks a done execution undone. Returns `undefined` if it was not done any more. */
export async function markExecutionUndone(
  tx: TenantTx,
  id: ActionExecutionId,
  undo: { by: UserId; at: Date; reason: UndoReason | null },
): Promise<AiActionExecutionRow | undefined> {
  const [row] = await tx
    .update(aiActionExecutions)
    .set({
      status: 'undone',
      undoneByUserId: Id.parse(undo.by),
      undoneAt: undo.at,
      undoReason: undo.reason === null ? null : UndoReasonSchema.parse(undo.reason),
    })
    .where(
      and(
        eq(aiActionExecutions.id, ActionExecutionIdSchema.parse(id)),
        eq(aiActionExecutions.status, 'done'),
      ),
    )
    .returning();
  return row;
}

/**
 * Up to `limit` executions, newest first: created before `before` if given, or after the
 * execution `after` in that order (the Activity log's pages, S52). The cursor is compared in
 * the database, row against row: executions made in one transaction share a time, and a
 * JavaScript date would lose the microseconds, so a page could skip one.
 */
export async function listExecutions(
  tx: TenantTx,
  options: { limit: number; before?: Date; after?: ActionExecutionId },
): Promise<AiActionExecutionRow[]> {
  const after =
    options.after === undefined ? undefined : ActionExecutionIdSchema.parse(options.after);
  return tx
    .select()
    .from(aiActionExecutions)
    .where(
      and(
        options.before === undefined ? undefined : lt(aiActionExecutions.createdAt, options.before),
        after === undefined
          ? undefined
          : sql`(${aiActionExecutions.createdAt}, ${aiActionExecutions.id}) < (SELECT e.created_at, e.id FROM ai_action_executions e WHERE e.id = ${after})`,
      ),
    )
    .orderBy(desc(aiActionExecutions.createdAt), desc(aiActionExecutions.id))
    .limit(LimitSchema.parse(options.limit));
}

/** One action's counts for its track record (S53, ADR-0055). */
export interface ActionTrackRow {
  action: AutonomyAction;
  /** Executions created at or after `since30`. */
  doneSince30: number;
  /** Executions created at or after `since90` and after the action's last mistake. */
  correctInARow: number;
}

const TrackRowSchema = z.object({
  action: AutonomyActionSchema,
  done_30: z.coerce.number().int().min(0),
  correct: z.coerce.number().int().min(0),
});

/**
 * Per action, how many times the AI did it since `since30`, and how many it did since `since90`
 * after its last mistake: an execution later undone as "wrong", or a proposal a member turned
 * down (S53's earned trust). Every time compared is one the database stamped (`created_at`), so
 * the run is never skewed by the domain clock: it restarts after the action that was wrong, or
 * the request that was turned down. Under `withMember`, staff count only their own records.
 * Actions with no executions since `since90` have no row.
 */
export async function actionTrackRecord(
  tx: TenantTx,
  options: { since30: Date; since90: Date },
): Promise<ActionTrackRow[]> {
  const since30 = z.date().parse(options.since30);
  const since90 = z.date().parse(options.since90);
  const { rows } = await tx.execute(sql`
    WITH mistakes AS (
      SELECT m.action, max(m.at) AS at FROM (
        SELECT action, created_at AS at FROM ai_action_executions
          WHERE undo_reason = 'wrong' AND created_at >= ${since90.toISOString()}::timestamptz
        UNION ALL
        SELECT action, created_at AS at FROM ai_action_proposals
          WHERE status = 'rejected' AND created_at >= ${since90.toISOString()}::timestamptz
      ) m
      GROUP BY m.action
    )
    SELECT e.action,
      count(*) FILTER (WHERE e.created_at >= ${since30.toISOString()}::timestamptz) AS done_30,
      count(*) FILTER (
        WHERE (mistakes.at IS NULL OR e.created_at > mistakes.at)
          AND e.undo_reason IS DISTINCT FROM 'wrong'
      ) AS correct
    FROM ai_action_executions e
    LEFT JOIN mistakes ON mistakes.action = e.action
    WHERE e.created_at >= ${since90.toISOString()}::timestamptz
    GROUP BY e.action
  `);
  return rows.map((raw) => {
    const row = TrackRowSchema.parse(raw);
    return { action: row.action, doneSince30: row.done_30, correctInARow: row.correct };
  });
}
