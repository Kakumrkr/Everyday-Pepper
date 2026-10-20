import { AvailableSlotSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingNotStartedError,
  BookingPageNotFoundError,
  BookingRequestExpiredError,
  BookingRequestNotFoundError,
  BookingRequestUsedError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
  TimeOffNotFoundError,
  WaitlistEntryNotChangeableError,
  WaitlistEntryNotFoundError,
  TooManyBookingRequestsError,
  WaitlistExpiredError,
  WrongVerificationCodeError,
} from './errors.js';

describe('appointments errors', () => {
  it.each([
    [new ServiceNotFoundError(), 'ServiceNotFoundError'],
    [new StaffMemberNotFoundError(), 'StaffMemberNotFoundError'],
    [new TimeOffNotFoundError(), 'TimeOffNotFoundError'],
    [new BookingNotFoundError(), 'BookingNotFoundError'],
    [new SlotUnavailableError([]), 'SlotUnavailableError'],
    [new BookingNotChangeableError(), 'BookingNotChangeableError'],
    [new BookingNotStartedError(), 'BookingNotStartedError'],
    [new IdempotencyKeyReusedError(), 'IdempotencyKeyReusedError'],
    [new WaitlistEntryNotFoundError(), 'WaitlistEntryNotFoundError'],
    [new WaitlistEntryNotChangeableError(), 'WaitlistEntryNotChangeableError'],
    [new WaitlistExpiredError(), 'WaitlistExpiredError'],
    [new BookingPageNotFoundError(), 'BookingPageNotFoundError'],
    [new BookingRequestNotFoundError(), 'BookingRequestNotFoundError'],
    [new BookingRequestExpiredError(), 'BookingRequestExpiredError'],
    [new BookingRequestUsedError(), 'BookingRequestUsedError'],
    [new WrongVerificationCodeError(3), 'WrongVerificationCodeError'],
    [new TooManyBookingRequestsError(), 'TooManyBookingRequestsError'],
  ])('%s is a named Error', (error, name) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).not.toBe('');
  });

  it('a wrong code carries the attempts left', () => {
    expect(new WrongVerificationCodeError(2).attemptsLeft).toBe(2);
  });

  it('a refused time carries its alternatives', () => {
    const alternatives = [
      AvailableSlotSchema.parse({
        staffMemberId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198',
        startsAt: '2026-11-02T15:00:00.000Z',
        endsAt: '2026-11-02T16:00:00.000Z',
      }),
    ];
    expect(new SlotUnavailableError(alternatives).alternatives).toEqual(alternatives);
  });
});
