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
import type { ApiErrorCode, SlotUnavailable } from '@pepper/contracts';
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
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { apiError } from '../auth/guards.js';

type ErrorClass = abstract new (...args: never[]) => Error;
type Answer = new (body: object) => HttpException;

/** Each domain error and the api's answer to it: the HTTP status and the stable code. */
const ANSWERS: readonly (readonly [ErrorClass, Answer, ApiErrorCode])[] = [
  [ForbiddenError, ForbiddenException, 'forbidden'],
  [MemberNotFoundError, NotFoundException, 'member_not_found'],
  [LastOwnerError, ConflictException, 'last_owner'],
  [BusinessLimitReachedError, ConflictException, 'business_limit_reached'],
  [TenantSlugTakenError, ConflictException, 'slug_taken'],
  [InviteInvalidError, NotFoundException, 'invite_invalid'],
  [InviteWrongAccountError, ForbiddenException, 'invite_wrong_account'],
  [InviteNotFoundError, NotFoundException, 'invite_not_found'],
  [InviteLimitReachedError, ConflictException, 'invite_limit_reached'],
  [AlreadyAMemberError, ConflictException, 'already_a_member'],
  [ServiceNotFoundError, NotFoundException, 'service_not_found'],
  [ServiceNameTakenError, ConflictException, 'service_name_taken'],
  [StaffMemberNotFoundError, NotFoundException, 'staff_member_not_found'],
  [StaffMemberLinkTakenError, ConflictException, 'staff_member_link_taken'],
  [TimeOffNotFoundError, NotFoundException, 'time_off_not_found'],
  [ClientNotFoundError, NotFoundException, 'client_not_found'],
  [ClientEmailTakenError, ConflictException, 'client_email_taken'],
  [BookingNotFoundError, NotFoundException, 'booking_not_found'],
  [BookingNotChangeableError, ConflictException, 'booking_not_changeable'],
  [BookingNotStartedError, ConflictException, 'booking_not_started'],
  [IdempotencyKeyReusedError, ConflictException, 'idempotency_key_reused'],
  [WaitlistEntryNotFoundError, NotFoundException, 'waitlist_entry_not_found'],
  [WaitlistEntryNotChangeableError, ConflictException, 'waitlist_entry_not_changeable'],
  [WaitlistExpiredError, BadRequestException, 'waitlist_expired'],
];

/**
 * The api's answer to a domain error (`{ code, message }`; a refused booking time also lists
 * `alternatives`); any other error is returned unchanged, so unexpected ones still become a
 * reported 500.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof SlotUnavailableError) {
    const body: SlotUnavailable = {
      ...apiError('slot_unavailable'),
      code: 'slot_unavailable',
      alternatives: [...error.alternatives],
    };
    return new ConflictException(body);
  }
  for (const [errorClass, Answer, code] of ANSWERS) {
    if (error instanceof errorClass) return new Answer(apiError(code));
  }
  return error;
}

/** Runs a domain call, answering its domain errors with the matching HTTP error. */
export async function answering<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHttpError(error);
  }
}
