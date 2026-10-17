import { AvailableSlotSchema } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import {
  BookingNotChangeableError,
  BookingNotFoundError,
  BookingNotStartedError,
  IdempotencyKeyReusedError,
  ServiceNotFoundError,
  SlotUnavailableError,
  StaffMemberNotFoundError,
  TimeOffNotFoundError,
  WaitlistEntryNotChangeableError,
  WaitlistEntryNotFoundError,
  WaitlistExpiredError,
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
  ])('%s is a named Error', (error, name) => {
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(name);
    expect(error.message).not.toBe('');
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
