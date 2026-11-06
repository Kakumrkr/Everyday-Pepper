import {
  ClientIdSchema,
  ImportBatchIdSchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  PLATFORM_DRAFTS,
  ServiceIdSchema,
  StaffMemberIdSchema,
  type ClientId,
  type MembershipRole,
} from '@pepper/contracts';
import {
  changeFeedSettings,
  rejectProposal,
  getProposal,
  listPendingProposals,
  ManualClock,
  openOutboxContent,
} from '@pepper/core';
import {
  findOutboxMessage,
  insertImportBatch,
  insertImportedBookings,
  listDueOutboxMessages,
  optOutClientEmail,
  withTenant,
  type Database,
} from '@pepper/db';
import { changeBooking, createBooking } from '@pepper/appointments';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEvalWorld, type EvalWorld } from '../evals/world.js';
import { ScriptedProvider } from '../scripted-provider.js';
import { approveToolProposal, reviseNudgeDraft } from '../tools/registry.js';
import { OUTBOX_KEY, startTestDatabase, type TestDatabase } from '../tools/test-support.js';
import type { ToolDeps } from '../tools/tool.js';
import { runMorningDraftsFor, type MorningDraftsOptions } from './morning.js';
import { draftReviewRequestsFor } from './review-requests.js';
import { draftWinBack } from './win-back.js';
import { reviewWords } from './review-words.js';

// Post-visit review requests end to end (S55.2, ADR-0059) on Postgres: AC-W4-14 (the morning
// after a kept visit, one thank-you asking for a review waits for an OK), AC-W4-15 (at most one
// a client per 90 days, 20 a business a day; no request without the link or the address, for a
// cancelled or missed visit, imported history, a client without an email or who unsubscribed),
// AC-W4-16 (approved, one email with the link and the unsubscribe footer; the opt-out is checked
// again at the send) and AC-W4-17 (owners and managers decide, staff can't).

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Tuesday 3 November 2026, 07:30 in New York: the morning pass's hour (7) has come; Monday's
// visits are over.
const MORNING = '2026-11-03T12:30:00.000Z';
const BASE_URL = 'https://app.pepper.test';
const REVIEW_URL = 'https://g.page/r/juniper/review';

const world = () =>
  seedEvalWorld(
    db,
    'juniper_feed',
    { now: new Date(MORNING), timeZone: 'America/New_York' },
    { facts: [], memoryPaused: false },
  );

const ref = (w: EvalWorld, name: string) => {
  const id = w.placeholders.get(name);
  if (id === undefined) throw new Error(`No ${name}`);
  return id;
};
const client = (w: EvalWorld, name: string): ClientId =>
  ClientIdSchema.parse(ref(w, `{{client:${name}}}`));

/** A haircut with Jess on Monday at `hour` (New York), booked a week before. */
async function visit(w: EvalWorld, name: string, hour: number) {
  const startsAt = new Date(Date.UTC(2026, 10, 2, hour + 5)).toISOString();
  return createBooking(
    db,
    w.actorFor('owner'),
    {
      clientId: client(w, name),
      serviceId: ServiceIdSchema.parse(ref(w, '{{service:haircut}}')),
      staffMemberId: StaffMemberIdSchema.parse(ref(w, '{{staff:jess}}')),
      startsAt,
      notifyClient: false,
      // The owner may book over the world's own schedule: these visits are only history.
      override: true,
    },
    { clock: new ManualClock(new Date(Date.parse(MORNING) - 7 * 86_400_000)) },
  );
}

function optionsFor(w: EvalWorld): MorningDraftsOptions {
  return {
    // No model call: the nudges are off in these worlds, and review requests write their own.
    provider: new ScriptedProvider([]),
    clock: w.clock,
    reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }),
    emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
    draftsOf: () => PLATFORM_DRAFTS,
    insightsOf: () => ({ enabled: ['rebooking_due'], minGapMinutes: 60 }),
  };
}

const depsAs = (w: EvalWorld, role: MembershipRole): ToolDeps => ({
  db,
  actor: w.actorFor(role),
  clock: w.clock,
  autonomy: { templateDefaults: {} },
  emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
});

/** Whom a proposal emails (its payload names the client). */
const clientOf = (proposal: { payload: unknown }): unknown =>
  (proposal.payload as { clientId?: unknown }).clientId;

const reviews = async (w: EvalWorld, role: MembershipRole = 'owner') =>
  (await listPendingProposals(db, w.actorFor(role), { clock: w.clock })).filter(
    (proposal) => proposal.tool === 'send_review_request',
  );

/** Nudges off (they need the model), the review link on. */
async function reviewsOnly(w: EvalWorld) {
  await changeFeedSettings(db, w.actorFor('owner'), {
    disabledKinds: ['rebooking_due'],
    reviewUrl: REVIEW_URL,
  });
}

