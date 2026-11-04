'use client';

import {
  AiActionViewSchema,
  AiProposalViewSchema,
  ApproveProposalResponseSchema,
  type AiActionView,
  type AiProposalView,
  type LocalSlot,
  type ToolCard,
} from '@pepper/contracts';
import {
  ChangeCard,
  DraftEditor,
  SlotPicker,
  whyModel,
  type ChangeCardProps,
  type DraftWords,
} from '@pepper/ui';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ROUTES } from '../../../lib/account';
import { fetchJson, sendJson } from '../../../lib/client-api';
import { undoAction } from './undo-action';
import { WhySheet } from './why-sheet';

type ChangeSnapshot = Extract<ToolCard, { kind: 'change' }>;

type Live =
  | { kind: 'snapshot' }
  | { kind: 'proposal'; proposal: AiProposalView }
  | { kind: 'action'; action: AiActionView };

/** What approving came to, for a plan's "Approve all" (it stops at anything but `executed`). */
export type ApproveOutcome = 'executed' | 'other';

/**
 * A change card in the chat, kept true to the trust layer's record (S26, ADR-0031). A streamed
 * or stored card is a snapshot; this re-reads the proposal or receipt by its id, so a card in
 * history never offers Approve for something already decided. Approve sends the proposal's id
 * and the fingerprint of exactly what this card shows, nothing else; a stale one is replaced by
 * the fresh proposal, and nothing runs.
 */
