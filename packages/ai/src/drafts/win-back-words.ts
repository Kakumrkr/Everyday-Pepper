import {
  ActionProposalIdSchema,
  NudgeDraftSchema,
  type NudgeDraft,
  type WinBackDraftResult,
  type WinBackRefusal,
} from '@pepper/contracts';
import type { WinBackEntry } from '@pepper/appointments';

// The pure half of a one-tap win-back draft (S54.2, ADR-0057): the words, and the answer a tap
// gets before any time is looked for. `win-back.ts` runs the rest in the business's
// transaction (proven against Postgres by `win-back.int.test.ts`).

/**
 * The words of a win-back email, from what the business knows (first name, service, date).
 * A name that breaks a draft rule (too long, or read as a link or contact) leaves the name
 * and the service out rather than failing the tap.
 */
export function winBackWords(facts: {
  firstName: string | null;
  serviceName: string;
  lastVisit: string;
}): NudgeDraft {
  const service = facts.serviceName.toLowerCase();
  const hello = facts.firstName === null ? 'Hi,' : `Hi ${facts.firstName},`;
  const named = NudgeDraftSchema.safeParse({
    subject:
      facts.firstName === null
        ? `Time for your next ${service}?`
        : `Time for your next ${service}, ${facts.firstName}?`,
    body: `${hello}\n\nIt's been a while since your last ${service} on ${facts.lastVisit}, and we'd love to see you again.`,
  });
  if (named.success) return named.data;
  return NudgeDraftSchema.parse({
    subject: 'Time for your next visit?',
    body: `Hi,\n\nIt's been a while since your last visit on ${facts.lastVisit}, and we'd love to see you again.`,
  });
}

/**
 * The answer a tap gets before any time is looked for, or `null` to go on: not on the list;
 * the draft already waiting (the second tap opens it); then why no email can go, in the order
 * the owner can do something about it.
 */
export function firstAnswer(
  entry:
    | Pick<
        WinBackEntry,
        'pendingProposalId' | 'optedOut' | 'hasEmail' | 'emailedAt' | 'serviceBookable'
      >
    | undefined,
  mailingAddressSet: boolean,
): WinBackDraftResult | null {
  if (entry === undefined) return refused('not_due');
  if (entry.pendingProposalId !== null) return drafted(entry.pendingProposalId);
  if (!mailingAddressSet) return refused('no_address');
  if (entry.optedOut) return refused('opted_out');
  if (!entry.hasEmail) return refused('no_email');
  if (entry.emailedAt !== null) return refused('recently_emailed');
  if (!entry.serviceBookable) return refused('service_hidden');
  return null;
}

export function refused(reason: WinBackRefusal): WinBackDraftResult {
  return { kind: 'refused', reason };
}

export function drafted(proposalId: string): WinBackDraftResult {
  return { kind: 'drafted', proposalId: ActionProposalIdSchema.parse(proposalId) };
}
