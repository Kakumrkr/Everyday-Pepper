import {
  ClientIdSchema,
  ServiceIdSchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  type ClientId,
  type MembershipRole,
} from '@pepper/contracts';
import {
  ForbiddenError,
  getProposal,
  listPendingProposals,
  openOutboxContent,
  rejectProposal,
  updateClient,
} from '@pepper/core';
import { listWinBackIn, runInsightsFor, updateService } from '@pepper/appointments';
import {
  findOutboxMessage,
  listDueOutboxMessages,
  listWaitingFeedItems,
  optOutClientEmail,
  withTenant,
  type Database,
} from '@pepper/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEvalWorld, type EvalWorld, type WorldSeed } from '../evals/world.js';
import { approveToolProposal } from '../tools/registry.js';
import { OUTBOX_KEY, startTestDatabase, type TestDatabase } from '../tools/test-support.js';
import type { ToolDeps } from '../tools/tool.js';
import { draftWinBack } from './win-back.js';
import { winBackWords } from './win-back-words.js';

// One-tap win-back drafts end to end on Postgres (S54.2, ADR-0057; AC-W4-7): the tap proposes
// the rebooking nudge with the domain's words and the next open time, a second tap opens the
// same draft, the daily cap and the quiet window hold, an unsubscribed client or one with no
// email gets nothing, and the send checks the opt-out again after the tap.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:30 in New York. Sara (with an email) and Sarah (without) each
// had three haircuts with Jess four weeks apart, the last five weeks ago (`juniper_feed`).
const MORNING = '2026-11-02T12:30:00.000Z';
const BASE_URL = 'https://app.pepper.test';

const world = (seed: Partial<WorldSeed> = {}) =>
  seedEvalWorld(
    db,
    'juniper_feed',
    { now: new Date(MORNING), timeZone: 'America/New_York' },
    { facts: [], memoryPaused: false, ...seed },
  );

const depsAs = (w: EvalWorld, role: MembershipRole): ToolDeps => ({
  db,
  actor: w.actorFor(role),
  clock: w.clock,
  autonomy: { templateDefaults: {} },
  emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
});

const client = (w: EvalWorld, ref: string): ClientId =>
  ClientIdSchema.parse(w.placeholders.get(`{{client:${ref}}}`));

const list = (w: EvalWorld) =>
  withTenant(db, w.tenantId, (tx) => listWinBackIn(tx, w.actorFor('owner'), { clock: w.clock }));

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

