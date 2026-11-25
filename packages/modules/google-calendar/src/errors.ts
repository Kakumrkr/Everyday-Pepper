// Google Calendar's refusals (S70, ADR-0069), mapped to answers by the api.

/** The signed-in member has no staff member to connect a calendar for (409). */
export class CalendarNotLinkedError extends Error {
  constructor() {
    super('This member has no staff member to connect a calendar for');
    this.name = 'CalendarNotLinkedError';
  }
}

/**
 * Google's answer can't finish a connect (400): the state is unknown, used, expired or another
 * member's, or Google refused the code. Nothing is stored.
 */
export class CalendarConnectRefusedError extends Error {
  constructor() {
    super('This Google Calendar connection can’t be finished; start again');
    this.name = 'CalendarConnectRefusedError';
  }
}

/** The member unticked free/busy on Google's page (409): nothing is stored, the grant revoked. */
export class CalendarScopeMissingError extends Error {
  constructor() {
    super('Google didn’t give Pepper access to the busy times');
    this.name = 'CalendarScopeMissingError';
  }
}

/** The member has no connected calendar (404). */
export class CalendarNotConnectedError extends Error {
  constructor() {
    super('No Google Calendar is connected');
    this.name = 'CalendarNotConnectedError';
  }
}
