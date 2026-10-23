import { createHash } from 'node:crypto';
import {
  ActionIdempotencyKeySchema,
  ServiceIdSchema,
  TrustJsonSchema,
  type ActionExecution,
  type ActionExecutionId,
  type ActionProposal,
  type ActionProposalId,
  type AutonomyAction,
  type AvailableSlot,
  type ChangeSide,
  type LlmToolCall,
  type LlmToolDefinition,
  type LocalSlot,
  type ServiceId,
  type ToolCard,
  type ToolErrorCode,
  type TrustJson,
  type UndoReason,
  type WouldBeEmail,
} from '@pepper/contracts';
import {
  approveProposal,
  ConcurrentActionError,
  getAction,
  getProposal,
  requestAction,
  undoAction,
  type ActionRunner,
  type Actor,
  type ApprovalResult,
  type UndoResult,
} from '@pepper/core';
import { withMember } from '@pepper/db';
import { z } from 'zod';
import { strictToolParameters } from '../strict-schema.js';
import {
  findAvailability,
  findClientBookings,
  findClients,
  getBooking,
  getDay,
  listServicesAndStaff,
} from './catalog/reads.js';
import { cancelBooking, createBooking, moveBooking } from './catalog/bookings.js';
import { addVisitNote, forgetFact, rememberFact } from './catalog/memory.js';
import { directoryOf, localSlot } from './catalog/shared.js';
import {
  addTodo,
  blockTime,
  completeTodo,
  listTodos,
  unblockTime,
} from './catalog/time-and-todos.js';
import {
  InvalidToolArgumentsError,
  toolRefusalOf,
  UnknownToolError,
  type ToolRefusal,
} from './errors.js';
import { describeTool } from './guide.js';
import { scopeOf, storedSchema, undoWith, writeRunner } from './runner.js';
import type { AnyTool, ToolDeps, WriteTool } from './tool.js';

// The tool registry (ADR-0029, playbook S24; S26b's four, ADR-0032; S30's three memory tools,
// ADR-0035): the seventeen tools,
// their definitions for the provider, and `dispatchToolCall`, the one way a model's tool call
// reaches the business. It parses the arguments twice (the provider's strict schema, then Zod),
// takes the business and the member from the session only, sends writes through the trust layer
// (`requestAction`: the dial, proposals, receipts, undo) and turns every refusal into a stable
// code the model can act on. Nothing here chains writes: one call is one action.

/** Every tool, reads first. */
export const TOOLS: readonly AnyTool[] = [
  findAvailability,
  findClients,
  findClientBookings,
  getDay,
  getBooking,
  listServicesAndStaff,
  listTodos,
  createBooking,
  moveBooking,
  cancelBooking,
  blockTime,
  unblockTime,
  addTodo,
  completeTodo,
  rememberFact,
  addVisitNote,
  forgetFact,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function findTool(name: string): AnyTool | undefined {
  return BY_NAME.get(name);
}

/** The definitions the provider gets (static: the prompt cache's prefix, playbook §3.12). */
export function toolDefinitions(): LlmToolDefinition[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: describeTool(tool.guide, { localTimes: tool.localTimes }),
    parameters: strictToolParameters(tool.args),
  }));
}

/** What the agent loop knows about the turn (S25); none of it comes from the model. */
export interface ToolTurn {
  /** `(conversation, turn)`: each call's idempotency key adds the step and the call. */
  turnKey: string;
  /**
   * The loop's step in the turn (1 for the first model answer). Part of the key, so a model
   * that reuses a call id in a later step (`call_1` again) is a new call, not the old one's
   * retry.
   */
  step: number;
  /** The member's message this turn answers (the *Why?* trace refers to it by id). */
  requestMessageId: string | null;
  /** The turn's context held untrusted text (tracked by the loop, never by the model). */
  untrustedContext: boolean;
  /**
   * Some of it came from outside the team (a client's words), not only from memory (S30).
   * Not given: all untrusted text counts as such.
   */
  outsideText?: boolean;
  /** The conversation turn (where a remembered fact came from, S30); `null` outside a chat. */
  turnId?: string | null;
  /** The remembered facts the turn's tool answers brought (*Why?* names them by id, S30). */
  recalled?: readonly string[];
}

