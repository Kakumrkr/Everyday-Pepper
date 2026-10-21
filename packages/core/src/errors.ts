import type { Permission, UndoRefusal } from '@pepper/contracts';

/** The member's role does not allow this (`permission`, if one permission decided it). */
export class ForbiddenError extends Error {
  constructor(readonly permission?: Permission) {
    super(permission === undefined ? 'Not allowed' : `Not allowed: ${permission}`);
    this.name = 'ForbiddenError';
  }
}

/** No such member in the business. */
export class MemberNotFoundError extends Error {
  constructor() {
    super('No such member in this business');
    this.name = 'MemberNotFoundError';
  }
}

/** The change would leave the business without an owner. */
export class LastOwnerError extends Error {
  constructor() {
    super('A business needs at least one owner');
    this.name = 'LastOwnerError';
  }
}

/**
 * The invite link does not work: no such token, or the invite was accepted, revoked or has
 * expired. One error for all, so a token reveals nothing about why.
 */
export class InviteInvalidError extends Error {
  constructor() {
    super('This invite link is no longer valid');
    this.name = 'InviteInvalidError';
  }
}

/** The invite is for another email than the signed-in user's. */
export class InviteWrongAccountError extends Error {
  constructor() {
    super('This invite is for another account');
    this.name = 'InviteWrongAccountError';
  }
}

/** No such open invite in the business. */
export class InviteNotFoundError extends Error {
  constructor() {
    super('No such open invite in this business');
    this.name = 'InviteNotFoundError';
  }
}

/** The business has as many open invites as it may. */
export class InviteLimitReachedError extends Error {
  constructor(readonly limit: number) {
    super(`A business may have at most ${String(limit)} open invites`);
    this.name = 'InviteLimitReachedError';
  }
}

/** The person is already a member of the business. */
export class AlreadyAMemberError extends Error {
  constructor() {
    super('Already a member of this business');
    this.name = 'AlreadyAMemberError';
  }
}

/** No such client in the business, or not one the member may see (staff: their own). */
export class ClientNotFoundError extends Error {
  constructor() {
    super('No such client in this business');
    this.name = 'ClientNotFoundError';
  }
}

/** No such conversation or turn of the member (every role sees only its own, ADR-0030). */
export class ConversationNotFoundError extends Error {
  constructor() {
    super('No such conversation');
    this.name = 'ConversationNotFoundError';
  }
}

/** No such task in the business, or not one the member may see (staff: their own). */
export class TaskNotFoundError extends Error {
  constructor() {
    super('No such task in this business');
    this.name = 'TaskNotFoundError';
  }
}

/** A task can only be given to a member of the business. */
export class TaskAssigneeNotMemberError extends Error {
  constructor() {
    super('The assignee is not a member of this business');
    this.name = 'TaskAssigneeNotMemberError';
  }
}

/**
 * No such AI proposal in the business, or not one the member may see (staff: the ones made
 * for them).
 */
export class ProposalNotFoundError extends Error {
  constructor() {
    super('No such proposal in this business');
    this.name = 'ProposalNotFoundError';
  }
}

/** The proposal was already rejected, expired or replaced by a newer one (ADR-0028). */
export class ProposalNotPendingError extends Error {
  constructor(readonly status: 'approved' | 'rejected' | 'expired' | 'superseded') {
    super(`This proposal is ${status}`);
    this.name = 'ProposalNotPendingError';
  }
}

/** No such AI action in the business, or not one the member may see. */
export class ActionNotFoundError extends Error {
  constructor() {
    super('No such action in this business');
    this.name = 'ActionNotFoundError';
  }
}

/** The action can no longer be undone: its undo window has closed, or it never had one. */
export class UndoWindowClosedError extends Error {
  constructor() {
    super('This action can no longer be undone');
    this.name = 'UndoWindowClosedError';
  }
}

/**
 * Why an undo was refused although its window is open (`UndoRefusalSchema` in the contracts):
 * the world moved on (the slot was rebooked, the appointment started, the email left).
 */
export type { UndoRefusal };

/** The inverse was refused by the domain; nothing was changed (ADR-0028). */
export class UndoRefusedError extends Error {
  constructor(readonly reason: UndoRefusal) {
    super(`This action can't be undone: ${reason}`);
    this.name = 'UndoRefusedError';
  }
}

/** The appointment the action is about has already started: it can't be proposed any more. */
export class ActionTooLateError extends Error {
  constructor() {
    super('The appointment has already started');
    this.name = 'ActionTooLateError';
  }
}

/**
 * A concurrent copy of the same AI action (same idempotency key) was recorded first; this one
 * rolled back. Asking again returns the first one's result.
 */
export class ConcurrentActionError extends Error {
  constructor() {
    super('This action was recorded by a concurrent request');
    this.name = 'ConcurrentActionError';
  }
}
