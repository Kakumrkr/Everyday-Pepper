import { readFile } from 'node:fs/promises';
import { senderVerdict } from '@pepper/core';
import { describe, expect, it, vi } from 'vitest';
import { addressOf, ResendInboundError, ResendInboundSource } from './resend-inbound.js';

// Resend's received-email API through the adapter (S59.3, AC-X-38), on recorded response shapes
// (src/fixtures/resend) and a fetch in memory: no network.

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/resend/${name}.json`, import.meta.url), 'utf8'));

const receivedFixture = (await fixture('received-email')) as Record<string, unknown>;
const attachmentFixture = (await fixture('attachment')) as Record<string, unknown>;
const received = () => receivedFixture;
const attachment = () => attachmentFixture;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function source(routes: Record<string, () => Response>) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetchImpl = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const route = routes[url];
    return Promise.resolve(route === undefined ? json({ message: 'nope' }, 404) : route());
  });
  return {
    calls,
    inbound: new ResendInboundSource({ apiKey: 're_test_key', fetch: fetchImpl }),
  };
}

const EMAIL = 'https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c';
const ATTACHMENT = `${EMAIL}/attachments/2a0c9ce0-3112-4728-976e-47ddcd16a318`;
const DOWNLOAD = 'https://inbound-cdn.resend.com/4ef9a417/2a0c9ce0?signature=abc';

describe('ResendInboundSource', () => {
  it('normalises a received email: addresses, headers in order, threading, attachments', async () => {
    const { inbound, calls } = source({ [EMAIL]: () => json(received()) });
    const email = await inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    expect(email).toMatchObject({
      from: 'ana@juniper.test',
      recipients: ['reply+pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test', 'ben@juniper.test'],
      subject: 'Re: Pepper replied to PEP-7K2M9Q',
      inReplyTo: '<support.pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test>',
      references: [
        '<0199f0a4-7c1e@pepper.test>',
        '<support.pep-7k2m9q-1-abcdefghijklmnopqrst@reply.pepper.test>',
      ],
    });
    expect(email?.attachments.map((a) => [a.filename, a.inline, a.size])).toEqual([
      ['Screenshot.png', true, 4708],
      ['invoice.pdf', false, 4013],
    ]);
    // The receiver's header first, so the sender check reads the right one.
    expect(email === null ? null : senderVerdict(email, 'amazonses.com')).toBe('pass');
    expect(calls).toEqual([{ url: EMAIL, auth: 'Bearer re_test_key' }]);
  });

  it('downloads an attachment by its signed link, without the API key', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { inbound, calls } = source({
      [EMAIL]: () => json(received()),
      [ATTACHMENT]: () => json(attachment()),
      [DOWNLOAD]: () => new Response(png, { status: 200 }),
    });
    const email = await inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    const bytes = await email?.attachments[0]?.content();
    expect(bytes).toEqual(png);
    expect(calls.find((call) => call.url === DOWNLOAD)?.auth).toBeNull();
  });

  it('refuses an attachment over 12 MB, by its size or while reading', async () => {
    const big = { ...attachment(), size: 13 * 1024 * 1024 };
    const tooBig = source({ [EMAIL]: () => json(received()), [ATTACHMENT]: () => json(big) });
    const email = await tooBig.inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    await expect(email?.attachments[0]?.content()).rejects.toBeInstanceOf(ResendInboundError);
    const streaming = source({
      [EMAIL]: () => json(received()),
      [ATTACHMENT]: () => json({ ...attachment(), size: null }),
      [DOWNLOAD]: () => new Response(new Uint8Array(13 * 1024 * 1024), { status: 200 }),
    });
    const second = await streaming.inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    await expect(second?.attachments[0]?.content()).rejects.toBeInstanceOf(ResendInboundError);
  });

  it('refuses a download link that isn’t https', async () => {
    const { inbound } = source({
      [EMAIL]: () => json(received()),
      [ATTACHMENT]: () => json({ ...attachment(), download_url: 'http://169.254.169.254/x' }),
    });
    const email = await inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    await expect(email?.attachments[0]?.content()).rejects.toThrow();
  });

  it('is null for an email Resend doesn’t know, and throws (to retry) on anything else', async () => {
    const missing = source({});
    expect(await missing.inbound.fetch('nope')).toBeNull();
    const down = source({ [EMAIL]: () => json({ message: 'busy' }, 503) });
    await expect(down.inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c')).rejects.toMatchObject({
      statusCode: 503,
    });
    const odd = source({ [EMAIL]: () => json({ id: 'x' }) });
    await expect(odd.inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c')).rejects.toThrow();
  });

  it('reads headers given as a list too', async () => {
    const listed = {
      ...received(),
      headers: [
        { name: 'Auto-Submitted', value: 'auto-replied' },
        { name: 'In-Reply-To', value: '<a@b.test>' },
      ],
    };
    const { inbound } = source({ [EMAIL]: () => json(listed) });
    const email = await inbound.fetch('4ef9a417-02e9-4d39-ad75-9611e0fcc33c');
    expect(email?.headers[0]).toEqual({ name: 'Auto-Submitted', value: 'auto-replied' });
    expect(email?.inReplyTo).toBe('<a@b.test>');
  });

  it('finds the address in a display name or a bare address', () => {
    expect(addressOf('"Ruiz, Ana" <Ana@Juniper.test>')).toBe('ana@juniper.test');
    expect(addressOf('ana@juniper.test')).toBe('ana@juniper.test');
    expect(addressOf('no address')).toBe('');
    // A display name can't stand in for the address.
    expect(addressOf('"<owner@biz.test>" <attacker@evil.test>')).toBe('attacker@evil.test');
    expect(addressOf('owner@biz.test <attacker@evil.test>')).toBe('attacker@evil.test');
    expect(addressOf('Owner owner@biz.test')).toBe('');
  });
});
