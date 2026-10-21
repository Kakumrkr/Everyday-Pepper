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
} from '@pepper/appointments';
import { looksLikeContact, ToolErrorCodeSchema } from '@pepper/contracts';
import {
  ActionTooLateError,
  ClientNotFoundError,
  ForbiddenError,
  TaskAssigneeNotMemberError,
  TaskNotFoundError,
  TaskNotOpenError,
  UndoRefusedError,
} from '@pepper/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  InvalidToolArgumentsError,
  toolRefusalOf,
  undoRefusalOf,
  UnknownToolError,
} from './errors.js';

const zodError = (() => {
  try {
    z.strictObject({ date: z.iso.date() }).parse({ date: 'maria@example.test' });
  } catch (error) {
    return error;
  }
  throw new Error('expected a ZodError');
})();

const CASES: [unknown, string][] = [
  [new SlotUnavailableError([]), 'slot_unavailable'],
  [zodError, 'invalid_arguments'],
  [new InvalidToolArgumentsError('No contact details, please.'), 'invalid_arguments'],
  [new UnknownToolError(), 'unknown_tool'],
  [new BookingNotFoundError(), 'not_found'],
  [new ServiceNotFoundError(), 'not_found'],
  [new StaffMemberNotFoundError(), 'not_found'],
  [new TimeOffNotFoundError(), 'not_found'],
  [new ClientNotFoundError(), 'not_found'],
  [new TaskNotFoundError(), 'not_found'],
  [new TaskNotOpenError(), 'not_changeable'],
  [new TaskAssigneeNotMemberError(), 'not_found'],
  [new ForbiddenError('bookings.manage'), 'forbidden'],
  [new BookingNotChangeableError(), 'not_changeable'],
  [new BookingNotStartedError(), 'not_changeable'],
  [new BookingAlreadyStartedError(), 'too_late'],
  [new ActionTooLateError(), 'too_late'],
  [new IdempotencyKeyReusedError(), 'conflict'],
  [new UndoRefusedError('slot_taken'), 'not_changeable'],
  [new Error('connection reset at 10.0.0.5 for maria@example.test'), 'internal'],
];

describe('toolRefusalOf', () => {
  it.each(CASES)('maps %s to a stable code', (error, code) => {
    expect(toolRefusalOf(error).code).toBe(code);
  });

  it("never passes on the error's own text, a value from the arguments or a contact", () => {
    const anything = fc.oneof(
      fc.constantFrom(...CASES.map(([error]) => error)),
      fc.string().map((text) => new Error(text)),
      fc.anything(),
    );
    fc.assert(
      fc.property(anything, (error) => {
        const refusal = toolRefusalOf(error);
        expect(ToolErrorCodeSchema.options).toContain(refusal.code);
        expect(looksLikeContact(refusal.message)).toBe(false);
        // An unexpected error's text (a host, a value) never reaches the model.
        if (error instanceof Error && error.constructor === Error && error.message.length > 3) {
          expect(refusal.message).not.toContain(error.message);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe('undoRefusalOf', () => {
  it('turns the domain refusing an inverse into the trust layer’s reasons', () => {
    const reason = (error: unknown) => (undoRefusalOf(error) as UndoRefusedError).reason;
    expect(reason(new SlotUnavailableError([]))).toBe('slot_taken');
    expect(reason(new BookingAlreadyStartedError())).toBe('already_started');
    expect(reason(new BookingNotChangeableError())).toBe('changed_since');
    expect(reason(new BookingNotFoundError())).toBe('changed_since');
    expect(reason(new UndoRefusedError('not_possible'))).toBe('not_possible');
    const forbidden = new ForbiddenError();
    expect(undoRefusalOf(forbidden)).toBe(forbidden);
  });
});
