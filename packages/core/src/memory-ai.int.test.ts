import {
  ActionExplanationSchema,
  ClientIdSchema,
  MemoryFactIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type ActionExplanation,
  type ClientId,
  type MemoryFactId,
  type MemoryFactInput,
  type MembershipRole,
  type StaffMemberId,
  type TenantId,
  type UserId,
} from '@pepper/contracts';
import {
  addMembership,
  insertBooking,
  insertClient,
  insertService,
  insertStaffMember,
  listAuditEntries,
  lockMemoryFact,
  withMember,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from './actor.js';
import { ManualClock } from './clock.js';
import { MemoryFactNotFoundError, UndoRefusedError } from './errors.js';
import { memoryOfAction } from './services/ai-views.js';
import { cleanUp } from './services/cleanup.js';
import { createBusiness } from './services/business.js';
import {
  activateFactIn,
  discardProposedFactIn,
  factsShownIn,
  forgetFact,
  forgetSavedFactIn,
  getFactIn,
  recallIn,
  restoreFactIn,
  saveFact,
  saveFactIn,
  subjectKey,
} from './services/memory.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The memory services the AI's tools use (S30, ADR-0035): a save the AI proposes waits as a
// `proposed` fact (its value never in the proposal) and becomes the current one when allowed;
// Undo brings a replaced value back; cards and *Why?* read facts live by id; recall gives the
// facts that travel with a record and a client's last visit.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let jess: UserId;
let jessStaff: StaffMemberId;
let maria: ClientId;
let lee: ClientId;
let pastVisit: string;
let olderVisit: string;

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T15:00:00Z');
const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const ai = () => ({ ...ana(), via: 'ai' as const });
const jessActor = () => as(jess, 'staff');
const clock = () => new ManualClock(NOW);

async function propose(input: MemoryFactInput, actor: Actor = ai()): Promise<MemoryFactId> {
  const { fact } = await withMember(db, actor.context, (tx) =>
    saveFactIn(tx, actor, input, { source: 'chat', turnId: null, status: 'proposed' }),
  );
  return fact.id;
}

async function row(id: MemoryFactId) {
  return withTenant(db, tenantId, (tx) => lockMemoryFact(tx, id));
}

async function auditOf(id: string) {
  const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1000 }));
  return entries.filter((entry) => entry.entity.id === id);
}

function explanation(facts: ActionExplanation['facts']): ActionExplanation {
  return ActionExplanationSchema.parse({
    requestMessageId: null,
    steps: [],
    facts,
    alternatives: [],
    untrustedContext: false,
    decision: { outcome: 'execute_and_notify', reason: 'setting' },
  });
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: 'juniper-memory-ai',
    timeZone: 'America/New_York',
  });
  tenantId = TenantIdSchema.parse(tenant.id);
  jess = await insertUser(db, 'Jess');
  await withTenant(db, tenantId, async (tx) => {
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
    const service = await insertService(tx, {
      name: 'Full color',
      category: 'Color',
      durationMinutes: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 12000,
      priceToCents: null,
      active: true,
    });
    const client = async (name: string) =>
      ClientIdSchema.parse(
        (await insertClient(tx, { name, email: null, phone: null, source: 'team' })).id,
      );
    maria = await client('Maria Lopez');
    lee = await client('Lee Park');
    const visit = async (clientId: ClientId, startsAt: Date) =>
      (
        await insertBooking(tx, {
          clientId,
          serviceId: ServiceIdSchema.parse(service.id),
          staffMemberId: jessStaff,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: 12000,
          priceToCents: null,
          source: 'team',
          overridden: false,
          idempotencyKey: null,
          createdBy: null,
        })
      ).id;
    olderVisit = await visit(maria, new Date(NOW.getTime() - 40 * DAY));
    pastVisit = await visit(maria, new Date(NOW.getTime() - 12 * DAY));
    await visit(maria, new Date(NOW.getTime() + 5 * DAY));
  });
});

afterAll(async () => {
  await database.stop();
});

