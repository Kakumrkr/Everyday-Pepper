import {
  ClientIdSchema,
  EMBEDDING_DIMENSIONS,
  MemoryEpisodeIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantIdSchema,
  type BookingId,
  BookingIdSchema,
  type ClientId,
  type Embedding,
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
import {
  ForbiddenError,
  MemoryEpisodeNotFoundError,
  MemoryFactNotFoundError,
  MemoryPausedError,
  MemorySubjectNotFoundError,
} from './errors.js';
import { createBusiness } from './services/business.js';
import {
  changeFact,
  changeMemorySettings,
  deleteEpisode,
  factsForIn,
  factsShown,
  forgetFact,
  getMemorySettings,
  listFactViews,
  listFacts,
  listMyEpisodes,
  saveEpisode,
  saveFact,
  searchEpisodesIn,
} from './services/memory.js';
import { insertUser, startTestDatabase, type TestDatabase } from './test-support.js';

// The memory services against real Postgres (ADR-0034): who may remember and change what, one
// current value with the replaced one kept for Undo, the pause switch, own-only episodes, and
// an audit entry for every change that never holds a value. Forget everywhere (the scrub) is
// proven in the db package's memory.int.test.ts.

let database: TestDatabase;
let db: Database;
let tenantId: TenantId;
let owner: UserId;
let jess: UserId;
let jessStaff: StaffMemberId;
let maria: ClientId;
let lee: ClientId;
let mariaVisit: BookingId;

const as = (userId: UserId, role: MembershipRole): Actor => ({
  context: { tenantId, userId, role },
});
const ana = () => as(owner, 'owner');
const jessActor = () => as(jess, 'staff');

function unit(axis: number): Embedding {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === axis ? 1 : 0));
}

async function auditOf(id: string) {
  const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1000 }));
  return entries.filter((entry) => entry.entity.id === id);
}

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
  owner = await insertUser(db, 'Ana');
  const tenant = await createBusiness(db, owner, {
    name: 'Juniper Hair Studio',
    slug: 'juniper-memory',
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
      category: 'color',
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
    const visit = await insertBooking(tx, {
      clientId: maria,
      serviceId: ServiceIdSchema.parse(service.id),
      staffMemberId: jessStaff,
      startsAt: new Date('2026-11-02T14:00:00Z'),
      endsAt: new Date('2026-11-02T15:30:00Z'),
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      priceFromCents: 12000,
      priceToCents: null,
      source: 'team',
      overridden: false,
      idempotencyKey: null,
      createdBy: null,
    });
    mariaVisit = BookingIdSchema.parse(visit.id);
  });
});

afterAll(async () => {
  await database.stop();
});

describe('saving facts', () => {
  it('a health key is sensitive by default; the audit entry never holds the value', async () => {
    const { fact, replaced } = await saveFact(db, ana(), {
      subject: { type: 'client', id: maria },
      key: 'allergy',
      value: 'PPD',
    });
    expect(fact).toMatchObject({ key: 'allergy', value: 'PPD', sensitive: true, status: 'active' });
    expect(fact.createdByUserId).toBe(owner);
    expect(replaced).toBeNull();
    const [entry] = await auditOf(fact.id);
    expect(entry).toMatchObject({
      action: 'memory_fact.created',
      actor: { kind: 'user', userId: owner },
      after: { subjectType: 'client', key: 'allergy', sensitive: true, source: 'screen' },
    });
    expect(JSON.stringify(entry)).not.toContain('PPD');
  });

  it('a new value for the same key replaces it and keeps the old one for Undo only', async () => {
    const clock = new ManualClock(new Date('2026-10-23T12:00:00Z'));
    const subject = { type: 'client', id: maria } as const;
    const first = await saveFact(db, ana(), { subject, key: 'usual_service', value: 'Full color' });
    const again = await saveFact(db, ana(), { subject, key: 'usual_service', value: 'Full color' });
    expect(again).toEqual({ fact: first.fact, replaced: null });
    const second = await saveFact(
      db,
      jessActor(),
      { subject, key: 'usual_service', value: 'Gloss and trim' },
      { source: 'chat' },
      { clock },
    );
    expect(second.fact.id).toBe(first.fact.id);
    expect(second.replaced).toBe('Full color');
    const row = await withTenant(db, tenantId, (tx) => lockMemoryFact(tx, second.fact.id));
    expect(row?.previousValue).toBe('Full color');
    expect(row?.previousUntil?.toISOString()).toBe('2026-10-30T12:00:00.000Z');
    const entries = await auditOf(first.fact.id);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'memory_fact.created',
      'memory_fact.updated',
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/Full color|Gloss/);
  });

  it('staff remember things about their own clients only, and nothing business-wide', async () => {
    await expect(
      saveFact(db, jessActor(), {
        subject: { type: 'client', id: lee },
        key: 'prefers',
        value: 'Quiet',
      }),
    ).rejects.toBeInstanceOf(MemorySubjectNotFoundError);
    await expect(
      saveFact(db, jessActor(), { subject: { type: 'business' }, key: 'parking', value: 'Behind' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      saveFact(db, ana(), {
        subject: { type: 'client', id: '0192f2c4-6a3b-7c1d-8e9f-0a1b2c3d4e5f' },
        key: 'prefers',
        value: 'Quiet',
      }),
    ).rejects.toBeInstanceOf(MemorySubjectNotFoundError);
    const { fact } = await saveFact(db, jessActor(), {
      subject: { type: 'client', id: maria },
      key: 'drink',
      value: 'Oat latte',
    });
    expect(fact.sensitive).toBe(false);
  });

  it('a paused business learns nothing new from the chat; people on screens still can', async () => {
    await expect(changeMemorySettings(db, jessActor(), { paused: true })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await changeMemorySettings(db, ana(), { paused: true })).toEqual({ paused: true });
    expect(await getMemorySettings(db, jessActor())).toEqual({ paused: true });
    await expect(
      saveFact(
        db,
        ana(),
        { subject: { type: 'business' }, key: 'parking', value: 'Behind the shop' },
        { source: 'chat' },
      ),
    ).rejects.toBeInstanceOf(MemoryPausedError);
    await expect(
      saveEpisode(
        db,
        { tenantId, userId: owner },
        {
          conversationId: null,
          summary: 'Talked about parking.',
          embedding: unit(1),
          embeddingModel: 'text-embedding-3-small',
        },
      ),
    ).rejects.toBeInstanceOf(MemoryPausedError);
    const manual = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'parking',
      value: 'Behind the shop',
    });
    expect(manual.fact.source).toBe('screen');
    await changeMemorySettings(db, ana(), { paused: false });
    const entries = await withTenant(db, tenantId, (tx) => listAuditEntries(tx, { limit: 1000 }));
    expect(entries.filter((entry) => entry.action === 'memory.settings_updated')).toHaveLength(2);
  });
});

