'use client';

import { BookingSchema, type AvailableSlot } from '@pepper/contracts';
import { Button, DetailTable, Sheet, SheetFooter } from '@pepper/ui';
import { useState } from 'react';
import { dateTimeLabel, timeLabel } from '../../../lib/booking';
import { DROP_PROBLEM_WORDS, type DropProblem } from '../../../lib/calendar-week';
import { sendJson, type CallResult } from '../../../lib/client-api';
import { NotifyClient } from '../booking/notify-client';
import { alternativesOf, Refusal } from '../booking/refusal';
import { Notice } from '../form-parts';

/** A move the week view asks about: a drop on a new time, or Undo of the last one. */
export interface PendingMove {
  kind: 'move' | 'undo';
  bookingId: string;
  client: string;
  service: string;
  /** Where the booking is now. */
  from: { startsAt: string; endsAt: string; staffMemberId: string };
  /** Where it would go. */
  to: { startsAt: string; endsAt: string; staffMemberId: string };
  /** What the drag saw there (a hint; the api decides). */
  problem: DropProblem | null;
  /** The nearest free times of a refusal, when one came before the sheet opened. */
  refused?: AvailableSlot[] | undefined;
}

/** A move the api made: where the booking went, and whether the client was emailed. */
export interface MadeMove {
  move: PendingMove;
  startsAt: string;
  staffMemberId: string;
  notified: boolean;
}

/**
 * Sends a move through `PATCH /v1/bookings/:id`, as the booking sheet's Move does, and never
 * with an override (AC-X-149): the api checks availability and double bookings. A refused time
 * answers with the nearest free ones.
 */
export async function sendMove(
  bookingId: string,
  body: { startsAt: string; staffMemberId: string; notifyClient: boolean },
): Promise<{ ok: true } | { ok: false; refused: AvailableSlot[] | null; message: string }> {
  const answer: CallResult<unknown> = await sendJson(
    'PATCH',
    `/v1/bookings/${encodeURIComponent(bookingId)}`,
    body,
  );
  if (answer.ok && BookingSchema.safeParse(answer.data).success) return { ok: true };
  const refused = alternativesOf(answer);
  return { ok: false, refused, message: answer.ok ? 'Something went wrong.' : answer.message };
}

/**
 * The sheet a drop (or Undo) opens (AC-X-148, AC-X-150): the old and new time, "Email the
 * client" ticked, and Move or keep it where it was. Keeping it changes nothing and sends
 * nothing; a refused time shows the nearest free ones to pick.
 */
export function MoveConfirm({
  pending,
  timeZone,
  staffName,
  onClose,
  onMoved,
}: {
  pending: PendingMove | null;
  timeZone: string;
  staffName: (staffMemberId: string) => string;
  onClose: () => void;
  onMoved: (made: MadeMove) => void;
}) {
  return (
    <Sheet
      title={
        pending === null
          ? 'Move'
          : pending.kind === 'undo'
            ? `Move ${pending.client} back?`
            : `Move ${pending.client}?`
      }
      description={
        pending === null
          ? undefined
          : `${pending.service} with ${staffName(pending.to.staffMemberId)}`
      }
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {pending === null ? null : (
        <MoveConfirmBody
          // A fresh form for every drop: its tick and answer start over.
          key={`${pending.bookingId}-${pending.kind}-${pending.to.startsAt}`}
          pending={pending}
          timeZone={timeZone}
          onClose={onClose}
          onMoved={onMoved}
        />
      )}
    </Sheet>
  );
}

function MoveConfirmBody({
  pending,
  timeZone,
  onClose,
  onMoved,
}: {
  pending: PendingMove;
  timeZone: string;
  onClose: () => void;
  onMoved: (made: MadeMove) => void;
}) {
  const [notifyClient, setNotifyClient] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<AvailableSlot[] | null>(pending.refused ?? null);

  async function move(startsAt: string, staffMemberId: string): Promise<void> {
    setBusy(true);
    setError(null);
    const answer = await sendMove(pending.bookingId, { startsAt, staffMemberId, notifyClient });
    setBusy(false);
    if (answer.ok) {
      onMoved({ move: pending, startsAt, staffMemberId, notified: notifyClient });
      return;
    }
    setRefused(answer.refused);
    setError(answer.refused === null ? answer.message : null);
  }

  const span = (at: { startsAt: string; endsAt: string }) => (
    <span className="tabular-nums">
      {dateTimeLabel(timeZone, at.startsAt)} – {timeLabel(timeZone, at.endsAt)}
    </span>
  );
  return (
    <div className="grid gap-4" data-testid="move-confirm">
      <DetailTable
        rows={[
          { label: 'Now', value: span(pending.from) },
          {
            label: pending.kind === 'undo' ? 'Back to' : 'New time',
            value: <span data-testid="move-to">{span(pending.to)}</span>,
          },
        ]}
      />
      {pending.problem === null || refused !== null ? null : (
        <p className="m-0 rounded-md bg-warn-soft px-4 py-3 type-label text-warn">
          {DROP_PROBLEM_WORDS[pending.problem]}, it looks like. I check before moving anything.
        </p>
      )}
      <NotifyClient checked={notifyClient} onChange={setNotifyClient}>
        {pending.kind === 'undo'
          ? 'Email the client the original time'
          : 'Email the client the new time'}
      </NotifyClient>
      {refused === null ? null : (
        <Refusal
          timeZone={timeZone}
          alternatives={refused}
          busy={busy}
          onPick={(slot) => void move(slot.startsAt, slot.staffMemberId)}
        />
      )}
      <SheetFooter>
        {error === null ? null : <Notice tone="error">{error}</Notice>}
        {refused === null ? (
          <Button
            block
            size="lg"
            busy={busy}
            onClick={() => void move(pending.to.startsAt, pending.to.staffMemberId)}
          >
            {busy ? 'Moving…' : pending.kind === 'undo' ? 'Move back' : 'Move'}
          </Button>
        ) : null}
        <Button block variant="quiet" onClick={onClose}>
          {pending.kind === 'undo' ? 'Leave it' : 'Keep it where it was'}
        </Button>
      </SheetFooter>
    </div>
  );
}
