import 'reflect-metadata';
import { approveToolProposal } from '@pepper/ai';
import {
  addToWaitlist,
  changeBooking,
  claimWaitlistOffer,
  createBooking,
  createService,
  createStaffMember,
  queueWaitlistTakenEmail,
  replaceWorkingHours,
} from '@pepper/appointments';
import {
  OfferTokenSchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  TenantIdSchema,
  TenantSlugSchema,
  UserIdSchema,
  type ActionProposal,
  type Client,
  type TenantId,
} from '@pepper/contracts';
import {
  changeAutonomy,
  createBusiness,
  createClient,
  listPendingProposals,
  openOutboxContent,
  outboxKeyFrom,
  systemClock,
  type Actor,
} from '@pepper/core';
import {
  findOutboxMessage,
  listDueOutboxMessages,
  listWaitlistMatches,
  prepareDatabase,
  users,
  withTenant,
  type Database,
  type DatabaseHandle,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboxModule } from './outbox/outbox.module.js';
import { WaitlistModule } from './waitlist/waitlist.module.js';

// AC-W5-1 end to end, on the real clock and the real worker (S37, ADR-0041): a cancellation's
// freed time goes from Postgres through the relay and BullMQ (Redis) to the matcher, which
// offers it to who is waiting within 2 minutes: as a proposal under "Needs your OK" (ask, the
// default) or as offer emails (auto, which leave after the Undo grace). The first claim books
// it, and the other client is emailed that it's taken (through the outbox and SMTP, Mailpit).

const key = outboxKeyFrom('an-integration-test-outbox-secret-32+');
const BASE_URL = 'https://app.plum.example';
const TWO_MINUTES = 2 * 60_000;

let postgres: TestService;
let redis: TestService;
let mailpit: TestMailpit;
let app: INestApplicationContext;
let db: Database;
let businesses = 0;

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + TWO_MINUTES;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function inbox(to: string): Promise<{ Subject: string }[]> {
  const response = await fetch(
    `${mailpit.apiUrl}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`,
  );
  return ((await response.json()) as { messages: { Subject: string }[] }).messages;
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
      WaitlistModule.forRoot({ redisUrl: redis.url, key, baseUrl: BASE_URL, pollMs: 200 }),
    ],
  }).compile();
  app = await moduleRef.init();
  db = app.get<DatabaseHandle>(DATABASE).db;
}, 120_000);

afterAll(async () => {
  await app.close();
  await Promise.all([postgres.stop(), redis.stop(), mailpit.stop()]);
});

interface Business {
  tenantId: TenantId;
  slug: string;
  owner: Actor;
  waiting: Client[];
  cancel: () => Promise<number>;
}

/**
 * Plum Salon (UTC, open every day 08:00–20:00): a booking with Jess two days from now at 15:00,
 * and two clients waiting for that afternoon. `cancel` cancels it and returns when.
 */
async function newBusiness(): Promise<Business> {
  businesses += 1;
  const n = String(businesses);
  const [user] = await db
    .insert(users)
    .values({ name: 'Ana', email: `owner-${n}@plum.example` })
    .returning({ id: users.id });
  if (user === undefined) throw new Error('no owner');
  const slug = `plum-salon-${n}`;
  const tenant = await createBusiness(db, UserIdSchema.parse(user.id), {
    name: 'Plum Salon',
    slug,
    timeZone: 'UTC',
  });
  const tenantId = TenantIdSchema.parse(tenant.id);
  const owner: Actor = {
    context: { tenantId, userId: UserIdSchema.parse(user.id), role: 'owner' },
  };
  const service = await createService(db, owner, { name: 'Cut', durationMinutes: 60 });
  const jess = await createStaffMember(db, owner, {
    displayName: 'Jess',
    serviceIds: [service.id],
  });
  await replaceWorkingHours(db, owner, jess.id, {
    intervals: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })),
  });
  const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const booked = await createClient(db, owner, {
    name: 'Bea Cole',
    email: `bea-${n}@example.test`,
  });
  const booking = await createBooking(db, owner, {
    clientId: booked.id,
    serviceId: service.id,
    staffMemberId: jess.id,
    startsAt: `${day}T15:00:00.000Z`,
    notifyClient: false,
  });
  const waiting: Client[] = [];
  for (const name of ['Sara Kim', 'Ana Ruiz']) {
    const email = `${name.split(' ')[0]?.toLowerCase() ?? 'x'}-${n}@example.test`;
    const client = await createClient(db, owner, { name, email });
    await addToWaitlist(db, owner, {
      clientId: client.id,
      serviceId: service.id,
      windows: [{ date: day, start: '13:00', end: '18:00' }],
    });
    waiting.push(client);
  }
  return {
    tenantId,
    slug,
    owner,
    waiting,
    cancel: async () => {
      await changeBooking(db, owner, booking.id, { status: 'cancelled', notifyClient: false });
      return Date.now();
    },
  };
}

