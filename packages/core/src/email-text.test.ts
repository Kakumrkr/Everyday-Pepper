import { describe, expect, it } from 'vitest';
import { htmlToText, replyTextOf, stripQuotedReply } from './email-text.js';
import { SUPPORT_REPLY_ABOVE } from './services/support.js';
import { loadInboundFixture } from './test-support.js';

const MARK = SUPPORT_REPLY_ABOVE;
const vars = {
  from: 'ana@juniper.test',
  reply: 'reply+pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test',
  root: '<support.pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test>',
  ref: 'PEP-7K2M9Q',
};

describe('the words of an emailed reply (AC-X-34)', () => {
  it.each(['gmail-reply', 'outlook-reply', 'apple-mail-reply', 'with-images'])(
    'keeps only what the person wrote: %s',
    async (name) => {
      const fixture = await loadInboundFixture(name, vars);
      expect(replyTextOf(fixture.email, MARK)).toBe(fixture.expected);
    },
  );

  it('cuts at the "Reply above this line" marker, quoted or not', () => {
    expect(stripQuotedReply(`Yes please\n\n${MARK}\nHi Ana`, MARK)).toBe('Yes please');
    expect(stripQuotedReply(`Yes please\n> ${MARK}\n> Hi Ana`, MARK)).toBe('Yes please');
    expect(stripQuotedReply('Yes please\n-- Reply above this line to answer --\nHi', MARK)).toBe(
      'Yes please',
    );
  });

  it('cuts at a translated "wrote:" line, Outlook separators and the signature delimiter', () => {
    expect(
      stripQuotedReply('Danke!\n\nAm 8. Nov. 2026 um 10:02 schrieb Pepper:\n> Hallo', MARK),
    ).toBe('Danke!');
    expect(stripQuotedReply('Ok\n-----Original Message-----\nFrom: Pepper', MARK)).toBe('Ok');
    expect(stripQuotedReply('Ok\n________________________________\nFrom: Pepper', MARK)).toBe('Ok');
    expect(stripQuotedReply('Ok\n\n-- \nAna Ruiz\nJuniper Salon', MARK)).toBe('Ok');
    expect(stripQuotedReply('Ok\nSent from Outlook for iOS', MARK)).toBe('Ok');
  });

  it('keeps quoted lines the person wrote between their own words', () => {
    expect(stripQuotedReply('You said:\n> pull down\nI did, still empty.', MARK)).toBe(
      'You said:\n> pull down\nI did, still empty.',
    );
  });

  it('keeps a sentence that merely mentions writing', () => {
    expect(stripQuotedReply('On Monday I wrote to you about this\nStill broken', MARK)).toBe(
      'On Monday I wrote to you about this\nStill broken',
    );
  });

  it('keeps the whole text when it knows no layout (no words lost)', () => {
    expect(stripQuotedReply('Line one\nFrom: me, to you\nLine three', MARK)).toBe(
      'Line one\nFrom: me, to you\nLine three',
    );
  });

  it('turns HTML into text: no tags, scripts, styles or comments; entities decoded', () => {
    expect(
      htmlToText(
        '<html><head><title>x</title><style>p{}</style></head><body><script>alert(1)</script><!-- c --><p>Hi &amp; bye&#8217;s &#x1F600;</p><ul><li>One</li><li>Two</li></ul><img src="https://tracker.test/p.gif"></body></html>',
      ),
    ).toBe('Hi & bye’s 😀\n• One\n• Two');
    expect(htmlToText('<p>A&nbsp;B &#0; &#xD800; &bogus;</p>')).toBe('A B   &bogus;');
  });

  it('stays fast on hostile HTML and long lines', () => {
    const started = performance.now();
    htmlToText('<style'.repeat(200_000));
    htmlToText('<'.repeat(1_000_000));
    htmlToText('<!--'.repeat(200_000));
    htmlToText(`${'<div '.repeat(300_000)}gmail_quote`);
    stripQuotedReply(`On ${'x '.repeat(400_000)}wrote`, MARK);
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(htmlToText('a<b')).toBe('a');
    expect(htmlToText('<p>a</p><style>x')).toBe('a');
  });

  it('looks for the quote in the body only, not in the head’s styles', () => {
    expect(
      htmlToText(
        '<html><head><style>div.gmail_quote{color:gray} .yahoo_quoted{}</style></head><body><p>Still empty on Tuesdays</p><div class="gmail_quote">On … wrote:</div></body></html>',
      ),
    ).toBe('Still empty on Tuesdays');
  });

  it('uses the HTML only when the text part is missing or blank', () => {
    expect(replyTextOf({ text: '  ', html: '<p>From HTML</p>' }, MARK)).toBe('From HTML');
    expect(replyTextOf({ text: null, html: null }, MARK)).toBe('');
    expect(replyTextOf({ text: 'Plain\u0007 text', html: '<p>HTML</p>' }, MARK)).toBe('Plain text');
  });
});
