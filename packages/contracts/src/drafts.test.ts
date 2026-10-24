import { describe, expect, it } from 'vitest';
import {
  DRAFT_LIMITS,
  EditDraftRequestSchema,
  looksLikeLink,
  MailingAddressSchema,
  NudgeDraftSchema,
  UnsubscribeTokenSchema,
  wordCount,
} from './drafts.js';
import { FeedSettingsChangeSchema } from './feed.js';
import { OutboxEmailSchema } from './outbox.js';
import { TemplateSchema } from './templates.js';
import { WouldBeEmailSchema } from './tool-cards.js';

const draft = {
  subject: '  Time for your next   haircut? ',
  body: 'Hi Sara,\r\n\r\n\r\nIt has been a while since your last haircut. Jess has an opening tomorrow.',
};

describe('nudge drafts', () => {
  it('keeps a short draft, with one-line subject and tidy paragraphs', () => {
    expect(NudgeDraftSchema.parse(draft)).toEqual({
      subject: 'Time for your next haircut?',
      body: 'Hi Sara,\n\nIt has been a while since your last haircut. Jess has an opening tomorrow.',
    });
  });

  it('refuses more than the word limit', () => {
    const body = Array.from({ length: DRAFT_LIMITS.maxWords + 1 }, () => 'word').join(' ');
    expect(NudgeDraftSchema.safeParse({ ...draft, body }).success).toBe(false);
    const fits = Array.from({ length: DRAFT_LIMITS.maxWords }, () => 'word').join(' ');
    expect(NudgeDraftSchema.safeParse({ ...draft, body: fits }).success).toBe(true);
  });

  it.each([
    ['a web address', 'Book at https://evil.example/now'],
    ['www', 'See www.juniper-offers.com'],
    ['a bare domain', 'Visit juniper-hair.com to book'],
    ['an email address', 'Write to sara@example.test'],
    ['a phone number', 'Call +1 212 555 0143'],
  ])('refuses %s in the words', (_, text) => {
    expect(NudgeDraftSchema.safeParse({ ...draft, body: text }).success).toBe(false);
    expect(NudgeDraftSchema.safeParse({ ...draft, subject: text }).success).toBe(false);
  });

  it('does not take ordinary sentences for links', () => {
    expect(looksLikeLink('See you soon. It was lovely, e.g. the new colour.')).toBe(false);
    expect(wordCount(' one  two\nthree ')).toBe(3);
  });

  it('refuses an empty subject or body', () => {
    expect(NudgeDraftSchema.safeParse({ subject: ' ', body: 'Hi' }).success).toBe(false);
    expect(NudgeDraftSchema.safeParse({ subject: 'Hi', body: '\n\n' }).success).toBe(false);
  });

  it('edits carry the shown fingerprint', () => {
    expect(
      EditDraftRequestSchema.safeParse({ fingerprint: 'f'.repeat(64), subject: 'a', body: 'b' })
        .success,
    ).toBe(true);
    expect(EditDraftRequestSchema.safeParse({ subject: 'a', body: 'b' }).success).toBe(false);
  });
});

describe('mailing address', () => {
  it('tidies lines and keeps at most four', () => {
    expect(MailingAddressSchema.parse('  12 Main  St\n\n Springfield, IL 62701 ')).toBe(
      '12 Main St\nSpringfield, IL 62701',
    );
    expect(MailingAddressSchema.safeParse('a\nb\nc\nd\ne').success).toBe(false);
    expect(MailingAddressSchema.safeParse('x').success).toBe(false);
  });

  it('refuses a contact in place of an address', () => {
    expect(MailingAddressSchema.safeParse('owner@example.test').success).toBe(false);
  });

  it('is one of the feed switches, and null takes it away', () => {
    expect(FeedSettingsChangeSchema.parse({ mailingAddress: null })).toEqual({
      mailingAddress: null,
    });
    expect(FeedSettingsChangeSchema.safeParse({ mailingAddress: 'x' }).success).toBe(false);
  });
});

describe('unsubscribe and the email it rides on', () => {
  it('takes base64url tokens only', () => {
    expect(UnsubscribeTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(UnsubscribeTokenSchema.safeParse('short').success).toBe(false);
    expect(UnsubscribeTokenSchema.safeParse(`${'A'.repeat(43)}/../`).success).toBe(false);
  });

  it('an email may carry an http(s) unsubscribe address, nothing else', () => {
    const email = { to: 'sara@example.test', subject: 'Hi', text: 'Body' };
    expect(
      OutboxEmailSchema.safeParse({ ...email, unsubscribeUrl: 'https://api.test/v1/x' }).success,
    ).toBe(true);
    expect(
      OutboxEmailSchema.safeParse({ ...email, unsubscribeUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
  });

  it('the cards know the nudge email', () => {
    expect(WouldBeEmailSchema.shape.template.options).toContain('rebooking_nudge');
  });
});

describe('template drafts', () => {
  it('defaults to the platform voice at 7 in the morning', () => {
    expect(TemplateSchema.shape.drafts.parse(undefined)).toEqual({
      voice: expect.any(String) as string,
      morningHour: 7,
    });
  });
});
