'use client';

import type { AiActionView, AiProposalView, ToolCard } from '@pepper/contracts';
import { LegacyCard } from '@pepper/ui';
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
 * shows.
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
      <LegacyCard labelledBy={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="m-0 text-lg font-bold">
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
      </LegacyCard>
    );
  }
  return (
    <LegacyCard labelledBy={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="m-0 text-lg font-bold">
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
      <p className="m-0 text-sm">
        <Link href={ROUTES.autonomy} className="font-semibold text-brand underline">
          Change what I do on my own
        </Link>
      </p>
    </LegacyCard>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <p className="m-0 rounded-md bg-surface-2 p-3 text-sm text-ink-2">
      <strong className="text-ink">{title}</strong> {text}
    </p>
  );
}

function snapshotOfProposal(proposal: AiProposalView): Extract<ToolCard, { kind: 'change' }> {
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
