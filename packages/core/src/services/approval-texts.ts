import { randomInt } from 'node:crypto';
import {
  ActionProposalIdSchema,
  OutboxDedupeKeySchema,
  smsPlainText,
  SmsPhoneSchema,
  smsSendableAt,
  UserIdSchema,
  type ActionProposal,
  type ActionProposalId,
  type ApprovalDecision,
  type TenantId,
} from '@pepper/contracts';
import {
  appendAuditEntry,
  findActiveMemberSmsConsent,
  findCurrentTenant,
  findMembership,
  findUserPhone,
  findUserSignInState,
  insertApprovalText,
  isSmsOptedOut,
  listCardTextRecipients,
  listExecutionsApprovedByText,
  lockApprovalText,
  markApprovalTextUsed,
  setApprovalTextExecution,
  smsApprovalTarget,
  withTenant,
  type Database,
  type TenantTx,
} from '@pepper/db';
import { requirePermission, type Actor } from '../actor.js';
import { decideTenantAccess, type TenantContext } from '../tenant-access.js';
import { queueSms } from './sms.js';
import { sameCodeHash, smsCodeHash } from './member-texts.js';

// Cards by text (S63, ADR-0066 §3–4): a card that waits for an OK is texted to each owner or
// manager who asked for it, with a code of its own; a reply of "Y" (or "N", S64) and that code
// is claimed here, once, from that number only, and handed back to the caller to approve (or
// skip) as that member with the fingerprint the text was written from. This module never
// decides a card itself.

/** How long a text's code works at most after the text can go out (AC-X-82). */
export const APPROVAL_TEXT_TTL_MS = 2 * 60 * 60 * 1000;
/** A card that would expire sooner than this after its text can go gets no text. */
export const APPROVAL_TEXT_MIN_MS = 15 * 60 * 1000;
/** The longest card summary a text carries (the rest of the text is fixed). */
export const APPROVAL_SUMMARY_MAX = 200;

export interface ApprovalTextOptions {
  /** `smsCodeKeyFrom(outboxKey)`. */
  codeKey: Buffer;
  outboxKey: Buffer;
  now: Date;
  /** Draws a 4-digit code (tests pass fixed ones). */
  drawCode?: () => string;
}

/**
 * Texts a pending proposal to every member who gets cards by text (AC-X-82), in the open
 * transaction of the business that made it, so the texts go if and only if the proposal
 * commits. `summary` is the card in a line, in the domain's words, first names only (the caller
 * builds it); the text adds "Reply Y {code} to OK or N {code} to skip, by {time}." (AC-X-95). Held for the quiet hours like every
 * text that isn't urgent; none when the card would expire within 15 minutes of when it can go.
 * Returns how many were queued.
 */
export async function queueApprovalTexts(
  tx: TenantTx,
  proposal: Pick<ActionProposal, 'id' | 'fingerprint' | 'expiresAt' | 'status'>,
  summary: string,
  options: ApprovalTextOptions,
): Promise<number> {
  if (proposal.status !== 'pending') return 0;
  const tenant = await findCurrentTenant(tx);
  if (tenant === undefined)
    throw new Error('Approval texts are queued in a business’s transaction');
  const now = options.now.getTime();
  const sendable = smsSendableAt(tenant.timeZone, now);
  const expiresAt = Math.min(Date.parse(proposal.expiresAt), sendable + APPROVAL_TEXT_TTL_MS);
  if (expiresAt - sendable < APPROVAL_TEXT_MIN_MS) return 0;
  const line = smsPlainText(summary, APPROVAL_SUMMARY_MAX);
  if (line === '') return 0;
  const by = byTime(tenant.timeZone, expiresAt);
  let queued = 0;
  for (const recipient of await listCardTextRecipients(tx)) {
    const phone = SmsPhoneSchema.parse(recipient.phone);
    if (await isSmsOptedOut(tx, phone)) continue;
    const code = await freshCode(tx, phone, options);
    const id = await queueSms(
      tx,
      {
        to: phone,
        body: `Pepper: ${line} Reply Y ${code} to OK or N ${code} to skip, by ${by}.`,
        wordsBy: 'template',
      },
      {
        key: options.outboxKey,
        dedupeKey: OutboxDedupeKeySchema.parse(`approval.text:${proposal.id}:${recipient.userId}`),
        now: options.now,
      },
    );
    if (id === undefined) continue;
    await insertApprovalText(tx, {
      id,
      proposalId: proposal.id,
      userId: recipient.userId,
      phone,
      fingerprint: proposal.fingerprint,
      codeHash: smsCodeHash(options.codeKey, 'approval', phone, code),
      expiresAt: new Date(expiresAt),
      createdAt: options.now,
    });
    queued += 1;
  }
  return queued;
}

/** A code no live text to this number has (any business): replies never meet two cards. */
async function freshCode(
  tx: TenantTx,
  phone: string,
  options: ApprovalTextOptions,
): Promise<string> {
  const draw = options.drawCode ?? (() => String(randomInt(0, 10_000)).padStart(4, '0'));
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = draw();
    if (!/^\d{4}$/.test(code)) throw new RangeError('An approval code has four digits');
    const taken = await smsApprovalTarget(
      tx,
      phone,
      smsCodeHash(options.codeKey, 'approval', phone, code),
      options.now,
    );
    if (taken?.live !== true) return code;
  }
  throw new Error('No free approval code for this number');
}

