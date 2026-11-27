import {
  getBookingIn,
  releaseTargetKey,
  releaseUnconfirmedBookingIn,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  UtcDateTimeSchema,
  visitRiskFactValue,
  type ChangeSide,
  type VisitRiskReason,
} from '@pepper/contracts';
import { UndoRefusedError } from '@pepper/core';
import { listVisitRisks } from '@pepper/db';
import { settleDepositOnCancelIn } from '@pepper/payments';
import { z } from 'zod';
import type { Performed, WriteTool } from '../tool.js';
import { bookingSide, bookingView, clientNames, directoryOf, domainOptions } from './shared.js';

// The release card (S78.2, ADR-0071 §S78.2; AC-X-207…213): a visit still unconfirmed at the
// confirm cut-off, after the client was asked, is released on the owner's tap: cancelled as the
// business's cancel, the client emailed kindly, a paid deposit refunded in full, and the freed
// time handed to the fill loop. The reminder job proposes it at the cut-off; it is never offered
// to the model, and its dial action `booking.release` asks in every preset. Nothing takes it
// back: the email and the refund leave Pepper (no inverse).

const ReleaseArgs = z.strictObject({
  bookingId: z.uuid(),
  /** The visit's start the card shows: a visit moved since is never released. */
  startsAt: UtcDateTimeSchema,
});
type ReleaseArgs = z.output<typeof ReleaseArgs>;

/** "Tue, Dec 1, 2:00 pm" in the business's zone. */
function visitWords(startsAt: string, timeZone: string): string {
  const instant = new Date(startsAt);
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(instant);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(instant)
    .replace('AM', 'am')
    .replace('PM', 'pm');
  return `${date}, ${time}`;
}

/** The visit's top risk reason (S77), flat for the card's side (AC-X-213); none without one. */
function topReasonSide(reason: VisitRiskReason | undefined): ChangeSide {
  if (reason === undefined) return { riskSignal: null };
  switch (reason.signal) {
    case 'missed_before':
      return { riskSignal: reason.signal, riskMisses: reason.misses, riskVisits: reason.visits };
    case 'booked_far_ahead':
      return { riskSignal: reason.signal, riskDays: reason.days };
    case 'first_visit':
    case 'online_no_deposit':
    case 'not_confirmed':
      return { riskSignal: reason.signal };
  }
}

export const releaseUnconfirmedBooking: WriteTool = {
  kind: 'write',
  name: 'release_unconfirmed_booking',
  version: 1,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: 'Release a visit whose client didn’t confirm by the cut-off (the reminder job proposes it; never offered to the model).',
    avoid: ['for anything the member asks in the chat'],
    returns: 'the release waiting for the owner’s OK.',
    // Never offered to the model, so never read: they only satisfy the guide's shape.
    examples: [
      { say: 'Ana didn’t confirm', args: { bookingId: { $any: true } } },
      { say: 'Release the unconfirmed 2 pm', args: { bookingId: { $any: true } } },
    ],
  },
  args: ReleaseArgs,
  actions: () => ['booking.release'],
  async perform(scope, raw): Promise<Performed> {
    const args: ReleaseArgs = ReleaseArgs.parse(raw);
    const id = BookingIdSchema.parse(args.bookingId);
    const before = await getBookingIn(scope.tx, scope.actor, id);
    const [risk] = await listVisitRisks(scope.tx, [id]);
    let refundsDeposit = false;
    const released = await releaseUnconfirmedBookingIn(
      scope.tx,
      scope.actor,
      { bookingId: id, startsAt: args.startsAt },
      {
        ...domainOptions(scope),
        notify: scope.notifyClient(before.clientId),
        // The business released it: a paid deposit is refunded in full (AC-X-209).
        onCancelled: async (tx, booking) => {
          const settled = await settleDepositOnCancelIn(tx, {
            ...booking,
            by: 'business',
            now: scope.now,
            outboxKey: scope.deps.emails.outboxKey,
          });
          refundsDeposit = settled === 'refund_pending';
        },
      },
    );
    const directory = await directoryOf(scope);
    const names = await clientNames(scope, [before.clientId]);
    const was = bookingView(scope, directory, names, before);
    const now = bookingView(scope, directory, names, released);
    const slot = visitWords(before.startsAt, scope.timeZone);
    return {
      entity: { type: 'booking', id },
      targetKey: releaseTargetKey(id),
      // Owners and managers decide, whoever's visit it is.
      recordOwner: null,
      appointmentStartsAt: new Date(before.startsAt),
      before: bookingSide(was, { withId: true }),
      after: {
        ...bookingSide(now, { withId: true }),
        release: true,
        refund: refundsDeposit,
        ...topReasonSide(risk?.reasons[0]),
      },
      touched: {
        bookingUpdatedAt: before.updatedAt,
        startsAt: before.startsAt,
        refund: refundsDeposit,
      },
      inverse: null,
      summary: `${was.clientName} hasn’t confirmed ${slot}. Release it and offer it?`,
      facts: [
        { kind: 'not_started', ref: null, value: { date: was.date, time: was.time } },
        ...(risk === undefined
          ? []
          : [{ kind: 'visit_risk' as const, ref: null, value: visitRiskFactValue(risk) }]),
      ],
      // A client's own name came from outside the team (the booking page).
      untrustedText: true,
    };
  },
  undo() {
    // The release email and the refund have left Pepper (D-5): the card said so.
    return Promise.reject(new UndoRefusedError('not_possible'));
  },
};
