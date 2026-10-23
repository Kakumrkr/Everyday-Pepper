import {
  BookingIdSchema,
  ClientIdSchema,
  ConversationIdSchema,
  ConversationTurnIdSchema,
  EMBEDDING_DIMENSIONS,
  MemoryEpisodeIdSchema,
  MemoryFactIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type BookingId,
  type ClientId,
  type ConversationTurnId,
  type Embedding,
  type MemoryFactId,
  type MemorySubject,
  type StaffMemberId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { MemorySubjectUnreachableError } from './errors.js';
import { insertService, insertStaffMember } from './repositories/appointments.js';
import { insertBooking } from './repositories/bookings.js';
import { insertClient } from './repositories/clients.js';
import {
  finishTurn,
  insertConversation,
  insertMessage,
  insertTurn,
  type NewConversationMessage,
} from './repositories/conversations.js';
import { addMembership } from './repositories/memberships.js';
import {
  activeMemoryFactsOf,
  clearExpiredMemoryPreviousValues,
  countMemoryFacts,
  deleteMemoryEpisode,
  deleteMemoryFact,
  storedTextsOf,
  deleteOldMemoryEpisodes,
  insertMemoryEpisode,
  insertMemoryFact,
  listMemoryEpisodes,
  listMemoryFacts,
  lockActiveMemoryFact,
  memoryPaused,
  memorySubjectOf,
  searchMemoryEpisodes,
  setMemoryPaused,
  updateMemoryFact,
  type NewMemoryFact,
} from './repositories/memory.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, sqlState, startTestDatabase, type TestDatabase } from './test-support.js';

// What Pepper remembers, against real Postgres (ADR-0034): who reaches which facts and
// episodes, one current value per subject and key, the guard, and forget everywhere (a deleted
// fact's value leaves the business's stored conversations and episodes in the same
// transaction, whoever's chats they are). Isolation between businesses is in
// isolation.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let other: TenantId;
// Ana owns the business; Jess and Marco are staff, each linked to their staff member.
let ana: UserId;
let jess: UserId;
let marco: UserId;
let jessStaff: StaffMemberId;
let marcoStaff: StaffMemberId;
let service: ReturnType<typeof ServiceIdSchema.parse>;
// Maria is booked with Jess, Lee with Marco.
let maria: ClientId;
let lee: ClientId;
let mariaVisit: BookingId;
let leeVisit: BookingId;
let slugs = 0;

const as = <T>(userId: UserId, work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId }, work);
const inTenant = <T>(work: (tx: TenantTx) => Promise<T>, t: TenantId = tenant) =>
  withTenant(db, t, work);

async function asAdmin<T extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

function fact(
  subject: MemorySubject,
  key: string,
  value: string,
  extra: Partial<NewMemoryFact> = {},
) {
  return {
    subject,
    key,
    value,
    sensitive: false,
    status: 'active',
    source: 'screen',
    sourceTurnId: null,
    createdBy: null,
    ...extra,
  } satisfies NewMemoryFact;
}

async function save(input: NewMemoryFact, by?: UserId): Promise<MemoryFactId> {
  const work = async (tx: TenantTx) =>
    MemoryFactIdSchema.parse((await insertMemoryFact(tx, input)).id);
  return by === undefined ? inTenant(work) : as(by, work);
}

/** A unit vector along `axis`, a little towards `lean` (for similarity order). */
function unit(axis: number, lean?: { axis: number; weight: number }): Embedding {
  const vector: number[] = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) =>
    i === axis ? 1 : 0,
  );
  if (lean !== undefined) vector[lean.axis] = lean.weight;
  return vector;
}