async function queuedEmails(w: EvalWorld, at: Date) {
  const due = (await listDueOutboxMessages(db, at, 100)).filter((m) => m.tenantId === w.tenantId);
  const emails = [];
  for (const message of due) {
    const row = await withTenant(db, w.tenantId, (tx) =>
      findOutboxMessage(tx, OutboxMessageIdSchema.parse(message.messageId)),
    );
    if (row?.type !== 'email' || row.payload === null) continue;
    emails.push(
      OutboxEmailSchema.parse(
        JSON.parse(openOutboxContent(OUTBOX_KEY, message.messageId, row.payload).toString('utf8')),
      ),
    );
  }
  return emails;
}

const later = (w: EvalWorld, minutes: number) =>
  new Date(w.clock.now().getTime() + minutes * 60_000);

describe('AC-W4-14: the morning after a visit, a review request waits for an OK', () => {
  it('drafts one thank-you per client with a kept visit, in the domain’s words', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    await visit(w, 'ana', 13); // a second visit the same day: one request
    await visit(w, 'maria', 15);

    const result = await runMorningDraftsFor(db, w.tenantId, optionsFor(w));
    expect(result).toMatchObject({ outcome: 'ran', drafted: 0, reviewRequests: 2, failed: 0 });

    const pending = await reviews(w);
    expect(pending).toHaveLength(2);
    const forAna = pending.find((p) => clientOf(p) === client(w, 'ana'));
    expect(forAna).toMatchObject({
      action: 'message.review_request',
      requestedByUserId: null,
      preview: {
        draft: reviewWords({ firstName: 'Ana', serviceName: 'Haircut', visitDate: 'November 2' }),
        emails: [{ template: 'review_request', clientId: client(w, 'ana') }],
        after: { email: 'review', clientName: 'Ana', serviceName: 'Haircut', staffName: 'Jess' },
      },
    });
    // Nothing is sent before the OK.
    expect(await queuedEmails(w, later(w, 60))).toEqual([]);
    // The manager decides it too.
    expect(await reviews(w, 'manager')).toHaveLength(2);
  });
});

describe('AC-W4-19: without a model, the review requests still come (S56a)', () => {
  it('drafts without a provider, the nudges on but skipped', async () => {
    const w = await world();
    // The rebooking nudges stay on: only the missing model skips them.
    await changeFeedSettings(db, w.actorFor('owner'), { reviewUrl: REVIEW_URL });
    await visit(w, 'maria', 15);
    const result = await runMorningDraftsFor(db, w.tenantId, { ...optionsFor(w), provider: null });
    expect(result).toMatchObject({ outcome: 'ran', drafted: 0, reviewRequests: 1, failed: 0 });
    expect((await reviews(w)).map(clientOf)).toEqual([client(w, 'maria')]);
  });

  it('without a model or a review link, the pass has nothing to do', async () => {
    const w = await world();
    await visit(w, 'maria', 15);
    const result = await runMorningDraftsFor(db, w.tenantId, { ...optionsFor(w), provider: null });
    expect(result).toEqual({ outcome: 'paused' });
  });
});

