import {
  ClientIdSchema,
  ConversationIdSchema,
  ConversationTurnIdSchema,
  EMBEDDING_DIMENSIONS,
  MemoryFactIdSchema,
  TenantIdSchema,
  type ClientId,
  type Embedding,
  type MemoryFactId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './client.js';
import { newId } from './ids.js';
import { insertClient } from './repositories/clients.js';
import { insertConversation, insertMessage, insertTurn } from './repositories/conversations.js';
import { addMembership } from './repositories/memberships.js';
import {
  activeMemoryFactsOf,
  deleteMemoryFact,
  insertMemoryFact,
  searchMemoryEpisodes,
} from './repositories/memory.js';
import { createTenant } from './repositories/tenants.js';
import { withMember, withTenant, type TenantTx } from './tenant.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// Memory's latency gates (Phase 7 playbook §2, measured in S33) on a business near its caps:
// fact recall ≤ 50 ms, episode search ≤ 150 ms, delete with scrub ≤ 1 s, all p95, each one
// whole member transaction (tenant and member context set, the work, the commit). Shared CI
// runners are noisy, so the test fails only at 3× a target (a real regression); the measured
// numbers are printed for the session log and the gate is read from them.

const TARGET_MS = { recall: 50, search: 150, deleteWithScrub: 1_000 } as const;
const RUNS = 20;
const CLIENTS = 2_000;
const FACTS_PER_CLIENT = 5;
const OWNER_EPISODES = 5_000;
const STAFF_EPISODES = 1_000;
const CONVERSATIONS = 300;
const MENTIONS = 5;

let database: TestDatabase;
let db: Database;
let tenant: TenantId;
let owner: UserId;
let staff: UserId;
const clients: ClientId[] = [];
const doomed: MemoryFactId[] = [];

const as = <T>(work: (tx: TenantTx) => Promise<T>) =>
  withMember(db, { tenantId: tenant, userId: owner }, work);

async function asAdmin(text: string, values: unknown[]) {
  const client = new pg.Client({ connectionString: database.migrationUrl });
  await client.connect();
  try {
    await client.query(text, values);
  } finally {
    await client.end();
  }
}

/** Episodes with random unit-ish vectors, written by Postgres itself (fast). */
const seedEpisodes = (userId: UserId, count: number) =>
  asAdmin(
    `INSERT INTO memory_episodes (id, tenant_id, user_id, summary, embedding, embedding_model)
     SELECT gen_random_uuid(), $1, $2, 'Talked about client ' || g || ' and their colour',
       (SELECT array_agg(random() - 0.5)::vector FROM generate_series(1, ${String(EMBEDDING_DIMENSIONS)}) WHERE g > 0),
       'text-embedding-3-small'
     FROM generate_series(1, $3::int) g`,
    [tenant, userId, count],
  );

function randomEmbedding(): Embedding {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => Math.random() - 0.5);
}

async function chat(texts: string[]) {
  await as(async (tx) => {
    const conversationId = ConversationIdSchema.parse(
      (await insertConversation(tx, { userId: owner, channel: 'chat' })).id,
    );
    const turn = await insertTurn(tx, {
      conversationId,
      userId: owner,
      clientTurnId: newId(),
      deadlineAt: new Date(Date.now() + 60_000),
    });
    if (turn === undefined) throw new Error('no turn');
    const turnId = ConversationTurnIdSchema.parse(turn.id);
    for (const [index, text] of texts.entries()) {
      const base = { conversationId, turnId, userId: owner, untrusted: false };
      await insertMessage(
        tx,
        index % 2 === 0
          ? { ...base, role: 'user', content: text }
          : { ...base, role: 'assistant', step: 1, content: text, toolCalls: [], replay: [] },
      );
    }
  });
}