async function newTenant(name: string): Promise<TenantId> {
  slugs += 1;
  const created = await createTenant(db, {
    name,
    slug: `${name.toLowerCase()}-memory-${String(slugs)}`,
    timeZone: 'America/New_York',
  });
  return TenantIdSchema.parse(created.id);
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = await newTenant('Juniper');
  other = await newTenant('Fig');
  ana = await insertUser(db, 'Ana');
  jess = await insertUser(db, 'Jess');
  marco = await insertUser(db, 'Marco');
  await inTenant(async (tx) => {
    await addMembership(tx, { userId: ana, role: 'owner' });
    const jessMembership = await addMembership(tx, { userId: jess, role: 'staff' });
    const marcoMembership = await addMembership(tx, { userId: marco, role: 'staff' });
    const staff = async (displayName: string, membershipId: string) =>
      StaffMemberIdSchema.parse(
        (await insertStaffMember(tx, { displayName, color: '#2a7230', active: true, membershipId }))
          .id,
      );
    jessStaff = await staff('Jess', jessMembership.id);
    marcoStaff = await staff('Marco', marcoMembership.id);
    service = ServiceIdSchema.parse(
      (
        await insertService(tx, {
          name: 'Full color',
          category: 'color',
          durationMinutes: 90,
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 12000,
          priceToCents: null,
          active: true,
        })
      ).id,
    );
    const client = async (name: string) =>
      ClientIdSchema.parse(
        (await insertClient(tx, { name, email: null, phone: null, source: 'team' })).id,
      );
    maria = await client('Maria Lopez');
    lee = await client('Lee Park');
    const visit = async (clientId: ClientId, staffMemberId: StaffMemberId, startsAt: string) =>
      BookingIdSchema.parse(
        (
          await insertBooking(tx, {
            clientId,
            serviceId: service,
            staffMemberId,
            startsAt: new Date(startsAt),
            endsAt: new Date(new Date(startsAt).getTime() + 90 * 60_000),
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            priceFromCents: 12000,
            priceToCents: null,
            source: 'team',
            overridden: false,
            idempotencyKey: null,
            createdBy: null,
          })
        ).id,
      );
    mariaVisit = await visit(maria, jessStaff, '2026-10-12T14:00:00Z');
    leeVisit = await visit(lee, marcoStaff, '2026-10-12T14:00:00Z');
  });
});

afterAll(async () => {
  await database.stop();
});

describe('who reaches which facts', () => {
  type FactName =
    | 'mariaAllergy'
    | 'mariaVisit'
    | 'leeAllergy'
    | 'leeVisit'
    | 'opening'
    | 'lease'
    | 'jessDays'
    | 'jessHealth'
    | 'marcoHealth'
    | 'colorNote';
  let ids: Record<FactName, MemoryFactId>;

  beforeAll(async () => {
    ids = {
      mariaAllergy: await save(
        fact({ type: 'client', id: maria }, 'allergy', 'Henna', { sensitive: true }),
      ),
      mariaVisit: await save(fact({ type: 'booking', id: mariaVisit }, 'formula', '6N + 20 vol')),
      leeAllergy: await save(
        fact({ type: 'client', id: lee }, 'allergy', 'Latex', { sensitive: true }),
      ),
      leeVisit: await save(fact({ type: 'booking', id: leeVisit }, 'formula', '7A + 10 vol')),
      opening: await save(
        fact({ type: 'business' }, 'prefers', 'No bookings before 10 on Mondays'),
      ),
      lease: await save(
        fact({ type: 'business' }, 'personal', 'Lease ends in March', { sensitive: true }),
      ),
      jessDays: await save(fact({ type: 'staff', id: jessStaff }, 'prefers', 'No Saturdays')),
      jessHealth: await save(
        fact({ type: 'staff', id: jessStaff }, 'health', 'Back surgery in May', {
          sensitive: true,
        }),
      ),
      marcoHealth: await save(
        fact({ type: 'staff', id: marcoStaff }, 'health', 'Knee injury', { sensitive: true }),
      ),
      colorNote: await save(
        fact({ type: 'service', id: service }, 'note', 'Patch test 48 hours before'),
      ),
    };
  });

  const seen = async (userId: UserId) =>
    new Set(
      (await as(userId, (tx) => listMemoryFacts(tx, { status: 'active', limit: 500 }))).map(
        (row) => row.id,
      ),
    );

  it('owners and managers reach every fact', async () => {
    const all = await seen(ana);
    for (const id of Object.values(ids)) expect(all.has(id)).toBe(true);
  });

  it("staff reach their clients' and visits' facts, their own, and the non-sensitive rest", async () => {
    const mine = await seen(jess);
    expect(
      Object.entries(ids)
        .filter(([, id]) => mine.has(id))
        .map(([name]) => name)
        .sort(),
    ).toEqual(['colorNote', 'jessDays', 'jessHealth', 'mariaAllergy', 'mariaVisit', 'opening']);
  });

  it('staff write only facts of what they reach, and never the business-wide ones', async () => {
    const onLee = await as(jess, (tx) =>
      insertMemoryFact(tx, fact({ type: 'client', id: lee }, 'prefers', 'Quiet appointments')),
    ).catch((e: unknown) => e);
    expect(onLee).toBeInstanceOf(MemorySubjectUnreachableError);
    const onBusiness = await as(jess, (tx) =>
      insertMemoryFact(tx, fact({ type: 'business' }, 'parking', 'Behind the shop')),
    ).catch((e: unknown) => e);
    expect(onBusiness).toBeInstanceOf(MemorySubjectUnreachableError);
    const onMarco = await as(jess, (tx) =>
      insertMemoryFact(tx, fact({ type: 'staff', id: marcoStaff }, 'prefers', 'Mornings')),
    ).catch((e: unknown) => e);
    expect(onMarco).toBeInstanceOf(MemorySubjectUnreachableError);
    const onMaria = await save(
      fact({ type: 'client', id: maria }, 'prefers', 'Quiet appointments'),
      jess,
    );
    expect(await as(jess, (tx) => deleteMemoryFact(tx, onMaria))).toBe(true);
    // She sees the business's opening rule but may not change or delete it.
    expect(
      await as(jess, (tx) => updateMemoryFact(tx, ids.opening, { value: 'Open at 9' })),
    ).toBeUndefined();
    expect(await as(jess, (tx) => deleteMemoryFact(tx, ids.opening))).toBe(false);
    expect(await as(jess, (tx) => deleteMemoryFact(tx, ids.leeAllergy))).toBe(false);
  });

  it('recall returns the subjects’ active facts the member reaches, sensitive first', async () => {
    const recalled = await as(jess, (tx) =>
      activeMemoryFactsOf(
        tx,
        [{ type: 'client', id: maria }, { type: 'client', id: lee }, { type: 'business' }],
        50,
      ),
    );
    expect(recalled.map((row) => row.id)).toEqual([ids.mariaAllergy, ids.opening]);
    expect(recalled.map(memorySubjectOf)).toEqual([
      { type: 'client', id: maria },
      { type: 'business' },
    ]);
  });
});

