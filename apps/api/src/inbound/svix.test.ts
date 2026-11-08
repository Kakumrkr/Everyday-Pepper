import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { svixKeyOf, verifySvix } from './svix.js';

const SECRET = `whsec_${Buffer.from('a-test-webhook-signing-key-32-bytes!').toString('base64')}`;
const key = svixKeyOf(SECRET) ?? Buffer.alloc(0);
const body = Buffer.from('{"type":"email.received","data":{"email_id":"e1"}}');
const now = new Date('2026-11-08T10:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const sign = (id: string, timestamp: string, payload: Buffer, k = key) =>
  `v1,${createHmac('sha256', k).update(`${id}.${timestamp}.`).update(payload).digest('base64')}`;

describe('Svix signatures (AC-X-33)', () => {
  it('reads a whsec_ secret and refuses anything else', () => {
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(svixKeyOf('not-a-secret')).toBeNull();
    expect(svixKeyOf('whsec_c2hvcnQ=')).toBeNull();
  });

  it('accepts the signed body, also among several signatures', () => {
    const signature = sign('msg_1', ts, body);
    expect(verifySvix(key, { id: 'msg_1', timestamp: ts, signature }, body, now)).toBe(true);
    expect(
      verifySvix(key, { id: 'msg_1', timestamp: ts, signature: `v1,AAAA ${signature}` }, body, now),
    ).toBe(true);
  });

  it('refuses another body, id, key or version, and missing headers', () => {
    const signature = sign('msg_1', ts, body);
    const other = Buffer.from(`${body.toString()} `);
    expect(verifySvix(key, { id: 'msg_1', timestamp: ts, signature }, other, now)).toBe(false);
    expect(verifySvix(key, { id: 'msg_2', timestamp: ts, signature }, body, now)).toBe(false);
    const otherKey = Buffer.from('another-webhook-signing-key-32-bytes');
    expect(
      verifySvix(
        key,
        { id: 'msg_1', timestamp: ts, signature: sign('msg_1', ts, body, otherKey) },
        body,
        now,
      ),
    ).toBe(false);
    expect(
      verifySvix(
        key,
        { id: 'msg_1', timestamp: ts, signature: signature.replace('v1,', 'v2,') },
        body,
        now,
      ),
    ).toBe(false);
    expect(verifySvix(key, { id: undefined, timestamp: ts, signature }, body, now)).toBe(false);
    expect(verifySvix(key, { id: 'msg_1', timestamp: 'soon', signature }, body, now)).toBe(false);
  });

  it('refuses a timestamp more than 5 minutes away (a replay)', () => {
    const old = String(Number(ts) - 301);
    expect(
      verifySvix(
        key,
        { id: 'msg_1', timestamp: old, signature: sign('msg_1', old, body) },
        body,
        now,
      ),
    ).toBe(false);
    const edge = String(Number(ts) - 299);
    expect(
      verifySvix(
        key,
        { id: 'msg_1', timestamp: edge, signature: sign('msg_1', edge, body) },
        body,
        now,
      ),
    ).toBe(true);
  });
});
