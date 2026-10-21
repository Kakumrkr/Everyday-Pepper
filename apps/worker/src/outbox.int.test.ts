import 'reflect-metadata';
import {
  OutboxDedupeKeySchema,
  TenantIdSchema,
  type OutboxMessageId,
  type TenantId,
} from '@pepper/contracts';
import { ManualClock, outboxKeyFrom, queueEmail } from '@pepper/core';
import {
  createTenant,
  findOutboxMessage,
  prepareDatabase,
  withTenant,
  type Database,
  type DatabaseHandle,
  type OutboxMessageRow,
} from '@pepper/db';
import { ConnectionsModule, DATABASE, MailModule } from '@pepper/runtime';
import {
  postgresUrlAs,
  startMailpit,
  startPostgres,
  startRedis,
  type TestMailpit,
  type TestService,
} from '@pepper/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboxModule, OutboxRunner } from './outbox/outbox.module.js';
import { OUTBOX_QUEUE } from './outbox/relay.js';

// AC-W4-2 end to end: emails queued in Postgres go through the relay, BullMQ (Redis) and SMTP
// (Mailpit) exactly once per recipient, even when jobs are duplicated, the relay sees a message
// many times, or the mail server refuses mail for a while (ADR-0024).

const SECRET = 'an-integration-test-outbox-secret-32+';
const key = outboxKeyFrom(SECRET);
const clock = new ManualClock('2026-10-20T15:00:00Z');

let postgres: TestService;
let redis: TestService;
let mailpit: TestMailpit;
let app: INestApplicationContext;
let db: Database;
let tenant: TenantId;
let keys = 0;

interface MailpitMessage {
  ID: string;
  MessageID: string;
  To: { Address: string }[];
  Subject: string;
}

/** The messages Mailpit received for `to`. */
async function inbox(to: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  const body = (await response.json()) as { messages: MailpitMessage[] };
  return body.messages;
}

/** Sets the probability (0–100) that Mailpit's SMTP server refuses a sender with `code`. */
async function refuseMail(code: number, probability: number): Promise<void> {
  const response = await fetch(`${mailpit.apiUrl}/api/v1/chaos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Sender: { ErrorCode: code, Probability: probability } }),
  });
  expect(response.status).toBe(200);
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function queue(to: string): Promise<OutboxMessageId> {
  keys += 1;
  const id = await withTenant(db, tenant, (tx) =>
    queueEmail(
      tx,
      { to, subject: "You're booked at Plum Salon", text: 'Hi Ana,\n\nSee you soon.' },
      {
        key,
        dedupeKey: OutboxDedupeKeySchema.parse(`test.email:${String(keys)}`),
        now: clock.now(),
      },
    ),
  );
  if (id === undefined) throw new Error('not queued');
  return id;
}

const stored = (id: OutboxMessageId): Promise<OutboxMessageRow | undefined> =>
  withTenant(db, tenant, (tx) => findOutboxMessage(tx, id));

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([startPostgres(), startRedis(), startMailpit()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConnectionsModule.forRoot({ databaseUrl, redisUrl: redis.url }),
      MailModule.forRoot({ smtpUrl: mailpit.smtpUrl, from: 'Plum Salon <hello@plum.example>' }),
      OutboxModule.forRoot({ redisUrl: redis.url, key, pollMs: 100, clock }),
    ],
  }).compile();
  app = await moduleRef.init();
  db = app.get<DatabaseHandle>(DATABASE).db;
  const created = await createTenant(db, {
    name: 'Plum Salon',
    slug: 'plum-salon',
    timeZone: 'America/Chicago',
  });
  tenant = TenantIdSchema.parse(created.id);
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop(), mailpit.stop()]);
});

beforeEach(async () => {
  await refuseMail(451, 0);
});

describe('outbox delivery (AC-W4-2)', () => {
  it('sends a queued email exactly once, with the message id as its Message-ID', async () => {
    const id = await queue('ana.once@example.test');
    const [received] = await eventually(
      () => inbox('ana.once@example.test'),
      (found) => found.length > 0,
    );
    expect(received).toMatchObject({
      MessageID: `${id}@plum.example`,
      Subject: "You're booked at Plum Salon",
    });
    // The mail server has it before the worker records it as sent: wait for the record.
    const sent = await eventually(
      () => stored(id),
      (row) => row?.status === 'sent',
    );
    expect(sent).toMatchObject({ status: 'sent', payload: null, attempts: 1 });

    // The same message queued again as another job (a retried relay), and many more relay
    // passes: still one email.
    const connection = new Redis(redis.url, { maxRetriesPerRequest: null });
    const jobs = new Queue(OUTBOX_QUEUE, { connection });
    await jobs.add('deliver', { messageId: id, tenantId: tenant }, { jobId: `${id}-again` });
    await jobs.close();
    await connection.quit();
    const runner = app.get(OutboxRunner);
    for (let pass = 0; pass < 5; pass += 1) await runner.relayOnce();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await inbox('ana.once@example.test')).toHaveLength(1);
  });

  it('retries while the mail server refuses, then sends exactly once', async () => {
    await refuseMail(451, 100);
    const id = await queue('ana.retry@example.test');
    const failed = await eventually(
      () => stored(id),
      (row) => typeof row?.lastError === 'string',
    );
    expect(failed).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await inbox('ana.retry@example.test')).toEqual([]);

    // The server recovers; the retry is due 30 seconds later.
    await refuseMail(451, 0);
    clock.advanceBy(30_000);
    await eventually(
      () => stored(id),
      (row) => row?.status === 'sent',
    );
    expect(await inbox('ana.retry@example.test')).toHaveLength(1);
    expect(await stored(id)).toMatchObject({ attempts: 2, lastError: null });
  });

  it('gives up on a permanent refusal and never sends', async () => {
    await refuseMail(550, 100);
    const id = await queue('ana.refused@example.test');
    const dead = await eventually(
      () => stored(id),
      (row) => row?.status === 'dead',
    );
    expect(dead).toMatchObject({ payload: null, attempts: 1 });
    await refuseMail(550, 0);
    clock.advanceBy(86_400_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inbox('ana.refused@example.test')).toEqual([]);
  });
});
