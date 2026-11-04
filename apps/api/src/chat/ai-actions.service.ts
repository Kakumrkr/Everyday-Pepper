import {
  approvalRefusal,
  approveToolProposal,
  reviseNudgeDraft,
  shownPreview,
  undoToolAction,
} from '@pepper/ai';
import {
  AiEmailViewSchema,
  AiWhyFactSchema,
  AUTONOMY_ACTIONS,
  ClientIdSchema,
  MemoryFactIdSchema,
  type ActionExecution,
  type ActionExecutionId,
  type ActionExplanation,
  type ActionProposal,
  type ActionProposalId,
  type AiActionsQuery,
  type AiActionsResponse,
  type AiActionView,
  type AiEmailRecipient,
  type AiEmailView,
  type AiMemoryView,
  type AiProposalsResponse,
  type AiProposalView,
  type AiWhy,
  type ApproveProposalResponse,
  type AutonomyAction,
  type AutonomyChange,
  type AutonomyTrackRecord,
  type AutonomyView,
  type BusinessAutonomy,
  type AutonomySettings,
  type ChangeSide,
  type EditDraftRequest,
  type MemoryFactId,
  type UndoActionResponse,
  type UndoReason,
  type WouldBeEmail,
} from '@pepper/contracts';
import {
  actionMessages,
  autonomyPresetOf,
  changeAutonomy,
  clientEmailAddresses,
  getAction,
  getActionOfProposal,
  getAutonomy,
  getProposal,
  getTrackRecord,
  listPendingProposals,
  listRecentActions,
  memberFirstNames,
  memoryOfAction,
  ownMessageText,
  permissionScope,
  ProposalNotPendingError,
  rejectProposal,
  type ActionMessage,
  type Actor,
  type Clock,
  type TenantContext,
} from '@pepper/core';
import { DATABASE } from '@pepper/runtime';
import type { Database } from '@pepper/db';
import { Inject, Injectable } from '@nestjs/common';
import { actorOf, CHAT_CLOCK, ChatService } from './chat.service.js';

/** Receipts listed on Home ("Done for you"). */
const RECENT_ACTIONS = 30;

/** The email a booking write queues for its client (a receipt keeps the message ids only). */
const EMAIL_OF: Partial<Record<AutonomyAction, WouldBeEmail['template']>> = {
  'booking.create': 'confirmed',
  'booking.move': 'rescheduled',
  'booking.cancel': 'cancelled',
};

/**
 * The AI's proposals and actions as the member sees them (S26, ADR-0031): the live state behind
 * a chat card, *Why?*, and Approve, Reject and Undo by id. Approve runs the stored proposal with
 * the fingerprint the card showed, never a payload from the browser; every view is assembled
 * from the trust layer's records as the member (RLS), never from model prose.
 */
