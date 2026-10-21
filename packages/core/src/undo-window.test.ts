import { AI_EMAIL_GRACE_SECONDS, AutonomyActionSchema } from '@pepper/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { undoUntil } from './undo-window.js';

const now = new Date('2026-10-21T15:00:00Z');
const hours = (n: number) => new Date(now.getTime() + n * 3_600_000);

describe('undoUntil', () => {
  it('gives an AI booking 24 hours, but never past the appointment’s start', () => {
    expect(
      undoUntil('booking.create', now, { hasInverse: true, appointmentStartsAt: hours(72) }),
    ).toEqual(hours(24));
    expect(
      undoUntil('booking.move', now, { hasInverse: true, appointmentStartsAt: hours(3) }),
    ).toEqual(hours(3));
    expect(
      undoUntil('booking.cancel', now, { hasInverse: true, appointmentStartsAt: null }),
    ).toEqual(hours(24));
  });

  it('is closed for an appointment that already started', () => {
    expect(
      undoUntil('booking.create', now, { hasInverse: true, appointmentStartsAt: hours(-1) }),
    ).toBeNull();
    expect(
      undoUntil('booking.create', now, { hasInverse: true, appointmentStartsAt: now }),
    ).toBeNull();
  });

  it('gives notes and to-dos a week, blocked time a day', () => {
    expect(
      undoUntil('client_note.save', now, { hasInverse: true, appointmentStartsAt: null }),
    ).toEqual(hours(168));
    expect(
      undoUntil('task.create', now, { hasInverse: true, appointmentStartsAt: hours(1) }),
    ).toEqual(hours(168));
    expect(
      undoUntil('time.block', now, { hasInverse: true, appointmentStartsAt: hours(1) }),
    ).toEqual(hours(24));
  });

  it('lets a message be taken back during its grace before it leaves', () => {
    expect(
      undoUntil('message.confirmation', now, { hasInverse: true, appointmentStartsAt: hours(1) }),
    ).toEqual(new Date(now.getTime() + AI_EMAIL_GRACE_SECONDS * 1000));
  });

  it('is null for an action without an inverse', () => {
    expect(
      undoUntil('booking.create', now, { hasInverse: false, appointmentStartsAt: null }),
    ).toBeNull();
  });

  it('is never in the past and never more than a week away (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AutonomyActionSchema.options),
        fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null }),
        (action, startOffsetHours) => {
          const until = undoUntil(action, now, {
            hasInverse: true,
            appointmentStartsAt: startOffsetHours === null ? null : hours(startOffsetHours),
          });
          if (until === null) return;
          expect(until.getTime()).toBeGreaterThan(now.getTime());
          expect(until.getTime()).toBeLessThanOrEqual(hours(168).getTime());
        },
      ),
    );
  });
});
