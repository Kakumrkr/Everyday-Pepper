import 'reflect-metadata';
import {
  changeBooking,
  createBooking,
  createService,
  createStaffMember,
  REMINDER_LEAD_MS,
} from '@pepper/appointments';
import { TenantIdSchema, UserIdSchema } from '@pepper/contracts';
import { createBusiness, createClient, outboxKeyFrom, type Actor } from '@pepper/core';
import { prepareDatabase, users, type Database, type DatabaseHandle } from '@pepper/db';
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobsModule } from './jobs/jobs.module.js';
import { OutboxModule } from './outbox/outbox.module.js';

// AC-W6-1 end to end, on the real clock: a booking's reminder goes from the reminder job
// through the outbox, BullMQ (Redis) and SMTP (Mailpit) within 5 minutes of when it is due,
// once; a cancelled booking's never does (ADR-0025).

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const FIVE_MINUTES = 5 * 60_000;

let postgres: TestService;
let redis: TestService;
let mailpit: TestMailpit;
let app: INestApplicationContext;
let db: Database;

interface MailpitMessage {
  Created: string;
  To: { Address: string }[];
  Subject: string;
}

async function inbox(to: string): Promise<MailpitMessage[]> {
  const response = await fetch(
    `${mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

beforeAll(async () => {
  [postgres, redis, mailpit] = await Promise.all([startPostgres(), startRedis(), startMailpit()]);
  const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
  await prepareDatabase(postgres.url, databaseUrl);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConnectionsModule.forRoot({ databaseUrl, redisUrl: redis.url }),
      MailModule.forRoot({ smtpUrl: mailpit.smtpUrl, from: 'Plum Salon <hello@plum.example>' }),
      OutboxModule.forRoot({ redisUrl: redis.url, key, pollMs: 100 }),
      JobsModule.forRoot({ key, reminderPollMs: 1000, cleanupIntervalMs: 60_000 }),
    ],
  }).compile();
  app = await moduleRef.init();
  db = app.get<DatabaseHandle>(DATABASE).db;
});

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop(), mailpit.stop()]);
});

describe('the reminder job (AC-W6-1)', () => {
  it('emails the reminder within 5 minutes of schedule, once; never for a cancelled booking', async () => {
    const [owner] = await db
      .insert(users)
      .values({ name: 'Ana', email: 'owner@plum.example' })
      .returning({ id: users.id });
    if (owner === undefined) throw new Error('no owner');
    const tenant = await createBusiness(db, UserIdSchema.parse(owner.id), {
      name: 'Plum Salon',
      slug: 'plum-salon',
      timeZone: 'America/Chicago',
    });
    const actor: Actor = {
      context: {
        tenantId: TenantIdSchema.parse(tenant.id),
        userId: UserIdSchema.parse(owner.id),
        role: 'owner',
      },
    };
    const service = await createService(db, actor, { name: 'Cut', durationMinutes: 30 });
    const jess = await createStaffMember(db, actor, {
      displayName: 'Jess',
      serviceIds: [service.id],
    });
    const book = async (email: string, startsAt: number) => {
      const client = await createClient(db, actor, { name: 'Ana Ruiz', email });
      // The owner overrides hours and rules: any free time works for this test.
      return createBooking(db, actor, {
        clientId: client.id,
        serviceId: service.id,
        staffMemberId: jess.id,
        startsAt: new Date(startsAt).toISOString(),
        override: true,
        notifyClient: false,
      });
    };

    // Reminders due in 3 seconds.
    const start = Math.ceil((Date.now() + REMINDER_LEAD_MS + 3000) / 1000) * 1000;
    const dueAt = start - REMINDER_LEAD_MS;
    await book('kept@example.test', start);
    const cancelled = await book('cancelled@example.test', start + 3_600_000);
    await changeBooking(db, actor, cancelled.id, { status: 'cancelled' });

    const [reminder] = await eventually(
      () => inbox('kept@example.test'),
      (messages) => messages.length > 0,
    );
    expect(reminder?.Subject).toBe('Reminder: your booking at Plum Salon');
    const receivedAt = Date.parse(reminder?.Created ?? '');
    expect(receivedAt).toBeGreaterThanOrEqual(dueAt - 1000);
    expect(receivedAt - dueAt).toBeLessThan(FIVE_MINUTES);

    // A few more passes of both jobs: still one reminder, and none for the cancelled booking.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(await inbox('kept@example.test')).toHaveLength(1);
    expect(await inbox('cancelled@example.test')).toEqual([]);
  });
});
