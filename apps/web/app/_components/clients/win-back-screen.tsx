'use client';

import {
  AiProposalViewSchema,
  WinBackDraftResultSchema,
  type AiProposalView,
  type WinBackClient,
  type WinBackResponse,
} from '@pepper/contracts';
import { Avatar, Button, EmptyState, List, MoneyChip, Skeleton } from '@pepper/ui';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ROUTES } from '../../../lib/account';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { IMPORT_PATH } from '../../../lib/imports';
import {
  ahaSentence,
  blockedReason,
  MAILING_ADDRESS_PATH,
  refusalText,
  rowMeta,
} from '../../../lib/win-back';
import { LiveChangeCard } from '../chat/live-change';
import { snapshotOfProposal } from '../chat/ai-activity';
import { kitLink } from '../kit-link';

/**
 * "Haven't been back" (S54.2, ADR-0057): the clients past their usual gap, the most recently
 * due first, each with what they're worth and "Draft email". A draft opens in place as the
 * usual approval card (the same one Home shows under "Needs your OK"), so one more tap sends it.
 */
export function WinBackScreen({
  initial,
  timeZone,
}: {
  /** `null` when it couldn't load. */
  initial: WinBackResponse | null;
  timeZone: string;
}) {
  const sentence = initial === null ? null : ahaSentence(initial);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link href={ROUTES.clients} className="type-label text-ink-2 no-underline hover:underline">
          ← Clients
        </Link>
        <h1 className="m-0 type-display">Haven’t been back</h1>
        <p className="m-0 type-body text-ink-2" data-testid="win-back-summary">
          {sentence === null
            ? 'Regulars who stop coming, so you can win them back.'
            : `${sentence}. One tap drafts an email with their next open time.`}
        </p>
      </header>
      {initial === null ? (
        <p role="alert" className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          I couldn’t load this list. Try again in a moment.
        </p>
      ) : initial.count === 0 ? (
        <EmptyState
          icon="clients"
          title="No one is overdue"
          body="After 2 visits, a client who stops coming shows here. Bring in your past visits and I’ll find them now."
          action={{ label: 'Import past visits', href: IMPORT_PATH, renderLink: kitLink }}
        />
      ) : (
        <>
          {initial.mailingAddressSet ? null : (
            <p className="m-0 rounded-md bg-warn-soft px-4 py-3 type-body text-ink">
              Every email like this carries your mailing address.{' '}
              <Link href={MAILING_ADDRESS_PATH} className="font-semibold text-ink">
                Add it in More
              </Link>{' '}
              and I can write to them.
            </p>
          )}
          <List label="Clients who haven’t been back" className="rounded-lg bg-surface px-4">
            {initial.clients.map((client) => (
              <WinBackRow
                key={client.clientId}
                client={client}
                timeZone={timeZone}
                mailingAddressSet={initial.mailingAddressSet}
              />
            ))}
          </List>
          {initial.count > initial.clients.length ? (
            <p className="m-0 type-caption text-ink-2 tabular-nums">
              Showing the {String(initial.clients.length)} most recently due of{' '}
              {String(initial.count)}.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function WinBackRow({
  client,
  timeZone,
  mailingAddressSet,
}: {
  client: WinBackClient;
  timeZone: string;
  mailingAddressSet: boolean;
}) {
  const [proposalId, setProposalId] = useState(client.pendingProposalId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const blocked = blockedReason(client, timeZone, mailingAddressSet);

  async function draft() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const answer = await sendJson('POST', `/v1/win-back/${client.clientId}/draft`, undefined);
    setBusy(false);
    if (!answer.ok) {
      setProblem(answer.message);
      return;
    }
    const result = WinBackDraftResultSchema.safeParse(answer.data);
    if (!result.success) {
      setProblem('Something went wrong. Try again.');
      return;
    }
    if (result.data.kind === 'drafted') setProposalId(result.data.proposalId);
    else setProblem(refusalText(result.data.reason));
  }

  return (
    <li className="flex flex-col gap-3 py-3" data-testid="win-back-row">
      <div className="flex min-h-14 items-center gap-3">
        <Avatar name={client.name} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            href={`${ROUTES.clients}/${client.clientId}`}
            className="truncate type-body font-semibold text-ink no-underline hover:underline"
          >
            {client.name}
          </Link>
          <span className="type-caption text-ink-2 tabular-nums" data-testid="win-back-meta">
            {rowMeta(client, timeZone)}
          </span>
        </span>
        {client.valueCents === null ? null : (
          <MoneyChip cents={client.valueCents} kind="estimate" className="shrink-0" />
        )}
      </div>
      {proposalId !== null ? (
        <DraftCard proposalId={proposalId} timeZone={timeZone} />
      ) : blocked !== null ? (
        <p className="m-0 type-caption text-ink-2" data-testid="win-back-blocked">
          {blocked}
        </p>
      ) : (
        <div className="flex flex-col items-start gap-2">
          <Button variant="secondary" size="sm" busy={busy} onClick={() => void draft()}>
            Draft email
          </Button>
          {problem === null ? null : (
            <p role="status" className="m-0 type-body text-ink-2">
              {problem}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

/** The drafted email as the approval card, read from the trust layer by its id. */
function DraftCard({ proposalId, timeZone }: { proposalId: string; timeZone: string }) {
  const [proposal, setProposal] = useState<AiProposalView | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    void fetchJson(`/v1/ai/proposals/${proposalId}`, AiProposalViewSchema).then((answer) => {
      if (live) setProposal(answer.ok ? answer.data : 'failed');
    });
    return () => {
      live = false;
    };
  }, [proposalId]);
  if (proposal === null) return <Skeleton className="h-40" />;
  if (proposal === 'failed') {
    return (
      <p className="m-0 type-body text-ink-2">
        The draft waits on{' '}
        <Link href={ROUTES.home} className="font-semibold text-ink">
          Home
        </Link>
        .
      </p>
    );
  }
  return (
    <LiveChangeCard
      card={snapshotOfProposal(proposal)}
      timeZone={timeZone}
      // A nudge's time taken meanwhile: the next morning (or another tap) finds a new one.
      onPickSlot={() => undefined}
    />
  );
}
