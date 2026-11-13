import type { ActionProposal } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { waitlistOfferSummary } from './approval-summary.js';

// The owner's text for a waitlist offer (S63, AC-X-82): first names only.

function proposal(
  after: Record<string, string | number | boolean>,
  names: readonly string[],
): Pick<ActionProposal, 'preview' | 'explanation'> {
  return {
    preview: { entityType: 'waitlist_match', before: null, after, emails: [], summary: 'x' },
    explanation: {
      requestMessageId: null,
      steps: [],
      facts: [
        {
          kind: 'slot_was_free',
          ref: null,
          value: { date: '2026-11-17', time: '14:00', staffName: 'Jess Moreno' },
        },
        ...names.map((clientName, i) => ({
          kind: i === 1 ? 'rebooking_due' : 'waitlist_rank',
          ref: null,
          value: { rank: i + 1, clientName },
        })),
      ],
      alternatives: [],
      untrustedContext: true,
      decision: { outcome: 'propose', reason: 'setting' },
    },
  };
}

const after = (time: string) => ({
  date: '2026-11-17',
  time,
  staffName: 'Jess Moreno',
  serviceName: 'Cut',
  offeredTo: 'Audy L., Marco P. and Sam K.',
  offers: 3,
  valueCents: 6500,
});

describe('waitlistOfferSummary (AC-X-82)', () => {
  it('names the day, time, staff and clients by first name only', () => {
    const line = waitlistOfferSummary(proposal(after('14:00'), ['Audy L.', 'Marco P.', 'Sam K.']));
    expect(line).toBe('Tue 2pm opened with Jess. Offer it to Audy, Marco and Sam?');
    // Nothing beyond first names: no last initial, price or service.
    expect(line).not.toMatch(/Moreno|L\.|P\.|K\.|\$|65|Cut/);
  });

  it('writes minutes, noon, one name and "more"', () => {
    expect(waitlistOfferSummary(proposal(after('12:30'), ['Ana R.']))).toBe(
      'Tue 12:30pm opened with Jess. Offer it to Ana?',
    );
    expect(
      waitlistOfferSummary(proposal(after('09:00'), ['A B.', 'C D.', 'E F.', 'G H.', 'I J.'])),
    ).toBe('Tue 9am opened with Jess. Offer it to A, C, E and 2 more?');
  });

  it('stays safe with a preview it can’t read', () => {
    expect(waitlistOfferSummary(proposal({ unexpected: true }, ['Sam K.']))).toBe(
      'A freed time can go to the waitlist. Offer it to Sam?',
    );
  });
});
