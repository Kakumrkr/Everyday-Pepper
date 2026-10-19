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

/** Completed and no-show record what happened, so the appointment must have started. */
export class BookingNotStartedError extends Error {
  constructor() {
    super('The booking has not started yet');
    this.name = 'BookingNotStartedError';
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