describe('a save the AI proposes', () => {
  it('waits as a proposed fact, then becomes the current one; no audit entry holds the value', async () => {
    const id = await propose({
      subject: { type: 'client', id: maria },
      key: 'allergy',
      value: 'PPD',
    });
    expect(await row(id)).toMatchObject({ status: 'proposed', sensitive: true });
    const { fact, change } = await withMember(db, ana().context, (tx) =>
      activateFactIn(tx, ai(), id, { clock: clock() }),
    );
    expect(change).toBe('created');
    expect(fact).toMatchObject({ id, status: 'active', value: 'PPD' });
    expect(JSON.stringify(await auditOf(id))).not.toContain('PPD');
  });

  it('over a current value: the current fact takes it, keeps the old one for Undo, and the proposed row goes', async () => {
    const subject = { type: 'client' as const, id: maria };
    const { fact: current } = await saveFact(db, ana(), {
      subject,
      key: 'usual_service',
      value: 'Full color with Jess',
    });
    const id = await propose({ subject, key: 'usual_service', value: 'Root touch-up with Jess' });
    const { fact, change } = await withMember(db, ana().context, (tx) =>
      activateFactIn(tx, ai(), id, { clock: clock() }),
    );
    expect(change).toBe('updated');
    expect(fact).toMatchObject({ id: current.id, value: 'Root touch-up with Jess' });
    expect(await row(id)).toBeUndefined();
    expect(await row(current.id)).toMatchObject({ previousValue: 'Full color with Jess' });

    const same = await propose({ subject, key: 'usual_service', value: 'Root touch-up with Jess' });
    const again = await withMember(db, ana().context, (tx) =>
      activateFactIn(tx, ai(), same, { clock: clock() }),
    );
    expect(again.change).toBe('unchanged');
    expect(await row(same)).toBeUndefined();
  });

  it('only a proposed fact the member may change can be activated', async () => {
    const { fact } = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'parking',
      value: 'Free after 6pm',
    });
    await expect(
      withMember(db, ana().context, (tx) => activateFactIn(tx, ai(), fact.id)),
    ).rejects.toBeInstanceOf(MemoryFactNotFoundError);
    const lees = await propose({
      subject: { type: 'client', id: lee },
      key: 'allergy',
      value: 'latex',
    });
    await expect(
      withMember(db, jessActor().context, (tx) =>
        activateFactIn(tx, { ...jessActor(), via: 'ai' }, lees),
      ),
    ).rejects.toBeInstanceOf(MemoryFactNotFoundError);
  });

  it('is discarded when it will not happen; an active fact is left alone', async () => {
    const id = await propose({
      subject: { type: 'business' },
      key: 'wifi',
      value: 'Ask at the desk',
    });
    await withMember(db, ana().context, (tx) => discardProposedFactIn(tx, ai(), id));
    expect(await row(id)).toBeUndefined();
    const { fact } = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'wifi',
      value: 'Ask at the desk',
    });
    await withMember(db, ana().context, (tx) => discardProposedFactIn(tx, ai(), fact.id));
    expect(await row(fact.id)).toMatchObject({ status: 'active' });
  });

  it('goes with the daily clean-up once its proposal is over', async () => {
    const id = await propose({ subject: { type: 'business' }, key: 'tips', value: 'Cash only' });
    const result = await cleanUp(db, { clock: new ManualClock(new Date(Date.now() + 3 * DAY)) });
    expect(result.memoryProposedFacts).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toBeUndefined();
  });
});

describe('Undo of a created fact', () => {
  it('forgets it while it is as the save left it, and refuses once it changed', async () => {
    const id = await propose({
      subject: { type: 'business' },
      key: 'door_code_note',
      value: 'Side door after 7',
    });
    const { fact } = await withMember(db, ana().context, (tx) =>
      activateFactIn(tx, ai(), id, { clock: clock() }),
    );
    await expect(
      withMember(db, ana().context, (tx) =>
        forgetSavedFactIn(tx, ana(), fact.id, new Date(Date.parse(fact.updatedAt) - 1)),
      ),
    ).rejects.toBeInstanceOf(UndoRefusedError);
    await withMember(db, ana().context, (tx) =>
      forgetSavedFactIn(tx, ana(), fact.id, new Date(fact.updatedAt)),
    );
    expect(await row(fact.id)).toBeUndefined();
    await expect(
      withMember(db, ana().context, (tx) => getFactIn(tx, ana(), fact.id)),
    ).rejects.toBeInstanceOf(MemoryFactNotFoundError);
  });
});