describe('changing, listing and forgetting', () => {
  it('a staff member reads but cannot change or forget the business’s facts', async () => {
    const { fact } = await saveFact(db, ana(), {
      subject: { type: 'business' },
      key: 'opening',
      value: 'No bookings before 10 on Mondays',
    });
    const seen = await listFacts(db, jessActor(), { subjectType: 'business' });
    expect(seen.map((f) => f.id)).toContain(fact.id);
    await expect(
      changeFact(db, jessActor(), fact.id, { value: 'Open at 9' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(forgetFact(db, jessActor(), fact.id)).rejects.toBeInstanceOf(ForbiddenError);
    const changed = await changeFact(db, ana(), fact.id, {
      value: 'No bookings before 11 on Mondays',
    });
    expect(changed.value).toBe('No bookings before 11 on Mondays');
  });

  it("a staff member can't see or forget another client's facts", async () => {
    const { fact } = await saveFact(db, ana(), {
      subject: { type: 'client', id: lee },
      key: 'allergy',
      value: 'Latex',
    });
    expect((await listFacts(db, jessActor())).map((f) => f.id)).not.toContain(fact.id);
    await expect(forgetFact(db, jessActor(), fact.id)).rejects.toBeInstanceOf(
      MemoryFactNotFoundError,
    );
    await expect(changeFact(db, jessActor(), fact.id, { sensitive: false })).rejects.toBeInstanceOf(
      MemoryFactNotFoundError,
    );
  });

  it('forgetting deletes the fact for everyone, with an audit entry and no value', async () => {
    const { fact } = await saveFact(db, jessActor(), {
      subject: { type: 'client', id: maria },
      key: 'pets',
      value: 'A dog called Rio',
    });
    await forgetFact(db, jessActor(), fact.id);
    expect((await listFacts(db, ana())).map((f) => f.id)).not.toContain(fact.id);
    await expect(forgetFact(db, ana(), fact.id)).rejects.toBeInstanceOf(MemoryFactNotFoundError);
    const entries = await auditOf(fact.id);
    expect(entries.map((entry) => entry.action).sort()).toEqual([
      'memory_fact.created',
      'memory_fact.deleted',
    ]);
    expect(JSON.stringify(entries)).not.toContain('Rio');
  });

  it('recall gives the subjects’ facts the member reaches, sensitive first', async () => {
    const recalled = await withMember(db, { tenantId, userId: jess }, (tx) =>
      factsForIn(tx, jessActor(), [
        { type: 'client', id: maria },
        { type: 'client', id: lee },
      ]),
    );
    expect(recalled.every((f) => f.subject.type === 'client' && f.subject.id === maria)).toBe(true);
    expect(recalled[0]).toMatchObject({ key: 'allergy', sensitive: true });
  });
});

describe('episodes', () => {
  it('are each member’s own: saved for them, searched, listed and deleted by them only', async () => {
    const save = (userId: UserId, summary: string, axis: number) =>
      saveEpisode(
        db,
        { tenantId, userId },
        {
          conversationId: null,
          summary,
          clientIds: [maria],
          embedding: unit(axis),
          embeddingModel: 'text-embedding-3-small',
        },
      );
    const anas = await save(owner, 'Decided Jess keeps Saturdays free.', 7);
    const jesss = await save(jess, 'Maria wants a gloss next time.', 7);
    const found = await withMember(db, { tenantId, userId: owner }, (tx) =>
      searchEpisodesIn(tx, ana(), unit(7), 5),
    );
    expect(found.map((e) => e.id)).toEqual([anas.id]);
    expect(found[0]?.similarity).toBeCloseTo(1, 5);
    expect((await listMyEpisodes(db, jessActor())).map((e) => e.id)).toEqual([jesss.id]);
    await expect(
      deleteEpisode(db, ana(), MemoryEpisodeIdSchema.parse(jesss.id)),
    ).rejects.toBeInstanceOf(MemoryEpisodeNotFoundError);
    await deleteEpisode(db, jessActor(), MemoryEpisodeIdSchema.parse(jesss.id));
    expect(await listMyEpisodes(db, jessActor())).toEqual([]);
    const entries = await auditOf(jesss.id);
    expect(entries.map((entry) => [entry.action, entry.actor.kind])).toEqual([
      ['memory_episode.deleted', 'user'],
      ['memory_episode.created', 'system'],
    ]);
  });
});

describe('"What I know" and the client profile (S32)', () => {
  it('lists facts with whom they are about, visit notes with their visit, by member', async () => {
    const save = async (actor: Actor, input: Parameters<typeof saveFact>[2]) =>
      (await saveFact(db, actor, input)).fact.id;
    const business = await save(ana(), {
      subject: { type: 'business' },
      key: 'parking_s32',
      value: 'Free parking behind the shop',
    });
    const secret = await save(ana(), {
      subject: { type: 'business' },
      key: 'personal_s32',
      value: 'The owner is moving in spring',
      sensitive: true,
    });
    const allergy = await save(jessActor(), {
      subject: { type: 'client', id: maria },
      key: 'skin_s32',
      value: 'Sensitive scalp',
      sensitive: true,
    });
    const formula = await save(ana(), {
      subject: { type: 'booking', id: mariaVisit },
      key: 'formula',
      value: '6N + 20 vol',
    });
    const leeFact = await save(ana(), {
      subject: { type: 'client', id: lee },
      key: 'drink_s32',
      value: 'Oat latte',
    });
    const jessFact = await save(ana(), {
      subject: { type: 'staff', id: jessStaff },
      key: 'specialty_s32',
      value: 'Balayage',
    });

    const owners = new Map((await listFactViews(db, ana())).map((view) => [view.id, view]));
    expect(owners.get(business)).toMatchObject({ subjectName: null, visit: null, byYou: true });
    expect(owners.get(allergy)).toMatchObject({
      subjectName: 'Maria Lopez',
      sensitive: true,
      source: 'screen',
      byYou: false,
    });
    expect(owners.get(formula)).toMatchObject({
      subject: { type: 'booking', id: mariaVisit },
      subjectName: 'Maria Lopez',
      visit: { startsAt: '2026-11-02T14:00:00.000Z', serviceName: 'Full color' },
    });
    expect(owners.get(jessFact)?.subjectName).toBe('Jess');
    expect(owners.has(secret) && owners.has(leeFact)).toBe(true);

    // The profile: the client's own facts and their visit notes, nobody else's.
    const profile = (await listFactViews(db, ana(), { clientId: maria })).map((view) => view.id);
    expect(profile).toEqual(expect.arrayContaining([allergy, formula]));
    expect(profile).not.toContain(leeFact);
    expect(profile).not.toContain(business);
    expect(
      (await listFactViews(db, ana(), { bookingId: mariaVisit })).map((view) => view.id),
    ).toEqual([formula]);
    const sensitive = await listFactViews(db, ana(), { sensitive: true });
    expect(sensitive.every((view) => view.sensitive)).toBe(true);

    // Staff: their clients and visits, and only the business's non-sensitive facts.
    const jessSees = new Map((await listFactViews(db, jessActor())).map((view) => [view.id, view]));
    expect([...jessSees.keys()]).toEqual(
      expect.arrayContaining([business, allergy, formula, jessFact]),
    );
    expect(jessSees.has(secret)).toBe(false);
    expect(jessSees.has(leeFact)).toBe(false);
    expect(jessSees.get(allergy)?.byYou).toBe(true);
    expect(await listFactViews(db, jessActor(), { clientId: lee })).toEqual([]);

    // The chip reads them live: hidden and forgotten facts are the same `gone`.
    expect(await factsShown(db, jessActor(), [allergy, leeFact])).toEqual([
      expect.objectContaining({ state: 'known', factId: allergy, value: 'Sensitive scalp' }),
      { state: 'gone', factId: leeFact },
    ]);
    await forgetFact(db, ana(), allergy);
    expect(await factsShown(db, jessActor(), [allergy])).toEqual([
      { state: 'gone', factId: allergy },
    ]);
    expect((await listFactViews(db, ana(), { clientId: maria })).map((v) => v.id)).not.toContain(
      allergy,
    );
  });
});