describe('AC-W4-15: one a client per 90 days, and only when it can go', () => {
  it('asks no client twice within 90 days, whatever became of the first', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    const deps = depsAs(w, 'owner');
    const context = (clock: ManualClock) => ({
      ai: w.actorFor('owner'),
      deps: { ...deps, clock },
      timeZone: 'America/New_York',
      today: '2026-11-03',
      clock,
    });
    expect(await draftReviewRequestsFor(db, w.tenantId, context(w.clock))).toEqual({
      drafted: 1,
      refused: 0,
      failed: 0,
    });
    // Turned down: still counts.
    const [first] = await reviews(w);
    if (first === undefined) throw new Error('No request');
    await rejectProposal(db, w.actorFor('owner'), first.id, { clock: w.clock });
    // Ana comes again 30 days later: no second request.
    const month = new ManualClock(new Date(Date.parse(MORNING) + 30 * 86_400_000));
    await createBooking(
      db,
      w.actorFor('owner'),
      {
        clientId: client(w, 'ana'),
        serviceId: ServiceIdSchema.parse(ref(w, '{{service:haircut}}')),
        staffMemberId: StaffMemberIdSchema.parse(ref(w, '{{staff:jess}}')),
        startsAt: new Date(Date.parse(MORNING) + 29 * 86_400_000 + 2 * 3_600_000).toISOString(),
        notifyClient: false,
        override: true,
      },
      { clock: new ManualClock(new Date(MORNING)) },
    );
    expect(
      await draftReviewRequestsFor(db, w.tenantId, { ...context(month), today: '2026-12-03' }),
    ).toMatchObject({ drafted: 0 });
    // After 90 days she may be asked again.
    const quarter = new ManualClock(new Date(Date.parse(MORNING) + 91 * 86_400_000));
    await createBooking(
      db,
      w.actorFor('owner'),
      {
        clientId: client(w, 'ana'),
        serviceId: ServiceIdSchema.parse(ref(w, '{{service:haircut}}')),
        staffMemberId: StaffMemberIdSchema.parse(ref(w, '{{staff:jess}}')),
        startsAt: new Date(Date.parse(MORNING) + 90 * 86_400_000 + 2 * 3_600_000).toISOString(),
        notifyClient: false,
        override: true,
      },
      { clock: new ManualClock(new Date(MORNING)) },
    );
    expect(
      await draftReviewRequestsFor(db, w.tenantId, { ...context(quarter), today: '2027-02-02' }),
    ).toMatchObject({ drafted: 1 });
  });

  it('skips cancelled and missed visits, unsubscribed clients and those without an email', async () => {
    const w = await world();
    await reviewsOnly(w);
    const cancelled = await visit(w, 'ana', 9);
    await changeBooking(
      db,
      w.actorFor('owner'),
      cancelled.id,
      { status: 'cancelled', notifyClient: false },
      { clock: new ManualClock(new Date(Date.parse(MORNING) - 3 * 86_400_000)) },
    );
    const missed = await visit(w, 'maria', 10);
    await changeBooking(
      db,
      w.actorFor('owner'),
      missed.id,
      { status: 'no_show' },
      { clock: w.clock },
    );
    // Imported history is not a visit Pepper saw.
    await withTenant(db, w.tenantId, async (tx) => {
      const batch = await insertImportBatch(tx, {
        createdByUserId: null,
        kind: 'visits',
        format: 'csv',
        preset: null,
        system: 'file:test',
        columns: [],
        problems: [],
        counts: {},
      });
      const startsAt = new Date(Date.UTC(2026, 10, 2, 20));
      await insertImportedBookings(tx, ImportBatchIdSchema.parse(batch.id), [
        {
          id: randomUUID(),
          clientId: client(w, 'ana'),
          serviceId: ref(w, '{{service:haircut}}'),
          staffMemberId: ref(w, '{{staff:marco}}'),
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          bufferBeforeMinutes: 0,
          bufferAfterMinutes: 0,
          priceFromCents: null,
          status: 'completed',
          createdBy: null,
        },
      ]);
    });
    await visit(w, 'sarah', 13); // no email
    await visit(w, 'sara', 16);
    await withTenant(db, w.tenantId, (tx) =>
      optOutClientEmail(tx, client(w, 'sara'), new Date(MORNING)),
    );
    expect(await runMorningDraftsFor(db, w.tenantId, optionsFor(w))).toMatchObject({
      outcome: 'ran',
      reviewRequests: 0,
    });
    expect(await reviews(w)).toEqual([]);
  });

  it('waits a week after a rebooking email: one marketing email a week at most', async () => {
    const w = await world();
    await reviewsOnly(w);
    // Sara is overdue, so the owner drafts her a win-back email (a rebooking nudge) first.
    const drafted = await draftWinBack(depsAs(w, 'owner'), client(w, 'sara'));
    expect(drafted.kind).toBe('drafted');
    await visit(w, 'sara', 10);
    await visit(w, 'ana', 13);
    expect(await runMorningDraftsFor(db, w.tenantId, optionsFor(w))).toMatchObject({
      reviewRequests: 1,
    });
    expect((await reviews(w)).map(clientOf)).toEqual([client(w, 'ana')]);
  });

  it('drafts nothing without the review link or the mailing address, or while paused', async () => {
    const noLink = await world();
    await changeFeedSettings(db, noLink.actorFor('owner'), { disabledKinds: ['rebooking_due'] });
    await visit(noLink, 'ana', 10);
    expect(await runMorningDraftsFor(db, noLink.tenantId, optionsFor(noLink))).toEqual({
      outcome: 'paused',
    });
    expect(await reviews(noLink)).toEqual([]);

    const paused = await world();
    await reviewsOnly(paused);
    await changeFeedSettings(db, paused.actorFor('owner'), { suggestionsPaused: true });
    await visit(paused, 'ana', 10);
    expect(await runMorningDraftsFor(db, paused.tenantId, optionsFor(paused))).toEqual({
      outcome: 'paused',
    });

    const noAddress = await world();
    await reviewsOnly(noAddress);
    await changeFeedSettings(db, noAddress.actorFor('owner'), { mailingAddress: null });
    await visit(noAddress, 'ana', 10);
    expect(await runMorningDraftsFor(db, noAddress.tenantId, optionsFor(noAddress))).toEqual({
      outcome: 'no_address',
    });
  });

  it('keeps to the daily cap, earliest visit first', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'maria', 15);
    await visit(w, 'ana', 10);
    const result = await draftReviewRequestsFor(db, w.tenantId, {
      ai: w.actorFor('owner'),
      deps: depsAs(w, 'owner'),
      timeZone: 'America/New_York',
      today: '2026-11-03',
      clock: w.clock,
      perBusinessPerDay: 1,
    });
    expect(result.drafted).toBe(1);
    expect((await reviews(w)).map((p) => clientOf(p))).toEqual([client(w, 'ana')]);
  });
});

