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
} from '@pepper/appointments';
import { AvailableSlotSchema, SlotUnavailableSchema } from '@pepper/contracts';
import {
  AlreadyAMemberError,
  ClientNotFoundError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
  LastOwnerError,
  MemberNotFoundError,
} from '@pepper/core';
import {
  BusinessLimitReachedError,
  ClientEmailTakenError,
  ServiceNameTakenError,
  StaffMemberLinkTakenError,
  TenantSlugTakenError,
} from '@pepper/db';
import { BadRequestException, HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { answering, toHttpError } from './domain-errors.js';

describe('toHttpError', () => {
  it.each([
    [new ForbiddenError('members.manage'), 403, 'forbidden'],
    [new MemberNotFoundError(), 404, 'member_not_found'],
    [new LastOwnerError(), 409, 'last_owner'],
    [new BusinessLimitReachedError(5), 409, 'business_limit_reached'],
    [new TenantSlugTakenError(), 409, 'slug_taken'],
    [new InviteInvalidError(), 404, 'invite_invalid'],
    [new InviteWrongAccountError(), 403, 'invite_wrong_account'],
    [new InviteNotFoundError(), 404, 'invite_not_found'],
    [new InviteLimitReachedError(20), 409, 'invite_limit_reached'],
    [new AlreadyAMemberError(), 409, 'already_a_member'],
    [new ServiceNotFoundError(), 404, 'service_not_found'],
    [new ServiceNameTakenError(), 409, 'service_name_taken'],
    [new StaffMemberNotFoundError(), 404, 'staff_member_not_found'],
    [new StaffMemberLinkTakenError(), 409, 'staff_member_link_taken'],
    [new TimeOffNotFoundError(), 404, 'time_off_not_found'],
    [new ClientNotFoundError(), 404, 'client_not_found'],
    [new ClientEmailTakenError(), 409, 'client_email_taken'],
    [new BookingNotFoundError(), 404, 'booking_not_found'],
    [new BookingNotChangeableError(), 409, 'booking_not_changeable'],
    [new BookingNotStartedError(), 409, 'booking_not_started'],
    [new IdempotencyKeyReusedError(), 409, 'idempotency_key_reused'],
    [new WaitlistEntryNotFoundError(), 404, 'waitlist_entry_not_found'],
    [new WaitlistEntryNotChangeableError(), 409, 'waitlist_entry_not_changeable'],
    [new WaitlistExpiredError(), 400, 'waitlist_expired'],
  ])('%s → %d %s', (error, status, code) => {
    const answer = toHttpError(error);
    expect(answer).toBeInstanceOf(HttpException);
    expect((answer as HttpException).getStatus()).toBe(status);
    expect((answer as HttpException).getResponse()).toMatchObject({ code });
  });

  it('answers a refused booking time with 409 and the alternatives', () => {
    const alternative = AvailableSlotSchema.parse({
      staffMemberId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198',
      startsAt: '2026-11-03T20:15:00.000Z',
      endsAt: '2026-11-03T21:15:00.000Z',
    });
    const answer = toHttpError(new SlotUnavailableError([alternative])) as HttpException;
    expect(answer.getStatus()).toBe(409);
    expect(SlotUnavailableSchema.parse(answer.getResponse())).toEqual({
      code: 'slot_unavailable',
      message: 'That time cannot be booked',
      alternatives: [alternative],
    });
  });

  it('passes HTTP errors and unexpected errors through unchanged', () => {
    const http = new BadRequestException();
    const unexpected = new Error('boom');
    expect(toHttpError(http)).toBe(http);
    expect(toHttpError(unexpected)).toBe(unexpected);
  });
});

describe('answering', () => {
  it('returns the result or throws the mapped error', async () => {
    await expect(answering(() => Promise.resolve(1))).resolves.toBe(1);
    await expect(answering(() => Promise.reject(new LastOwnerError()))).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});
