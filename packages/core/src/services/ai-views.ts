import {
  ActionProposalIdSchema,
  ConversationMessageIdSchema,
  LastVisitFactValueSchema,
  MEMORY_FACT_KINDS,
  MemoryFactIdSchema,
  OutboxMessageIdSchema,
  type ActionExecution,
  type ActionExplanation,
  type ActionProposalId,
  type AiMemoryView,
  type MemoryFactId,
  type MemoryFactShown,
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
  type TenantTx,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { systemClock, type Clock } from '../clock.js';
import { toExecution } from './ai-actions.js';
import { factsShownIn } from './memory.js';

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
  return withTenant(db, actor.context.tenantId, (tx) => memberFirstNamesIn(tx, actor, userIds));
}

/** `memberFirstNames` inside the caller's transaction (the AI's `list_todos`, S26b). */
export async function memberFirstNamesIn(
  tx: TenantTx,
  actor: Actor,
  userIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  requirePermission(actor, 'business.read');
  const wanted = new Set(userIds.filter((id): id is string => id !== null));
  if (wanted.size === 0) return new Map();
  const members = await listTenantMembers(tx);
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

/**
 * Memory on an AI action's card and in its *Why?* (S30, playbook principle 7), read live as
 * the member: the explanation names facts by id only. `remembered`: every fact it used, a
 * deleted or hidden one as `gone` ("a fact you deleted"). `card`: the fact a memory tool saves
 * or forgets (for a proposed save, `proposedFactId` holds the new value and the current fact
 * the one it replaces), the booking's warnings and the client's last visit, only what is still
 * there; `null` when there is none.
 */
export async function memoryOfAction(
  db: Database,
  actor: Actor,
  explanation: ActionExplanation,
  options: { proposedFactId?: MemoryFactId | null; clock?: Clock } = {},
): Promise<{ remembered: MemoryFactShown[]; card: AiMemoryView | null }> {
  requirePermission(actor, 'business.read');
  const kinds: readonly string[] = MEMORY_FACT_KINDS;
  const named = explanation.facts.filter((fact) => kinds.includes(fact.kind) && fact.ref !== null);
  const proposed = options.proposedFactId ?? null;
  if (named.length === 0 && proposed === null) return { remembered: [], card: null };
  const ids = [
    ...new Set([
      ...named.map((fact) => MemoryFactIdSchema.parse(fact.ref)),
      ...(proposed === null ? [] : [proposed]),
    ]),
  ];
  const now = (options.clock ?? systemClock).now();
  const shown = new Map(
    (await withMember(db, actor.context, (tx) => factsShownIn(tx, ids, now))).map((fact) => [
      fact.factId,
      fact,
    ]),
  );
  const of = (kind: string) =>
    named
      .filter((fact) => fact.kind === kind)
      .flatMap((fact) => {
        const found = shown.get(MemoryFactIdSchema.parse(fact.ref));
        return found === undefined ? [] : [found];
      });
  const known = (facts: MemoryFactShown[]) => facts.filter((fact) => fact.state === 'known');

  const [current] = of('memory_fact');
  const pending = proposed === null ? undefined : shown.get(proposed);
  let fact: MemoryFactShown | null = current ?? null;
  if (pending?.state === 'known' && pending.factId !== current?.factId) {
    // A proposed save over a current value: the new value, and the one it would replace.
    fact = {
      ...pending,
      previous:
        current?.state === 'known' && current.value !== pending.value ? current.value : null,
    };
  } else if (pending !== undefined && current === undefined) {
    fact = pending;
  }
  const visit = explanation.facts.find((each) => each.kind === 'last_visit');
  const visitValue = LastVisitFactValueSchema.safeParse(visit?.value);
  const notes = known(of('memory_last_visit'));
  const warnings = known(of('memory_warning'));
  const card: AiMemoryView = {
    fact,
    warnings,
    lastVisit:
      visitValue.success && notes.length > 0
        ? { date: visitValue.data.date, serviceName: visitValue.data.serviceName, notes }
        : null,
  };
  return {
    remembered: named
      .flatMap((each) => {
        const found = shown.get(MemoryFactIdSchema.parse(each.ref));
        return found === undefined ? [] : [found];
      })
      .filter(
        (each, index, all) => all.findIndex((other) => other.factId === each.factId) === index,
      ),
    card: card.fact === null && warnings.length === 0 && card.lastVisit === null ? null : card,
  };
}