const offerProposals = async (b: Business): Promise<ActionProposal[]> =>
  (await listPendingProposals(db, b.owner)).filter((p) => p.tool === 'send_waitlist_offers');

/** The offer emails waiting in the outbox (sealed; opened here), with when they may leave. */
async function queuedOffers(b: Business) {
  const due = (await listDueOutboxMessages(db, new Date(Date.now() + 10 * 60_000), 100)).filter(
    (m) => m.tenantId === b.tenantId,
  );
  const offers = [];
  for (const message of due) {
    const row = await withTenant(db, b.tenantId, (tx) =>
      findOutboxMessage(tx, OutboxMessageIdSchema.parse(message.messageId)),
    );
    if (row?.type !== 'email' || row.payload === null) continue;
    const email = OutboxEmailSchema.parse(
      JSON.parse(openOutboxContent(key, message.messageId, row.payload).toString('utf8')),
    );
    if (email.subject.startsWith('A time opened up')) {
      offers.push({ email, createdAt: row.createdAt, availableAt: row.availableAt });
    }
  }
  return offers;
}

describe('AC-W5-1 on the worker', () => {
  it(
    'at "ask": the offer is proposed under "Needs your OK" within 2 minutes',
    { timeout: 180_000 },
    async () => {
      const b = await newBusiness();
      const cancelledAt = await b.cancel();
      const [proposal] = await eventually(
        () => offerProposals(b),
        (found) => found.length > 0,
      );
      expect(Date.parse(proposal?.createdAt ?? '') - cancelledAt).toBeLessThan(TWO_MINUTES);
      expect(proposal?.preview).toMatchObject({ after: { offers: 2, staffName: 'Jess' } });
      const [match] = await withTenant(db, b.tenantId, (tx) => listWaitlistMatches(tx, 10));
      expect(match).toMatchObject({ status: 'done', outcome: 'proposed' });
      // Approved: the offers are queued (the emails wait out the Undo grace).
      if (proposal === undefined) throw new Error('no proposal');
      const approved = await approveToolProposal(
        {
          db,
          actor: b.owner,
          clock: systemClock,
          autonomy: { templateDefaults: {} },
          emails: { baseUrl: BASE_URL, outboxKey: key },
        },
        proposal.id,
        proposal.fingerprint,
      );
      expect(approved.kind).toBe('executed');
      expect(await queuedOffers(b)).toHaveLength(2);
    },
  );

  it(
    'at "auto": the offers are made within 2 minutes; the first claim books, the other is told',
    { timeout: 180_000 },
    async () => {
      const b = await newBusiness();
      await changeAutonomy(
        db,
        b.owner,
        { levels: { 'message.waitlist_offer': 'auto' } },
        { templateDefaults: {} },
      );
      const cancelledAt = await b.cancel();
      const offers = await eventually(
        () => queuedOffers(b),
        (found) => found.length === 2,
      );
      for (const offer of offers) {
        expect(offer.createdAt.getTime() - cancelledAt).toBeLessThan(TWO_MINUTES);
        // They leave after the Undo grace (ADR-0028), so Undo can still take them back.
        expect(offer.availableAt.getTime()).toBeGreaterThan(offer.createdAt.getTime());
      }
      const [sara, ana] = b.waiting;
      const toSara = offers.find((o) => o.email.to === sara?.email);
      if (toSara === undefined || ana === undefined) throw new Error('no offer to Sara');
      const token = OfferTokenSchema.parse(
        /offer#([A-Za-z0-9_-]{43})/.exec(toSara.email.text)?.[1],
      );
      const claimed = await claimWaitlistOffer(db, TenantSlugSchema.parse(b.slug), token, {
        tellTaken: (tx, notice) =>
          queueWaitlistTakenEmail(tx, notice, { baseUrl: BASE_URL, outboxKey: key }).then(
            () => undefined,
          ),
      });
      expect(claimed.booking.status).toBe('confirmed');
      const [taken] = await eventually(
        () => inbox(ana.email ?? ''),
        (messages) => messages.length > 0,
      );
      expect(taken?.Subject).toBe('That time at Plum Salon has been taken');
    },
  );
});
