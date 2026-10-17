import type { Permission } from '@floty/contracts';

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
