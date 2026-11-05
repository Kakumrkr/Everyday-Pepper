import { NudgeDraftSchema } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { reviewEmailText, reviewWords } from './review-words.js';

describe('reviewWords', () => {
  it('thanks the client by name for the visit and asks for a review', () => {
    const draft = reviewWords({
      firstName: 'Ana',
      serviceName: 'Haircut',
      visitDate: 'November 4',
    });
    expect(draft).toEqual({
      subject: 'Thanks for coming in, Ana',
      body: 'Hi Ana,\n\nThank you for coming in for your haircut on November 4. If you have a minute, a short review would mean a lot and helps other people find us.',
    });
    expect(NudgeDraftSchema.safeParse(draft).success).toBe(true);
  });

  it('leaves the name and the service out when they break a draft rule', () => {
    const draft = reviewWords({
      firstName: 'ana@example.com',
      serviceName: 'Cut',
      visitDate: 'November 4',
    });
    expect(draft.subject).toBe('Thanks for coming in');
    expect(draft.body).toBe(
      'Hi,\n\nThank you for your visit on November 4. If you have a minute, a short review would mean a lot and helps other people find us.',
    );
  });

  it('works without a first name', () => {
    expect(
      reviewWords({ firstName: null, serviceName: 'Lash fill', visitDate: 'May 2' }).subject,
    ).toBe('Thanks for coming in');
  });
});

describe('reviewEmailText', () => {
  it('puts the review link after the words and the footer with the unsubscribe link last', () => {
    const text = reviewEmailText({
      draft: { subject: 'Thanks', body: 'Hi Ana,\n\nThank you.' },
      reviewUrl: 'https://g.page/r/abc/review',
      businessName: 'Fade Room',
      mailingAddress: '1 Main St\nAustin, TX 78701',
      unsubscribeUrl: 'https://app.test/unsubscribe/t',
    });
    expect(text.split('\n')).toEqual([
      'Hi Ana,',
      '',
      'Thank you.',
      '',
      'Leave a review here:',
      'https://g.page/r/abc/review',
      '',
      '--',
      'Fade Room',
      '1 Main St',
      'Austin, TX 78701',
      '',
      'You get this email because you are a client of Fade Room.',
      'Unsubscribe: https://app.test/unsubscribe/t',
    ]);
  });
});