/** What one tool call came to: for the member (card) and the model (`toolMessageContent`). */
export type ToolOutcome =
  | {
      status: 'answered';
      tool: string;
      summary: string;
      data: TrustJson;
      card: ToolCard | null;
      /** The answer holds text a client typed: the loop marks the turn untrusted. */
      untrustedText: boolean;
    }
  | {
      status: 'done';
      tool: string;
      summary: string;
      card: ToolCard;
      execution: ActionExecution;
      /** The summary echoes untrusted stored text (S27): the loop labels it as data. */
      untrustedText: boolean;
      /** Remembered facts for the model, by reference (S30): warnings, the last visit. */
      memory?: TrustJson;
    }
  | {
      status: 'awaiting_approval';
      tool: string;
      summary: string;
      card: ToolCard;
      proposal: ActionProposal;
      untrustedText: boolean;
      memory?: TrustJson;
    }
  | {
      status: 'refused';
      tool: string;
      code: ToolErrorCode;
      message: string;
      alternatives: LocalSlot[];
      card: ToolCard | null;
      /** The original error for the server's own log (never sent to the model). */
      error: unknown;
    };

const TurnKeySchema = z.string().regex(/^[A-Za-z0-9.:_-]{1,150}$/);
const StepSchema = z.int().min(1).max(99);

/**
 * Runs one tool call for the member in `deps`. Never throws for anything the model did: an
 * unknown tool, bad arguments or a refusal by the domain come back as `refused` with a code.
 */
export async function dispatchToolCall(
  deps: ToolDeps,
  turn: ToolTurn,
  call: LlmToolCall,
): Promise<ToolOutcome> {
  const tool = findTool(call.name);
  let args: unknown;
  try {
    if (tool === undefined) throw new UnknownToolError();
    args = parseArguments(tool, call.arguments);
    const member = memberOf(deps.actor);
    if (tool.kind === 'read') {
      const ai: Actor = { ...member, via: 'ai' };
      const { untrustedText, ...answer } = await withMember(deps.db, member.context, async (tx) =>
        tool.run(await scopeOf(tx, ai, deps), args),
      );
      return {
        status: 'answered',
        tool: tool.name,
        ...answer,
        untrustedText: untrustedText ?? false,
      };
    }
    return await requestWrite(deps, turn, tool, args, call.id);
  } catch (error) {
    return refused(deps, tool?.name ?? 'unknown', toolRefusalOf(error), error, serviceIdIn(args));
  }
}

/** The tool message the model gets back: the outcome as compact JSON, ids and local times. */
export function toolMessageContent(outcome: ToolOutcome): string {
  switch (outcome.status) {
    case 'answered':
      return JSON.stringify({ status: 'answered', summary: outcome.summary, data: outcome.data });
    case 'done':
      return JSON.stringify({
        status: 'done',
        summary: outcome.summary,
        note: 'Done; the member sees it with Undo.',
        ...(outcome.memory !== undefined && { memory: outcome.memory }),
      });
    case 'awaiting_approval':
      return JSON.stringify({
        status: 'awaiting_approval',
        summary: outcome.summary,
        note: 'Nothing has changed yet: the member approves or rejects it on the card. Say so; never claim it is done.',
        ...(outcome.memory !== undefined && { memory: outcome.memory }),
      });
    case 'refused':
      return JSON.stringify({
        status: 'refused',
        code: outcome.code,
        message: outcome.message,
        ...(outcome.alternatives.length > 0 && { alternatives: outcome.alternatives }),
      });
  }
}

/**
 * A member approves a proposal they were shown (S26), by its id and the fingerprint the card
 * showed: the stored proposal is loaded here (never a payload the caller sends), and the trust
 * layer re-runs the tool's dry run on it and acts only if the fingerprint still matches.
 * People only.
 */
