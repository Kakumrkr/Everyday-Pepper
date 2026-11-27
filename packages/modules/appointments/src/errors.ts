import type { AvailableSlot } from '@pepper/contracts';

/** No such service in the business (also for a service id given in a staff member's list). */
export class ServiceNotFoundError extends Error {
  constructor() {
    super('No such service in this business');
    this.name = 'ServiceNotFoundError';
  }
}

/** No such staff member in the business. */
export class StaffMemberNotFoundError extends Error {
  constructor() {
    super('No such staff member in this business');
    this.name = 'StaffMemberNotFoundError';
  }
}

/** No such time-off entry for the staff member. */
export class TimeOffNotFoundError extends Error {
  constructor() {
    super('No such time off for this staff member');
    this.name = 'TimeOffNotFoundError';
  }
}

/** No such booking in the business, or not one the member may reach (staff: their own). */
export class BookingNotFoundError extends Error {
  constructor() {
    super('No such booking in this business');
    this.name = 'BookingNotFoundError';
  }
}

/**
 * The time cannot be booked: outside hours or the rules, or another booking (buffers included)
 * is in the way. `alternatives` are the nearest times that can be, with the same service and
 * staff member, nearest first (AC-W2-1).
 */
export class SlotUnavailableError extends Error {
  constructor(readonly alternatives: readonly AvailableSlot[]) {
    super('That time cannot be booked');
    this.name = 'SlotUnavailableError';
  }
}

/** The change does not apply to the booking's status (a cancelled booking is final). */
export class BookingNotChangeableError extends Error {
  constructor() {
    super('This booking can no longer be changed this way');
    this.name = 'BookingNotChangeableError';
  }
}

/** The visit's time is no longer the one the client saw (S78: a confirm by link). */
export class BookingMovedError extends Error {
  constructor() {
    super('This visit has moved; check its new time');
    this.name = 'BookingMovedError';
  }
}

/**
 * The visit can't be released (S78.2, AC-X-210): the client confirmed, it moved, was cancelled
 * or started, or the business stopped asking clients to confirm. `reason` names which.
 */
export class BookingNotReleasableError extends Error {
  constructor(readonly reason: string) {
    super('This visit can no longer be released');
    this.name = 'BookingNotReleasableError';
  }
}

/** Completed and no-show record what happened, so the appointment must have started. */
export class BookingNotStartedError extends Error {
  constructor() {
    super('The booking has not started yet');
    this.name = 'BookingNotStartedError';
  }
}

/** The appointment has already started, so the booking can't be brought back. */
export class BookingAlreadyStartedError extends Error {
  constructor() {
    super('The appointment has already started');
    this.name = 'BookingAlreadyStartedError';
  }
}

/** The idempotency key was already used for a different booking. */
export class IdempotencyKeyReusedError extends Error {
  constructor() {
    super('This idempotency key was already used for a different booking');
    this.name = 'IdempotencyKeyReusedError';
  }
}

/** No such waitlist entry in the business, or not one the member may reach. */
export class WaitlistEntryNotFoundError extends Error {
  constructor() {
    super('No such waitlist entry in this business');
    this.name = 'WaitlistEntryNotFoundError';
  }
}

/** The waitlist entry was already booked or cancelled. */
export class WaitlistEntryNotChangeableError extends Error {
  constructor() {
    super('This waitlist entry can no longer be changed');
    this.name = 'WaitlistEntryNotChangeableError';
  }
}

/** Every window of the new waitlist entry has already passed. */
export class WaitlistExpiredError extends Error {
  constructor() {
    super('Every window of this waitlist entry has already passed');
    this.name = 'WaitlistExpiredError';
  }
}

/**
 * A time inside the windows asked for can still be booked, so nothing was added (S44, AC-W5-2):
 * the waitlist is for times that are full. `freeTimes` are the earliest that can, earliest first.
 */
export class WaitlistTimesFreeError extends Error {
  constructor(readonly freeTimes: readonly AvailableSlot[]) {
    super('A time inside these windows is still free');
    this.name = 'WaitlistTimesFreeError';
  }
}

