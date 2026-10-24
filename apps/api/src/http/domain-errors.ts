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
import type { ApiErrorCode, SlotUnavailable, UndoRefusedBody, WrongCode } from '@pepper/contracts';
import {
  ActionNotFoundError,
  AlreadyAMemberError,
  ClientNotFoundError,
  ConversationNotFoundError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  DraftRefusedError,
  FeedItemNotFoundError,
  NudgeNotSendableError,
  UnsubscribeLinkInvalidError,
  InviteWrongAccountError,
  LastOwnerError,
  MemberNotFoundError,
  MemoryEpisodeNotFoundError,
  MemoryFactNotFoundError,
  MemoryLimitError,
  MemoryPausedError,
  MemorySubjectNotFoundError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
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
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { apiError } from '../auth/guards.js';

type ErrorClass = abstract new (...args: never[]) => Error;
type Answer = new (body: object) => HttpException;

/** 429: too many requests (Nest has no exception class for it). */
export class TooManyRequestsException extends HttpException {
  constructor(body: object) {
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}

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
  [WaitlistOfferNotFoundError, NotFoundException, 'waitlist_offer_not_found'],
  [WaitlistOfferUsedError, ConflictException, 'waitlist_offer_used'],
  [WaitlistOfferTakenError, ConflictException, 'waitlist_offer_taken'],
  [WaitlistOfferExpiredError, GoneException, 'waitlist_offer_expired'],
  [TaskNotFoundError, NotFoundException, 'task_not_found'],
  [FeedItemNotFoundError, NotFoundException, 'feed_item_not_found'],
  [DraftRefusedError, UnprocessableEntityException, 'draft_refused'],
  [NudgeNotSendableError, ConflictException, 'nudge_not_sendable'],
  [UnsubscribeLinkInvalidError, NotFoundException, 'unsubscribe_link_invalid'],
  [ConversationNotFoundError, NotFoundException, 'conversation_not_found'],
  [ProposalNotFoundError, NotFoundException, 'proposal_not_found'],
  [ProposalNotPendingError, ConflictException, 'proposal_not_pending'],
  [ActionNotFoundError, NotFoundException, 'action_not_found'],
  [UndoWindowClosedError, ConflictException, 'undo_window_closed'],
  [MemoryFactNotFoundError, NotFoundException, 'memory_fact_not_found'],
  [MemorySubjectNotFoundError, NotFoundException, 'memory_subject_not_found'],
  [MemoryEpisodeNotFoundError, NotFoundException, 'memory_episode_not_found'],
  [MemoryLimitError, ConflictException, 'memory_limit_reached'],
  [MemoryPausedError, ConflictException, 'memory_paused'],
  [TaskAssigneeNotMemberError, UnprocessableEntityException, 'task_assignee_not_member'],
  [BookingPageNotFoundError, NotFoundException, 'booking_page_not_found'],
  [BookingRequestNotFoundError, NotFoundException, 'booking_request_not_found'],
  [BookingRequestExpiredError, GoneException, 'booking_request_expired'],
  [BookingRequestUsedError, ConflictException, 'booking_request_used'],
  [TooManyBookingRequestsError, TooManyRequestsException, 'too_many_requests'],
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
  if (error instanceof UndoRefusedError) {
    const body: UndoRefusedBody = {
      ...apiError('undo_refused'),
      code: 'undo_refused',
      reason: error.reason,
    };
    return new ConflictException(body);
  }
  if (error instanceof WrongVerificationCodeError) {
    const body: WrongCode = {
      ...apiError('wrong_code'),
      code: 'wrong_code',
      attemptsLeft: error.attemptsLeft,
    };
    return new UnprocessableEntityException(body);
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
