import { queueBookingEmail, type BookingNotify } from '@pepper/appointments';
import {
  AI_EMAIL_GRACE_SECONDS,
  OutboxDedupeKeySchema,
  type ClientId,
  type OutboxMessageId,
  type TrustJson,
  type WouldBeEmail,
} from '@pepper/contracts';
import {
  queueEmail,
  stateFingerprint,
  type ActionEffect,
  type ActionPreview,
  type ActionReceipt,
  type ActionRunner,
  type Actor,
} from '@pepper/core';
import { findCurrentTenant, type TenantTx } from '@pepper/db';
import { undoRefusalOf } from './errors.js';
import type { ClientEmail, Performed, ToolDeps, ToolScope, WriteScope, WriteTool } from './tool.js';

// A write tool as the trust layer's `ActionRunner` (ADR-0028 §9, ADR-0029). Preview and execute
// run the very same `perform` through the domain: the trust layer runs the preview in a savepoint
// it rolls back, so what the member is shown (the typed diff and the would-be emails) is what
// the execution does (D-1), not a separate guess. The fingerprint covers only what the tool
// touches: the payload, the touched rows' versions, the outcome and the emails.

/**
 * The trust layer's runner for one call of `tool` with `payload` (parsed again on every run).
 * `lastPreview` is what its latest dry run showed, for the card of an action that ran at once,
 * and `lastUntrusted` whether its summary echoed untrusted text.
 */
export function writeRunner(
  tool: WriteTool,
  deps: ToolDeps,
  payload: unknown,
): {
  runner: ActionRunner;
  lastPreview: () => TrustJson | undefined;
  /** Whether that dry run's summary echoed untrusted text (`undefined`: no dry run ran). */
  lastUntrusted: () => boolean | undefined;
  /** The remembered facts its latest run gave the model, by reference (S30). */
  lastMemory: () => TrustJson | undefined;
} {
  const args: unknown = storedSchema(tool).parse(payload);
  let shown: TrustJson | undefined;
  let untrusted: boolean | undefined;
  let memory: TrustJson | undefined;
  const runner: ActionRunner = {
    tool: tool.name,
    version: tool.version,
    actions: tool.actions(args),
    tier: tool.tier,
    ...(tool.alwaysAsks === true && { alwaysAsks: true }),
    async preview(tx, actor, stored): Promise<ActionPreview> {
      const { performed, emails } = await run(tool, deps, tx, actor, stored);
      shown = previewOf(performed, emails);
      untrusted = performed.untrustedText ?? false;
      memory = performed.memory;
      return {
        preview: shown,
        fingerprint: stateFingerprint({
          tool: tool.name,
          toolVersion: tool.version,
          payload: stored,
          state: { touched: performed.touched, before: performed.before, after: performed.after },
          messages: emails,
        }),
        recipients: new Set(emails.map((email) => email.clientId)).size,
        recordOwner: performed.recordOwner,
        targetKey: performed.targetKey,
        appointmentStartsAt: performed.appointmentStartsAt,
        facts: performed.facts,
      };
    },
    async execute(tx, actor, stored): Promise<ActionEffect> {
      const { performed, queued } = await run(tool, deps, tx, actor, stored);
      memory = performed.memory ?? memory;
      return {
        entity: performed.entity,
        before: performed.before,
        after: performed.after,
        inverse: performed.inverse,
        outboxMessageIds: queued,
        appointmentStartsAt: performed.appointmentStartsAt,
        summary: performed.summary,
      };
    },
    undo: (tx, actor, receipt) => undoWith(tool, deps, tx, actor, receipt),
  };
  return {
    runner,
    lastPreview: () => shown,
    lastUntrusted: () => untrusted,
    lastMemory: () => memory,
  };
}

/** How a tool's stored payload parses: its arguments, or what `stash` stored instead. */
export function storedSchema(tool: WriteTool) {
  return tool.payload ?? tool.args;
}

/**
 * Runs the tool's inverse as the member; the domain refusing it (the slot was booked, the
 * appointment started, it changed since) becomes the trust layer's `UndoRefusedError`.
 */
export async function undoWith(
  tool: WriteTool,
  deps: ToolDeps,
  tx: TenantTx,
  actor: Actor,
  receipt: ActionReceipt,
): Promise<void> {
  try {
    await tool.undo(await scopeOf(tx, actor, deps), receipt.inverse);
  } catch (error) {
    throw undoRefusalOf(error);
  }
}

/** What a proposal stores and the card shows: the change and the emails, ids only. */
export function previewOf(performed: Performed, emails: readonly WouldBeEmail[]): TrustJson {
  return {
    entityType: performed.entity.type,
    before: performed.before,
    after: performed.after,
    emails: emails.map((email) => ({ template: email.template, clientId: email.clientId })),
    summary: performed.summary,
    ...(performed.draft !== undefined && { draft: performed.draft }),
  };
}

/** The tool's scope in `tx`: the business's time zone and the clock's now. */
export async function scopeOf(tx: TenantTx, actor: Actor, deps: ToolDeps): Promise<ToolScope> {
  const tenant = await findCurrentTenant(tx);
  // Every member transaction has its business.
  if (tenant === undefined) throw new Error('No business in this transaction');
  return {
    tx,
    actor,
    deps,
    requester: deps.requester ?? actor.context.userId,
    timeZone: tenant.timeZone,
    now: deps.clock.now(),
  };
}

async function run(
  tool: WriteTool,
  deps: ToolDeps,
  tx: TenantTx,
  actor: Actor,
  stored: TrustJson,
): Promise<{ performed: Performed; emails: WouldBeEmail[]; queued: OutboxMessageId[] }> {
  const args: unknown = storedSchema(tool).parse(stored);
  const emails: WouldBeEmail[] = [];
  const queued: OutboxMessageId[] = [];
  const notifyClient =
    (clientId: ClientId): BookingNotify =>
    async (inTx, notice) => {
      const id = await queueBookingEmail(inTx, notice, {
        ...deps.emails,
        clock: deps.clock,
        holdSeconds: AI_EMAIL_GRACE_SECONDS,
      });
      if (id === undefined) return;
      emails.push({ template: notice.kind, clientId });
      queued.push(id);
    };
  const emailClient = async (email: ClientEmail) => {
    const id = await queueEmail(tx, email.message, {
      key: deps.emails.outboxKey,
      dedupeKey: OutboxDedupeKeySchema.parse(email.dedupeKey),
      now: new Date(deps.clock.now().getTime() + AI_EMAIL_GRACE_SECONDS * 1000),
    });
    if (id === undefined) return;
    emails.push({ template: email.template, clientId: email.clientId });
    queued.push(id);
  };
  const heldMessage = (id: OutboxMessageId, to: WouldBeEmail) => {
    emails.push(to);
    queued.push(id);
  };
  const scope: WriteScope = {
    ...(await scopeOf(tx, actor, deps)),
    notifyClient,
    emailClient,
    heldMessage,
  };
  const performed = await tool.perform(scope, args);
  return { performed, emails, queued };
}
