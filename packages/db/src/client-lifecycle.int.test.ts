import {
  ClientIdSchema,
  ConversationTurnIdSchema,
  EMBEDDING_DIMENSIONS,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type ClientId,
  type ConversationTurnId,
  type ServiceId,
  type StaffMemberId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { ClientEmailTakenError } from './errors.js';
import { newId } from './ids.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking, insertWaitlistEntry } from './repositories/bookings.js';
import {
  DELETED_CLIENT_NAME,
  clientVisitsOverlap,
  countClientRecords,
  deleteClientRow,
  findClient,
  findClientsByContact,
  findClientsByIds,
  insertClient,
  insertWalkInClient,
  listClients,
  mergeClientRows,
  updateClient,
} from './repositories/clients.js';
import { insertConversation, insertMessage, insertTurn } from './repositories/conversations.js';
import { listInsightBookings } from './repositories/feed.js';
import { addMembership } from './repositories/memberships.js';
import { insertMemoryEpisode, insertMemoryFact } from './repositories/memory.js';
import { insertRememberedDevice } from './repositories/remembered-devices.js';
import { createTenant } from './repositories/tenants.js';
import { insertProposal } from './repositories/trust.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// Merging and deleting clients against real Postgres (S50, ADR-0051): what moves, what is
// forgotten, what stays for past visits, and that staff can do neither. Isolation between
// businesses is in isolation.int.test.ts.

const NOW = new Date('2099-03-10T12:00:00Z');
const PAST = new Date('2099-02-01T15:00:00Z');
const LATER = new Date('2099-03-20T15:00:00Z');

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let ana: UserId;
let jess: UserId;
let jessStaff: StaffMemberId;
let leeStaff: StaffMemberId;
let service: ServiceId;
let slugs = 0;

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);
const inTenant = <T>(work: (tx: TenantTx) => Promise<T>) => withTenant(db, tenant, work);

