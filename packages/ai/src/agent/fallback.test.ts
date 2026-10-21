import { ChatFallbackSchema, TurnStopReasonSchema } from '@pepper/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fallbackFor, screenFor } from './fallback.js';

describe('fallbackFor', () => {
  it('gives every stop reason a valid reply, with what was done and where to go', () => {
    for (const reason of TurnStopReasonSchema.exclude(['answered']).options) {
      const fallback = fallbackFor(reason, {
        message: 'Book Maria tomorrow at 10',
        done: [
          { status: 'done', summary: 'Booked Maria L. on Tue Nov 3 at 10:00.' },
          { status: 'awaiting_approval', summary: 'Email Maria L. the confirmation.' },
        ],
      });
      expect(ChatFallbackSchema.parse(fallback)).toEqual(fallback);
      expect(fallback.text).toContain('Already done: Booked Maria L.');
      expect(fallback.text).toContain('Waiting for your OK');
    }
    expect(fallbackFor('provider_unavailable', { message: 'x', done: [] })).toEqual({
      reason: 'provider_unavailable',
      text: 'I can’t reach my AI service right now. You can do it yourself in Calendar; everything there works as usual.',
      link: { label: 'Calendar', href: '/calendar' },
    });
  });

  it('stays valid for any message and any number of things done', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TurnStopReasonSchema.exclude(['answered']).options),
        fc.string({ maxLength: 5_000 }),
        fc.array(
          fc.record({
            status: fc.constantFrom('done' as const, 'awaiting_approval' as const),
            summary: fc.string({ maxLength: 600 }),
          }),
          { maxLength: 10 },
        ),
        (reason, message, done) => {
          expect(ChatFallbackSchema.safeParse(fallbackFor(reason, { message, done })).success).toBe(
            true,
          );
        },
      ),
    );
  });
});

describe('screenFor', () => {
  it('links to the screen the member asked about', () => {
    expect(screenFor('Remind me to call Maria Friday').href).toBe('/');
    expect(screenFor("Update Sarah's client profile").href).toBe('/clients');
    expect(screenFor('Give Jess Friday off').href).toBe('/team');
    expect(screenFor('Change the price of a cut').href).toBe('/services');
    expect(screenFor('Move the 3pm to 4pm').href).toBe('/calendar');
  });
});