/**
 * "4:10pm" in the business's zone. A text goes between 8:00 and 20:00 and its code works at most
 * 2 hours, so the time is always on the day the text arrives.
 */
function byTime(timeZone: string, at: number): string {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(at))
    .replace(/\s?(AM|PM)$/i, (_, half: string) => half.toLowerCase());
}

/** What a "Y" or "N" and a code came to (AC-X-83…85, AC-X-93); only `claimed` is to be decided. */
export type ApprovalClaim =
  /** No such text to this number, or the member may no longer approve by text: one answer. */
  | { kind: 'miss' }
  | { kind: 'used' }
  | { kind: 'expired' }
  | {
      kind: 'claimed';
      tenantId: TenantId;
      /** The spent text, to link to what its approval does (`recordTextApproval`). */
      approvalTextId: string;
      /** The member, with their role now, to approve as. */
      context: TenantContext;
      proposalId: ActionProposalId;
      /** What the text showed: the approval runs only if the card is unchanged. */
      fingerprint: string;
    };

/**
 * Claims the text a reply of "Y" or "N" and `code` from `from` answers (AC-X-83…85, AC-X-93,
 * S64: the decision is audited with it, and the caller approves or skips): the text sent to
 * that number with that code (any business, `sms_approval_target`), locked in its business;
 * used → `used`, expired → `expired`; the number must still be the member's checked one, and the
 * member an owner or manager with a second factor and "Text me cards" on there, else `miss`.
 * The code is spent here, committed before the caller approves, so it works once even if the
 * approval then fails. Audited as the member, without the number.
 */
export async function claimApprovalText(
  db: Database,
  input: { from: string; code: string; receivedAt: Date; decision?: ApprovalDecision },
  options: { codeKey: Buffer },
): Promise<ApprovalClaim> {
  const from = SmsPhoneSchema.safeParse(input.from);
  if (!from.success || !/^\d{4}$/.test(input.code)) return { kind: 'miss' };
  const hash = smsCodeHash(options.codeKey, 'approval', from.data, input.code);
  const target = await smsApprovalTarget(db, from.data, hash, input.receivedAt);
  if (target === undefined) return { kind: 'miss' };
  return withTenant(db, target.tenantId, async (tx): Promise<ApprovalClaim> => {
    const text = await lockApprovalText(tx, target.approvalTextId);
    // The lookup crossed businesses; this checks it again in this one.
    if (text?.phone !== from.data || !sameCodeHash(text.codeHash, hash)) {
      return { kind: 'miss' };
    }
    const userId = UserIdSchema.parse(text.userId);
    const context = await approverContext(tx, target.tenantId, userId, from.data);
    if (context === null) return { kind: 'miss' };
    if (text.usedAt !== null) return { kind: 'used' };
    if (text.expiresAt.getTime() <= input.receivedAt.getTime()) return { kind: 'expired' };
    if (!(await markApprovalTextUsed(tx, text.id, input.receivedAt))) return { kind: 'used' };
    await appendAuditEntry(tx, {
      actor: { kind: 'user', userId },
      change: {
        action: 'sms.approval_reply',
        entity: { type: 'approval_text', id: text.id },
        before: { used: false },
        after: { used: true, proposalId: text.proposalId, decision: input.decision ?? 'approve' },
      },
    });
    return {
      kind: 'claimed',
      tenantId: target.tenantId,
      approvalTextId: text.id,
      context,
      proposalId: ActionProposalIdSchema.parse(text.proposalId),
      fingerprint: text.fingerprint,
    };
  });
}

/**
 * The member as they may act now, or `null`: the number is still their checked one, they are
 * still an owner or manager here with a second factor (as `decideTenantAccess` asks of a
 * session), their account isn't being deleted, and "Text me cards" is on with their consent.
 */
async function approverContext(
  tx: TenantTx,
  tenantId: TenantId,
  userId: ReturnType<typeof UserIdSchema.parse>,
  phone: string,
): Promise<TenantContext | null> {
  const [own, state, membership] = [
    await findUserPhone(tx, userId),
    await findUserSignInState(tx, userId),
    await findMembership(tx, userId),
  ];
  if (own?.phone !== phone || state === undefined || state.beingDeleted) return null;
  if (membership?.cardTexts !== true) return null;
  if (membership.role !== 'owner' && membership.role !== 'manager') return null;
  if ((await findActiveMemberSmsConsent(tx, phone, userId)) === undefined) return null;
  const access = decideTenantAccess({
    userId,
    activeTenantId: tenantId,
    role: membership.role,
    twoFactorEnabled: state.twoFactorEnabled,
  });
  return access.allowed ? access.context : null;
}

/**
 * Records that a claimed text's approval went through (S63.2, AC-X-91): the execution it made,
 * so Activity can say the card was approved by text. Only after `executed`: a spent code whose
 * approval was refused or found the card changed stays unlinked.
 */
export async function recordTextApproval(
  db: Database,
  tenantId: TenantId,
  approvalTextId: string,
  executionId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, (tx) =>
    setApprovalTextExecution(tx, approvalTextId, executionId),
  );
}

/** Of these executions, the ones approved by a text reply (S63.2, AC-X-91). */
export async function executionsApprovedByText(
  db: Database,
  actor: Actor,
  executionIds: readonly string[],
): Promise<Set<string>> {
  requirePermission(actor, 'business.read');
  return withTenant(db, actor.context.tenantId, (tx) =>
    listExecutionsApprovedByText(tx, executionIds),
  );
}