async function newTenant(name: string): Promise<TenantId> {
  slugs += 1;
  const created = await createTenant(db, {
    name,
    slug: `${name.toLowerCase()}-lifecycle-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  return TenantIdSchema.parse(created.id);
}

async function client(
  name: string,
  details: { email?: string; phone?: string; tags?: string[] } = {},
): Promise<ClientId> {
  return inTenant(async (tx) =>
    ClientIdSchema.parse(
      (
        await insertClient(tx, {
          name,
          email: details.email ?? null,
          phone: details.phone ?? null,
          source: 'team',
          ...(details.tags === undefined ? {} : { tags: details.tags }),
        })
      ).id,
    ),
  );
}

async function visit(
  clientId: ClientId,
  startsAt: Date,
  staffMemberId: StaffMemberId = jessStaff,
): Promise<string> {
  const minutes = 60;
  return inTenant(async (tx) => {
    const row = await insertBooking(tx, {
      clientId,
      serviceId: service,
      staffMemberId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 4000,
      priceToCents: null,
      source: 'team',
      overridden: true,
      idempotencyKey: null,
      createdBy: null,
    });
    return row.id;
  });
}

async function note(clientId: ClientId, key: string, value: string): Promise<string> {
  return inTenant(async (tx) => {
    const row = await insertMemoryFact(tx, {
      subject: { type: 'client', id: clientId },
      key,
      value,
      sensitive: false,
      status: 'active',
      source: 'screen',
      sourceTurnId: null,
      createdBy: null,
    });
    return row.id;
  });
}

async function chat(userId: UserId, content: string): Promise<ConversationTurnId> {
  return withMember(db, { tenantId: tenant, userId }, async (tx) => {
    const conversation = await insertConversation(tx, { userId, channel: 'chat' });
    const turn = await insertTurn(tx, {
      conversationId: conversation.id as never,
      userId,
      clientTurnId: newId(),
      deadlineAt: new Date(Date.now() + 60_000),
    });
    if (turn === undefined) throw new Error('no turn');
    const turnId = ConversationTurnIdSchema.parse(turn.id);
    await insertMessage(tx, {
      conversationId: conversation.id as never,
      turnId,
      userId,
      untrusted: false,
      role: 'user',
      content,
    });
    return turnId;
  });
}

async function chatText(turnId: ConversationTurnId): Promise<string[]> {
  const rows = await inTenant((tx) =>
    tx.execute<{ content: string }>(
      sql`SELECT content FROM conversation_messages WHERE turn_id = ${turnId} ORDER BY created_at`,
    ),
  );
  return rows.rows.map((row) => row.content);
}

async function episode(clientIds: ClientId[], summary: string): Promise<string> {
  return inTenant(async (tx) => {
    const row = await insertMemoryEpisode(tx, {
      userId: ana,
      conversationId: null,
      summary,
      clientIds,
      embedding: Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)),
      embeddingModel: 'text-embedding-3-small',
    });
    return row.id;
  });
}

async function episodeClients(id: string): Promise<string[] | undefined> {
  const rows = await inTenant((tx) =>
    tx.execute<{ client_ids: string[] }>(
      sql`SELECT client_ids FROM memory_episodes WHERE id = ${id}`,
    ),
  );
  return rows.rows[0]?.client_ids;
}

async function propose(clientId: ClientId): Promise<string> {
  return inTenant(async (tx) => {
    const row = await insertProposal(tx, {
      action: 'message.rebooking_nudge',
      tool: 'send_rebooking_nudge',
      targetKey: `nudge:client:${clientId}`,
      idempotencyKey: `nudge.${newId()}`,
      payload: { clientId },
      preview: {},
      fingerprint: 'a'.repeat(64),
      explanation: {
        requestMessageId: null,
        steps: [],
        facts: [],
        alternatives: [],
        untrustedContext: true,
        decision: { outcome: 'propose', reason: 'setting' },
      },
      requestedBy: null,
      recordOwner: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    if (row === undefined) throw new Error('not stored');
    return row.id;
  });
}

async function proposalStatus(id: string): Promise<string | undefined> {
  const rows = await inTenant((tx) =>
    tx.execute<{ status: string }>(sql`SELECT status FROM ai_action_proposals WHERE id = ${id}`),
  );
  return rows.rows[0]?.status;
}

async function count(table: string, clientId: ClientId): Promise<number> {
  const rows = await inTenant((tx) =>
    tx.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE client_id = ${clientId}`,
    ),
  );
  return rows.rows[0]?.n ?? 0;
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = await newTenant('Juniper');
  ana = await insertUser(db, 'Ana');
  jess = await insertUser(db, 'Jess');
  await inTenant(async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    const membership = await addMembership(tx, { userId: jess, role: 'staff' });
    jessStaff = StaffMemberIdSchema.parse(
      (
        await insertStaffMember(tx, {
          displayName: 'Jess',
          color: '#2a7230',
          active: true,
          membershipId: membership.id,
        })
      ).id,
    );
    leeStaff = StaffMemberIdSchema.parse(
      (
        await insertStaffMember(tx, {
          displayName: 'Lee',
          color: '#2a7230',
          active: true,
          membershipId: null,
        })
      ).id,
    );
    service = ServiceIdSchema.parse(
      (
        await insertService(tx, {
          name: 'Cut',
          category: 'hair',
          durationMinutes: 60,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 4000,
          priceToCents: null,
          active: true,
        })
      ).id,
    );
  });
});

afterAll(async () => {
  await database.stop();
});

