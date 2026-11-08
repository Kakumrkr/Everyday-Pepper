import { describe, expect, it } from 'vitest';
import { outboxKeyFrom } from './outbox.js';
import {
  findSupportReference,
  readSupportReplyToken,
  supportReplyAddress,
  supportReplyKeysFrom,
  supportReplyToken,
  supportThreadRootId,
} from './support-reply-address.js';

const keys = supportReplyKeysFrom(outboxKeyFrom('a-test-outbox-secret-of-32-characters!'));
const other = supportReplyKeysFrom(outboxKeyFrom('another-outbox-secret-of-32-characters'));
const DOMAIN = 'reply.pepper.test';

describe('support reply addresses (AC-X-32)', () => {
  it('names the request, in lowercase base32, under 64 characters before the @', () => {
    const address = supportReplyAddress(keys, 'PEP-7K2M9Q', 'Reply.Pepper.Test');
    expect(address).toMatch(/^reply\+pep-7k2m9q-1-[a-z2-7]{20}@reply\.pepper\.test$/);
    expect(address.split('@')[0]?.length).toBeLessThan(64);
    expect(readSupportReplyToken(keys, supportReplyToken(keys, 'PEP-7K2M9Q'))).toBe('PEP-7K2M9Q');
  });

  it('is the same address every time, and reads whatever case a server gives it', () => {
    const token = supportReplyToken(keys, 'PEP-7K2M9Q');
    expect(supportReplyToken(keys, 'PEP-7K2M9Q')).toBe(token);
    expect(readSupportReplyToken(keys, token.toUpperCase())).toBe('PEP-7K2M9Q');
  });

  it('refuses another key, another reference with the old signature, a cut or made-up token', () => {
    const token = supportReplyToken(keys, 'PEP-7K2M9Q');
    expect(readSupportReplyToken(other, token)).toBeNull();
    expect(readSupportReplyToken(keys, token.replace('pep-7k2m9q', 'pep-7k2m9r'))).toBeNull();
    expect(readSupportReplyToken(keys, token.slice(0, -1))).toBeNull();
    expect(readSupportReplyToken(keys, `${token.slice(0, -1)}a`)).not.toBe('PEP-7K2M9Q');
    expect(readSupportReplyToken(keys, 'pep-7k2m9q-1-aaaaaaaaaaaaaaaaaaaa')).toBeNull();
    expect(readSupportReplyToken(keys, '../etc/passwd')).toBeNull();
  });

  it('refuses a key version it does not hold', () => {
    const token = supportReplyToken(keys, 'PEP-7K2M9Q').replace('-1-', '-2-');
    expect(readSupportReplyToken(keys, token)).toBeNull();
  });

  it('refuses anything that is not a reference', () => {
    expect(() => supportReplyToken(keys, 'PEP-ILOU00')).toThrow(RangeError);
    expect(() => supportReplyToken(keys, 'nope')).toThrow(RangeError);
  });

  it('finds the request by its address first, then by the root id in the headers', () => {
    const address = supportReplyAddress(keys, 'PEP-7K2M9Q', DOMAIN);
    const root = supportThreadRootId(keys, 'PEP-AB12CD', DOMAIN);
    expect(root).toMatch(/^<support\.pep-ab12cd-1-[a-z2-7]{20}@reply\.pepper\.test>$/);
    expect(
      findSupportReference(keys, DOMAIN, {
        recipients: ['team@pepper.test', address.toUpperCase()],
        inReplyTo: root,
        references: [],
      }),
    ).toBe('PEP-7K2M9Q');
    expect(
      findSupportReference(keys, DOMAIN, {
        recipients: ['support@pepper.test'],
        inReplyTo: '<abc@mail.gmail.com>',
        references: ['<x@y>', root],
      }),
    ).toBe('PEP-AB12CD');
  });

  it('counts only addresses and ids on the inbound domain, with a valid signature', () => {
    const token = supportReplyToken(keys, 'PEP-7K2M9Q');
    expect(
      findSupportReference(keys, DOMAIN, {
        recipients: [`reply+${token}@evil.test`, `reply+${token.slice(0, -2)}xx@${DOMAIN}`],
        inReplyTo: `<support.${token}@evil.test>`,
        references: [`<support.${supportReplyToken(other, 'PEP-7K2M9Q')}@${DOMAIN}>`],
      }),
    ).toBeNull();
  });
});
