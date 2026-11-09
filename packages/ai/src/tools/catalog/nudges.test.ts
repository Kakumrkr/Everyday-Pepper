import { aiDisclosureLines } from '@pepper/contracts';
import { describe, expect, it } from 'vitest';
import { nudgeDisclosure, nudgeEmailText, NudgeWordsBySchema } from './nudges.js';

// The rebooking email as the client reads it (S36), and its AI disclosure (S59.5, AC-X-55/56).

const parts = {
  draft: { subject: 'Time for a fresh fade?', body: 'Hi Maria,\n\nIt has been six weeks.' },
  staffName: 'Dre',
  when: 'on Tuesday, October 27 at 2:00 PM',
  bookingUrl: 'https://app.example.com/book/fade-lab',
  businessName: 'Fade Lab',
  mailingAddress: '1 Main St, Austin, TX',
  unsubscribeUrl: 'https://app.example.com/unsubscribe/token',
};

describe('nudgeEmailText', () => {
  it("puts the model's words, the opening, the AI disclosure, then the footer (AC-X-55)", () => {
    const text = nudgeEmailText({
      ...parts,
      disclosure: aiDisclosureLines('Fade Lab', 'https://app.example.com'),
    });
    expect(text).toBe(
      [
        'Hi Maria,',
        '',
        'It has been six weeks.',
        '',
        'Dre has an opening on Tuesday, October 27 at 2:00 PM. Book it here:',
        'https://app.example.com/book/fade-lab',
        '',
        'Written with help from Pepper, the AI assistant Fade Lab uses.',
        'How Pepper works and what it does with your details: https://app.example.com/privacy#ai',
        '',
        '--',
        'Fade Lab',
        '1 Main St, Austin, TX',
        '',
        'You get this email because you are a client of Fade Lab.',
        'Unsubscribe: https://app.example.com/unsubscribe/token',
      ].join('\n'),
    );
  });

  it("leaves the disclosure out of Pepper's fixed words (a win-back draft)", () => {
    const text = nudgeEmailText({ ...parts, disclosure: [] });
    expect(text).not.toContain('Pepper');
    expect(text).toContain('Book it here:\nhttps://app.example.com/book/fade-lab\n\n--\nFade Lab');
  });
});

describe('who wrote the words', () => {
  const lines = aiDisclosureLines('Fade Lab', 'https://app.example.com');

  it("discloses the model's words, and a nudge stored before anyone said who wrote them", () => {
    expect(nudgeDisclosure('ai', 'Fade Lab', 'https://app.example.com')).toEqual(lines);
    expect(nudgeDisclosure(undefined, 'Fade Lab', 'https://app.example.com')).toEqual(lines);
  });

  it("leaves Pepper's fixed words alone", () => {
    expect(nudgeDisclosure('template', 'Fade Lab', 'https://app.example.com')).toEqual([]);
  });

  it('is the model or the template, and nothing else', () => {
    expect(NudgeWordsBySchema.options).toEqual(['ai', 'template']);
    expect(NudgeWordsBySchema.safeParse('member').success).toBe(false);
  });
});