export function LiveChangeCard({
  card,
  timeZone,
  onPickSlot,
  register,
}: {
  card: ChangeSnapshot;
  timeZone: string;
  /** A refused approval's nearest free times: picking one asks Pepper again. */
  onPickSlot: (slot: LocalSlot) => void;
  /** Lets a plan approve this card exactly as shown (`null` when it needs no OK). */
  register?: (approve: (() => Promise<ApproveOutcome>) | null) => void;
}) {
  const [live, setLive] = useState<Live>({ kind: 'snapshot' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [slots, setSlots] = useState<LocalSlot[] | null>(null);
  const [picked, setPicked] = useState<LocalSlot | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const whyButton = useRef<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadAction = useCallback(async (id: string): Promise<void> => {
    const answer = await fetchJson(`/v1/ai/actions/${id}`, AiActionViewSchema);
    if (answer.ok) setLive({ kind: 'action', action: answer.data });
  }, []);

  const loadProposal = useCallback(
    async (id: string): Promise<void> => {
      const answer = await fetchJson(`/v1/ai/proposals/${id}`, AiProposalViewSchema);
      if (!answer.ok) return;
      if (answer.data.status === 'approved' && answer.data.executionId !== null) {
        await loadAction(answer.data.executionId);
        return;
      }
      setLive({ kind: 'proposal', proposal: answer.data });
    },
    [loadAction],
  );

  useEffect(() => {
    if (card.executionId !== null) void loadAction(card.executionId);
    else if (card.proposalId !== null) void loadProposal(card.proposalId);
    // Undo windows and email times read against the clock.
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 30_000);
    return () => {
      clearInterval(timer);
    };
  }, [card.executionId, card.proposalId, loadAction, loadProposal]);

  const shown = shownProposal(card, live);

  const approve = useCallback(async (): Promise<ApproveOutcome> => {
    if (shown === null) return 'other';
    setBusy(true);
    const answer = await sendJson('POST', `/v1/ai/proposals/${shown.id}/approve`, {
      fingerprint: shown.fingerprint,
    });
    setBusy(false);
    if (!answer.ok) {
      setNotice(answer.message);
      await loadProposal(shown.id);
      return 'other';
    }
    const result = ApproveProposalResponseSchema.safeParse(answer.data);
    if (!result.success) {
      setNotice('Something went wrong. Nothing was changed.');
      return 'other';
    }
    switch (result.data.kind) {
      case 'executed':
        setLive({ kind: 'action', action: result.data.action });
        setNotice('Done.');
        return 'executed';
      case 'stale':
        setLive({ kind: 'proposal', proposal: result.data.proposal });
        setNotice(
          'Something changed since I showed you this, so I didn’t do it. Here is the up-to-date version.',
        );
        return 'other';
      case 'refused':
        await loadProposal(shown.id);
        setNotice(result.data.message);
        if (result.data.card?.kind === 'slot_picker') setSlots(result.data.card.slots);
        return 'other';
      case 'expired':
        await loadProposal(shown.id);
        setNotice('This waited too long, or I was updated since, so it expired. Ask me again.');
        return 'other';
    }
  }, [shown, loadProposal]);

  useEffect(() => {
    const pending = shown !== null && (live.kind !== 'proposal' || live.proposal.canDecide);
    register?.(pending ? approve : null);
  }, [register, approve, shown, live]);

  async function reject(): Promise<void> {
    if (shown === null) return;
    setBusy(true);
    const answer = await sendJson('POST', `/v1/ai/proposals/${shown.id}/reject`, undefined);
    setBusy(false);
    const view = answer.ok ? AiProposalViewSchema.safeParse(answer.data) : null;
    if (view?.success === true) {
      setLive({ kind: 'proposal', proposal: view.data });
      setNotice('OK, I won’t do it.');
    } else {
      setNotice(answer.ok ? 'Something went wrong.' : answer.message);
    }
  }

  /** A nudge's new words (S36): the proposal is replaced, and the card shows the new one. */
  async function saveDraft(words: DraftWords): Promise<string | null> {
    if (live.kind !== 'proposal') return 'Something went wrong.';
    const answer = await sendJson('POST', `/v1/ai/proposals/${live.proposal.id}/draft`, {
      fingerprint: live.proposal.fingerprint,
      ...words,
    });
    if (!answer.ok) return answer.message;
    const view = AiProposalViewSchema.safeParse(answer.data);
    if (!view.success) return 'Something went wrong.';
    setLive({ kind: 'proposal', proposal: view.data });
    setNotice(
      view.data.id === live.proposal.id
        ? 'This changed since you opened it. Here is the up-to-date version.'
        : 'Saved. Approve sends these words.',
    );
    return null;
  }

  async function undo(): Promise<void> {
    const id = live.kind === 'action' ? live.action.id : card.executionId;
    if (id === null) return;
    setBusy(true);
    const result = await undoAction(id);
    setBusy(false);
    if (!result.ok) {
      setNotice(result.message);
      await loadAction(id);
      return;
    }
    setLive({ kind: 'action', action: result.action });
    setNotice(result.notice);
  }

  const props = cardProps(card, live, timeZone, now);
  const why =
    live.kind === 'proposal'
      ? whyModel(live.proposal.why, live.proposal.action, live.proposal.emails.length)
      : live.kind === 'action'
        ? whyModel(live.action.why, live.action.action, live.action.emails.length)
        : null;
  return (
    <div className="flex flex-col gap-3">
      <ChangeCard
        {...props}
        busy={busy}
        notice={notice}
        onApprove={() => void approve()}
        onReject={() => void reject()}
        onUndo={() => void undo()}
        {...(why !== null && {
          onWhy: () => {
            // The button pressed, so focus returns to it when the sheet closes.
            whyButton.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setWhyOpen(true);
          },
        })}
        settingsLink={
          <Link href={ROUTES.autonomy} className="font-semibold text-brand underline">
            Change this
          </Link>
        }
      />
      {live.kind === 'proposal' && live.proposal.draft !== undefined ? (
        <DraftEditor
          // A new proposal (after an edit) starts the editor afresh.
          key={live.proposal.id}
          draft={live.proposal.draft}
          canEdit={live.proposal.status === 'pending' && live.proposal.canDecide}
          onSave={saveDraft}
        />
      ) : null}
      {slots === null ? null : (
        <SlotPicker
          slots={slots}
          picked={picked}
          onPick={(slot) => {
            setPicked(slot);
            onPickSlot(slot);
          }}
        />
      )}
      {why === null ? null : (
        <WhySheet
          open={whyOpen}
          onOpenChange={setWhyOpen}
          why={why}
          proposed={props.status === 'proposed'}
          returnFocus={() => whyButton.current}
        />
      )}
    </div>
  );
}

/** The proposal this card shows, with the fingerprint it was shown with, if one is waiting. */
function shownProposal(
  card: ChangeSnapshot,
  live: Live,
): { id: string; fingerprint: string } | null {
  if (live.kind === 'proposal') {
    return live.proposal.status === 'pending'
      ? { id: live.proposal.id, fingerprint: live.proposal.fingerprint }
      : null;
  }
  if (
    live.kind === 'snapshot' &&
    card.state === 'proposed' &&
    card.proposalId !== null &&
    card.fingerprint !== null
  ) {
    return { id: card.proposalId, fingerprint: card.fingerprint };
  }
  return null;
}

function cardProps(
  card: ChangeSnapshot,
  live: Live,
  timeZone: string,
  now: number,
): Omit<ChangeCardProps, 'busy' | 'notice'> {
  const common = { timeZone, now };
  if (live.kind === 'proposal') {
    const { proposal } = live;
    return {
      ...common,
      action: proposal.action,
      status:
        proposal.status === 'pending'
          ? 'proposed'
          : proposal.status === 'approved'
            ? 'done'
            : proposal.status,
      summary: proposal.summary,
      before: proposal.before,
      after: proposal.after,
      emails: proposal.emails,
      recipients: proposal.recipients ?? [],
      undoUntil: null,
      canDecide: proposal.canDecide,
      canUndo: false,
      memory: proposal.memory ?? null,
    };
  }
  if (live.kind === 'action') {
    const { action } = live;
    return {
      ...common,
      action: action.action,
      status: action.status,
      summary: action.summary,
      before: action.before,
      after: action.after,
      emails: action.emails,
      recipients: action.recipients ?? [],
      undoUntil: action.undoUntil,
      canDecide: false,
      canUndo: action.canUndo,
      approvedByName: action.approvedByName,
      memory: action.memory ?? null,
    };
  }
  return {
    ...common,
    action: card.action,
    status: card.state === 'proposed' ? 'proposed' : 'done',
    summary: card.summary ?? null,
    before: card.before,
    after: card.after,
    emails: card.emails,
    undoUntil: card.undoUntil,
    // Until the record is read, the trust layer still decides who may act on it.
    canDecide: card.state === 'proposed',
    canUndo: card.state === 'done',
  };
}