function clientAt(index: number): ClientId {
  const id = clients[index % CLIENTS];
  if (id === undefined) throw new Error(`no client ${String(index)}`);
  return id;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  tenant = TenantIdSchema.parse(
    (await createTenant(db, { name: 'Busy', slug: 'busy-latency', timeZone: 'America/New_York' }))
      .id,
  );
  owner = await insertUser(db, 'Owner');
  staff = await insertUser(db, 'Staff');
  await withTenant(db, tenant, async (tx) => {
    await addMembership(tx, { userId: owner, role: 'owner' });
    await addMembership(tx, { userId: staff, role: 'staff' });
    for (let i = 0; i < CLIENTS; i += 1) {
      const row = await insertClient(tx, {
        name: `Client ${String(i)}`,
        email: null,
        phone: null,
        source: 'team',
      });
      clients.push(ClientIdSchema.parse(row.id));
    }
  });
  // Half the business's fact cap, and the per-member episode cap for the owner.
  await asAdmin(
    `INSERT INTO memory_facts (id, tenant_id, subject_type, client_id, key, value, source)
     SELECT gen_random_uuid(), $1, 'client', c.id, 'note_' || k, 'Prefers quiet mornings, note ' || k, 'screen'
     FROM clients c, generate_series(1, ${String(FACTS_PER_CLIENT)}) k WHERE c.tenant_id = $1`,
    [tenant],
  );
  await seedEpisodes(owner, OWNER_EPISODES);
  await seedEpisodes(staff, STAFF_EPISODES);
  // Stored chats to scrub; each fact deleted below is mentioned in a few of them.
  for (let i = 0; i < RUNS + 1; i += 1) {
    const value = `Allergic to dye brand Z${String(i)}Q`;
    doomed.push(
      MemoryFactIdSchema.parse(
        (
          await as((tx) =>
            insertMemoryFact(tx, {
              subject: { type: 'client', id: clientAt(i) },
              key: 'dye_allergy',
              value,
              sensitive: true,
              status: 'active',
              source: 'chat',
              sourceTurnId: null,
              createdBy: owner,
            }),
          )
        ).id,
      ),
    );
    for (let m = 0; m < MENTIONS; m += 1) {
      await chat([`Remember ${value}.`, `Saved: ${value}.`]);
    }
  }
  for (let i = 0; i < CONVERSATIONS; i += 1) {
    await chat([
      `What does day ${String(i)} look like?`,
      'Three bookings and a lunch break.',
      'Move the 3pm to 4pm.',
      'Done, the client was told.',
    ]);
  }
}, 600_000);

afterAll(async () => {
  await database.stop();
});

describe('memory latency on a business near its caps (playbook §2)', () => {
  const report: string[] = [];

  afterAll(() => {
    // eslint-disable-next-line no-console -- the measured numbers go into the session log
    console.info(`Memory latency (${String(RUNS)} runs each):\n${report.join('\n')}`);
  });

  async function measure(name: keyof typeof TARGET_MS, run: (index: number) => Promise<void>) {
    await run(RUNS); // one warm-up call
    const times: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const started = performance.now();
      await run(index);
      times.push(performance.now() - started);
    }
    const p50 = percentile(times, 50);
    const p95 = percentile(times, 95);
    report.push(
      `  ${name.padEnd(16)} p50 ${p50.toFixed(0).padStart(4)} ms  p95 ${p95.toFixed(0).padStart(4)} ms  (target ${String(TARGET_MS[name])} ms)`,
    );
    expect(p95, `${name} p95 ms`).toBeLessThanOrEqual(3 * TARGET_MS[name]);
  }

  it('fact recall: a client’s and the business’s active facts', async () => {
    await measure('recall', async (index) => {
      const facts = await as((tx) =>
        activeMemoryFactsOf(
          tx,
          [{ type: 'client', id: clientAt(index * 97) }, { type: 'business' }],
          20,
        ),
      );
      expect(facts.length).toBeGreaterThanOrEqual(FACTS_PER_CLIENT);
    });
  });

  it('episode search: the 5 nearest of the member’s own 5,000', async () => {
    await measure('search', async () => {
      const found = await as((tx) => searchMemoryEpisodes(tx, randomEmbedding(), 5));
      expect(found).toHaveLength(5);
    });
  });

  it('delete with scrub: the fact goes and its value leaves every stored chat', async () => {
    await measure('deleteWithScrub', async (index) => {
      const id = doomed[index];
      if (id === undefined) throw new Error('no fact to delete');
      expect(await as((tx) => deleteMemoryFact(tx, id))).toBe(true);
    });
    const left = await withTenant(db, tenant, (tx) =>
      tx.execute(`SELECT 1 FROM conversation_messages WHERE content LIKE '%dye brand Z%'`),
    );
    expect(left.rows).toEqual([]);
  });
});
