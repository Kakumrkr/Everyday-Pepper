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