describe('Undo of a replaced value', () => {
  it('brings the old value back while the window is open and the fact is as the save left it', async () => {
    const subject = { type: 'client' as const, id: maria };
    await saveFact(db, ana(), { subject, key: 'formula_note', value: '6N + 20 vol' });
    const id = await propose({ subject, key: 'formula_note', value: '7N + 20 vol' });
    const { fact } = await withMember(db, ana().context, (tx) =>
      activateFactIn(tx, ai(), id, { clock: clock() }),
    );
    const savedAt = new Date(fact.updatedAt);
    await expect(
      withMember(db, ana().context, (tx) =>
        restoreFactIn(tx, ana(), fact.id, new Date(savedAt.getTime() - 1), { clock: clock() }),
      ),
    ).rejects.toBeInstanceOf(UndoRefusedError);
    await expect(
      withMember(db, ana().context, (tx) =>
        restoreFactIn(tx, ana(), fact.id, savedAt, {
          clock: new ManualClock(new Date(NOW.getTime() + 8 * DAY)),
        }),
      ),
    ).rejects.toBeInstanceOf(UndoRefusedError);
    await withMember(db, ana().context, (tx) =>
      restoreFactIn(tx, ana(), fact.id, savedAt, { clock: clock() }),
    );
    expect(await row(fact.id)).toMatchObject({
      value: '6N + 20 vol',
      previousValue: null,
      previousUntil: null,
    });
  });

  it('refuses for a fact that is gone', async () => {
    const { fact } = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'closing_note',
      value: 'Closed on holidays',
    });
    await forgetFact(db, ana(), fact.id);
    await expect(
      withMember(db, ana().context, (tx) =>
        restoreFactIn(tx, ana(), fact.id, new Date(fact.updatedAt)),
      ),
    ).rejects.toBeInstanceOf(UndoRefusedError);
  });
});

describe('facts read live by id', () => {
  it('shows what the member may read, `gone` for the rest, the replaced value only while Undo is open', async () => {
    const subject = { type: 'client' as const, id: lee };
    const { fact: secret } = await saveFact(db, ana(), {
      subject,
      key: 'health',
      value: 'Migraines',
    });
    const { fact: open } = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'parking_note',
      value: 'Street parking',
    });
    await saveFact(
      db,
      ana(),
      { subject: { type: 'business' }, key: 'parking_note', value: 'Lot B' },
      { source: 'screen' },
      { clock: clock() },
    );
    const deleted = MemoryFactIdSchema.parse('0199f4b2-7c1e-7a00-8000-00000000dead');
    const owners = await withMember(db, ana().context, (tx) =>
      factsShownIn(tx, [secret.id, open.id, deleted], NOW),
    );
    expect(owners).toEqual([
      expect.objectContaining({ state: 'known', value: 'Migraines', sensitive: true }),
      expect.objectContaining({ state: 'known', value: 'Lot B', previous: 'Street parking' }),
      { state: 'gone', factId: deleted },
    ]);
    const staff = await withMember(db, jessActor().context, (tx) =>
      factsShownIn(tx, [secret.id, open.id], new Date(NOW.getTime() + 30 * DAY)),
    );
    expect(staff).toEqual([
      { state: 'gone', factId: secret.id },
      expect.objectContaining({ state: 'known', value: 'Lot B', previous: null }),
    ]);
  });
});

