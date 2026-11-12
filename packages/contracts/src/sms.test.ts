import { describe, expect, it } from 'vitest';
import {
  classifySmsKeyword,
  normalizeSmsText,
  OutboxSmsSchema,
  SMS_CONSENT_WORDING,
  SMS_MAX_SEGMENTS,
  smsConsentText,
  smsDeliveryStatusOf,
  smsKeywordReply,
  SmsPhoneSchema,
  smsSegments,
  smsSendableAt,
  smsStatusCallbackUrl,
  smsStatusMovesForward,
  TwilioInboundSmsSchema,
  type SmsDeliveryStatus,
} from './sms.js';

describe('SmsPhoneSchema (ADR-0065)', () => {
  it.each(['+15551234567', '+14165550123', ' +12125550199 '])('accepts %s', (phone) => {
    expect(SmsPhoneSchema.parse(phone)).toBe(phone.trim());
  });

  it.each(['+442071234567', '+1555123456', '+10551234567', '5551234567', ''])(
    'refuses %s',
    (phone) => {
      expect(SmsPhoneSchema.safeParse(phone).success).toBe(false);
    },
  );
});

describe('GSM-7 text and segments (AC-X-63)', () => {
  it('turns look-alike characters into their plain forms', () => {
    expect(normalizeSmsText('“See you” — it’s at 3–4pm… ok​')).toBe(
      '"See you" - it\'s at 3-4pm... ok',
    );
    expect(normalizeSmsText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('keeps a normalised AI-style text in GSM-7, where the raw one would be UCS-2', () => {
    const raw = 'Hi Sam — your trim’s tomorrow at 2:30. Reply C to confirm.';
    expect(smsSegments(raw).encoding).toBe('ucs2');
    expect(smsSegments(normalizeSmsText(raw))).toEqual({
      encoding: 'gsm7',
      units: 58,
      segments: 1,
    });
  });

  it('counts GSM-7 segments at 160 alone and 153 a part', () => {
    expect(smsSegments('a'.repeat(160))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
  });

  it('counts an extension character as two septets', () => {
    expect(smsSegments('€'.repeat(80))).toEqual({ encoding: 'gsm7', units: 160, segments: 1 });
    expect(smsSegments(`${'€'.repeat(80)}a`).segments).toBe(2);
  });

  it('counts UCS-2 at 70 alone and 67 a part, an emoji as two units', () => {
    expect(smsSegments('✂'.repeat(70))).toEqual({ encoding: 'ucs2', units: 70, segments: 1 });
    expect(smsSegments('✂'.repeat(71)).segments).toBe(2);
    expect(smsSegments('💈').units).toBe(2);
  });

  it('queues a text normalised, and refuses one over the segment limit or empty', () => {
    const sms = OutboxSmsSchema.parse({ to: '+15551234567', body: '  It’s confirmed  ' });
    expect(sms).toEqual({ to: '+15551234567', body: "It's confirmed" });
    expect(
      OutboxSmsSchema.safeParse({ to: '+15551234567', body: 'a'.repeat(153 * SMS_MAX_SEGMENTS) })
        .success,
    ).toBe(true);
    expect(
      OutboxSmsSchema.safeParse({
        to: '+15551234567',
        body: 'a'.repeat(153 * SMS_MAX_SEGMENTS + 1),
      }).success,
    ).toBe(false);
    expect(OutboxSmsSchema.safeParse({ to: '+15551234567', body: ' ​ ' }).success).toBe(false);
  });

  it('keeps `urgent` to true or absent, and nothing else in the content', () => {
    expect(OutboxSmsSchema.safeParse({ to: '+15551234567', body: 'x', urgent: true }).success).toBe(
      true,
    );
    expect(
      OutboxSmsSchema.safeParse({ to: '+15551234567', body: 'x', urgent: false }).success,
    ).toBe(false);
    expect(
      OutboxSmsSchema.safeParse({ to: '+15551234567', body: 'x', from: '+15550000000' }).success,
    ).toBe(false);
  });
});

describe('classifySmsKeyword (AC-X-59)', () => {
  it.each([
    'STOP',
    'stop',
    ' Stop. ',
    'STOP!!',
    'StopAll',
    'UNSUBSCRIBE',
    'cancel',
    'END',
    'quit',
    'OPTOUT',
    'opt out',
    'Opt-out',
    'REVOKE',
    'Stop texting me',
    'stop please',
    'unsubscribe me',
    'Opt out of these',
    'ｓｔｏｐ',
  ])('reads %j as STOP', (body) => {
    expect(classifySmsKeyword(body)).toBe('stop');
  });

  it.each(['START', 'start', 'Unstop', 'YES', 'yes!'])('reads %j as START', (body) => {
    expect(classifySmsKeyword(body)).toBe('start');
  });

  it.each(['HELP', 'help?', 'Info'])('reads %j as HELP', (body) => {
    expect(classifySmsKeyword(body)).toBe('help');
  });

  it.each([
    '',
    '   ',
    'C',
    'Y',
    'Thanks!',
    'Cancel my 3pm please',
    'I want to end early',
    'Can I stop by at 3',
    'Help me move my appointment to Friday please thanks',
    'stop and think about how great that haircut was today friend',
  ])('reads %j as no keyword', (body) => {
    expect(classifySmsKeyword(body)).toBeNull();
  });
});

describe('the keyword replies and consent wording', () => {
  it('says who texts, how to stop and that rates apply, in at most two segments each', () => {
    const help = smsKeywordReply('help', 'https://app.example.com/help');
    expect(help).toContain('Reply STOP');
    expect(help).toContain('Msg & data rates may apply');
    expect(help).toContain('https://app.example.com/help');
    expect(smsKeywordReply('stop', 'x')).toContain('START');
    expect(smsKeywordReply('start', 'x')).toContain('STOP');
    for (const keyword of ['stop', 'start', 'help'] as const) {
      const reply = smsKeywordReply(keyword, 'https://app.example.com/help');
      expect(smsSegments(reply)).toMatchObject({ encoding: 'gsm7' });
      expect(smsSegments(reply).segments).toBeLessThanOrEqual(2);
    }
  });

  it('puts the business in the consent wording, with STOP, HELP, rates and "not required"', () => {
    const text = smsConsentText('sms-consent-v1', ' Fade Bros ');
    expect(text).toContain('from Fade Bros at this number');
    expect(text).toMatch(/STOP.*HELP/);
    expect(text).toContain('Msg & data rates may apply');
    expect(text).toContain('Not required to book');
    expect(Object.keys(SMS_CONSENT_WORDING)).toEqual(['sms-consent-v1']);
  });
});

describe('delivery status (AC-X-62)', () => {
  it('maps Twilio statuses, and knows none of the others', () => {
    expect(smsDeliveryStatusOf('accepted')).toBe('queued');
    expect(smsDeliveryStatusOf('scheduled')).toBe('queued');
    expect(smsDeliveryStatusOf('delivered')).toBe('delivered');
    expect(smsDeliveryStatusOf('read')).toBe('delivered');
    expect(smsDeliveryStatusOf('receiving')).toBeNull();
  });

  it('moves only forwards, and a final status stays', () => {
    const moves: [SmsDeliveryStatus, SmsDeliveryStatus, boolean][] = [
      ['queued', 'sent', true],
      ['sent', 'sending', false],
      ['sent', 'delivered', true],
      ['delivered', 'failed', false],
      ['undelivered', 'delivered', false],
      ['sent', 'sent', false],
    ];
    for (const [current, next, expected] of moves) {
      expect(smsStatusMovesForward(current, next)).toBe(expected);
    }
  });
});

describe('TwilioInboundSmsSchema', () => {
  it('reads the fields Pepper needs and lets the others through for the signature', () => {
    const parsed = TwilioInboundSmsSchema.parse({
      MessageSid: `SM${'a'.repeat(32)}`,
      AccountSid: `AC${'b'.repeat(32)}`,
      From: '+15551234567',
      To: '+15557654321',
      NumMedia: '0',
    });
    expect(parsed.Body).toBe('');
    expect(TwilioInboundSmsSchema.safeParse({ ...parsed, MessageSid: 'SM1' }).success).toBe(false);
  });
});

describe('smsSendableAt (AC-X-60)', () => {
  const NY = 'America/New_York';
  const at = (iso: string) => new Date(iso).getTime();
  const iso = (instant: number) => new Date(instant).toISOString();

  it('lets a text go at once inside 8:00–20:00 there', () => {
    expect(iso(smsSendableAt(NY, at('2026-11-12T13:00:00Z')))).toBe('2026-11-12T13:00:00.000Z'); // 8:00
    expect(iso(smsSendableAt(NY, at('2026-11-13T00:59:59Z')))).toBe('2026-11-13T00:59:59.000Z'); // 19:59
  });

  it('holds an early one until 8:00 the same day, a late one until 8:00 the next', () => {
    expect(iso(smsSendableAt(NY, at('2026-11-12T12:59:00Z')))).toBe('2026-11-12T13:00:00.000Z'); // 7:59
    expect(iso(smsSendableAt(NY, at('2026-11-13T01:00:00Z')))).toBe('2026-11-13T13:00:00.000Z'); // 20:00
    expect(iso(smsSendableAt(NY, at('2026-11-13T04:59:00Z')))).toBe('2026-11-13T13:00:00.000Z'); // 23:59
    expect(iso(smsSendableAt(NY, at('2026-11-13T05:00:00Z')))).toBe('2026-11-13T13:00:00.000Z'); // 0:00
  });

  it('is 8:00 on the business’s clock on daylight-saving days', () => {
    // Spring forward (Mar 8, 2026): 8:00 EDT is 12:00 UTC; the evening before was EST.
    expect(iso(smsSendableAt(NY, at('2026-03-08T02:00:00Z')))).toBe('2026-03-08T12:00:00.000Z');
    // Fall back (Nov 1, 2026): 8:00 EST is 13:00 UTC; the evening before was EDT.
    expect(iso(smsSendableAt(NY, at('2026-11-01T01:30:00Z')))).toBe('2026-11-01T13:00:00.000Z');
  });

  it('follows the business’s own zone', () => {
    // 7:00 in Los Angeles is 10:00 in New York.
    expect(iso(smsSendableAt('America/Los_Angeles', at('2026-11-12T15:00:00Z')))).toBe(
      '2026-11-12T16:00:00.000Z',
    );
    expect(iso(smsSendableAt(NY, at('2026-11-12T15:00:00Z')))).toBe('2026-11-12T15:00:00.000Z');
  });

  it('builds the signed status URL with the business and the message', () => {
    expect(smsStatusCallbackUrl('https://app.example.com', 't-1', 'm-2')).toBe(
      'https://app.example.com/v1/webhooks/sms/status?t=t-1&m=m-2',
    );
  });
});
