'use client';

import type { AiActionView, AiProposalView, ToolCard } from '@pepper/contracts';
import { Card } from '@pepper/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId } from 'react';
import { ROUTES } from '../../../lib/account';
import { LiveChangeCard } from './live-change';

/** How many of the latest receipts Home shows. */
const SHOWN = 5;

/**
 * Pepper's work on Home (S26; the Phase 8 feed takes it over): what waits for the member's OK,
 * and "Done for you" with Undo and Why?. Staff see their own, including what a lead approved
 * for them (S23 log). Each card reads its live state and approves exactly what it shows.
 */
export function AiActivity({
  proposals,
  actions,
  timeZone,
}: {
  proposals: AiProposalView[];
  actions: AiActionView[];
  timeZone: string;
}) {
  const router = useRouter();
  const needsId = useId();
  const doneId = useId();
  const toChat = () => {
    router.push(ROUTES.chat);
  };
  if (proposals.length === 0 && actions.length === 0) return null;
  return (
    <div className="flex flex-col gap-6">
      {proposals.length === 0 ? null : (
        <Card labelledBy={needsId} className="flex flex-col gap-3">
          <h2 id={needsId} className="m-0 text-lg font-bold">
            Needs your OK
          </h2>
          {proposals.map((proposal) => (
            <LiveChangeCard
              key={proposal.id}
              card={snapshotOfProposal(proposal)}
              timeZone={timeZone}
              onPickSlot={toChat}
            />
          ))}
        </Card>
      )}
      {actions.length === 0 ? null : (
        <Card labelledBy={doneId} className="flex flex-col gap-3">
          <h2 id={doneId} className="m-0 text-lg font-bold">
            Done for you
          </h2>
          {actions.slice(0, SHOWN).map((action) => (
            <LiveChangeCard
              key={action.id}
              card={snapshotOfAction(action)}
              timeZone={timeZone}
              onPickSlot={toChat}
            />
          ))}
          <p className="m-0 text-sm">
            <Link href={ROUTES.autonomy} className="font-semibold text-brand underline">
              Change what I do on my own
            </Link>
          </p>
        </Card>
      )}
    </div>
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