/** The booking page's waitlist takes days up to `PUBLIC_WAITLIST_DAYS` ahead only (S38a). */
export class WaitlistDayTooFarError extends Error {
  constructor() {
    super('That day is too far ahead to join the waitlist');
    this.name = 'WaitlistDayTooFarError';
  }
}

// The public booking page (ADR-0022).

/** No business has a booking page at this address. */
export class BookingPageNotFoundError extends Error {
  constructor() {
    super('No booking page at this address');
    this.name = 'BookingPageNotFoundError';
  }
}

/** No such booking request in the business. */
export class BookingRequestNotFoundError extends Error {
  constructor() {
    super('No such booking request');
    this.name = 'BookingRequestNotFoundError';
  }
}

/** The request's code expired or was typed wrong too often: ask for a new one. */
export class BookingRequestExpiredError extends Error {
  constructor() {
    super('This code has expired; ask for a new one');
    this.name = 'BookingRequestExpiredError';
  }
}

/** The request's code was already used: its booking exists. */
export class BookingRequestUsedError extends Error {
  constructor() {
    super('This booking request was already confirmed');
    this.name = 'BookingRequestUsedError';
  }
}

/** The typed code is not the one emailed; `attemptsLeft` more may be tried. */
export class WrongVerificationCodeError extends Error {
  constructor(readonly attemptsLeft: number) {
    super('That code is not right');
    this.name = 'WrongVerificationCodeError';
  }
}

/** Too many booking requests for one email address in a short time. */
export class TooManyBookingRequestsError extends Error {
  constructor() {
    super('Too many booking requests for this email address; try again later');
    this.name = 'TooManyBookingRequestsError';
  }
}

/** No waitlist offer behind this link (or not at this business). */
export class WaitlistOfferNotFoundError extends Error {
  constructor() {
    super('This offer link is not valid');
    this.name = 'WaitlistOfferNotFoundError';
  }
}

/** This client already claimed the offer: the booking exists. */
export class WaitlistOfferUsedError extends Error {
  constructor() {
    super('This offer has already been claimed');
    this.name = 'WaitlistOfferUsedError';
  }
}

/** Someone else claimed the time first, or it was booked meanwhile (never says who). */
export class WaitlistOfferTakenError extends Error {
  constructor() {
    super('Sorry, this time has been taken');
    this.name = 'WaitlistOfferTakenError';
  }
}

/** The offer was not claimed in time, or was taken back. */
export class WaitlistOfferExpiredError extends Error {
  constructor() {
    super('This offer has expired');
    this.name = 'WaitlistOfferExpiredError';
  }
}

// Booking page photos (S47.2, ADR-0048).

/** No such photo in the business (or one of another business). */
export class PhotoNotFoundError extends Error {
  constructor() {
    super('No such photo');
    this.name = 'PhotoNotFoundError';
  }
}

/** The gallery already holds its 12 photos. */
export class GalleryFullError extends Error {
  constructor() {
    super('The gallery holds 12 photos');
    this.name = 'GalleryFullError';
  }
}

/** A service's deposit rule doesn't fit its price (S66, AC-X-111): what to change, in words. */
export class DepositRuleMismatchError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'DepositRuleMismatchError';
  }
}

/**
 * A booking page request for a service with a deposit, without an authorized payment (S66,
 * AC-X-115): nothing is booked.
 */
export class PaymentRequiredError extends Error {
  constructor() {
    super('This booking needs its deposit or card first');
    this.name = 'PaymentRequiredError';
  }
}

/**
 * A service with a deposit while the business can't take one (S66, AC-X-113): it can't be booked
 * online until payments can take charges.
 */
export class DepositsClosedError extends Error {
  constructor() {
    super('This service can’t be booked online right now');
    this.name = 'DepositsClosedError';
  }
}

/** A payment asked for a service that needs none (S66). */
export class PaymentNotNeededError extends Error {
  constructor() {
    super('This service needs no deposit');
    this.name = 'PaymentNotNeededError';
  }
}
