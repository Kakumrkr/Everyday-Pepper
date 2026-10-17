import {
  AlreadyAMemberError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
  LastOwnerError,
  MemberNotFoundError,
} from '@floty/core';
import { BusinessLimitReachedError, TenantSlugTakenError } from '@floty/db';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { apiError } from '../auth/guards.js';

/**
 * The api's answer to a domain error (`{ code, message }`); any other error is returned
 * unchanged, so unexpected ones still become a reported 500.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof ForbiddenError) return new ForbiddenException(apiError('forbidden'));
  if (error instanceof MemberNotFoundError) {
    return new NotFoundException(apiError('member_not_found'));
  }
  if (error instanceof LastOwnerError) return new ConflictException(apiError('last_owner'));
  if (error instanceof BusinessLimitReachedError) {
    return new ConflictException(apiError('business_limit_reached'));
  }
  if (error instanceof TenantSlugTakenError) return new ConflictException(apiError('slug_taken'));
  if (error instanceof InviteInvalidError) return new NotFoundException(apiError('invite_invalid'));
  if (error instanceof InviteWrongAccountError) {
    return new ForbiddenException(apiError('invite_wrong_account'));
  }
  if (error instanceof InviteNotFoundError) {
    return new NotFoundException(apiError('invite_not_found'));
  }
  if (error instanceof InviteLimitReachedError) {
    return new ConflictException(apiError('invite_limit_reached'));
  }
  if (error instanceof AlreadyAMemberError) {
    return new ConflictException(apiError('already_a_member'));
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
