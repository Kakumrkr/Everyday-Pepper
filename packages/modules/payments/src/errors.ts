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
