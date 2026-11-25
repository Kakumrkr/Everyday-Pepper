import { getBookingIn } from '@pepper/appointments';
import {
  BookingIdSchema,
  moneyWords,
  noShowFeeChoiceLine,
  type TrustJson,
} from '@pepper/contracts';
import { UndoRefusedError } from '@pepper/core';
import {
  approveNoShowFeeIn,
  NoShowFeeBusyError,
  NoShowFeeNotChargeableError,
  noShowFeeOfferIn,
  undoNoShowFeeIn,
} from '@pepper/payments';
import { z } from 'zod';
import type { Performed, WriteTool } from '../tool.js';
import { bookingView, clientNames, directoryOf } from './shared.js';

// The no-show fee (S68, ADR-0068 amendment; AC-X-137…141): charges the card a client kept with a
// booking-page booking the fee their stored terms allow, less a kept deposit, on the owner's OK.
// A no-show proposes it (`proposeNoShowFeeIn`); it is never offered to the model, its dial action
// `payment.no_show_fee` always asks and only owners may approve it. Running it records the fee
// and queues one charge after a grace (no Stripe call here); Undo cancels it while it waits and
// refunds it once taken.

const FeeArgs = z.strictObject({
  bookingId: z.uuid(),
  /** The amount the card shows: approving charges exactly this, or nothing. */
  chargeCents: z.number().int().min(50).max(10_000_000),
});
type FeeArgs = z.output<typeof FeeArgs>;

/** The card's side holds strings up to 200 characters; a longer sentence is cut, never dropped. */
function shortText(value: string): string {
  return value.length <= 200 ? value : `${value.slice(0, 199)}…`;
}

export const chargeNoShowFee: WriteTool = {
  kind: 'write',
  name: 'charge_no_show_fee',
  version: 1,
  localTimes: false,
  tier: 'external_or_irreversible',
  guide: {
    use: 'Charge a no-show the fee their cancellation policy allows (a no-show proposes it; never offered to the model).',
    avoid: ['for anything the member asks in the chat'],
    returns: 'the fee waiting for the owner’s OK.',
    // Never offered to the model, so never read: they only satisfy the guide's shape.
    examples: [
      { say: 'Ana missed her visit', args: { bookingId: { $any: true } } },
      { say: 'Sara didn’t come in', args: { bookingId: { $any: true } } },
    ],
  },
  args: FeeArgs,
  actions: () => ['payment.no_show_fee'],
  async perform(scope, raw): Promise<Performed> {
    const args = FeeArgs.parse(raw);
    const id = BookingIdSchema.parse(args.bookingId);
    // Read first for the card's words: the approval reads the offer again in its own checks.
    const offer = await noShowFeeOfferIn(scope.tx, id);
    if (typeof offer === 'string') throw new NoShowFeeNotChargeableError(offer);
    const fee = await approveNoShowFeeIn(scope.tx, scope.actor, {
      bookingId: id,
      chargeCents: args.chargeCents,
      now: scope.now,
      outboxKey: scope.deps.emails.outboxKey,
    });
    const directory = await directoryOf(scope);
    const booking = await getBookingIn(scope.tx, scope.actor, id);
    const visit = bookingView(
      scope,
      directory,
      await clientNames(scope, [booking.clientId]),
      booking,
    );
    const amount = moneyWords(offer.chargeCents);
    return {
      entity: { type: 'booking', id },
      targetKey: `fee:booking:${id}`,
      // Money: owners decide, whoever's visit it was.
      recordOwner: null,
      appointmentStartsAt: null,
      before: null,
      after: {
        fee: 'no_show',
        clientName: visit.clientName,
        serviceName: visit.serviceName,
        staffName: visit.staffName,
        date: visit.date,
        time: visit.time,
        endTime: visit.endTime,
        amount,
        card: offer.cardKind === 'deposit' ? 'deposit_card' : 'card_on_file',
        keptDeposit: offer.keptDepositCents > 0 ? moneyWords(offer.keptDepositCents) : null,
        policy: shortText(offer.policySentence),
        choice: noShowFeeChoiceLine(offer),
      },
      touched: {
        bookingUpdatedAt: booking.updatedAt,
        chargeCents: offer.chargeCents,
        policy: offer.policySentence,
      },
      inverse: { bookingFeeId: fee.id } satisfies TrustJson,
      // The visit's day and time are the card's own rows, in the business's words.
      summary: `Charge ${visit.clientName}'s ${amount} no-show fee for the missed ${visit.serviceName.toLowerCase()} with ${visit.staffName}.`,
      facts: [{ kind: 'visit_started', ref: null, value: { date: visit.date, time: visit.time } }],
      // A client's own name came from outside the team (the booking page).
      untrustedText: true,
    };
  },
  async undo(scope, inverse) {
    const { bookingFeeId } = z.strictObject({ bookingFeeId: z.uuid() }).parse(inverse);
    try {
      await undoNoShowFeeIn(scope.tx, scope.actor, {
        bookingFeeId,
        now: scope.deps.clock.now(),
        outboxKey: scope.deps.emails.outboxKey,
      });
    } catch (error) {
      // Stripe is being asked this moment: nothing changed; Undo works again in a moment.
      if (error instanceof NoShowFeeBusyError) throw new UndoRefusedError('not_possible');
      throw error;
    }
  },
};
