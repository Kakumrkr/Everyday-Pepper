import { readFile } from 'node:fs/promises';
import { SmsRejectedError } from '@pepper/core';
import { describe, expect, it } from 'vitest';
import { loadSmsConfig } from './config.js';
import {
  maskPhone,
  SandboxSmsSender,
  SandboxTextLog,
  smsSenderFor,
  TwilioSmsSender,
} from './sms.js';

// Twilio's Messages API as its documentation shows it (S61, ADR-0065 §1, AC-X-57), replayed from
// fixtures (src/fixtures/twilio) through a fetch in memory: no network.

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(new URL(`./fixtures/twilio/${name}.json`, import.meta.url), 'utf8'));

const ACCOUNT = 'AC00000000000000000000000000000001';
const TOKEN = '0123456789abcdef0123456789abcdef';
const SERVICE = 'MG00000000000000000000000000000002';

interface Call {
  url: string;
  init: RequestInit;
}

/** The request body the sender wrote: a form, as a string. */
function formOf(call: Call | undefined): URLSearchParams {
  const body = call?.init.body;
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (url, init) => {
    calls.push({ url: url instanceof Request ? url.url : url.toString(), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
}

const message = {
  to: '+15552340001',
  body: 'Plum Salon: see you tomorrow at 2:30pm. Reply STOP to opt out.',
  id: '0199f4b2-7c1e-7a00-8000-000000000001',
  statusCallbackUrl: 'https://app.example.test/v1/webhooks/sms/status?t=a&m=b',
};

describe('TwilioSmsSender (AC-X-57)', () => {
  it('posts the text form-encoded with Basic auth from the Messaging Service', async () => {
    const calls: Call[] = [];
    const sender = new TwilioSmsSender({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: SERVICE,
      fetch: fakeFetch(201, await fixture('message-created'), calls),
    });
    expect(await sender.send(message)).toEqual({
      provider: 'twilio',
      providerMessageId: 'SM0123456789abcdef0123456789abcdef',
      segments: 1,
      status: 'queued',
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/Messages.json`);
    expect(call?.init.method).toBe('POST');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(
      `Basic ${Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64')}`,
    );
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    const form = formOf(call);
    expect(Object.fromEntries(form)).toEqual({
      To: message.to,
      Body: message.body,
      MessagingServiceSid: SERVICE,
      StatusCallback: message.statusCallbackUrl,
    });
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends from a number when the sender is one, and asks for no report without a URL', async () => {
    const calls: Call[] = [];
    const sender = new TwilioSmsSender({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: '+15557654321',
      fetch: fakeFetch(201, await fixture('message-created'), calls),
    });
    await sender.send({ to: message.to, body: message.body, id: message.id });
    const form = formOf(calls[0]);
    expect(form.get('From')).toBe('+15557654321');
    expect(form.has('MessagingServiceSid')).toBe(false);
    expect(form.has('StatusCallback')).toBe(false);
  });

  it('counts segments itself when Twilio doesn’t say', async () => {
    const created = { ...((await fixture('message-created')) as object), num_segments: null };
    const sender = new TwilioSmsSender({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: SERVICE,
      fetch: fakeFetch(201, created),
    });
    expect((await sender.send({ ...message, body: 'a'.repeat(200) })).segments).toBe(2);
  });

  it.each([
    ['error-21211', 400, 21211, true],
    ['error-21610', 400, 21610, true],
    ['error-20429', 429, 20429, false],
    ['error-20003', 401, 20003, false],
  ] as const)(
    'classifies %s (%d) by its code, without the message',
    async (name, status, code, permanent) => {
      const sender = new TwilioSmsSender({
        accountSid: ACCOUNT,
        authToken: TOKEN,
        sender: SERVICE,
        fetch: fakeFetch(status, await fixture(name)),
      });
      const error = await sender.send(message).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SmsRejectedError);
      expect(error).toMatchObject({ statusCode: status, code, permanent });
      expect((error as Error).message).not.toContain('+1555');
    },
  );

  it('retries a 5xx without a body, and refuses an answer that isn’t Twilio’s', async () => {
    const down = new TwilioSmsSender({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: SERVICE,
      fetch: () => Promise.resolve(new Response('Bad gateway', { status: 502 })),
    });
    await expect(down.send(message)).rejects.toMatchObject({
      statusCode: 502,
      code: null,
      permanent: false,
    });
    const odd = new TwilioSmsSender({
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: SERVICE,
      fetch: fakeFetch(201, { sid: 'not-a-sid' }),
    });
    await expect(odd.send(message)).rejects.toThrow();
  });
});

describe('SandboxSmsSender', () => {
  it('keeps the texts, logs each masked with no words, and reports them delivered', async () => {
    const lines: string[] = [];
    const sandbox = new SandboxSmsSender((line) => lines.push(line));
    const accepted = await sandbox.send(message);
    expect(accepted).toMatchObject({ provider: 'sandbox', segments: 1, status: 'delivered' });
    expect(accepted.providerMessageId).toMatch(/^SB[0-9a-f]{32}$/);
    expect(sandbox.sent).toEqual([
      { ...message, providerMessageId: accepted.providerMessageId, segments: 1 },
    ]);
    expect(lines).toEqual(['SMS sandbox: 1 segment(s) to +1••••••••01']);
  });

  it('keeps only the newest 100', async () => {
    const sandbox = new SandboxSmsSender();
    for (let i = 0; i < 105; i += 1) await sandbox.send({ ...message, body: String(i) });
    expect(sandbox.sent).toHaveLength(100);
    expect(sandbox.sent[0]?.body).toBe('5');
  });

  it('masks short values whole', () => {
    expect(maskPhone('+1')).toBe('••••');
  });
});

/** Redis's lists as `SandboxTextLog` uses them. */
class FakeLists {
  readonly lists = new Map<string, string[]>();
  readonly expiries = new Map<string, number>();
  lpush(key: string, value: string) {
    this.lists.set(key, [value, ...(this.lists.get(key) ?? [])]);
    return Promise.resolve(this.lists.get(key)?.length);
  }
  ltrim(key: string, start: number, stop: number) {
    this.lists.set(key, (this.lists.get(key) ?? []).slice(start, stop + 1));
    return Promise.resolve('OK');
  }
  expire(key: string, seconds: number) {
    this.expiries.set(key, seconds);
    return Promise.resolve(1);
  }
  lrange(key: string, start: number, stop: number) {
    return Promise.resolve((this.lists.get(key) ?? []).slice(start, stop + 1));
  }
}

describe('SandboxTextLog (S63, AC-X-87)', () => {
  it('records what the sandbox sends, reads it back by number newest first, for a day, 100 at most', async () => {
    const redis = new FakeLists();
    const log = new SandboxTextLog(redis);
    const sandbox = new SandboxSmsSender(() => undefined, log);
    await sandbox.send({ ...message, body: 'first' });
    await sandbox.send({ ...message, to: '+15550000002', body: 'elsewhere' });
    await sandbox.send({ ...message, body: 'second' });
    const mine = await log.sentTo(message.to);
    expect(mine.map((text) => text.body)).toEqual(['second', 'first']);
    expect(mine[0]?.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect([...redis.expiries.values()]).toEqual([86_400]);
    const latest = mine[0];
    if (latest === undefined) throw new Error('nothing recorded');
    for (let i = 0; i < 105; i += 1) await log.record({ ...latest, body: String(i) });
    expect([...redis.lists.values()][0]).toHaveLength(100);
  });

  it('skips an entry that isn’t a text, and the same sender without the log keeps memory only', async () => {
    const redis = new FakeLists();
    const log = new SandboxTextLog(redis);
    await log.record({ to: message.to, body: 'kept', sentAt: new Date().toISOString() });
    const key = [...redis.lists.keys()][0] ?? '';
    redis.lists.set(key, ['not json', '{"to":1}', ...(redis.lists.get(key) ?? [])]);
    expect((await log.sentTo(message.to)).map((text) => text.body)).toEqual(['kept']);
    const plain = new SandboxSmsSender();
    await plain.send(message);
    expect(plain.sent).toHaveLength(1);
    expect(smsSenderFor({ provider: 'sandbox' }, undefined, log)).toBeInstanceOf(SandboxSmsSender);
  });
});

describe('loadSmsConfig', () => {
  const twilio = {
    SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: ACCOUNT,
    TWILIO_AUTH_TOKEN: TOKEN,
    TWILIO_SENDER: SERVICE,
  };

  it('is off by default, and with an empty value', () => {
    expect(loadSmsConfig('worker', {})).toBeNull();
    expect(loadSmsConfig('worker', { SMS_PROVIDER: '' })).toBeNull();
    expect(smsSenderFor(null)).toBeNull();
  });

  it('reads the sandbox and Twilio', () => {
    expect(loadSmsConfig('worker', { SMS_PROVIDER: 'sandbox' })).toEqual({ provider: 'sandbox' });
    expect(smsSenderFor({ provider: 'sandbox' })).toBeInstanceOf(SandboxSmsSender);
    const config = loadSmsConfig('worker', twilio);
    expect(config).toEqual({
      provider: 'twilio',
      accountSid: ACCOUNT,
      authToken: TOKEN,
      sender: SERVICE,
    });
    expect(smsSenderFor(config)).toBeInstanceOf(TwilioSmsSender);
  });

  it('stops the process for Twilio without its keys, or with malformed ones, naming no value', () => {
    expect(() => loadSmsConfig('worker', { SMS_PROVIDER: 'twilio' })).toThrow(
      /^Invalid worker environment: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_SENDER$/,
    );
    expect(() => loadSmsConfig('worker', { ...twilio, TWILIO_AUTH_TOKEN: 'short' })).toThrow(
      'Invalid worker environment: TWILIO_AUTH_TOKEN',
    );
    expect(() => loadSmsConfig('worker', { ...twilio, TWILIO_SENDER: '+442071234567' })).toThrow(
      'TWILIO_SENDER',
    );
    expect(() => loadSmsConfig('worker', { SMS_PROVIDER: 'carrier-pigeon' })).toThrow(
      'SMS_PROVIDER',
    );
  });
});
