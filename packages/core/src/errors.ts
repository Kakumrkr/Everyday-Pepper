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

/** A client with upcoming visits can't be deleted (S50, ADR-0051): cancel them first. */
export class ClientHasUpcomingVisitsError extends Error {
  constructor(readonly upcoming: number) {
    super('The client has upcoming visits');
    this.name = 'ClientHasUpcomingVisitsError';
  }
}

/** Two clients booked at the same time are two people: they can't be merged (ADR-0051). */
export class ClientMergeOverlapError extends Error {
  constructor() {
    super('The two clients have visits at the same time');
    this.name = 'ClientMergeOverlapError';
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

/** No open feed item with this id that the member may see (closed, expired or not theirs). */
export class FeedItemNotFoundError extends Error {
  constructor() {
    super('No such open feed item');
    this.name = 'FeedItemNotFoundError';
  }
}

/** An unsubscribe link this server did not sign, or for a business that is gone (S36). */
export class UnsubscribeLinkInvalidError extends Error {
  constructor() {
    super('No such unsubscribe link');
    this.name = 'UnsubscribeLinkInvalidError';
  }
}

/**
 * A rebooking email can't be drafted or edited as asked (S36): the words break a draft rule (a
 * link, a contact, a remembered sensitive value, too long), or the proposal is not a draft.
 */
export class DraftRefusedError extends Error {
  constructor(
    readonly reason: 'invalid' | 'sensitive' | 'not_a_draft',
    message = 'This draft cannot be used',
  ) {
    super(message);
    this.name = 'DraftRefusedError';
  }
}

/**
 * A rebooking email can't go to this client now (S36): the business has no mailing address
 * yet, the client has no email address, or they unsubscribed from marketing email.
 */
export class NudgeNotSendableError extends Error {
  constructor(readonly reason: 'no_address' | 'no_email' | 'opted_out') {
    super(`A rebooking email can't be sent (${reason})`);
    this.name = 'NudgeNotSendableError';
  }
}

/**
 * A review request can't go to this client now (S55.2, ADR-0059): the business has no mailing
 * address or review link, the client has no email address or unsubscribed, or the visit it
 * follows was cancelled, missed or never happened.
 */
export class ReviewRequestNotSendableError extends Error {
  constructor(
    readonly reason: 'no_address' | 'no_review_link' | 'no_email' | 'opted_out' | 'no_visit',
  ) {
    super(`A review request can't be sent (${reason})`);
    this.name = 'ReviewRequestNotSendableError';
  }
}

/**
 * A message the member asked for can't go to this client (S56a, ADR-0060): the visit isn't
 * booked any more, a reminder's visit has started, "running late" is too early or too late for
 * the visit, or the client has no email address.
 */
export class ClientMessageNotSendableError extends Error {
  constructor(readonly reason: 'not_booked' | 'started' | 'too_early' | 'too_late' | 'no_email') {
    super(`A message can't be sent (${reason})`);
    this.name = 'ClientMessageNotSendableError';
  }
}

/** The task is already done: there is nothing to complete (S26b). */
export class TaskNotOpenError extends Error {
  constructor() {
    super('This task is already done');
    this.name = 'TaskNotOpenError';
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

/** No such memory fact in the business, or not one the member may reach (ADR-0034). */
export class MemoryFactNotFoundError extends Error {
  constructor() {
    super('No such fact in memory');
    this.name = 'MemoryFactNotFoundError';
  }
}

/**
 * The fact's subject (a client, staff member, service or visit) is not in the business, or not
 * one the member may reach.
 */
export class MemorySubjectNotFoundError extends Error {
  constructor() {
    super('No such client, staff member, service or visit to remember this about');
    this.name = 'MemorySubjectNotFoundError';
  }
}

/** The business paused remembering new things (playbook D-15). */
export class MemoryPausedError extends Error {
  constructor() {
    super('Remembering new things is paused for this business');
    this.name = 'MemoryPausedError';
  }
}

/** Memory is full: per subject, for the business, or a member's episodes (ADR-0034). */
export class MemoryLimitError extends Error {
  constructor(readonly limit: 'subject' | 'business' | 'episodes') {
    super(
      limit === 'subject'
        ? 'This has as many facts as it can keep; change or delete one first'
        : limit === 'business'
          ? 'Memory is full for this business; delete facts you no longer need'
          : 'You have as many past conversations remembered as can be kept',
    );
    this.name = 'MemoryLimitError';
  }
}

/** No such episode of the member's own (episodes are own-only, ADR-0034). */
export class MemoryEpisodeNotFoundError extends Error {
  constructor() {
    super('No such past conversation in memory');
    this.name = 'MemoryEpisodeNotFoundError';
  }
}

/** The name typed to confirm a business's deletion isn't the business's (S51.2, ADR-0054). */
export class DeletionNameMismatchError extends Error {
  constructor() {
    super('The typed name is not the business’s');
    this.name = 'DeletionNameMismatchError';
  }
}

/**
 * The account is the only owner of a business that isn't being deleted, so it can't be deleted
 * (S51.2, ADR-0054): the business would be left with nobody who may run it.
 */
export class AccountOwnsBusinessError extends Error {
  constructor() {
    super('The account is the only owner of a business');
    this.name = 'AccountOwnsBusinessError';
  }
}

/**
 * The owner's own account is being deleted, so they can't keep a business they alone own: it
 * would outlive its only owner (S51.2, ADR-0054). Keep the account first.
 */
export class AccountBeingDeletedError extends Error {
  constructor() {
    super('The account is being deleted');
    this.name = 'AccountBeingDeletedError';
  }
}
