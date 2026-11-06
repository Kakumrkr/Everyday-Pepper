import {
  BookingAlreadyStartedError,
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
  WaitlistTimesFreeError,
} from '@pepper/appointments';
import type { AvailableSlot, ToolErrorCode } from '@pepper/contracts';
import {
  ActionTooLateError,
  ClientMessageNotSendableError,
  ClientNotFoundError,
  DraftRefusedError,
  ForbiddenError,
  MemoryFactNotFoundError,
  MemoryLimitError,
  MemoryPausedError,
  MemorySubjectNotFoundError,
  NudgeNotSendableError,
  ReviewRequestNotSendableError,
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
  TaskNotOpenError,
  UndoRefusedError,
} from '@pepper/core';
import { ZodError } from 'zod';

// Domain errors as answers the model can act on (playbook S24, ADR-0029): a stable code and one
// plain sentence. Nothing of the error's own text, a row or a stack reaches the model; another
// business's record is "not found", exactly like one that doesn't exist (no oracle).

export interface ToolRefusal {
  code: ToolErrorCode;
  message: string;
  /**
   * With `slot_unavailable`: the nearest times that can be booked, nearest first; with
   * `times_free`: the earliest free times inside the windows asked for.
   */
  alternatives?: readonly AvailableSlot[];
}

/** No tool of this name (the model made one up). */
export class UnknownToolError extends Error {
  constructor() {
    super('No such tool');
    this.name = 'UnknownToolError';
  }
}

/** The arguments aren't JSON, or hold a client's contact details (never stored, ADR-0028). */
export class InvalidToolArgumentsError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'InvalidToolArgumentsError';
  }
}

const NUDGE_NOT_SENDABLE = {
  no_address: 'Add the business’s mailing address first: rebooking emails must carry it.',
  no_email: 'This client has no email address.',
  opted_out: 'This client unsubscribed from these emails.',
} as const;

const REVIEW_NOT_SENDABLE = {
  no_address: 'Add the business’s mailing address first: review requests must carry it.',
  no_review_link: 'Add the business’s review link first.',
  no_email: 'This client has no email address.',
  opted_out: 'This client unsubscribed from these emails.',
  no_visit: 'That visit was cancelled or missed, so there is nothing to ask about.',
} as const;

const MESSAGE_NOT_SENDABLE = {
  not_booked: 'That visit isn’t booked any more (cancelled, done or missed), so nothing was sent.',
  started: 'That visit has already started, so a reminder makes no sense. Nothing was sent.',
  too_early:
    'That visit is more than 3 hours away; a running-late note goes within 3 hours of it. Nothing was sent.',
  too_late: 'That visit started over an hour ago, so nothing was sent.',
  no_email: 'This client has no email address, so I can’t message them yet.',
} as const;

const NOT_FOUND = [
  BookingNotFoundError,
  ServiceNotFoundError,
  StaffMemberNotFoundError,
  TimeOffNotFoundError,
  ClientNotFoundError,
  TaskNotFoundError,
  TaskAssigneeNotMemberError,
  MemoryFactNotFoundError,
  MemorySubjectNotFoundError,
  WaitlistEntryNotFoundError,
];

