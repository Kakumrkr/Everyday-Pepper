import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { PushRejectedError } from '@pepper/core';
import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import { PushEndpointNotAllowedError, WebPusher } from './web-pusher.js';

// The device's side of Web Push (RFC 8291): its key pair and auth secret, and how it opens a
// message, so the test proves a browser could read what we send.
const device = createECDH('prime256v1');
device.generateKeys();
const auth = randomBytes(16);
const keys = {
  p256dh: device.getPublicKey().toString('base64url'),
  auth: auth.toString('base64url'),
};
const vapid = webpush.generateVAPIDKeys();
const config = { ...vapid, subject: 'mailto:bookings@pepper.localhost' };
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** Opens an `aes128gcm` Web Push body as the device would. */
function open(body: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const shared = device.computeSecret(serverKey);
  const prkKey = hmac(auth, shared);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    device.getPublicKey(),
    serverKey,
    Buffer.from([1]),
  ]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const padded = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ]);
  // The last record ends with the 0x02 delimiter, then any padding zeros.
  return padded.subarray(0, padded.lastIndexOf(2)).toString('utf8');
}

function capture(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(new Response(null, { status }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const message = {
  endpoint: ENDPOINT,
  keys,
  payload: JSON.stringify({
    title: 'New booking',
    body: 'Haircut, Tue 10:00 AM',
    url: '/calendar',
  }),
  ttlSeconds: 86_400,
};

describe('WebPusher (ADR-0026)', () => {
  it('posts the payload encrypted to the device, readable only with its keys', async () => {
    const { fetch, calls } = capture();
    await new WebPusher(config, fetch).send(message);

    const [call] = calls;
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('content-encoding')).toBe('aes128gcm');
    expect(headers.get('ttl')).toBe('86400');
    expect(headers.get('urgency')).toBe('normal');
    const body = Buffer.from(call?.init.body as Uint8Array);
    expect(body.toString('utf8')).not.toContain('Haircut');
    expect(open(body)).toBe(message.payload);
  });

  it('signs a VAPID JWT for the push service with our key', async () => {
    const { fetch, calls } = capture();
    await new WebPusher(config, fetch).send(message);
    const authorization = new Headers(calls[0]?.init.headers).get('authorization');
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization ?? '');
    expect(match?.[2]).toBe(vapid.publicKey);
    const [header = '', claims = '', signature = ''] = (match?.[1] ?? '').split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'mailto:bookings@pepper.localhost',
    });
    const point = Buffer.from(vapid.publicKey, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${claims}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('passes a topic, and refuses with the push service status', async () => {
    const { fetch, calls } = capture();
    await new WebPusher(config, fetch).send({ ...message, topic: 'task123' });
    expect(new Headers(calls[0]?.init.headers).get('topic')).toBe('task123');

    for (const status of [410, 429, 500]) {
      await expect(new WebPusher(config, capture(status).fetch).send(message)).rejects.toEqual(
        new PushRejectedError(status),
      );
    }
  });

  it('never calls an endpoint that is not a known push service (refused for good)', async () => {
    const { fetch, calls } = capture();
    for (const endpoint of [
      'https://internal.example.test/admin',
      'https://fcm.googleapis.com:8443/x',
      'http://fcm.googleapis.com/x',
    ]) {
      const error = await new WebPusher(config, fetch)
        .send({ ...message, endpoint })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PushEndpointNotAllowedError);
      expect(error).toMatchObject({ statusCode: 400, name: 'PushEndpointNotAllowedError' });
    }
    expect(calls).toEqual([]);
  });
});