@Injectable()
export class AiActionsService {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(CHAT_CLOCK) private readonly clock: Clock,
    private readonly chat: ChatService,
  ) {
    this.db = database.db;
  }

  async proposal(tenant: TenantContext, id: ActionProposalId): Promise<AiProposalView> {
    const actor = actorOf(tenant);
    return this.proposalView(actor, await getProposal(this.db, actor, id));
  }

  async proposals(tenant: TenantContext): Promise<AiProposalsResponse> {
    const actor = actorOf(tenant);
    const pending = await listPendingProposals(this.db, actor, { clock: this.clock });
    return { proposals: await Promise.all(pending.map((p) => this.proposalView(actor, p))) };
  }

  async action(tenant: TenantContext, id: ActionExecutionId): Promise<AiActionView> {
    const actor = actorOf(tenant);
    return this.actionView(actor, await getAction(this.db, actor, id));
  }

  async actions(tenant: TenantContext, query: AiActionsQuery = {}): Promise<AiActionsResponse> {
    const actor = actorOf(tenant);
    const limit = query.limit ?? RECENT_ACTIONS;
    // One more than the page tells whether there is a next one.
    const recent = await listRecentActions(this.db, actor, {
      limit: limit + 1,
      ...(query.after === undefined ? {} : { after: query.after }),
    });
    const page = recent.slice(0, limit);
    return {
      actions: await Promise.all(page.map((e) => this.actionView(actor, e))),
      next: recent.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Approves exactly the proposal and fingerprint the card showed. */
  async approve(
    tenant: TenantContext,
    id: ActionProposalId,
    fingerprint: string,
  ): Promise<ApproveProposalResponse> {
    const actor = actorOf(tenant);
    const deps = await this.chat.toolDeps(tenant);
    const result = await approveToolProposal(deps, id, fingerprint);
    switch (result.kind) {
      case 'executed':
        return { kind: 'executed', action: await this.actionView(actor, result.execution) };
      case 'stale':
        return { kind: 'stale', proposal: await this.proposalView(actor, result.proposal) };
      case 'refused': {
        const proposal = await getProposal(this.db, actor, id);
        return { kind: 'refused', ...(await approvalRefusal(deps, proposal, result.error)) };
      }
      case 'expired':
        return { kind: 'expired' };
    }
  }

  /** Replaces a nudge's words (S36); an expired proposal answers `proposal_not_pending`. */
  async editDraft(
    tenant: TenantContext,
    id: ActionProposalId,
    edit: EditDraftRequest,
  ): Promise<AiProposalView> {
    const actor = actorOf(tenant);
    const result = await reviseNudgeDraft(await this.chat.toolDeps(tenant), id, edit.fingerprint, {
      subject: edit.subject,
      body: edit.body,
    });
    if (result.kind === 'expired') throw new ProposalNotPendingError('expired');
    return this.proposalView(actor, result.proposal);
  }

  async reject(tenant: TenantContext, id: ActionProposalId): Promise<AiProposalView> {
    const actor = actorOf(tenant);
    return this.proposalView(
      actor,
      await rejectProposal(this.db, actor, id, { clock: this.clock }),
    );
  }

  async undo(
    tenant: TenantContext,
    id: ActionExecutionId,
    reason: UndoReason | null,
  ): Promise<UndoActionResponse> {
    const actor = actorOf(tenant);
    const { execution, messages } = await undoToolAction(
      await this.chat.toolDeps(tenant),
      id,
      reason,
    );
    return {
      action: await this.actionView(actor, execution),
      takenBack: messages.cancelled.length,
      alreadySent: messages.tooLate.length,
    };
  }

  async autonomy(tenant: TenantContext): Promise<AutonomyView> {
    const deps = await this.chat.toolDeps(tenant);
    return withPreset(await getAutonomy(this.db, actorOf(tenant), deps.autonomy), deps.autonomy);
  }

  async changeAutonomy(tenant: TenantContext, change: AutonomyChange): Promise<AutonomyView> {
    const deps = await this.chat.toolDeps(tenant);
    return withPreset(
      await changeAutonomy(this.db, actorOf(tenant), change, deps.autonomy),
      deps.autonomy,
    );
  }

  /** The Autonomy page's counts and earned-trust offers (S53, ADR-0055). */
  async trackRecord(tenant: TenantContext): Promise<AutonomyTrackRecord> {
    const deps = await this.chat.toolDeps(tenant);
    return getTrackRecord(this.db, actorOf(tenant), { ...deps.autonomy, clock: this.clock });
  }

  /** Each emailed client's address the viewer may see (S53: the card names who gets it). */
  private async recipientsOf(
    actor: Actor,
    emails: readonly { clientId: string }[],
  ): Promise<AiEmailRecipient[]> {
    const ids = emails.flatMap((email) => {
      const id = ClientIdSchema.safeParse(email.clientId);
      return id.success ? [id.data] : [];
    });
    const addresses = await clientEmailAddresses(this.db, actor, ids);
    return [...addresses].map(([clientId, address]) => ({ clientId, address }));
  }

  // -------------------------------------------------------------------------------------------

  private async proposalView(actor: Actor, proposal: ActionProposal): Promise<AiProposalView> {
    const shown = shownPreview(proposal.preview);
    const execution =
      proposal.status === 'approved'
        ? await getActionOfProposal(this.db, actor, proposal.id)
        : null;
    const me = actor.context.userId;
    const names = await memberFirstNames(this.db, actor, [proposal.decidedByUserId]);
    const forYou = proposal.requestedByUserId === me;
    return {
      id: proposal.id,
      action: proposal.action,
      tool: proposal.tool,
      status: proposal.status,
      fingerprint: proposal.fingerprint,
      summary: shown?.summary ?? '',
      before: shown?.before ?? null,
      after: shown?.after ?? null,
      emails: shown?.emails ?? [],
      recipients: await this.recipientsOf(actor, shown?.emails ?? []),
      expiresAt: proposal.expiresAt,
      createdAt: proposal.createdAt,
      executionId: execution?.id ?? null,
      decidedByName:
        proposal.decidedByUserId === null || proposal.decidedByUserId === me
          ? null
          : (names.get(proposal.decidedByUserId) ?? null),
      forYou,
      canDecide:
        proposal.status === 'pending' && (forYou || this.reachesAll(actor, proposal.action)),
      ...(await this.withMemory(actor, proposal.explanation, proposedFactOf(proposal))),
      ...(shown?.draft !== undefined && { draft: shown.draft }),
    };
  }

  private async actionView(actor: Actor, execution: ActionExecution): Promise<AiActionView> {
    const me = actor.context.userId;
    const [names, messages] = await Promise.all([
      memberFirstNames(this.db, actor, [execution.onBehalfOfUserId]),
      actionMessages(this.db, actor, execution),
    ]);
    const forYou = execution.requestedByUserId === me || execution.onBehalfOfUserId === me;
    const emails = emailsOf(execution, messages);
    const approvedByOther =
      execution.proposalId !== null &&
      execution.onBehalfOfUserId !== null &&
      execution.onBehalfOfUserId !== execution.requestedByUserId &&
      execution.onBehalfOfUserId !== me;
    const open =
      execution.status === 'done' &&
      execution.undoUntil !== null &&
      Date.parse(execution.undoUntil) > this.clock.now().getTime();
    return {
      id: execution.id,
      proposalId: execution.proposalId,
      action: execution.action,
      tool: execution.tool,
      outcome: execution.outcome,
      status: execution.status,
      summary: execution.summary,
      before: sideOf(execution.before),
      after: sideOf(execution.after),
      emails,
      recipients: await this.recipientsOf(actor, emails),
      createdAt: execution.createdAt,
      undoUntil: execution.undoUntil,
      canUndo: open && (forYou || this.reachesAll(actor, execution.action)),
      undoneAt: execution.undoneAt,
      undoReason: execution.undoReason,
      approvedByName:
        approvedByOther && execution.onBehalfOfUserId !== null
          ? (names.get(execution.onBehalfOfUserId) ?? null)
          : null,
      forYou,
      ...(await this.withMemory(actor, execution.explanation, null)),
    };
  }

  /**
   * *Why?* and what the card shows from memory (S30), read live by id: a fact deleted since is
   * "gone" in *Why?* and left off the card.
   */
  private async withMemory(
    actor: Actor,
    explanation: ActionExplanation,
    proposedFactId: MemoryFactId | null,
  ): Promise<{ why: AiWhy; memory?: AiMemoryView }> {
    const [why, remembered] = await Promise.all([
      this.why(actor, explanation),
      memoryOfAction(this.db, actor, explanation, { proposedFactId, clock: this.clock }),
    ]);
    return {
      why: remembered.remembered.length > 0 ? { ...why, remembered: remembered.remembered } : why,
      ...(remembered.card !== null && { memory: remembered.card }),
    };
  }

  /** *Why?* from the stored explanation: the member's own words only, never another's. */
  private async why(actor: Actor, explanation: ActionExplanation): Promise<AiWhy> {
    const asked =
      explanation.requestMessageId === null
        ? ({ kind: 'none' } as const)
        : await ownMessageText(this.db, actor, explanation.requestMessageId).then((text) =>
            text === null ? ({ kind: 'not_shown' } as const) : { kind: 'message' as const, text },
          );
    return {
      asked,
      steps: explanation.steps.map((step) => ({ tool: step.tool })),
      decision: explanation.decision,
      untrustedContext: explanation.untrustedContext,
      // What the domain checked (S26b): only flat, contact-free facts; any other is left out
      // rather than failing the whole view.
      facts: explanation.facts.flatMap((fact) => {
        const shown = AiWhyFactSchema.safeParse({ kind: fact.kind, value: fact.value });
        return shown.success ? [shown.data] : [];
      }),
    };
  }

  /** Whether the member's role reaches every record of this kind (owners and managers). */
  private reachesAll(actor: Actor, action: AutonomyAction): boolean {
    return permissionScope(actor.context.role, AUTONOMY_ACTIONS[action].permission) === 'all';
  }
}

/** A stored before/after as a card side (`null` when it isn't one). */
function sideOf(value: unknown): ChangeSide | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as ChangeSide;
}