describe('AC-W4-16: approved, one email with the review link and the footer', () => {
  it('sends the words, the link and a one-click unsubscribe, once', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w));
    const [request] = await reviews(w);
    if (request === undefined) throw new Error('No request');

    const owner = depsAs(w, 'owner');
    const approved = await approveToolProposal(owner, request.id, request.fingerprint);
    expect(approved.kind).toBe('executed');
    const emails = await queuedEmails(w, later(w, 5));
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: 'ana@example.test',
      subject: 'Thanks for coming in, Ana',
    });
    expect(emails[0]?.text).toContain('Thank you for coming in for your haircut on November 2.');
    expect(emails[0]?.text).toContain(`Leave a review here:\n${REVIEW_URL}`);
    expect(emails[0]?.text).toContain('Unsubscribe: https://app.pepper.test/unsubscribe/');
    expect(emails[0]?.unsubscribeUrl).toMatch(
      /^https:\/\/app\.pepper\.test\/v1\/public\/unsubscribe\//,
    );
    await expect(
      approveToolProposal(owner, request.id, request.fingerprint),
    ).resolves.toMatchObject({ kind: 'executed' });
    expect(await queuedEmails(w, later(w, 5))).toHaveLength(1);
  });

  it('checks the opt-out, the link and the visit again at the send', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    const maria = await visit(w, 'maria', 13);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w));
    const pending = await reviews(w);
    const forAna = pending.find((p) => clientOf(p) === client(w, 'ana'));
    const forMaria = pending.find((p) => clientOf(p) === client(w, 'maria'));
    if (forAna === undefined || forMaria === undefined) throw new Error('No requests');

    // Ana unsubscribes before the OK.
    await withTenant(db, w.tenantId, (tx) =>
      optOutClientEmail(tx, client(w, 'ana'), w.clock.now()),
    );
    const owner = depsAs(w, 'owner');
    const ana = await approveToolProposal(owner, forAna.id, forAna.fingerprint);
    expect(ana.kind).not.toBe('executed');
    // Maria's visit turns out to have been missed.
    await changeBooking(
      db,
      w.actorFor('owner'),
      maria.id,
      { status: 'no_show' },
      { clock: w.clock },
    );
    const missed = await approveToolProposal(owner, forMaria.id, forMaria.fingerprint);
    expect(missed.kind).not.toBe('executed');
    expect(await queuedEmails(w, later(w, 5))).toEqual([]);
  });

  it('lets a manager edit the words, but never with a link', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w));
    const [request] = await reviews(w);
    if (request === undefined) throw new Error('No request');
    const manager = depsAs(w, 'manager');
    await expect(
      reviseNudgeDraft(manager, request.id, request.fingerprint, {
        subject: 'Thanks',
        body: 'Review us at https://evil.example',
      }),
    ).rejects.toThrow();
    const revised = await reviseNudgeDraft(manager, request.id, request.fingerprint, {
      subject: 'Thank you, Ana',
      body: 'Hi Ana,\n\nThanks for coming in. A short review would mean a lot.',
    });
    expect(revised.kind).toBe('revised');
    const stored = await getProposal(db, w.actorFor('manager'), revised.proposal.id);
    expect(stored.preview).toMatchObject({
      draft: {
        subject: 'Thank you, Ana',
        body: 'Hi Ana,\n\nThanks for coming in. A short review would mean a lot.',
      },
    });
  });
});

describe('AC-W4-17: owners and managers decide, staff cannot', () => {
  it('neither shows a staff member the request nor lets them approve it', async () => {
    const w = await world();
    await reviewsOnly(w);
    await visit(w, 'ana', 10);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w));
    const [request] = await reviews(w);
    if (request === undefined) throw new Error('No request');
    expect(await reviews(w, 'staff')).toEqual([]);
    await expect(
      approveToolProposal(depsAs(w, 'staff'), request.id, request.fingerprint),
    ).rejects.toThrow(/./);
    // Still waiting for the owner.
    expect((await reviews(w)).map((p) => p.id)).toEqual([request.id]);
  });
});
