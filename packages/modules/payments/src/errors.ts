// Payments' refusals (S65, ADR-0067), mapped to answers by the api.

/** Stripe won't work with the business (`rejected.*`): no new onboarding link. */
export class PaymentsRejectedError extends Error {
  constructor() {
    super('Stripe rejected this business’s account');
    this.name = 'PaymentsRejectedError';
  }
}

/** The Express dashboard before the owner finished Stripe's pages (or with no account). */
export class PaymentsNotOnboardedError extends Error {
  constructor() {
    super('Payments are not set up with Stripe yet');
    this.name = 'PaymentsNotOnboardedError';
  }
}

/**
 * The business can't take a deposit now (S66, AC-X-113): payments aren't ready, or the request's
 * payment is done with. Deposit services can't be booked online until they can.
 */
export class DepositsUnavailableError extends Error {
  constructor() {
    super('Deposits can’t be taken for this business now');
    this.name = 'DepositsUnavailableError';
  }
}

/** Stripe doesn't say the request's payment is authorized (S66, AC-X-115): nothing is booked. */
export class PaymentNotAuthorizedError extends Error {
  constructor() {
    super('The deposit is not authorized');
    this.name = 'PaymentNotAuthorizedError';
  }
}

/**
 * A no-show fee can't be charged (S68, AC-X-139): the visit is no longer a no-show, the booking
 * kept no terms or no card, nothing is left after its deposit, the business can't take charges,
 * or a fee was already decided. Nothing is charged.
 */
export class NoShowFeeNotChargeableError extends Error {
  constructor(
    readonly reason:
      | 'not_no_show'
      | 'no_terms'
      | 'no_card'
      | 'nothing_to_charge'
      | 'payments_off'
      | 'already_decided',
  ) {
    super(`The no-show fee can’t be charged (${reason})`);
    this.name = 'NoShowFeeNotChargeableError';
  }
}

/** The fee is being charged this moment (S68, AC-X-141): Undo can't decide yet; try again. */
export class NoShowFeeBusyError extends Error {
  constructor() {
    super('The no-show fee is being charged right now');
    this.name = 'NoShowFeeBusyError';
  }
}