/** The emails a booking write queued, with where each is now. */
function emailsOf(execution: ActionExecution, messages: readonly ActionMessage[]): AiEmailView[] {
  const template = EMAIL_OF[execution.action];
  const side = sideOf(execution.after) ?? sideOf(execution.before);
  const clientId = ClientIdSchema.safeParse(side?.['clientId']);
  if (template === undefined || !clientId.success) return [];
  return messages.map((message) =>
    AiEmailViewSchema.parse({
      template,
      clientId: clientId.data,
      status:
        message.status === 'pending'
          ? 'waiting'
          : message.status === 'cancelled'
            ? 'taken_back'
            : message.status === 'dead'
              ? 'failed'
              : 'sent',
      sendsAt: message.status === 'pending' ? message.availableAt.toISOString() : null,
    }),
  );
}

/** The autonomy with the preset it matches (S53). */
function withPreset(
  autonomy: BusinessAutonomy,
  defaults: { templateDefaults: AutonomySettings },
): AutonomyView {
  return { ...autonomy, preset: autonomyPresetOf(autonomy, defaults.templateDefaults) };
}

/** The fact a memory save proposes (its payload holds only the id, S30), if it is one. */
function proposedFactOf(proposal: ActionProposal): MemoryFactId | null {
  if (proposal.tool !== 'remember_fact' && proposal.tool !== 'add_visit_note') return null;
  const payload = proposal.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const id = MemoryFactIdSchema.safeParse(payload['factId']);
  return id.success ? id.data : null;
}
