import {
  ActionProposalIdSchema,
  ConversationMessageIdSchema,
  OutboxMessageIdSchema,
  type ActionExecution,
  type ActionProposalId,
  type OutboxStatus,
} from '@pepper/contracts';
import {
  findExecutionOfProposal,
  findMessage,
  findOutboxMessage,
  listTenantMembers,
  withMember,
  withTenant,
  type Database,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { toExecution } from './ai-actions.js';

// What the chat cards and the *Why?* sheet need besides the proposal or receipt itself (S26,
// ADR-0031): the member's own words, the first names of the people who decided, and where the
// emails an action queued are now. Each is read as the member, so RLS limits it.

/**
 * The text of the member's own message `messageId` (what started an AI action), or `null` when
 * it isn't theirs (conversations are own-only for every role), isn't a message they typed, or
 * was deleted with its conversation after 90 days.
 */
export async function ownMessageText(
  db: Database,
  actor: Actor,
  messageId: string,
): Promise<string | null> {
  requirePermission(actor, 'ai.chat');
  const id = ConversationMessageIdSchema.safeParse(messageId);
  if (!id.success) return null;
  const row = await withMember(db, actor.context, (tx) => findMessage(tx, id.data));
  return row?.role === 'user' && row.userId === actor.context.userId ? row.content : null;
}

/**
 * The first names of the members of the actor's business among `userIds` ("Approved by Ana").
 * Only names: staff may not list the team, but they know who decided on their own request.
 */
export async function memberFirstNames(
  db: Database,
  actor: Actor,
  userIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  requirePermission(actor, 'business.read');
  const wanted = new Set(userIds.filter((id): id is string => id !== null));
  if (wanted.size === 0) return new Map();
  const members = await withTenant(db, actor.context.tenantId, listTenantMembers);
  return new Map(
    members
      .filter((member) => wanted.has(member.userId))
      .map((member) => [member.userId, member.name.trim().split(/\s+/)[0] ?? '']),
  );
}

export interface ActionMessage {
  id: string;
  status: OutboxStatus;
  /** When a pending message leaves (the undo-send grace). */
  availableAt: Date;
}

/** Where each message an AI action queued is now, in the receipt's order. */
export async function actionMessages(
  db: Database,
  actor: Actor,
  execution: Pick<ActionExecution, 'outboxMessageIds'>,
): Promise<ActionMessage[]> {
  requirePermission(actor, 'business.read');
  if (execution.outboxMessageIds.length === 0) return [];
  return withMember(db, actor.context, async (tx) => {
    const messages: ActionMessage[] = [];
    for (const id of execution.outboxMessageIds) {
      const row = await findOutboxMessage(tx, OutboxMessageIdSchema.parse(id));
      if (row !== undefined) {
        messages.push({ id: row.id, status: row.status, availableAt: row.availableAt });
      }
    }
    return messages;
  });
}

/** The receipt of an approved proposal, if the member may see it. */
export async function getActionOfProposal(
  db: Database,
  actor: Actor,
  proposalId: ActionProposalId,
): Promise<ActionExecution | null> {
  requirePermission(actor, 'business.read');
  const id = ActionProposalIdSchema.parse(proposalId);
  const row = await withMember(db, actor.context, (tx) => findExecutionOfProposal(tx, id));
  return row === undefined ? null : toExecution(row);
}
