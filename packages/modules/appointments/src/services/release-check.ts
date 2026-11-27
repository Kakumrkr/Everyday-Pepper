import { BookingIdSchema, RELEASE_ANSWER_HOURS, type ReminderSettings } from '@pepper/contracts';
import { withdrawPendingProposal } from '@pepper/core';
import {
  findBooking,
  findPendingProposalFor,
  listPendingProposals,
  lockPendingProposalFor,
  type BookingRow,
  type TenantTx,
} from '@pepper/db';

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
  | 'held_back'
  | 'not_asked'
  | 'asked_late'
  | 'before_cutoff'
  | 'started'
  | 'moved';

/**
 * Whether the visit may be released at `now` (ms), from its row and the business's settings
 * (D-2): the business asks clients to confirm; the visit is booked, not started and unconfirmed;
 * while the holdback is on, it didn't keep the visit from its early ask (S78.3, AC-X-215:
 * whatever asked it since, so the held-back visits stay a fair comparison; turned off, every
 * visit is treated alike again); its client was asked at least
 * `RELEASE_ANSWER_HOURS` before the business's cut-off (S78.3, AC-X-218); the cut-off has come.
 * `shownStartsAt` (ms): the time the card showed, which must still be the visit's.
 */
export function releaseCheck(
  row: Pick<
    BookingRow,
    'status' | 'startsAt' | 'clientConfirmedAt' | 'confirmAskedAt' | 'confirmHeldBackAt'
  >,
  settings: Pick<ReminderSettings, 'askToConfirm' | 'confirmCutoffHours' | 'holdback'>,
  now: number,
  shownStartsAt?: number,
): ReleaseCheck {
  const startsAt = row.startsAt.getTime();
  if (!settings.askToConfirm) return 'not_asking';
  if (row.status !== 'confirmed') return 'not_booked';
  if (shownStartsAt !== undefined && shownStartsAt !== startsAt) return 'moved';
  if (startsAt <= now) return 'started';
  if (row.clientConfirmedAt !== null) return 'confirmed';
  if (settings.holdback && row.confirmHeldBackAt !== null) return 'held_back';
  if (row.confirmAskedAt === null) return 'not_asked';
  const cutoff = startsAt - settings.confirmCutoffHours * HOUR_MS;
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

/**
 * Waits for and locks the visit's release card, if one waits (S78.2 review): a confirm calls it
 * before it locks the booking, the order an approval takes them (the card, then the booking), so
 * a confirm and an approval never interleave. An approval's dry run releases the booking's lock
 * when its savepoint rolls back; without this, a confirm landing in that gap left a card behind.
 */
export async function lockReleaseCard(tx: TenantTx, bookingId: string): Promise<void> {
  await lockPendingProposalFor(tx, releaseTargetKey(bookingId));
}

/**
 * Release cards looked over at a time: a card waits only between a visit's cut-off and its
 * start (48 h at most), so a business has far fewer waiting than this.
 */
const WITHDRAW_PAGE = 500;

/**
 * Takes every waiting release card away (S78.2 review): the business stopped asking clients to
 * confirm, so none of them could be approved any more. Returns how many went.
 */
export async function withdrawReleaseCards(tx: TenantTx, now: number): Promise<number> {
  const at = new Date(now);
  let withdrawn = 0;
  // Only the release cards (S78.3 review: other proposals no longer crowd them out of a page),
  // a page at a time while each page took some away.
  for (;;) {
    const page = await listPendingProposals(tx, at, WITHDRAW_PAGE, 'booking.release');
    let taken = 0;
    for (const proposal of page) {
      if (await withdrawPendingProposal(tx, proposal.targetKey, at)) taken += 1;
    }
    withdrawn += taken;
    if (page.length < WITHDRAW_PAGE || taken === 0) return withdrawn;
  }
}

/**
 * Takes away the waiting release cards that no longer fit the business's new cut-off (S78.3,
 * AC-X-218): a card shown at the old cut-off for a visit not yet at the new one, or whose ask no
 * longer came early enough. The re-planned release check brings a card back at the new cut-off.
 * Returns how many went.
 */
export async function withdrawUnfitReleaseCards(
  tx: TenantTx,
  settings: Pick<ReminderSettings, 'askToConfirm' | 'confirmCutoffHours' | 'holdback'>,
  now: number,
): Promise<number> {
  const at = new Date(now);
  let withdrawn = 0;
  for (const proposal of await listPendingProposals(tx, at, WITHDRAW_PAGE, 'booking.release')) {
    const payload = proposal.payload as { bookingId?: unknown; startsAt?: unknown } | null;
    const id = BookingIdSchema.safeParse(payload?.bookingId);
    // A card whose visit can't be read no longer fits either.
    const row = id.success ? await findBooking(tx, id.data) : undefined;
    const shown = typeof payload?.startsAt === 'string' ? Date.parse(payload.startsAt) : NaN;
    if (row !== undefined && releaseCheck(row, settings, now, shown) === 'ok') continue;
    if (await withdrawPendingProposal(tx, proposal.targetKey, at)) withdrawn += 1;
  }
  return withdrawn;
}