describe('one current value per subject and key', () => {
  it('a second active value for the same key is refused; proposals may queue', async () => {
    const subject = { type: 'client', id: lee } as const;
    await save(fact(subject, 'usual_service', 'Full color with Marco'));
    const twice = await save(fact(subject, 'usual_service', 'Cut with Jess')).catch(
      (e: unknown) => e,
    );
    expect(sqlState(twice)).toBe('23505');
    await save(fact(subject, 'usual_service', 'Cut', { status: 'proposed', source: 'chat' }));
    await save(fact(subject, 'usual_service', 'Trim', { status: 'proposed', source: 'chat' }));
    const locked = await inTenant((tx) => lockActiveMemoryFact(tx, subject, 'usual_service'));
    expect(locked?.value).toBe('Full color with Marco');
    expect(await inTenant((tx) => countMemoryFacts(tx, subject))).toMatchObject({ subject: 4 });
  });

  it('keeps its subject and origin; a proposal may become active, not back', async () => {
    const id = await save(
      fact({ type: 'client', id: maria }, 'pets', 'A dog called Rio', {
        status: 'proposed',
        source: 'chat',
      }),
    );
    const moved = await asAdmin('UPDATE memory_facts SET client_id = $1 WHERE id = $2', [
      lee,
      id,
    ]).catch((e: unknown) => e);
    expect(sqlState(moved)).toBe('P0001');
    expect((await inTenant((tx) => updateMemoryFact(tx, id, { status: 'active' })))?.status).toBe(
      'active',
    );
    const back = await inTenant((tx) => updateMemoryFact(tx, id, { status: 'proposed' })).catch(
      (e: unknown) => e,
    );
    expect(sqlState(back)).toBe('P0001');
  });

  it('the clean-up clears replaced values whose Undo window ended', async () => {
    const id = await save(fact({ type: 'client', id: maria }, 'drink', 'Oat latte'));
    await inTenant((tx) =>
      updateMemoryFact(tx, id, {
        value: 'Green tea',
        previousValue: 'Oat latte',
        previousUntil: new Date('2026-01-01T00:00:00Z'),
      }),
    );
    expect(
      await inTenant((tx) =>
        clearExpiredMemoryPreviousValues(tx, new Date('2026-01-02T00:00:00Z'), 100),
      ),
    ).toBeGreaterThanOrEqual(1);
    const [row] = await asAdmin<{ previous_value: string | null; value: string }>(
      'SELECT previous_value, value FROM memory_facts WHERE id = $1',
      [id],
    );
    expect(row).toEqual({ previous_value: null, value: 'Green tea' });
  });
});

const REMOVED_ANSWER = '[Removed: this answer used a fact that was deleted]';