describe('AC-W4-7: one tap drafts a win-back email', () => {
  it("proposes the nudge for the owner's OK, linked to the feed, once a day per client", async () => {
    const w = await world();
    // The feed has Sara as due back, so her card waits on the draft too.
    await runInsightsFor(db, w.tenantId, {
      clock: w.clock,
      insightsOf: () => ({ enabled: ['rebooking_due'], minGapMinutes: 60 }),
    });
    const owner = depsAs(w, 'owner');
    const sara = client(w, 'sara');
    const result = await draftWinBack(owner, sara);
    if (result.kind !== 'drafted') throw new Error(`refused: ${result.reason}`);

    const proposal = await getProposal(db, w.actorFor('owner'), result.proposalId);
    expect(proposal).toMatchObject({
      status: 'pending',
      tool: 'send_rebooking_nudge',
      action: 'message.rebooking_nudge',
      requestedByUserId: w.actorFor('owner').context.userId,
      preview: {
        draft: winBackWords({
          firstName: 'Sara',
          serviceName: 'Haircut',
          lastVisit: 'September 28',
        }),
        emails: [{ template: 'rebooking_nudge', clientId: sara }],
        after: { staffName: 'Jess', serviceName: 'Haircut' },
      },
    });
    expect(proposal.preview).toMatchObject({
      draft: { subject: 'Time for your next haircut, Sara?' },
    });
    // The manager decides it too.
    const pending = await listPendingProposals(db, w.actorFor('manager'), { clock: w.clock });
    expect(pending.map((each) => each.id)).toContain(result.proposalId);
    const waiting = await withTenant(db, w.tenantId, (tx) => listWaitingFeedItems(tx));
    expect(waiting).toMatchObject([{ clientId: sara, actionProposalId: result.proposalId }]);

    // A second tap opens the same draft; the list says it waits.
    expect(await draftWinBack(owner, sara)).toEqual(result);
    const row = (await list(w)).clients.find((each) => each.clientId === sara);
    expect(row?.pendingProposalId).toBe(result.proposalId);

    // Turned down: she is in the quiet window, so no new draft for 28 days.
    await rejectProposal(db, w.actorFor('owner'), result.proposalId, { clock: w.clock });
    expect(await draftWinBack(owner, sara)).toEqual({
      kind: 'refused',
      reason: 'recently_emailed',
    });
    w.clock.advanceBy(29 * 86_400_000);
    expect((await draftWinBack(owner, sara)).kind).toBe('drafted');
  });

  it('sends exactly one email with the footer once approved', async () => {
    const w = await world();
    const owner = depsAs(w, 'owner');
    const result = await draftWinBack(owner, client(w, 'sara'));
    if (result.kind !== 'drafted') throw new Error('not drafted');
    const proposal = await getProposal(db, w.actorFor('owner'), result.proposalId);
    expect((await approveToolProposal(owner, proposal.id, proposal.fingerprint)).kind).toBe(
      'executed',
    );
    const emails = await queuedEmails(w, later(w, 3));
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatchObject({
      to: 'sara@example.test',
      subject: 'Time for your next haircut, Sara?',
    });
    expect(emails[0]?.text).toContain("Hi Sara,\n\nIt's been a while since your last haircut");
    expect(emails[0]?.text).toMatch(/Jess has an opening on .+\. Book it here:/);
    expect(emails[0]?.text).toContain('Unsubscribe: https://app.pepper.test/unsubscribe/');
    // Pepper's fixed words, no model: no AI disclosure (AC-X-55).
    expect(emails[0]?.text).not.toContain('Written with help from Pepper');
    expect(emails[0]?.text).not.toContain('/privacy');
  });

  it('refuses a client without an email, one who unsubscribed, one not due, and staff', async () => {
    const w = await world({ feed: { optedOut: ['{{client:sara}}'], mailingAddress: true } });
    const owner = depsAs(w, 'owner');
    expect(await draftWinBack(owner, client(w, 'sara'))).toEqual({
      kind: 'refused',
      reason: 'opted_out',
    });
    expect(await draftWinBack(owner, client(w, 'sarah'))).toEqual({
      kind: 'refused',
      reason: 'no_email',
    });
    // Ana has no visits: she is not on the list.
    expect(await draftWinBack(owner, client(w, 'ana'))).toEqual({
      kind: 'refused',
      reason: 'not_due',
    });
    await expect(draftWinBack(depsAs(w, 'staff'), client(w, 'sarah'))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await listPendingProposals(db, w.actorFor('owner'), { clock: w.clock })).toEqual([]);

    const noAddress = await world({ feed: { optedOut: [], mailingAddress: false } });
    expect(await draftWinBack(depsAs(noAddress, 'owner'), client(noAddress, 'sara'))).toEqual({
      kind: 'refused',
      reason: 'no_address',
    });
  });

  it('never hands back an expired draft that the clean-up has not marked yet', async () => {
    const w = await world();
    const sara = client(w, 'sara');
    const result = await draftWinBack(depsAs(w, 'owner'), sara);
    if (result.kind !== 'drafted') throw new Error('not drafted');
    // Past its time (within the week) and its time to live: still "pending" in the table.
    w.clock.advanceBy(8 * 86_400_000);
    expect((await list(w)).clients.find((each) => each.clientId === sara)).toMatchObject({
      pendingProposalId: null,
    });
    // It still counts as this month's email, so no new one yet.
    expect(await draftWinBack(depsAs(w, 'owner'), sara)).toEqual({
      kind: 'refused',
      reason: 'recently_emailed',
    });
  });

  it('refuses a client whose last service is hidden from booking, and the list says so', async () => {
    const w = await world();
    const haircut = ServiceIdSchema.parse(w.placeholders.get('{{service:haircut}}'));
    await updateService(db, w.actorFor('owner'), haircut, {
      name: 'Haircut',
      durationMinutes: 60,
      active: false,
    });
    const sara = client(w, 'sara');
    expect((await list(w)).clients.find((each) => each.clientId === sara)).toMatchObject({
      serviceBookable: false,
    });
    expect(await draftWinBack(depsAs(w, 'owner'), sara)).toEqual({
      kind: 'refused',
      reason: 'service_hidden',
    });
  });

  it('holds the daily cap', async () => {
    const w = await world();
    const owner = depsAs(w, 'owner');
    await updateClient(db, w.actorFor('owner'), client(w, 'sarah'), {
      name: 'Sarah Park',
      email: 'sarah@example.test',
    });
    expect((await draftWinBack(owner, client(w, 'sara'), { perBusinessPerDay: 1 })).kind).toBe(
      'drafted',
    );
    expect(await draftWinBack(owner, client(w, 'sarah'), { perBusinessPerDay: 1 })).toEqual({
      kind: 'refused',
      reason: 'daily_limit',
    });
    // The next local day the cap starts again.
    w.clock.advanceBy(86_400_000);
    expect((await draftWinBack(owner, client(w, 'sarah'), { perBusinessPerDay: 1 })).kind).toBe(
      'drafted',
    );
  });

  it('checks the opt-out again at the send: a client who unsubscribes after the tap gets nothing', async () => {
    const w = await world();
    const owner = depsAs(w, 'owner');
    const sara = client(w, 'sara');
    const result = await draftWinBack(owner, sara);
    if (result.kind !== 'drafted') throw new Error('not drafted');
    const proposal = await getProposal(db, w.actorFor('owner'), result.proposalId);
    await withTenant(db, w.tenantId, (tx) => optOutClientEmail(tx, sara, w.clock.now()));
    expect((await approveToolProposal(owner, proposal.id, proposal.fingerprint)).kind).toBe(
      'refused',
    );
    expect(await queuedEmails(w, later(w, 3))).toEqual([]);
  });
});
