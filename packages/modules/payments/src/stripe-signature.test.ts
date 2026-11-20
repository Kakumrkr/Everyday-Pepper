import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  stripeSignature,
  stripeSignatureHeader,
  verifyStripeSignature,
} from './stripe-signature.js';

const SECRET = 'whsec_test_5f3a1c9e7b2d4f6a8c0e1b3d5f7a9c2e';
const OTHER = 'whsec_test_0000000000000000000000000000000000';
const NOW = new Date('2026-11-20T15:00:00Z');
const T = Math.floor(NOW.getTime() / 1000);
const BODY = Buffer.from('{"id":"evt_1","object":"event","type":"account.updated"}', 'utf8');

function check(header: string | undefined, now = NOW, payload = BODY) {
  return verifyStripeSignature({ secret: SECRET, payload, header, now });
}

describe('verifyStripeSignature (AC-X-95)', () => {
  it('signs "<t>.<raw body>" with HMAC-SHA256 under the whole secret, in hex', () => {
    // Independent of the code under test: the documented recipe, spelled out.
    const expected = createHmac('sha256', SECRET)
      .update(`${String(T)}.${BODY.toString('utf8')}`)
      .digest('hex');
    expect(stripeSignature(SECRET, T, BODY)).toBe(expected);
    expect(stripeSignatureHeader(SECRET, BODY, NOW)).toBe(`t=${String(T)},v1=${expected}`);
  });

  it('accepts Stripe’s header in any order, with v0 and debug entries beside it', () => {
    const v1 = stripeSignature(SECRET, T, BODY);
    expect(check(`t=${String(T)},v1=${v1}`)).toBe(true);
    expect(
      check(
        `v0=${'a'.repeat(64)},secret=whsec_x,v1=${v1},destination=we_1,t=${String(T)},payload=a25a`,
      ),
    ).toBe(true);
  });

  it('accepts any v1, so a secret being rolled keeps working', () => {
    const old = stripeSignature(OTHER, T, BODY);
    const current = stripeSignature(SECRET, T, BODY);
    expect(check(`t=${String(T)},v1=${old},v1=${current}`)).toBe(true);
    expect(check(`t=${String(T)},v1=${current},v1=${old}`)).toBe(true);
  });

  it('refuses another secret, a changed body and a v0 alone', () => {
    expect(check(`t=${String(T)},v1=${stripeSignature(OTHER, T, BODY)}`)).toBe(false);
    const changed = Buffer.from(BODY.toString('utf8').replace('updated', 'deleted'));
    expect(check(`t=${String(T)},v1=${stripeSignature(SECRET, T, BODY)}`, NOW, changed)).toBe(
      false,
    );
    expect(check(`t=${String(T)},v0=${stripeSignature(SECRET, T, BODY)}`)).toBe(false);
  });

  it('refuses a signature for another timestamp than the header’s', () => {
    expect(check(`t=${String(T)},v1=${stripeSignature(SECRET, T - 1, BODY)}`)).toBe(false);
  });

  it('refuses a timestamp more than 5 minutes off, either way (replay)', () => {
    const at = (seconds: number) =>
      `t=${String(T + seconds)},v1=${stripeSignature(SECRET, T + seconds, BODY)}`;
    expect(check(at(-300))).toBe(true);
    expect(check(at(300))).toBe(true);
    expect(check(at(-301))).toBe(false);
    expect(check(at(301))).toBe(false);
    expect(
      verifyStripeSignature({
        secret: SECRET,
        payload: BODY,
        header: at(-30),
        now: NOW,
        toleranceSeconds: 10,
      }),
    ).toBe(false);
  });

  it('refuses headers that aren’t Stripe’s shape', () => {
    const v1 = stripeSignature(SECRET, T, BODY);
    for (const header of [
      undefined,
      '',
      v1,
      `v1=${v1}`,
      `t=${String(T)}`,
      `t=${String(T)},t=${String(T)},v1=${v1}`,
      `t=abc,v1=${v1}`,
      `t=${String(T)},v1=${v1.toUpperCase()}`,
      `t=${String(T)},v1=${v1.slice(0, 63)}`,
      `t=${String(T)},v1=${v1}${'0'.repeat(2)}`,
      `t=${String(T)},v1=${v1},${'x'.repeat(5000)}`,
    ]) {
      expect(check(header), String(header).slice(0, 40)).toBe(false);
    }
  });
});