/** The refusal to give the model, or `internal` for anything unexpected (nothing changed). */
export function toolRefusalOf(error: unknown): ToolRefusal {
  if (error instanceof SlotUnavailableError) {
    return {
      code: 'slot_unavailable',
      message:
        'That time is not free. Offer the member the nearest free times listed here; never pick one for them.',
      alternatives: error.alternatives,
    };
  }
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || 'arguments'))];
    return {
      code: 'invalid_arguments',
      message: `These arguments are not valid: ${fields.join(', ')}. Check them against the tool's description.`,
    };
  }
  if (error instanceof InvalidToolArgumentsError) {
    return { code: 'invalid_arguments', message: error.reason };
  }
  if (error instanceof UnknownToolError) {
    return { code: 'unknown_tool', message: 'There is no such tool. Use only the tools listed.' };
  }
  if (NOT_FOUND.some((kind) => error instanceof kind)) {
    return {
      code: 'not_found',
      message:
        'No such record here, or not one this member may see. Look it up again; never guess an id.',
    };
  }
  if (error instanceof ForbiddenError) {
    return {
      code: 'forbidden',
      message:
        "This member's role doesn't allow that. Tell them plainly, and that an owner or manager can do it; don't try another way.",
    };
  }
  if (error instanceof BookingNotStartedError) {
    return {
      code: 'not_changeable',
      message:
        'That appointment hasn’t started yet, so it can’t be marked a no-show or done. Nothing was changed.',
    };
  }
  if (error instanceof BookingNotChangeableError) {
    return {
      code: 'not_changeable',
      message: "The booking's status doesn't allow that change (a cancelled booking is final).",
    };
  }
  if (error instanceof TaskNotOpenError) {
    return { code: 'not_changeable', message: 'That to-do is already done.' };
  }
  if (error instanceof BookingAlreadyStartedError || error instanceof ActionTooLateError) {
    return { code: 'too_late', message: 'The appointment has already started.' };
  }
  if (error instanceof MemoryPausedError) {
    return {
      code: 'memory_paused',
      message:
        'The owner paused remembering new things; nothing was saved. Say so; it can be turned back on on the "What I know" page in More.',
    };
  }
  if (error instanceof MemoryLimitError) {
    return {
      code: 'not_changeable',
      message:
        'There is no room to remember more about this. The member can clear old items on the "What I know" page.',
    };
  }
  if (error instanceof NudgeNotSendableError) {
    return { code: 'not_changeable', message: NUDGE_NOT_SENDABLE[error.reason] };
  }
  if (error instanceof ReviewRequestNotSendableError) {
    return { code: 'not_changeable', message: REVIEW_NOT_SENDABLE[error.reason] };
  }
  if (error instanceof ClientMessageNotSendableError) {
    return { code: 'not_changeable', message: MESSAGE_NOT_SENDABLE[error.reason] };
  }
  if (error instanceof DraftRefusedError) {
    return {
      code: 'invalid_arguments',
      message:
        'The email’s words break a rule: no links, contact details or sensitive notes, and at most 120 words (a note to a client: 200 characters).',
    };
  }
  if (error instanceof WaitlistExpiredError) {
    return {
      code: 'too_late',
      message: 'Every one of those times has already passed. Ask the member for later days.',
    };
  }
  if (error instanceof WaitlistTimesFreeError) {
    return {
      code: 'times_free',
      message:
        'Nothing was added: the waitlist is for full times, and the times listed here inside those windows are free. Offer them to the member to book; never pick one for them.',
      alternatives: error.freeTimes,
    };
  }
  if (error instanceof WaitlistEntryNotChangeableError) {
    return {
      code: 'not_changeable',
      message: 'That waitlist entry was already booked or removed.',
    };
  }
  if (error instanceof IdempotencyKeyReusedError) {
    return { code: 'conflict', message: 'This request was already made differently.' };
  }
  if (error instanceof UndoRefusedError) {
    return { code: 'not_changeable', message: `It can't be undone (${error.reason}).` };
  }
  return { code: 'internal', message: 'Something went wrong on our side; nothing was changed.' };
}

/**
 * Why the domain refused an undo, as the trust layer's `UndoRefusedError` (ADR-0028): the slot
 * was booked meanwhile, the appointment started, or the record changed since. Other errors
 * (a permission) are not refusals and pass unchanged.
 */
export function undoRefusalOf(error: unknown): unknown {
  if (error instanceof UndoRefusedError) return error;
  if (error instanceof SlotUnavailableError) return new UndoRefusedError('slot_taken');
  if (error instanceof BookingAlreadyStartedError) return new UndoRefusedError('already_started');
  if (
    error instanceof BookingNotChangeableError ||
    // An entry booked from an offer since (S37) can't be taken off the list.
    error instanceof WaitlistEntryNotChangeableError ||
    NOT_FOUND.some((kind) => error instanceof kind)
  ) {
    return new UndoRefusedError('changed_since');
  }
  return error;
}
