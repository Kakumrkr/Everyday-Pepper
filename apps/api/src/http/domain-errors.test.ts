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
  WaitlistTimesFreeError,
  StaffMemberNotFoundError,
  TimeOffNotFoundError,
  TooManyBookingRequestsError,
  WaitlistEntryNotChangeableError,
  WaitlistEntryNotFoundError,
  WaitlistExpiredError,
  WaitlistOfferExpiredError,
  WaitlistOfferNotFoundError,
  WaitlistOfferTakenError,
  WaitlistOfferUsedError,
  WrongVerificationCodeError,
} from '@pepper/appointments';
import {
  AvailableSlotSchema,
  SlotUnavailableSchema,
  WaitlistTimesFreeSchema,
  UndoRefusedBodySchema,
  WrongCodeSchema,
} from '@pepper/contracts';
import {
  ActionNotFoundError,
  AlreadyAMemberError,
  ClientNotFoundError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
  LastOwnerError,
  MemberNotFoundError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  UndoRefusedError,
  UndoWindowClosedError,
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
    [new WaitlistOfferNotFoundError(), 404, 'waitlist_offer_not_found'],
    [new WaitlistOfferUsedError(), 409, 'waitlist_offer_used'],
    [new WaitlistOfferTakenError(), 409, 'waitlist_offer_taken'],
    [new WaitlistOfferExpiredError(), 410, 'waitlist_offer_expired'],
    [new BookingPageNotFoundError(), 404, 'booking_page_not_found'],
    [new BookingRequestNotFoundError(), 404, 'booking_request_not_found'],
    [new BookingRequestExpiredError(), 410, 'booking_request_expired'],
    [new BookingRequestUsedError(), 409, 'booking_request_used'],
    [new TooManyBookingRequestsError(), 429, 'too_many_requests'],
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

  it('answers a waitlist window that is not full with 409 and its free times (AC-W5-2)', () => {
    const free = AvailableSlotSchema.parse({
      staffMemberId: '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708198',
      startsAt: '2026-11-07T16:00:00.000Z',
      endsAt: '2026-11-07T16:45:00.000Z',
    });
    const answer = toHttpError(new WaitlistTimesFreeError([free])) as HttpException;
    expect(answer.getStatus()).toBe(409);
    expect(WaitlistTimesFreeSchema.parse(answer.getResponse())).toEqual({
      code: 'waitlist_times_free',
      message: 'A time inside these windows is still free: book it instead',
      alternatives: [free],
    });
  });

  it('answers the trust layer’s errors with stable codes, and a refused undo with its reason', () => {
    const cases: [Error, number, string][] = [
      [new ProposalNotFoundError(), 404, 'proposal_not_found'],
      [new ProposalNotPendingError('rejected'), 409, 'proposal_not_pending'],
      [new ActionNotFoundError(), 404, 'action_not_found'],
      [new UndoWindowClosedError(), 409, 'undo_window_closed'],
    ];
    for (const [error, status, code] of cases) {
      const answer = toHttpError(error) as HttpException;
      expect([answer.getStatus(), (answer.getResponse() as { code: string }).code]).toEqual([
        status,
        code,
      ]);
    }
    const refused = toHttpError(new UndoRefusedError('slot_taken')) as HttpException;
    expect(refused.getStatus()).toBe(409);
    expect(UndoRefusedBodySchema.parse(refused.getResponse())).toMatchObject({
      code: 'undo_refused',
      reason: 'slot_taken',
    });
  });

  it('answers a wrong code with 422 and the attempts left', () => {
    const answer = toHttpError(new WrongVerificationCodeError(3)) as HttpException;
    expect(answer.getStatus()).toBe(422);
    expect(WrongCodeSchema.parse(answer.getResponse())).toEqual({
      code: 'wrong_code',
      message: 'That code is not right. Check the email and try again',
      attemptsLeft: 3,
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