export async function approveToolProposal(
  deps: ToolDeps,
  proposalId: ActionProposalId,
  shownFingerprint: string,
): Promise<ApprovalResult> {
  const proposal = await getProposal(deps.db, deps.actor, proposalId);
  const tool = writeToolNamed(proposal.tool);
  // "Me" in the request is the member who asked, not the approver (S26: a lead approving a
  // staff member's "remind me" made the to-do the lead's).
  const forRequester: ToolDeps =
    proposal.requestedByUserId === null ? deps : { ...deps, requester: proposal.requestedByUserId };
  // A proposal from another version of the tool expires (ADR-0031): its payload may not even
  // parse with today's schema, so it is never re-run.
  const runner =
    proposal.toolVersion === tool.version
      ? writeRunner(tool, forRequester, proposal.payload).runner
      : expiringRunner(tool, proposal.action);
  return approveProposal(
    deps.db,
    deps.actor,
    proposal.id,
    { shownFingerprint, runner },
    { clock: deps.clock },
  );
}

/**
 * What a refused approval tells the member (S26): the tool's stable code and plain message,
 * and for a time taken meanwhile, a SlotPicker with the nearest free times. Never the error's
 * own text.
 */
export async function approvalRefusal(
  deps: ToolDeps,
  proposal: Pick<ActionProposal, 'tool' | 'payload'>,
  error: unknown,
): Promise<{ code: ToolErrorCode; message: string; card: ToolCard | null }> {
  const outcome = await refused(
    deps,
    proposal.tool,
    toolRefusalOf(error),
    error,
    serviceIdIn(proposal.payload),
  );
  if (outcome.status !== 'refused') throw new Error('A refusal is always refused');
  return { code: outcome.code, message: outcome.message, card: outcome.card };
}

/**
 * A stored preview as the cards show it: the tool's summary, the change and the would-be
 * emails (`null` for a preview that doesn't have that shape).
 */
export function shownPreview(preview: unknown): {
  summary: string;
  before: ChangeSide | null;
  after: ChangeSide | null;
  emails: WouldBeEmail[];
} | null {
  const shown = PreviewSchema.safeParse(preview);
  if (!shown.success) return null;
  return {
    summary: shown.data.summary,
    before: shown.data.before as ChangeSide | null,
    after: shown.data.after as ChangeSide | null,
    emails: shown.data.emails as WouldBeEmail[],
  };
}

/** A member undoes an AI action within its window (S26), by its id. People only. */
export async function undoToolAction(
  deps: ToolDeps,
  executionId: ActionExecutionId,
  reason: UndoReason | null,
): Promise<UndoResult> {
  const execution = await getAction(deps.db, deps.actor, executionId);
  const tool = writeToolNamed(execution.tool);
  return undoAction(
    deps.db,
    deps.actor,
    execution.id,
    { runner: undoRunner(tool, deps, execution.action), reason },
    { clock: deps.clock },
  );
}

// ---------------------------------------------------------------------------------------------

function parseArguments(tool: AnyTool, text: string): unknown {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InvalidToolArgumentsError('The arguments are not valid JSON.');
  }
  return tool.args.parse(json);
}

/** The member themselves: the session's identity, whatever `via` the caller set. */
function memberOf(actor: Actor): Actor {
  return {
    context: actor.context,
    ...(actor.requestId !== undefined && { requestId: actor.requestId }),
  };
}

