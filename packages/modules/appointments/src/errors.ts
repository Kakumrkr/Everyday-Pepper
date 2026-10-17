/** No such service in the business (also for a service id given in a staff member's list). */
export class ServiceNotFoundError extends Error {
  constructor() {
    super('No such service in this business');
    this.name = 'ServiceNotFoundError';
  }
}

/** No such staff member in the business. */
export class StaffMemberNotFoundError extends Error {
  constructor() {
    super('No such staff member in this business');
    this.name = 'StaffMemberNotFoundError';
  }
}

/** No such time-off entry for the staff member. */
export class TimeOffNotFoundError extends Error {
  constructor() {
    super('No such time off for this staff member');
    this.name = 'TimeOffNotFoundError';
  }
}
