import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { twilioSignatureOf, verifyTwilioSignature } from './twilio-signature.js';

// Twilio's signature scheme as its security documentation describes it (S61, AC-X-61): the URL,
// then each field's name and value sorted by name, HMAC-SHA1 with the auth token, base64.

const TOKEN = '0123456789abcdef0123456789abcdef';
const URL_ = 'https://app.example.test/v1/webhooks/sms';
const FIELDS: [string, string][] = [
  ['To', '+15557654321'],
  ['Body', 'STOP'],
  ['From', '+15552340001'],
  ['MessageSid', `SM${'a'.repeat(32)}`],
  ['AccountSid', `AC${'b'.repeat(32)}`],
];

describe('twilioSignatureOf', () => {
  it('signs the URL followed by the fields sorted by name', () => {
    const data =
      `${URL_}AccountSidAC${'b'.repeat(32)}BodySTOP` +
      `From+15552340001MessageSidSM${'a'.repeat(32)}To+15557654321`;
    expect(twilioSignatureOf(TOKEN, URL_, FIELDS)).toBe(
      createHmac('sha1', TOKEN).update(data).digest('base64'),
    );
  });

  it('sorts a repeated field by its values', () => {
    expect(
      twilioSignatureOf(TOKEN, URL_, [
        ['A', '2'],
        ['A', '1'],
      ]),
    ).toBe(createHmac('sha1', TOKEN).update(`${URL_}A1A2`).digest('base64'));
  });
});

describe('verifyTwilioSignature', () => {
  const good = twilioSignatureOf(TOKEN, URL_, FIELDS);

  it('accepts Twilio’s signature, in any field order', () => {
    expect(verifyTwilioSignature(TOKEN, URL_, [...FIELDS].reverse(), good)).toBe(true);
  });

  it('refuses another token, URL, field or value, and a missing or odd signature', () => {
    expect(verifyTwilioSignature('f'.repeat(32), URL_, FIELDS, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, `${URL_}?x=1`, FIELDS, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, [...FIELDS, ['NumMedia', '0']], good)).toBe(false);
    const tampered = FIELDS.map(([k, v]): [string, string] => [k, k === 'Body' ? 'START' : v]);
    expect(verifyTwilioSignature(TOKEN, URL_, tampered, good)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, FIELDS, undefined)).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, FIELDS, '')).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, FIELDS, 'x'.repeat(201))).toBe(false);
    expect(verifyTwilioSignature(TOKEN, URL_, FIELDS, good.slice(0, -4))).toBe(false);
  });
});