describe('editing tags and birthday (S50)', () => {
  it('sets them when given and keeps them when left out', async () => {
    const id = await client('Tia Moss');
    await as(ana, (tx) =>
      updateClient(tx, id, {
        name: 'Tia Moss',
        email: null,
        phone: null,
        tags: ['VIP', 'vip', 'Color'],
        birthday: { month: 7, day: 4, year: null },
      }),
    );
    const kept = await as(ana, (tx) =>
      updateClient(tx, id, { name: 'Tia M.', email: null, phone: null }),
    );
    expect(kept?.tags).toEqual(['VIP', 'Color']);
    expect([kept?.birthdayMonth, kept?.birthdayDay, kept?.birthdayYear]).toEqual([7, 4, null]);
    const cleared = await as(ana, (tx) =>
      updateClient(tx, id, { name: 'Tia M.', email: null, phone: null, tags: [], birthday: null }),
    );
    expect(cleared?.tags).toEqual([]);
    expect(cleared?.birthdayMonth).toBeNull();
  });
});

describe('merging clients (ADR-0051)', () => {
  it("moves the other's visits, entries, notes, episodes and import ids, fills the gaps, and removes them", async () => {
    const keep = await client('Dee Hart', { phone: '+15550001111', tags: ['VIP'] });
    const other = await client('Dee H.', { email: 'dee@example.test', tags: ['vip', 'Color'] });
    await inTenant((tx) =>
      tx.execute(
        sql`UPDATE clients SET birthday_month = 5, birthday_day = 2, email_opt_out_at = ${PAST.toISOString()}::timestamptz WHERE id = ${other}`,
      ),
    );
    await visit(other, PAST);
    await visit(keep, LATER);
    await inTenant((tx) =>
      insertWaitlistEntry(tx, {
        clientId: other,
        serviceId: service,
        staffMemberId: null,
        windows: [{ date: '2099-03-21', start: '10:00', end: '14:00' }] as never,
        expiresAt: new Date('2099-03-22T00:00:00Z'),
        createdBy: null,
      }),
    );
    await note(keep, 'allergy', 'Latex gloves');
    await note(keep, 'shampoo', 'Sulfate free');
    await note(other, 'shampoo', 'Sulfate free');
    const same = await chat(ana, 'Dee only takes sulfate free shampoo.');
    const asked = async () =>
      (
        await inTenant((tx) =>
          tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM insight_requests`),
        )
      ).rows[0]?.n ?? 0;
    const requestsBefore = await asked();
    const lost = await note(other, 'allergy', 'Peroxide');
    const moved = await note(other, 'drink', 'Oat flat white');
    const told = await chat(ana, 'Dee H. loves an oat flat white; peroxide is a no.');
    const both = await episode([keep, other], 'Dee and Dee H. talked about color.');
    const theirs = await episode([other], 'Dee H. asked about balayage.');
    const nudge = await propose(other);
    const batch = newId();
    await inTenant(async (tx) => {
      await tx.execute(sql`
        INSERT INTO import_batches (id, format, system, status, problems, counts, columns)
        VALUES (${batch}, 'csv', 'file:abc', 'staged', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb)`);
      await tx.execute(sql`
        INSERT INTO client_import_refs (id, system, external_id, client_id, batch_id)
        VALUES (${newId()}, 'file:abc', 'x-1', ${other}, ${batch})`);
      await tx.execute(sql`
        INSERT INTO import_rows (id, batch_id, position, row, row_hash, outcome, client_id, created_client, applied_at)
        VALUES (${newId()}, ${batch}, 0, 1, 'h1', 'create', ${other}, true, now())`);
    });

    expect(await as(ana, (tx) => clientVisitsOverlap(tx, keep, other))).toBe(false);
    const result = await as(ana, (tx) => mergeClientRows(tx, keep, other, NOW));
    expect(result?.moved).toEqual({ visits: 1, waitlistEntries: 1, notes: 1 });
    expect(result?.row).toMatchObject({
      email: 'dee@example.test',
      phone: '+15550001111',
      tags: ['VIP', 'Color'],
      birthdayMonth: 5,
      birthdayDay: 2,
    });
    expect(result?.row.emailOptOutAt?.toISOString()).toBe(PAST.toISOString());
    expect(await as(ana, (tx) => findClient(tx, other))).toBeUndefined();
    expect(await count('bookings', keep)).toBe(2);
    expect(await count('waitlist_entries', keep)).toBe(1);
    expect(await count('client_import_refs', keep)).toBe(1);
    const facts = await inTenant((tx) =>
      tx.execute<{ id: string; value: string }>(
        sql`SELECT id, value FROM memory_facts WHERE client_id = ${keep} ORDER BY key`,
      ),
    );
    expect(facts.rows.map((row) => row.value)).toEqual([
      'Latex gloves',
      'Oat flat white',
      'Sulfate free',
    ]);
    // The same value on both: still remembered, so nothing is scrubbed.
    expect(await chatText(same)).toEqual(['Dee only takes sulfate free shampoo.']);
    expect(await asked()).toBe(requestsBefore + 1);
    expect(facts.rows.map((row) => row.id)).toContain(moved);
    expect(facts.rows.map((row) => row.id)).not.toContain(lost);
    // The note that lost to the kept client's is forgotten like a deleted fact; the moved one isn't.
    expect(await chatText(told)).toEqual(['Dee H. loves an oat flat white; [forgotten] is a no.']);
    expect(await episodeClients(both)).toEqual([keep]);
    expect(await episodeClients(theirs)).toEqual([keep]);
    expect(await proposalStatus(nudge)).toBe('expired');
    const rows = await inTenant((tx) =>
      tx.execute<{ client_id: string; created_client: boolean }>(
        sql`SELECT client_id, created_client FROM import_rows WHERE batch_id = ${batch}`,
      ),
    );
    expect(rows.rows).toEqual([{ client_id: keep, created_client: false }]);
  });

  it('two copies offered one time as regulars (S54): the merge keeps one offer', async () => {
    const keep = await client('Rae One', { email: 'rae1@example.test' });
    const other = await client('Rae Two', { email: 'rae2@example.test' });
    const freed = await visit(await client('Freed Slot'), new Date('2099-04-03T15:00:00Z'));
    const match = newId();
    const offerFor = (clientId: ClientId, rank: number) =>
      sql`INSERT INTO waitlist_offers (id, match_id, entry_id, source, client_id, service_id, staff_member_id, starts_at, rank, token_hash, expires_at)
        VALUES (${newId()}, ${match}, NULL, 'regular', ${clientId}, ${service}, ${jessStaff}, '2099-04-03T15:00:00Z', ${rank}, ${'a'.repeat(63) + String(rank)}, '2099-04-03T14:00:00Z')`;
    await inTenant(async (tx) => {
      await tx.execute(sql`
        INSERT INTO waitlist_matches (id, booking_id, staff_member_id, starts_at, ends_at)
        VALUES (${match}, ${freed}, ${jessStaff}, '2099-04-03T15:00:00Z', '2099-04-03T16:00:00Z')`);
      await tx.execute(offerFor(keep, 1));
      await tx.execute(offerFor(other, 2));
    });
    expect(await as(ana, (tx) => mergeClientRows(tx, keep, other, NOW))).toBeDefined();
    const offers = await inTenant((tx) =>
      tx.execute<{ client_id: string; rank: number }>(
        sql`SELECT client_id, rank FROM waitlist_offers WHERE match_id = ${match}`,
      ),
    );
    expect(offers.rows).toEqual([{ client_id: keep, rank: 1 }]);
  });

  it('sees overlapping visits of the two, and merges nothing twice', async () => {
    const a = await client('Kai One');
    const b = await client('Kai Two');
    await visit(a, new Date('2099-04-01T15:00:00Z'));
    await visit(b, new Date('2099-04-01T15:30:00Z'), leeStaff);
    expect(await as(ana, (tx) => clientVisitsOverlap(tx, a, b))).toBe(true);
    expect(await as(ana, (tx) => mergeClientRows(tx, a, a, NOW))).toBeUndefined();
    expect(
      await as(ana, (tx) => mergeClientRows(tx, a, ClientIdSchema.parse(newId()), NOW)),
    ).toBeUndefined();
  });

  it('staff can’t merge, even their own clients', async () => {
    const a = await client('Lou One');
    const b = await client('Lou Two');
    await visit(a, new Date('2099-05-01T15:00:00Z'));
    await visit(b, new Date('2099-05-02T15:00:00Z'));
    const refused = await as(jess, (tx) => mergeClientRows(tx, a, b, NOW)).catch(
      (error: unknown) => error,
    );
    expect(sqlState(refused)).toBe('42501');
    expect(await count('bookings', b)).toBe(1);
  });

  it("a fact's subject still can't change outside a merge", async () => {
    const a = await client('Ray One');
    const b = await client('Ray Two');
    const id = await note(a, 'drink', 'Black coffee');
    const refused = await as(ana, (tx) =>
      tx.execute(sql`UPDATE memory_facts SET client_id = ${b} WHERE id = ${id}`),
    ).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('P0001');
    const named = await as(ana, async (tx) => {
      await tx.execute(sql`SELECT set_config('pepper.client_merge', ${`${a}>${newId()}`}, true)`);
      return tx.execute(sql`UPDATE memory_facts SET client_id = ${b} WHERE id = ${id}`);
    }).catch((error: unknown) => error);
    expect(sqlState(named)).toBe('P0001');
  });
});

describe('deleting a client (ADR-0051)', () => {
  it('refuses while they have upcoming visits', async () => {
    const id = await client('Uma Soon');
    await visit(id, new Date('2099-03-25T15:00:00Z'));
    expect(await as(ana, (tx) => deleteClientRow(tx, id, NOW))).toEqual({
      deleted: false,
      upcoming: 1,
    });
    expect(await as(ana, (tx) => findClient(tx, id))).toBeDefined();
  });

  it('forgets them everywhere and keeps their past visits under a placeholder', async () => {
    const id = await client('Zoe Quill', { email: 'zoe@example.test', phone: '+15550002222' });
    const past = await visit(id, new Date('2099-02-02T15:00:00Z'));
    await inTenant((tx) =>
      tx.execute(sql`UPDATE bookings SET manage_token_hash = ${'c'.repeat(64)} WHERE id = ${past}`),
    );
    await visit(id, new Date('2099-01-05T15:00:00Z'));
    await inTenant((tx) =>
      tx.execute(
        sql`UPDATE bookings SET status = 'cancelled' WHERE id <> ${past} AND client_id = ${id}`,
      ),
    );
    await note(id, 'allergy', 'Ammonia');
    const told = await chat(
      jess,
      'Zoe Quill (zoe@example.test, +15550002222) cannot have ammonia.',
    );
    const named = await episode([id], 'Talked about Zoe Quill.');
    const nudge = await propose(id);
    await inTenant((tx) =>
      insertRememberedDevice(tx, {
        email: 'zoe@example.test',
        tokenHash: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 86_400_000),
        now: new Date(),
      }),
    );
    expect(await as(ana, (tx) => countClientRecords(tx, id, NOW))).toEqual({
      upcomingVisits: 0,
      pastVisits: 1,
      waitlistEntries: 0,
      notes: 1,
    });

    expect(await as(ana, (tx) => deleteClientRow(tx, id, NOW))).toEqual({
      deleted: true,
      pastVisitsKept: 1,
      notesForgotten: 1,
    });
    expect(await as(ana, (tx) => findClient(tx, id))).toBeUndefined();
    expect(await as(ana, (tx) => listClients(tx, { search: 'Zoe', limit: 50 }))).toEqual([]);
    expect(await as(ana, (tx) => findClientsByContact(tx, 'zoe@example.test' as never))).toEqual(
      [],
    );
    const [row] = await as(ana, (tx) => findClientsByIds(tx, [id]));
    expect(row).toMatchObject({
      name: DELETED_CLIENT_NAME,
      email: null,
      phone: null,
      tags: [],
      birthdayMonth: null,
    });
    expect(row?.deletedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await count('bookings', id)).toBe(2);
    const links = await inTenant((tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM bookings WHERE client_id = ${id} AND manage_token_hash IS NOT NULL`,
      ),
    );
    expect(links.rows[0]?.n).toBe(0);
    expect(await count('memory_facts', id)).toBe(0);
    expect(await chatText(told)).toEqual([
      '[forgotten] ([forgotten], [forgotten]) cannot have [forgotten].',
    ]);
    expect(await episodeClients(named)).toBeUndefined();
    expect(await proposalStatus(nudge)).toBe('expired');
    const devices = await inTenant((tx) =>
      tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM remembered_devices WHERE email = 'zoe@example.test'`,
      ),
    );
    expect(devices.rows[0]?.n).toBe(0);
    // Their past visits suggest nothing more.
    const insight = await inTenant((tx) =>
      listInsightBookings(tx, new Date('2099-01-01T00:00:00Z')),
    );
    expect(insight.map((booking) => booking.id)).not.toContain(past);
    // A second delete finds no one; the row can't be given details back.
    expect(await as(ana, (tx) => deleteClientRow(tx, id, NOW))).toBeUndefined();
    const refill = await inTenant((tx) =>
      tx.execute(sql`UPDATE clients SET email = 'zoe@example.test' WHERE id = ${id}`),
    ).catch((error: unknown) => error);
    expect(sqlState(refill)).toBe('23514');
  });

  it('staff can’t delete, and the forget function refuses them and other businesses', async () => {
    const id = await client('Ivy Staff');
    await visit(id, new Date('2099-02-03T15:00:00Z'));
    const refused = await as(jess, (tx) => deleteClientRow(tx, id, NOW)).catch(
      (error: unknown) => error,
    );
    expect(sqlState(refused)).toBe('42501');
    const elsewhere = await newTenant('Fig');
    const stranger = await withTenant(db, elsewhere, async (tx) =>
      ClientIdSchema.parse(
        (await insertClient(tx, { name: 'Far Away', email: null, phone: null, source: 'team' })).id,
      ),
    );
    const across = await as(ana, (tx) =>
      tx.execute(sql`SELECT client_forget(${stranger}::uuid)`),
    ).catch((error: unknown) => error);
    expect(sqlState(across)).toBe('P0002');
    const merge = await as(ana, (tx) =>
      tx.execute(sql`SELECT client_merge_episodes(${stranger}::uuid, ${id}::uuid)`),
    ).catch((error: unknown) => error);
    expect(sqlState(merge)).toBe('P0002');
  });
});

describe('walk-in clients (S50.2, ADR-0052)', () => {
  const bookIn = (tx: TenantTx, clientId: ClientId, startsAt: Date) =>
    insertBooking(tx, {
      clientId,
      serviceId: service,
      staffMemberId: jessStaff,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 4000,
      priceToCents: null,
      source: 'team',
      overridden: true,
      idempotencyKey: null,
      createdBy: jess,
    });
  const named = async (name: string) =>
    (
      await inTenant((tx) =>
        tx.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM clients WHERE name = ${name}`),
      )
    ).rows[0]?.n;

  it('a staff member adds a walk-in with their booking; other staff don’t see them', async () => {
    const id = await as(jess, async (tx) => {
      const added = await insertWalkInClient(tx, {
        name: 'Walker Inn',
        email: 'walker@example.com',
        phone: '+15550001111',
      });
      // Not theirs until the booking is written.
      expect(await findClient(tx, added)).toBeUndefined();
      await bookIn(tx, added, new Date('2099-05-17T07:00:00Z'));
      expect((await findClient(tx, added))?.name).toBe('Walker Inn');
      return added;
    });
    const kim = await insertUser(db, 'Kim');
    await inTenant(async (tx) => {
      const membership = await addMembership(tx, { userId: kim, role: 'staff' });
      await insertStaffMember(tx, {
        displayName: 'Kim',
        color: '#2a7230',
        active: true,
        membershipId: membership.id,
      });
    });
    expect(await as(kim, (tx) => findClient(tx, id))).toBeUndefined();
    const seen = await as(ana, (tx) => findClient(tx, id));
    expect(seen).toMatchObject({ source: 'team', email: 'walker@example.com' });
  });

  it('refuses at commit a walk-in the transaction didn’t book', async () => {
    const refused = await as(jess, (tx) =>
      insertWalkInClient(tx, { name: 'Never Booked', email: null, phone: null }),
    ).catch((error: unknown) => error);
    expect(sqlState(refused)).toBe('23514');
    expect(await named('Never Booked')).toBe(0);
  });

  it('only a staff member of the business adds one, and staff still can’t add a client', async () => {
    // Ana is the owner without a staff member; a stranger has no membership at all.
    const owner = await as(ana, (tx) =>
      insertWalkInClient(tx, { name: 'Owner Walk', email: null, phone: null }),
    ).catch((error: unknown) => error);
    expect(sqlState(owner)).toBe('42501');
    const stranger = await insertUser(db, 'Stranger');
    const outside = await as(stranger, (tx) =>
      insertWalkInClient(tx, { name: 'Outside Walk', email: null, phone: null }),
    ).catch((error: unknown) => error);
    expect(sqlState(outside)).toBe('42501');
    const elsewhere = await newTenant('Hazel');
    const across = await withMember(db, { tenantId: elsewhere, userId: jess }, (tx) =>
      insertWalkInClient(tx, { name: 'Across Walk', email: null, phone: null }),
    ).catch((error: unknown) => error);
    expect(sqlState(across)).toBe('42501');
    const direct = await as(jess, (tx) =>
      insertClient(tx, { name: 'Direct Add', email: null, phone: null, source: 'team' }),
    ).catch((error: unknown) => error);
    expect(sqlState(direct)).toBe('42501');
    expect(await named('Owner Walk')).toBe(0);
    expect(await named('Direct Add')).toBe(0);
  });

  it('a walk-in with a taken email is refused as taken', async () => {
    await client('Taken Email', { email: 'taken@example.com' });
    const refused = await as(jess, (tx) =>
      insertWalkInClient(tx, { name: 'Second', email: 'taken@example.com', phone: null }),
    ).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ClientEmailTakenError);
  });
});

