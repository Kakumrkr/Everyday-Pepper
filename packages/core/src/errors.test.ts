import { describe, expect, it } from 'vitest';
import {
  AccountBeingDeletedError,
  AccountOwnsBusinessError,
  AlreadyAMemberError,
  DeletionNameMismatchError,
  ClientNotFoundError,
  DraftRefusedError,
  FeedItemNotFoundError,
  ForbiddenError,
  InviteInvalidError,
  InviteLimitReachedError,
  InviteNotFoundError,
  InviteWrongAccountError,
  LastOwnerError,
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
  MemberNotFoundError,
  NudgeNotSendableError,
  SavedRepliesFullError,
  SavedReplyNotFoundError,
  SupportLimitReachedError,
  SupportNotRatableError,
  SupportThreadNotFoundError,
  UnsubscribeLinkInvalidError,
} from './errors.js';

describe('domain errors', () => {
  it.each([
    [new ForbiddenError(), 'ForbiddenError', 'Not allowed'],
    [new SupportThreadNotFoundError(), 'SupportThreadNotFoundError', 'No such support request'],
    // S59.2.2: rating, and the team's saved replies.
    [
      new SupportNotRatableError(),
      'SupportNotRatableError',
      'Only the person who asked rates a solved request',
    ],
    [new SavedReplyNotFoundError(), 'SavedReplyNotFoundError', 'No such saved reply'],
    [new SavedRepliesFullError(), 'SavedRepliesFullError', 'Too many saved replies'],
    [
      new SupportLimitReachedError('threads'),
      'SupportLimitReachedError',
      'Too many support threads today',
    ],
    [
      new SupportLimitReachedError('messages'),
      'SupportLimitReachedError',
      'Too many support messages today',
    ],
    [
      new DeletionNameMismatchError(),
      'DeletionNameMismatchError',
      'The typed name is not the business’s',
    ],
    [
      new AccountOwnsBusinessError(),
      'AccountOwnsBusinessError',
      'The account is the only owner of a business',
    ],
    [new AccountBeingDeletedError(), 'AccountBeingDeletedError', 'The account is being deleted'],
    [new ForbiddenError('members.invite'), 'ForbiddenError', 'Not allowed: members.invite'],
    [new MemberNotFoundError(), 'MemberNotFoundError', 'No such member in this business'],
    [new LastOwnerError(), 'LastOwnerError', 'A business needs at least one owner'],
    [new InviteInvalidError(), 'InviteInvalidError', 'This invite link is no longer valid'],
    [
      new InviteWrongAccountError(),
      'InviteWrongAccountError',
      'This invite is for another account',
    ],
    [new InviteNotFoundError(), 'InviteNotFoundError', 'No such open invite in this business'],
    [
      new InviteLimitReachedError(20),
      'InviteLimitReachedError',
      'A business may have at most 20 open invites',
    ],
    [new AlreadyAMemberError(), 'AlreadyAMemberError', 'Already a member of this business'],
    [new ClientNotFoundError(), 'ClientNotFoundError', 'No such client in this business'],
    [new TaskNotFoundError(), 'TaskNotFoundError', 'No such task in this business'],
    [
      new TaskAssigneeNotMemberError(),
      'TaskAssigneeNotMemberError',
      'The assignee is not a member of this business',
    ],
    [new FeedItemNotFoundError(), 'FeedItemNotFoundError', 'No such open feed item'],
    [new UnsubscribeLinkInvalidError(), 'UnsubscribeLinkInvalidError', 'No such unsubscribe link'],
    [new DraftRefusedError('invalid'), 'DraftRefusedError', 'This draft cannot be used'],
    [
      new NudgeNotSendableError('opted_out'),
      'NudgeNotSendableError',
      "A rebooking email can't be sent (opted_out)",
    ],
  ])('%s', (error, name, message) => {
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.message]).toEqual([name, message]);
  });

  it('carries the limit and the permission', () => {
    expect(new InviteLimitReachedError(20).limit).toBe(20);
    expect(new ForbiddenError('audit.read').permission).toBe('audit.read');
    // S36: the api maps each reason to its own message.
    expect(new DraftRefusedError('sensitive', 'Mentions a private note').reason).toBe('sensitive');
    expect(new NudgeNotSendableError('no_email').reason).toBe('no_email');
  });
});
