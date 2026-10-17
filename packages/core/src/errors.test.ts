import { describe, expect, it } from 'vitest';
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
} from './errors.js';

describe('domain errors', () => {
  it.each([
    [new ForbiddenError(), 'ForbiddenError', 'Not allowed'],
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
  ])('%s', (error, name, message) => {
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.message]).toEqual([name, message]);
  });

  it('carries the limit and the permission', () => {
    expect(new InviteLimitReachedError(20).limit).toBe(20);
    expect(new ForbiddenError('audit.read').permission).toBe('audit.read');
  });
});