describe('forget everywhere', () => {
  /** A conversation turn of `userId` with these messages; returns the turn id. */
  async function chat(
    userId: UserId,
    messages: (
      | { role: 'user'; content: string }
      | { role: 'assistant'; content: string; args?: string; replay?: Record<string, unknown>[] }
      | { role: 'tool'; content: string; cardName?: string }
    )[],
    t: TenantId = tenant,
  ): Promise<ConversationTurnId> {
    return withMember(db, { tenantId: t, userId }, async (tx) => {
      const conversationId = ConversationIdSchema.parse(
        (await insertConversation(tx, { userId, channel: 'chat' })).id,
      );
      const turn = await insertTurn(tx, {
        conversationId,
        userId,
        clientTurnId: newId(),
        deadlineAt: new Date(Date.now() + 60_000),
      });
      if (turn === undefined) throw new Error('no turn');
      const turnId = ConversationTurnIdSchema.parse(turn.id);
      for (const message of messages) {
        const base = { conversationId, turnId, userId, untrusted: false };
        const input: NewConversationMessage =
          message.role === 'user'
            ? { ...base, role: 'user', content: message.content }
            : message.role === 'assistant'
              ? {
                  ...base,
                  role: 'assistant',
                  step: 1,
                  content: message.content,
                  toolCalls:
                    message.args === undefined
                      ? []
                      : [{ id: 'call_1', name: 'remember_fact', arguments: message.args }],
                  replay: message.replay ?? [],
                }
              : {
                  ...base,
                  role: 'tool',
                  step: 1,
                  toolCallId: 'call_1',
                  toolName: 'remember_fact',
                  isError: false,
                  content: message.content,
                  card:
                    message.cardName === undefined
                      ? null
                      : {
                          kind: 'client_choice',
                          clients: [{ clientId: maria, name: message.cardName }],
                        },
                };
        await insertMessage(tx, input);
      }
      return turnId;
    });
  }

  async function stored(turnId: ConversationTurnId) {
    return asAdmin<{
      role: string;
      content: string;
      tool_calls: unknown;
      card: unknown;
      replay: unknown;
    }>(
      'SELECT role, content, tool_calls, card, replay FROM conversation_messages WHERE turn_id = $1 ORDER BY seq',
      [turnId],
    );
  }

  async function anywhere(pattern: RegExp, t: TenantId = tenant): Promise<string[]> {
    const [messages, episodes, facts] = await Promise.all([
      asAdmin<{ text: string }>(
        `SELECT content || ' ' || tool_calls::text || ' ' || coalesce(card::text, '') || ' ' || replay::text AS text
           FROM conversation_messages WHERE tenant_id = $1`,
        [t],
      ),
      asAdmin<{ text: string }>(
        'SELECT summary AS text FROM memory_episodes WHERE tenant_id = $1',
        [t],
      ),
      asAdmin<{ text: string }>(
        "SELECT value || ' ' || coalesce(previous_value, '') AS text FROM memory_facts WHERE tenant_id = $1",
        [t],
      ),
    ]);
    return [...messages, ...episodes, ...facts]
      .map((row) => row.text)
      .filter((text) => pattern.test(text));
  }

  it('a deleted fact leaves no trace in any member’s chats or episodes', async () => {
    const id = await save(
      fact({ type: 'client', id: maria }, 'dye_allergy', 'PPD', {
        sensitive: true,
        source: 'chat',
      }),
      ana,
    );
    const told = await chat(ana, [
      { role: 'user', content: 'Maria is allergic to PPD, remember that.' },
      {
        role: 'assistant',
        content: '',
        args: JSON.stringify({ key: 'allergy', value: 'PPD' }),
        replay: [
          { type: 'reasoning', encrypted_content: 'opaque' },
          { type: 'pepper.message_phase', phase: 'commentary' },
        ],
      },
      { role: 'tool', content: JSON.stringify({ saved: 'allergy: PPD' }), cardName: 'Maria (ppd)' },
      { role: 'assistant', content: 'Saved: Maria is allergic to PPD.' },
    ]);
    const unrelated = await chat(ana, [
      { role: 'user', content: 'What does Friday look like? PPDX is a product code.' },
      {
        role: 'assistant',
        content: 'Three bookings.',
        replay: [{ type: 'reasoning', encrypted_content: 'kept' }],
      },
    ]);
    const jessChat = await chat(jess, [
      { role: 'user', content: 'Anything about Maria? (ppd allergy)' },
    ]);
    const elsewhere = await chat(
      await (async () => {
        const user = await insertUser(db, 'Other owner');
        await inTenant((tx) => addMembership(tx, { userId: user, role: 'owner' }), other);
        return user;
      })(),
      [{ role: 'user', content: 'Our supplier sells PPD-free dye.' }],
      other,
    );
    const episode = await inTenant((tx) =>
      insertMemoryEpisode(tx, {
        userId: jess,
        conversationId: null,
        summary: 'Maria has a PPD allergy; color with care.',
        clientIds: [maria],
        embedding: unit(1),
        embeddingModel: 'text-embedding-3-small',
      }),
    );
    const kept = await inTenant((tx) =>
      insertMemoryEpisode(tx, {
        userId: jess,
        conversationId: null,
        summary: 'Jess keeps Saturdays free.',
        clientIds: [],
        embedding: unit(2),
        embeddingModel: 'text-embedding-3-small',
      }),
    );

    expect(await as(ana, (tx) => deleteMemoryFact(tx, id))).toBe(true);

    expect(await anywhere(/(?<![a-z0-9_])ppd(?![a-z0-9_])/i)).toEqual([]);
    const [user, call, tool, answer] = await stored(told);
    expect(user?.content).toBe('Maria is allergic to [forgotten], remember that.');
    expect(call?.tool_calls).toEqual([
      { id: 'call_1', name: 'remember_fact', arguments: '{"key":"allergy","value":"[forgotten]"}' },
    ]);
    // The provider's opaque reasoning may hold it too: dropped, the phase kept.
    expect(call?.replay).toEqual([{ type: 'pepper.message_phase', phase: 'commentary' }]);
    expect(JSON.parse(tool?.content ?? '')).toEqual({ saved: 'allergy: [forgotten]' });
    // A card that held it is dropped: a longer text could break its shape.
    expect(tool?.card).toBeNull();
    expect(answer?.content).toBe('Saved: Maria is allergic to [forgotten].');
    // A staff member's own chat is scrubbed too, though the owner deleted it.
    expect((await stored(jessChat))[0]?.content).toBe(
      'Anything about Maria? ([forgotten] allergy)',
    );
    // Whole words only; another turn and another business are untouched.
    const [question, reply] = await stored(unrelated);
    expect(question?.content).toBe('What does Friday look like? PPDX is a product code.');
    expect(reply?.replay).toEqual([{ type: 'reasoning', encrypted_content: 'kept' }]);
    expect((await stored(elsewhere))[0]?.content).toBe('Our supplier sells PPD-free dye.');
    const episodes = await inTenant((tx) => listMemoryEpisodes(tx, 100));
    expect(episodes.map((row) => row.id)).not.toContain(episode.id);
    expect(episodes.map((row) => row.id)).toContain(kept.id);
  });

  it('a staff member’s delete scrubs the owner’s chats; a replaced value goes too', async () => {
    const id = await save(
      fact({ type: 'client', id: maria }, 'metal_allergy', 'Latex gloves', { sensitive: true }),
      jess,
    );
    await as(jess, (tx) =>
      updateMemoryFact(tx, id, {
        value: 'Nickel',
        previousValue: 'Latex gloves',
        previousUntil: new Date(Date.now() + 86_400_000),
      }),
    );
    const told = await chat(ana, [
      { role: 'user', content: 'Maria reacts to LATEX   gloves and to nickel.' },
    ]);
    expect(await as(jess, (tx) => deleteMemoryFact(tx, id))).toBe(true);
    expect((await stored(told))[0]?.content).toBe(
      'Maria reacts to [forgotten] and to [forgotten].',
    );
  });

  it('values with symbols match literally; very short values are left alone', async () => {
    const formula = await save(
      fact({ type: 'booking', id: mariaVisit }, 'toner', '6N + 20 vol (cool)'),
    );
    const short = await save(fact({ type: 'client', id: maria }, 'kids', 'no'));
    const told = await chat(ana, [
      { role: 'user', content: 'Used 6n  +  20 VOL (cool) on Maria, no toner. Not 6N 20 vol.' },
    ]);
    await inTenant(async (tx) => {
      await deleteMemoryFact(tx, formula);
      await deleteMemoryFact(tx, short);
    });
    expect((await stored(told))[0]?.content).toBe(
      'Used [forgotten] on Maria, no toner. Not 6N 20 vol.',
    );
  });

  it("deleting a client takes their facts, scrubs the values, and drops every member's episodes that name them", async () => {
    const lee2 = await inTenant(async (tx) =>
      ClientIdSchema.parse(
        (await insertClient(tx, { name: 'Robin Kay', email: null, phone: null, source: 'team' }))
          .id,
      ),
    );
    await save(fact({ type: 'client', id: lee2 }, 'allergy', 'Ammonia', { sensitive: true }));
    const told = await chat(jess, [{ role: 'user', content: 'Robin cannot have ammonia.' }]);
    const named = await inTenant((tx) =>
      insertMemoryEpisode(tx, {
        userId: ana,
        conversationId: null,
        summary: 'Talked about Robin.',
        clientIds: [lee2],
        embedding: unit(3),
        embeddingModel: 'text-embedding-3-small',
      }),
    );
    await inTenant((tx) => tx.execute(sql`DELETE FROM clients WHERE id = ${lee2}`));
    expect(await anywhere(/ammonia/i)).toEqual([]);
    expect((await stored(told))[0]?.content).toBe('Robin cannot have [forgotten].');
    expect(
      (await inTenant((tx) => listMemoryEpisodes(tx, 100))).map((row) => row.id),
    ).not.toContain(named.id);
  });

  it('touches only text since the fact existed, and the turn it came from', async () => {
    const before = await chat(ana, [{ role: 'user', content: 'Ordered Olaplex for the shop.' }]);
    const source = await chat(ana, [{ role: 'user', content: 'Lee is sensitive to Olaplex.' }]);
    const id = await save(
      fact({ type: 'client', id: lee }, 'product_allergy', 'Olaplex', {
        source: 'chat',
        sourceTurnId: source,
      }),
    );
    const after = await chat(ana, [{ role: 'user', content: 'Skip Olaplex for Lee next time.' }]);
    await inTenant((tx) => deleteMemoryFact(tx, id));
    expect((await stored(before))[0]?.content).toBe('Ordered Olaplex for the shop.');
    expect((await stored(source))[0]?.content).toBe('Lee is sensitive to [forgotten].');
    expect((await stored(after))[0]?.content).toBe('Skip [forgotten] for Lee next time.');
  });

  it('finds values with quotes inside tool calls, and letters beyond ASCII', async () => {
    const quoted = await save(
      fact({ type: 'client', id: lee }, 'nickname', 'the "Queen" of curls'),
    );
    const accented = await save(fact({ type: 'client', id: lee }, 'drink', 'Crème brûlée latte'));
    const told = await chat(ana, [
      {
        role: 'assistant',
        content: 'Lee likes a crème brûlée latte.',
        args: JSON.stringify({ value: 'the "Queen" of curls' }),
      },
      { role: 'tool', content: JSON.stringify({ saved: 'the "Queen" of curls' }) },
    ]);
    await inTenant(async (tx) => {
      await deleteMemoryFact(tx, quoted);
      await deleteMemoryFact(tx, accented);
    });
    const [call, tool] = await stored(told);
    expect(call?.content).toBe('Lee likes a [forgotten].');
    expect(call?.tool_calls).toEqual([
      { id: 'call_1', name: 'remember_fact', arguments: '{"value":"[forgotten]"}' },
    ]);
    expect(JSON.parse(tool?.content ?? '')).toEqual({ saved: '[forgotten]' });
  });

  it('a forgotten fact takes the AI’s answers that recalled it, however worded (S30b)', async () => {
    const note = await save(
      fact({ type: 'booking', id: mariaVisit }, 'toner_formula', '6N + 20 vol, 35 min'),
      ana,
    );
    const kept = await save(
      fact({ type: 'client', id: maria }, 'favourite_drink', 'Oat latte'),
      ana,
    );
    // One conversation, three turns: before the look-up, the look-up, and a repeat from history.
    const turns = await as(ana, async (tx) => {
      const conversationId = ConversationIdSchema.parse(
        (await insertConversation(tx, { userId: ana, channel: 'chat' })).id,
      );
      const ids: ConversationTurnId[] = [];
      for (const messages of [
        [
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello! How can I help?' },
        ],
        [
          { role: 'user', content: 'What formula did we use on Maria last time?' },
          { role: 'assistant', content: '', call: true },
          { role: 'tool', content: JSON.stringify({ lastVisit: { notes: [{ $fact: note }] } }) },
          { role: 'assistant', content: 'Her last formula was 6N with 20 volume, for 35 minutes.' },
        ],
        [
          { role: 'user', content: 'Say that again?' },
          { role: 'assistant', content: 'Six N, twenty volume, thirty-five minutes.' },
        ],
      ] as const) {
        const turn = await insertTurn(tx, {
          conversationId,
          userId: ana,
          clientTurnId: newId(),
          deadlineAt: new Date(Date.now() + 60_000),
        });
        if (turn === undefined) throw new Error('no turn');
        const turnId = ConversationTurnIdSchema.parse(turn.id);
        for (const message of messages) {
          const base = { conversationId, turnId, userId: ana, untrusted: false };
          await insertMessage(
            tx,
            message.role === 'user'
              ? { ...base, role: 'user', content: message.content }
              : message.role === 'assistant'
                ? {
                    ...base,
                    role: 'assistant',
                    step: 1,
                    content: message.content,
                    toolCalls:
                      'call' in message
                        ? [{ id: 'call_1', name: 'find_client_bookings', arguments: '{}' }]
                        : [],
                    replay: [{ type: 'reasoning', encrypted_content: 'opaque' }],
                  }
                : {
                    ...base,
                    role: 'tool',
                    step: 1,
                    toolCallId: 'call_1',
                    toolName: 'find_client_bookings',
                    isError: false,
                    content: message.content,
                    card: null,
                  },
          );
        }
        await finishTurn(tx, turnId, {
          status: 'completed',
          stopReason: 'answered',
          at: new Date(),
          progress: null,
        });
        ids.push(turnId);
      }
      return ids;
    });
    // Another conversation recalled only the fact that stays.
    const other = await chat(ana, [
      { role: 'user', content: 'What does Maria like to drink?' },
      { role: 'tool', content: JSON.stringify({ memory: [{ $fact: kept }] }) },
      { role: 'assistant', content: 'An oat latte.' },
    ]);

    expect(await as(ana, (tx) => deleteMemoryFact(tx, note))).toBe(true);

    const [before, lookUp, repeat] = await Promise.all(turns.map((turn) => stored(turn)));
    // Before the look-up the model had not seen it: untouched.
    expect(before?.map((row) => row.content)).toEqual(['Hi', 'Hello! How can I help?']);
    expect(before?.[1]?.replay).toEqual([{ type: 'reasoning', encrypted_content: 'opaque' }]);
    // From the look-up on, the AI's words in that conversation go, with its reasoning items;
    // the member's words and the tool answer (a reference, no value) stay.
    expect(lookUp?.map((row) => row.content)).toEqual([
      'What formula did we use on Maria last time?',
      '',
      JSON.stringify({ lastVisit: { notes: [{ $fact: note }] } }),
      REMOVED_ANSWER,
    ]);
    expect(lookUp?.[1]?.tool_calls).toEqual([
      { id: 'call_1', name: 'find_client_bookings', arguments: '{}' },
    ]);
    expect(lookUp?.[3]?.replay).toEqual([]);
    expect(repeat?.map((row) => row.content)).toEqual(['Say that again?', REMOVED_ANSWER]);
    expect(await anywhere(/35 min|thirty-five/i)).toEqual([]);
    // A conversation that recalled only other facts keeps its answers.
    expect((await stored(other)).map((row) => row.content)).toContain('An oat latte.');
  });

  it('the scrub can only be reached by deleting a fact', async () => {
    const direct = await inTenant((tx) =>
      tx.execute(sql`SELECT memory_scrub(${tenant}::uuid, 'Maria', now(), NULL)`),
    ).catch((e: unknown) => e);
    expect(sqlState(direct)).toBe('42501');
    const recalled = await inTenant((tx) =>
      tx.execute(sql`SELECT memory_forget_recalled(${tenant}::uuid, ${newId()}::uuid, now())`),
    ).catch((e: unknown) => e);
    expect(sqlState(recalled)).toBe('42501');
    const update = await as(ana, (tx) =>
      tx.execute(sql`UPDATE conversation_messages SET content = 'rewritten'`),
    ).catch((e: unknown) => e);
    expect(sqlState(update)).toBe('42501');
  });

  it('a proposed fact that goes scrubs nothing: it was never remembered (S30)', async () => {
    const id = await save(
      fact({ type: 'client', id: maria }, 'nut_allergy', 'Hazelnut oil', {
        sensitive: true,
        status: 'proposed',
        source: 'chat',
      }),
      ana,
    );
    const told = await chat(ana, [{ role: 'user', content: 'Maria reacts to hazelnut oil.' }]);
    expect(await as(ana, (tx) => deleteMemoryFact(tx, id))).toBe(true);
    expect((await stored(told))[0]?.content).toBe('Maria reacts to hazelnut oil.');
  });

  it('every text where a value could travel is listed for the deletion checks (S30)', async () => {
    await chat(ana, [{ role: 'user', content: 'Remember the Zanzibar code word.' }]);
    const texts = await inTenant((tx) => storedTextsOf(tx));
    expect(texts.some((text) => text.includes('Zanzibar code word'))).toBe(true);
  });

  it('a whole business can still be deleted', async () => {
    const gone = await newTenant('Gone');
    const owner = await insertUser(db, 'Gone owner');
    await inTenant((tx) => addMembership(tx, { userId: owner, role: 'owner' }), gone);
    await inTenant(
      (tx) => insertMemoryFact(tx, fact({ type: 'business' }, 'prefers', 'Closed Sundays')),
      gone,
    );
    await chat(owner, [{ role: 'user', content: 'We are closed Sundays.' }], gone);
    await asAdmin('DELETE FROM tenants WHERE id = $1', [gone]);
    expect(await asAdmin('SELECT 1 FROM memory_facts WHERE tenant_id = $1', [gone])).toEqual([]);
  });
});