async function requestWrite(
  deps: ToolDeps,
  turn: ToolTurn,
  tool: WriteTool,
  args: unknown,
  callId: string,
): Promise<ToolOutcome> {
  // Stored with the proposal or receipt: ids, local times, the member's short texts, never a
  // contact (ADR-0028). The tool's schema refuses those already; this is the second check.
  const checked = TrustJsonSchema.safeParse(args);
  if (!checked.success) {
    throw new InvalidToolArgumentsError(
      'Leave email addresses and phone numbers out; refer to the client by their id.',
    );
  }
  // A remembered value is stored where it belongs first; the action keeps only its id (S30).
  const payload = tool.stash === undefined ? checked.data : await stashed(deps, tool, args, turn);
  const { runner, lastPreview, lastUntrusted, lastMemory } = writeRunner(tool, deps, payload);
  const ask = () =>
    requestAction(
      deps.db,
      deps.actor,
      runner,
      {
        payload,
        idempotencyKey: idempotencyKeyOf(turn, callId),
        explanation: {
          requestMessageId: turn.requestMessageId,
          steps: [{ tool: tool.name, input: payload }],
          facts: (turn.recalled ?? [])
            .slice(0, 10)
            .map((ref) => ({ kind: 'memory_recalled', ref, value: null })),
          alternatives: [],
        },
        untrustedContext: turn.untrustedContext,
        ...(turn.outsideText !== undefined && { outsideText: turn.outsideText }),
      },
      { templateDefaults: deps.autonomy.templateDefaults, clock: deps.clock },
    );
  // A copy of the same call racing this one recorded it first: asking again finds its result.
  let result: Awaited<ReturnType<typeof ask>>;
  try {
    result = await ask().catch((error: unknown) => {
      if (error instanceof ConcurrentActionError) return ask();
      throw error;
    });
  } catch (error) {
    await unstash(deps, tool, payload);
    throw error;
  }
  // What `stash` stored stays only with this call's proposal: a retry or a racing copy found
  // another's result, and a run made it current already (only a still-proposed fact goes).
  if (
    tool.unstash !== undefined &&
    (result.kind === 'executed' ||
      JSON.stringify(result.proposal.payload) !== JSON.stringify(payload))
  ) {
    await unstash(deps, tool, payload);
  }
  const memory = lastMemory();
  if (result.kind === 'proposed') {
    const shown = PreviewSchema.parse(result.proposal.preview);
    return {
      status: 'awaiting_approval',
      tool: tool.name,
      summary: `Waiting for the member's OK: ${shown.summary}`,
      proposal: result.proposal,
      // A proposal found again without a fresh dry run: its stored summary is labelled anyway.
      untrustedText: lastUntrusted() ?? true,
      ...(memory !== undefined && { memory }),
      card: changeCard(tool.name, result.proposal.action, shown, {
        state: 'proposed',
        proposalId: result.proposal.id,
        fingerprint: result.proposal.fingerprint,
        executionId: null,
        undoUntil: null,
      }),
    };
  }
  const { execution } = result;
  // A retried call finds its first execution without a fresh preview.
  const shown = PreviewSchema.safeParse(lastPreview()).data ?? {
    before: null,
    after: null,
    emails: [],
    summary: 'This was already done.',
  };
  return {
    status: 'done',
    tool: tool.name,
    summary: `Done: ${shown.summary}`,
    execution,
    // Without a fresh dry run the summary is the fixed "already done", which echoes nothing.
    untrustedText: lastUntrusted() ?? false,
    ...(memory !== undefined && { memory }),
    card: changeCard(tool.name, execution.action, shown, {
      state: 'done',
      proposalId: execution.proposalId,
      fingerprint: null,
      executionId: execution.id,
      undoUntil: execution.undoUntil,
    }),
  };
}

/** Runs the tool's `stash` as the AI, in its own transaction: the payload to store instead. */
async function stashed(
  deps: ToolDeps,
  tool: WriteTool,
  args: unknown,
  turn: ToolTurn,
): Promise<TrustJson> {
  if (tool.stash === undefined) throw new Error(`${tool.name} stores nothing first`);
  const stash = tool.stash.bind(tool);
  const member = memberOf(deps.actor);
  const stored = await withMember(deps.db, member.context, async (tx) =>
    stash(await scopeOf(tx, { ...member, via: 'ai' }, deps), args, {
      turnId: turn.turnId ?? null,
    }),
  );
  return TrustJsonSchema.parse(storedSchema(tool).parse(stored));
}

/** Removes what `stash` stored for a call that won't use it. Never fails the call. */
async function unstash(deps: ToolDeps, tool: WriteTool, payload: TrustJson): Promise<void> {
  if (tool.unstash === undefined) return;
  const remove = tool.unstash.bind(tool);
  const member = memberOf(deps.actor);
  await withMember(deps.db, member.context, async (tx) =>
    remove(await scopeOf(tx, { ...member, via: 'ai' }, deps), payload),
  ).catch(() => undefined);
}

