'use client';

import type { AiActionView, AiProposalView, ToolCard } from '@pepper/contracts';
import { buttonStyle, cx } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { ROUTES } from '../../../lib/account';
import { LiveChangeCard } from './live-change';

/** How many of the latest receipts Home shows. */
const SHOWN = 5;

/**
 * Pepper's work on Home's feed (S26; S35 makes Home the feed): "Needs your OK" (proposals
 * waiting for the member) or "Done for you" (receipts with Undo and Why?), one section each,
 * with an empty state that says what will appear. Staff see their own, including what a lead
 * approved for them (S23 log). Each card reads its live state and approves exactly what it
 * shows. On the kit (S41): flat sections; a proposal's card is raised, a receipt's is flat.
 */
export function AiActivity({
  section,
  proposals,
  actions,
  timeZone,
}: {
  section: 'needs' | 'done';
  proposals: AiProposalView[];
  actions: AiActionView[];
  timeZone: string;
}) {
  const router = useRouter();
  const headingId = useId();
  const toChat = () => {
    router.push(ROUTES.chat);
  };
  if (section === 'needs') {
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="m-0 type-heading">
          Needs your OK
        </h2>
        {proposals.length === 0 ? (
          <EmptyState
            title="Nothing waiting."
            text="When I need your OK before I change something or message a client, it shows here."
          />
        ) : (
          proposals.map((proposal) => (
            <LiveChangeCard
              key={proposal.id}
              card={snapshotOfProposal(proposal)}
              timeZone={timeZone}
              onPickSlot={toChat}
            />
          ))
        )}
      </section>
    );
  }
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 type-heading">
        Done for you
      </h2>
      {actions.length === 0 ? (
        <EmptyState
          title="Nothing done yet."
          text="What I do for you, like bookings and to-dos, lands here with an Undo."
        />
      ) : (
        actions
          .slice(0, SHOWN)
          .map((action) => (
            <LiveChangeCard
              key={action.id}
              card={snapshotOfAction(action)}
              timeZone={timeZone}
              onPickSlot={toChat}
            />
          ))
      )}
      <Link
        href={ROUTES.autonomy}
        className={cx(buttonStyle({ variant: 'quiet', size: 'sm' }), '-ml-4 self-start')}
      >
        Change what I do on my own
      </Link>
    </section>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <p className="m-0 rounded-lg bg-surface-2 px-5 py-4 type-body text-ink-2">
      <strong className="text-ink">{title}</strong> {text}
    </p>
  );
}

export function snapshotOfProposal(
  proposal: AiProposalView,
): Extract<ToolCard, { kind: 'change' }> {
  return {
    kind: 'change',
    tool: proposal.tool,
    action: proposal.action,
    state: 'proposed',
    proposalId: proposal.id,
    fingerprint: proposal.fingerprint,
    executionId: null,
    undoUntil: null,
    before: proposal.before,
    after: proposal.after,
    emails: proposal.emails,
    summary: proposal.summary,
  };
}

function snapshotOfAction(action: AiActionView): Extract<ToolCard, { kind: 'change' }> {
  return {
    kind: 'change',
    tool: action.tool,
    action: action.action,
    state: 'done',
    proposalId: action.proposalId,
    fingerprint: null,
    executionId: action.id,
    undoUntil: action.undoUntil,
    before: action.before,
    after: action.after,
    emails: action.emails.map(({ template, clientId }) => ({ template, clientId })),
    ...(action.summary !== null && { summary: action.summary }),
  };
}