describe('episodes', () => {
  it('own-only: a member reaches, searches and deletes only their own', async () => {
    const t = await newTenant('Episodes');
    const owner = await insertUser(db, 'Owner');
    const staff = await insertUser(db, 'Staff');
    await inTenant(async (tx) => {
      await addMembership(tx, { userId: owner, role: 'owner' });
      await addMembership(tx, { userId: staff, role: 'staff' });
    }, t);
    const add = (userId: UserId, summary: string, embedding: Embedding) =>
      inTenant(
        (tx) =>
          insertMemoryEpisode(tx, {
            userId,
            conversationId: null,
            summary,
            clientIds: [],
            embedding,
            embeddingModel: 'text-embedding-3-small',
          }),
        t,
      );
    const near = await add(owner, 'Saturday hours for Jess', unit(10, { axis: 11, weight: 0.1 }));
    const far = await add(owner, 'Color stock order', unit(12));
    const nearer = await add(
      owner,
      'Jess and Saturdays again',
      unit(10, { axis: 11, weight: 0.01 }),
    );
    const staffs = await add(staff, 'Jess Saturdays (staff chat)', unit(10));
    // Another business's identical vector is never a match.
    const elsewhere = await insertUser(db, 'Elsewhere');
    await inTenant(async (tx) => {
      await addMembership(tx, { userId: elsewhere, role: 'owner' });
      await insertMemoryEpisode(tx, {
        userId: elsewhere,
        conversationId: null,
        summary: 'Saturdays',
        clientIds: [],
        embedding: unit(10),
        embeddingModel: 'm',
      });
    }, other);

    const asOwner = <T>(work: (tx: TenantTx) => Promise<T>) =>
      withMember(db, { tenantId: t, userId: owner }, work);
    const found = await asOwner((tx) => searchMemoryEpisodes(tx, unit(10), 2));
    expect(found.map((row) => row.id)).toEqual([nearer.id, near.id]);
    expect(found[0]?.similarity).toBeGreaterThan(found[1]?.similarity ?? 1);
    expect(found[0]).not.toHaveProperty('embedding');
    expect((await asOwner((tx) => listMemoryEpisodes(tx, 10))).map((row) => row.id).sort()).toEqual(
      [far.id, near.id, nearer.id].sort(),
    );
    // The staff member's identical episode is theirs alone, and the owner can't delete it.
    expect(
      await asOwner((tx) => deleteMemoryEpisode(tx, MemoryEpisodeIdSchema.parse(staffs.id))),
    ).toBe(false);
    const staffFound = await withMember(db, { tenantId: t, userId: staff }, (tx) =>
      searchMemoryEpisodes(tx, unit(10), 10),
    );
    expect(staffFound.map((row) => row.id)).toEqual([staffs.id]);
    // Written once.
    const changed = await withMember(db, { tenantId: t, userId: staff }, (tx) =>
      tx.execute(sql`UPDATE memory_episodes SET summary = 'changed'`),
    ).catch((e: unknown) => e);
    expect(sqlState(changed)).toBe('42501');
  });

  it('the clean-up deletes episodes past retention', async () => {
    const t = await newTenant('Retention');
    const owner = await insertUser(db, 'Owner');
    await inTenant((tx) => addMembership(tx, { userId: owner, role: 'owner' }), t);
    const old = await inTenant(
      (tx) =>
        insertMemoryEpisode(tx, {
          userId: owner,
          conversationId: null,
          summary: 'Old',
          clientIds: [],
          embedding: unit(4),
          embeddingModel: 'm',
        }),
      t,
    );
    await asAdmin(
      "UPDATE memory_episodes SET created_at = now() - interval '400 days' WHERE id = $1",
      [old.id],
    );
    await inTenant(
      (tx) =>
        insertMemoryEpisode(tx, {
          userId: owner,
          conversationId: null,
          summary: 'New',
          clientIds: [],
          embedding: unit(5),
          embeddingModel: 'm',
        }),
      t,
    );
    expect(
      await inTenant(
        (tx) => deleteOldMemoryEpisodes(tx, new Date(Date.now() - 365 * 86_400_000), 100),
        t,
      ),
    ).toBe(1);
    expect(
      (await inTenant((tx) => listMemoryEpisodes(tx, 10), t)).map((row) => row.summary),
    ).toEqual(['New']);
  });
});

describe('the pause switch', () => {
  it('is per business and returns the value it replaced', async () => {
    expect(await inTenant((tx) => memoryPaused(tx))).toBe(false);
    expect(await inTenant((tx) => setMemoryPaused(tx, true))).toBe(false);
    expect(await inTenant((tx) => memoryPaused(tx))).toBe(true);
    expect(await inTenant((tx) => memoryPaused(tx), other)).toBe(false);
    expect(await inTenant((tx) => setMemoryPaused(tx, false))).toBe(true);
  });
});