describe('recall with a record', () => {
  it('gives the subjects’ facts and the notes of each client’s latest visit that has any', async () => {
    const formula = await saveFact(db, ana(), {
      subject: { type: 'booking', id: pastVisit },
      key: 'formula',
      value: '6N + 20 vol, 35 min',
    });
    await saveFact(db, ana(), {
      subject: { type: 'booking', id: olderVisit },
      key: 'formula',
      value: '5N + 10 vol',
    });
    const recall = await withMember(db, ana().context, (tx) =>
      recallIn(
        tx,
        ai(),
        { subjects: [{ type: 'client', id: maria }], lastVisitsOf: [maria, lee] },
        NOW,
      ),
    );
    const facts = recall.facts.get(subjectKey({ type: 'client', id: maria })) ?? [];
    expect(facts.map((fact) => fact.key)).toContain('allergy');
    // Sensitive first.
    expect(facts[0]?.sensitive).toBe(true);
    const visit = recall.lastVisits.get(maria);
    expect(visit?.bookingId).toBe(pastVisit);
    expect(visit?.notes.map((note) => note.id)).toEqual([formula.fact.id]);
    expect(recall.lastVisits.has(lee)).toBe(false);
  });

  it('skips what a staff member may not read, without refusing the lookup', async () => {
    const recall = await withMember(db, jessActor().context, (tx) =>
      recallIn(
        tx,
        { ...jessActor(), via: 'ai' },
        { subjects: [{ type: 'client', id: lee }, { type: 'business' }], lastVisitsOf: [lee] },
        NOW,
      ),
    );
    expect(recall.facts.has(subjectKey({ type: 'client', id: lee }))).toBe(false);
    for (const fact of recall.facts.get('business') ?? []) expect(fact.sensitive).toBe(false);
  });
});

describe('memory on an action’s card and in Why?', () => {
  it('shows the saved fact, the warnings and the last visit live, and a deleted fact as gone', async () => {
    const subject = { type: 'client' as const, id: maria };
    const { fact: allergy } = await saveFact(db, ana(), { subject, key: 'allergy', value: 'PPD' });
    const { fact: note } = await saveFact(db, ana(), {
      subject: { type: 'booking', id: pastVisit },
      key: 'processing_time',
      value: '35 min',
    });
    const { fact: recalled } = await saveFact(db, ana(), {
      subject,
      key: 'prefers',
      value: 'Quiet appointments',
    });
    const why = explanation([
      { kind: 'memory_warning', ref: allergy.id, value: null },
      {
        kind: 'last_visit',
        ref: pastVisit,
        value: { date: '2026-10-29', serviceName: 'Full color' },
      },
      { kind: 'memory_last_visit', ref: note.id, value: null },
      { kind: 'memory_recalled', ref: recalled.id, value: null },
    ]);
    const before = await memoryOfAction(db, ana(), why, { clock: clock() });
    expect(before.card).toEqual({
      fact: null,
      warnings: [expect.objectContaining({ key: 'allergy', value: 'PPD' })],
      lastVisit: {
        date: '2026-10-29',
        serviceName: 'Full color',
        notes: [expect.objectContaining({ value: '35 min' })],
      },
    });
    expect(before.remembered.map((fact) => fact.state)).toEqual(['known', 'known', 'known']);

    await forgetFact(db, ana(), recalled.id);
    const after = await memoryOfAction(db, ana(), why, { clock: clock() });
    expect(after.remembered).toContainEqual({ state: 'gone', factId: recalled.id });
    expect(JSON.stringify(after)).not.toContain('Quiet appointments');
  });

  it('a proposed save shows its new value and the one it would replace', async () => {
    const subject = { type: 'client' as const, id: maria };
    const { fact: current } = await saveFact(db, ana(), {
      subject,
      key: 'stylist_note',
      value: 'Likes Jess',
    });
    const pending = await propose({ subject, key: 'stylist_note', value: 'Likes Marco' });
    const shown = await memoryOfAction(
      db,
      ana(),
      explanation([{ kind: 'memory_fact', ref: current.id, value: null }]),
      { proposedFactId: pending, clock: clock() },
    );
    expect(shown.card?.fact).toMatchObject({ value: 'Likes Marco', previous: 'Likes Jess' });
  });

  it('refuses an explanation that names a fact by its value', () => {
    expect(() => explanation([{ kind: 'memory_fact', ref: null, value: 'PPD' }])).toThrow(
      /by its id/,
    );
  });
});
