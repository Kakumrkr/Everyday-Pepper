import {
  CONFIRM_CUTOFF_HOURS,
  RELEASE_ANSWER_HOURS,
  type ReminderSettings,
} from '@pepper/contracts';
import { withdrawPendingProposal } from '@pepper/core';
import { findPendingProposalFor, type BookingRow, type TenantTx } from '@pepper/db';

// The release card (S78.2, ADR-0071 §S78.2; AC-X-207…210): while the business asks clients to
// confirm, a visit asked early enough and still unconfirmed at the cut-off gets one owner card,
// "Release it and offer it?". Approving it cancels the visit as the business's cancel (never the
// client's miss), emails the client kindly, refunds a paid deposit in full (the caller's
// `onCancelled`) and frees the time for the fill loop. A confirm, a move or a cancel takes the
// card away. The model plays no part: these are domain rules with named constants.

const HOUR_MS = 3_600_000;

/** The trust layer's target for a visit's release card: one card per visit. */
export function releaseTargetKey(bookingId: string): string {
  return `release:booking:${bookingId}`;
}

/** Why a visit can or can't be released now. */
export type ReleaseCheck =
  | 'ok'
  | 'not_asking'
  | 'not_booked'
  | 'confirmed'
  | 'not_asked'
  | 'asked_late'
  | 'before_cutoff'
  | 'started'
  | 'moved';

/**
 * Whether the visit may be released at `now` (ms), from its row and the business's settings
 * (D-2): the business asks clients to confirm; the visit is booked, not started and unconfirmed;
 * its client was asked at least `RELEASE_ANSWER_HOURS` before the cut-off; the cut-off has come.
 * `shownStartsAt` (ms): the time the card showed, which must still be the visit's.
 */
export function releaseCheck(
  row: Pick<BookingRow, 'status' | 'startsAt' | 'clientConfirmedAt' | 'confirmAskedAt'>,
  settings: Pick<ReminderSettings, 'askToConfirm'>,
  now: number,
  shownStartsAt?: number,
): ReleaseCheck {
  const startsAt = row.startsAt.getTime();
  if (!settings.askToConfirm) return 'not_asking';
  if (row.status !== 'confirmed') return 'not_booked';
  if (shownStartsAt !== undefined && shownStartsAt !== startsAt) return 'moved';
  if (startsAt <= now) return 'started';
  if (row.clientConfirmedAt !== null) return 'confirmed';
  if (row.confirmAskedAt === null) return 'not_asked';
  const cutoff = startsAt - CONFIRM_CUTOFF_HOURS * HOUR_MS;
  if (row.confirmAskedAt.getTime() > cutoff - RELEASE_ANSWER_HOURS * HOUR_MS) return 'asked_late';
  if (now < cutoff) return 'before_cutoff';
  return 'ok';
}

/**
 * Takes the visit's release card away when it no longer fits (AC-X-210): the visit is no longer
 * booked, the client confirmed, or it moved off the card's time. Called by every booking write
 * (`keepReminderInStep`) and by both confirms; never waits on a card being approved this moment.
 */
export async function keepReleaseCardInStep(
  tx: TenantTx,
  row: Pick<BookingRow, 'id' | 'status' | 'startsAt' | 'clientConfirmedAt'>,
  now: number,
): Promise<void> {
  const target = releaseTargetKey(row.id);
  const pending = await findPendingProposalFor(tx, target);
  if (pending === undefined) return;
  const payload = pending.payload as { startsAt?: unknown } | null;
  const shown = typeof payload?.startsAt === 'string' ? Date.parse(payload.startsAt) : NaN;
  if (
    row.status === 'confirmed' &&
    row.clientConfirmedAt === null &&
    shown === row.startsAt.getTime()
  ) {
    return;
  }
  await withdrawPendingProposal(tx, target, new Date(now));
}
