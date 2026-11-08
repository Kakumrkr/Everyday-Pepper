import { describe, expect, it } from 'vitest';
import { isAutoReply, isSpam, messageIdsOf, senderVerdict } from './inbound-email.js';
import { loadInboundFixture } from './test-support.js';

const vars = {
  from: 'ana@juniper.test',
  reply: 'reply+pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test',
  root: '<support.pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test>',
  ref: 'PEP-7K2M9Q',
};
const header = (name: string, value: string) => ({ name, value });
const SES = 'amazonses.com';

describe('auto-replies and spam (AC-X-35)', () => {
  it('knows an auto-reply by its headers or its subject', async () => {
    expect(isAutoReply((await loadInboundFixture('auto-reply', vars)).email)).toBe(true);
    expect(isAutoReply((await loadInboundFixture('gmail-reply', vars)).email)).toBe(false);
    const email = (headers: { name: string; value: string }[], subject = 'Re: hi') => ({
      headers,
      subject,
    });
    expect(isAutoReply(email([header('Auto-Submitted', 'no')]))).toBe(false);
    expect(isAutoReply(email([header('auto-submitted', 'auto-generated')]))).toBe(true);
    expect(isAutoReply(email([header('X-Autoreply', 'yes')]))).toBe(true);
    expect(isAutoReply(email([header('X-Autorespond', 'yes')]))).toBe(true);
    expect(isAutoReply(email([header('Precedence', 'bulk')]))).toBe(true);
    expect(isAutoReply(email([header('Precedence', 'first-class')]))).toBe(false);
    expect(isAutoReply(email([header('X-Auto-Response-Suppress', 'All')]))).toBe(true);
    expect(isAutoReply(email([], 'Out of Office: back Monday'))).toBe(true);
    expect(isAutoReply(email([], 'RE: Automatic reply: hello'))).toBe(true);
    expect(isAutoReply(email([], 'Re: Office hours question'))).toBe(false);
  });

  it('knows the receiving server’s spam and virus verdicts', async () => {
    expect(isSpam((await loadInboundFixture('spam', vars)).email)).toBe(true);
    expect(isSpam({ headers: [header('X-SES-Virus-Verdict', 'FAIL')] })).toBe(true);
    expect(isSpam({ headers: [header('X-Spam-Flag', 'YES')] })).toBe(true);
    expect(isSpam({ headers: [header('X-SES-Spam-Verdict', 'PASS')] })).toBe(false);
  });
});

describe('the sender check (ADR-0063 §4)', () => {
  it('passes the fixtures from Gmail, Outlook and Apple Mail', async () => {
    for (const name of ['gmail-reply', 'outlook-reply', 'apple-mail-reply']) {
      expect(senderVerdict((await loadInboundFixture(name, vars)).email, SES)).toBe('pass');
    }
  });

  it('fails a spoofed From, whatever a header below the receiver’s says', async () => {
    expect(senderVerdict((await loadInboundFixture('spoofed', vars)).email, SES)).toBe('fail');
  });

  it('knows nothing without the receiver’s own header, or without the setting', async () => {
    const gmail = (await loadInboundFixture('gmail-reply', vars)).email;
    expect(senderVerdict(gmail, null)).toBe('unknown');
    expect(senderVerdict(gmail, 'mx.google.com')).toBe('unknown');
    expect(senderVerdict({ from: 'a@b.test', headers: [] }, SES)).toBe('unknown');
  });

  it('takes DMARC for the From domain, or an aligned DKIM signature', () => {
    const verdict = (value: string, from = 'ana@mail.juniper.test') =>
      senderVerdict({ from, headers: [header('Authentication-Results', value)] }, SES);
    expect(verdict(`${SES}; dmarc=pass header.from=mail.juniper.test`)).toBe('pass');
    expect(verdict(`${SES}; dmarc=pass header.from=other.test`)).toBe('fail');
    expect(verdict(`${SES}; dmarc=pass`)).toBe('fail');
    expect(verdict(`${SES}; dkim=pass header.d=juniper.test`)).toBe('pass');
    expect(verdict(`${SES}; dkim=pass header.i=@mail.juniper.test`)).toBe('pass');
    expect(verdict(`${SES}; dkim=pass header.d=sendgrid.net`)).toBe('fail');
    expect(verdict(`${SES}; dkim=fail header.d=juniper.test; spf=pass`)).toBe('fail');
    expect(verdict(`AMAZONSES.COM; DMARC=PASS header.from=MAIL.JUNIPER.TEST`)).toBe('pass');
    // A result smuggled in through a value the server copied from the sender counts for nothing,
    // and a DMARC failure for the From domain decides.
    expect(
      verdict(
        `${SES}; spf=pass smtp.mailfrom="a;dkim=pass header.d=mail.juniper.test b"@evil.test; dmarc=fail header.from=mail.juniper.test`,
      ),
    ).toBe('fail');
    expect(
      verdict(
        `${SES}; spf=pass (sender "x;dkim=pass header.d=juniper.test") smtp.mailfrom=evil.test; dkim=none`,
      ),
    ).toBe('fail');
    expect(
      verdict(`${SES}; dkim=pass header.d=juniper.test; dmarc=fail header.from=mail.juniper.test`),
    ).toBe('fail');
  });
});

describe('References', () => {
  it('splits the ids of a header', () => {
    expect(messageIdsOf('<a@x> <b@y>\r\n <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
    expect(messageIdsOf(null)).toEqual([]);
    expect(messageIdsOf('garbage')).toEqual([]);
  });
});