/**
 * `(conversation, turn, step, tool call)`; the model's call id is hashed, never trusted as
 * text. The loop refuses a call id repeated within one answer, so the key names one call.
 */
export function idempotencyKeyOf(turn: ToolTurn, callId: string): string {
  const step = StepSchema.parse(turn.step);
  const call = createHash('sha256').update(callId).digest('hex').slice(0, 24);
  return ActionIdempotencyKeySchema.parse(
    `${TurnKeySchema.parse(turn.turnKey)}.s${String(step)}.${call}`,
  );
}

/** A write's preview as `previewOf` stores it. */
const PreviewSchema = z.object({
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  emails: z.array(z.object({ template: z.string(), clientId: z.string() })),
  summary: z.string(),
});

function changeCard(
  tool: string,
  action: AutonomyAction,
  shown: z.infer<typeof PreviewSchema>,
  state: Pick<
    Extract<ToolCard, { kind: 'change' }>,
    'state' | 'proposalId' | 'fingerprint' | 'executionId' | 'undoUntil'
  >,
): ToolCard {
  return {
    kind: 'change',
    tool,
    action,
    ...state,
    before: shown.before as ChangeSide | null,
    after: shown.after as ChangeSide | null,
    emails: shown.emails as WouldBeEmail[],
    summary: shown.summary,
  };
}

async function refused(
  deps: ToolDeps,
  tool: string,
  refusal: ToolRefusal,
  error: unknown,
  serviceId: ServiceId | null,
): Promise<ToolOutcome> {
  const alternatives = await localAlternatives(deps, refusal.alternatives ?? []);
  return {
    status: 'refused',
    tool,
    code: refusal.code,
    message: refusal.message,
    alternatives,
    card:
      alternatives.length === 0
        ? null
        : { kind: 'slot_picker', reason: 'alternatives', serviceId, slots: alternatives },
    error,
  };
}

/** The service a refused call named, if any (a move keeps its booking's). */
function serviceIdIn(args: unknown): ServiceId | null {
  const parsed = z.object({ serviceId: ServiceIdSchema }).safeParse(args);
  return parsed.success ? parsed.data.serviceId : null;
}

/** The alternatives in the business's local time, read as the member. */
async function localAlternatives(
  deps: ToolDeps,
  slots: readonly AvailableSlot[],
): Promise<LocalSlot[]> {
  if (slots.length === 0) return [];
  const member = memberOf(deps.actor);
  return withMember(deps.db, member.context, async (tx) => {
    const scope = await scopeOf(tx, { ...member, via: 'ai' }, deps);
    const directory = await directoryOf(scope);
    return slots.map((slot) => localSlot(scope, directory, slot));
  });
}

function writeToolNamed(name: string): WriteTool {
  const tool = findTool(name);
  if (tool?.kind !== 'write') throw new UnknownToolError();
  return tool;
}

/** The runner for a proposal of another tool version: the trust layer only expires it. */
function expiringRunner(tool: WriteTool, action: AutonomyAction): ActionRunner {
  const refuse = () => Promise.reject(new Error(`${tool.name}: an older proposal only expires`));
  return {
    tool: tool.name,
    version: tool.version,
    actions: [action],
    tier: tool.tier,
    preview: refuse,
    execute: refuse,
    undo: refuse,
  };
}

/** A runner that can only undo (the receipt holds the inverse; no payload is needed). */
function undoRunner(tool: WriteTool, deps: ToolDeps, action: AutonomyAction): ActionRunner {
  const refuse = () => Promise.reject(new Error(`${tool.name}: this runner only undoes`));
  return {
    tool: tool.name,
    version: tool.version,
    actions: [action],
    tier: tool.tier,
    preview: refuse,
    execute: refuse,
    undo: (tx, actor, receipt) => undoWith(tool, deps, tx, actor, receipt),
  };
}