describe('paging and searching clients (S50.2)', () => {
  it('pages by name and id with no repeats or gaps, and finds part of a phone', async () => {
    const shop = await newTenant('Paging');
    const names = ['Pat', 'pat', 'Pat', 'Amy', 'Zed', 'Bo', 'Pat'];
    await withTenant(db, shop, async (tx) => {
      for (const [index, name] of names.entries()) {
        await insertClient(tx, {
          name,
          email: null,
          phone: index === 4 ? '+15551234567' : null,
          source: 'import',
        });
      }
    });
    const all = await withTenant(db, shop, (tx) => listClients(tx, { limit: 50 }));
    const paged: string[] = [];
    let after: ClientId | undefined;
    for (;;) {
      const page = await withTenant(db, shop, (tx) => listClients(tx, { limit: 2, after }));
      paged.push(...page.map((row) => row.id));
      if (page.length < 2) break;
      after = ClientIdSchema.parse(page.at(-1)?.id);
    }
    expect(paged).toEqual(all.map((row) => row.id));
    expect(new Set(paged).size).toBe(names.length);
    const search = (text: string, namesOnly = false) =>
      withTenant(db, shop, (tx) => listClients(tx, { search: text, limit: 50, namesOnly })).then(
        (rows) => rows.map((row) => row.name),
      );
    expect(await search('(555) 123')).toEqual(['Zed']);
    expect(await search('555-123-4567')).toEqual(['Zed']);
    expect(await search('55')).toEqual([]);
    // An email-like search with digits matches no phone.
    expect(await search('zed555@')).toEqual([]);
    expect(await search('555 123', true)).toEqual([]);
  });
});
