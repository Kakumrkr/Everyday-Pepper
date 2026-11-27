import {
  addTimeOff,
  addToWaitlist,
  changeBooking,
  removeTimeOff,
  claimWaitlistOffer,
  runInsightsFor,
  updateService,
  waitlistFillOf,
} from '@pepper/appointments';
import {
  BookingIdSchema,
  ClientIdSchema,
  OfferTokenSchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  OutboxSmsSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  TenantSlugSchema,
  WaitlistMatchIdSchema,
  type MembershipRole,
} from '@pepper/contracts';
import {
  changeAutonomy,
  claimApprovalText,
  listPendingProposals,
  listRecentActions,
  openOutboxContent,
  setMemberCardTexts,
  smsCodeKeyFrom,
  startMemberPhoneCheck,
  verifyMemberPhone,
  type Actor,
} from '@pepper/core';
import {
  findOutboxMessage,
  listDueOutboxMessages,
  listDueWaitlistMatches,
  listOpenFeedItems,
  listWaitlistMatches,
  updateClient,
  withTenant,
  type Database,
} from '@pepper/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEvalWorld, type EvalWorld } from '../evals/world.js';
import { approveToolProposal, undoToolAction } from '../tools/registry.js';
import { OUTBOX_KEY, startTestDatabase, type TestDatabase } from '../tools/test-support.js';
import type { ToolDeps } from '../tools/tool.js';
import { runWaitlistMatch, type MatcherOptions } from './matcher.js';

// The smart waitlist's matcher end to end on Postgres (S37, ADR-0041, AC-W5-1), without a
// worker: Maria's Tuesday 15:00 with Jess is cancelled; Sara (anyone) and Ana (Jess) wait for
// Tuesday afternoon. With the dial at "ask" (the default) the offer waits under "Needs your
// OK" for an owner or manager; at "auto" it goes at once, with Undo until the emails leave.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:00 in New York.
const NOW = '2026-11-02T12:00:00.000Z';
const BASE_URL = 'https://app.pepper.test';

const world = () =>
  seedEvalWorld(
    db,
    'juniper',
    { now: new Date(NOW), timeZone: 'America/New_York' },
    { facts: [], memoryPaused: false },
  );

const id = (w: EvalWorld, key: string): string => {
  const value = w.placeholders.get(key);
  if (value === undefined) throw new Error(`no ${key}`);
  return value;
};

function optionsFor(w: EvalWorld): MatcherOptions {
  return {
    clock: w.clock,
    waitlistOf: () => ({ offerFanOut: 3 }),
    autonomyOf: () => ({}),
    emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
  };
}

const depsAs = (w: EvalWorld, role: MembershipRole): ToolDeps => ({
  db,
  actor: w.actorFor(role),
  clock: w.clock,
  autonomy: { templateDefaults: {} },
  emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
});

/** Sara (anyone) and Ana (Jess) wait for Tuesday afternoon; Maria's 15:00 is cancelled. */
async function cancelWithTwoWaiting(w: EvalWorld) {
  const owner = w.actorFor('owner');
  const window = [{ date: '2026-11-03', start: '13:00', end: '17:00' }];
  const haircut = ServiceIdSchema.parse(id(w, '{{service:haircut}}'));
  // They joined while the afternoon was full (the waitlist takes only full times, AC-W5-2):
  // Jess and Marco off, back once they are on the list.
  const staff = ['{{staff:jess}}', '{{staff:marco}}'].map((key) =>
    StaffMemberIdSchema.parse(id(w, key)),
  );
  const afternoon = { startsAt: '2026-11-03T18:00:00.000Z', endsAt: '2026-11-03T22:00:00.000Z' };
  const off = await Promise.all(
    staff.map(
      async (staffId) => [staffId, await addTimeOff(db, owner, staffId, afternoon)] as const,
    ),
  );
  await addToWaitlist(
    db,
    owner,
    {
      clientId: ClientIdSchema.parse(id(w, '{{client:sara}}')),
      serviceId: haircut,
      windows: window,
    },
    { clock: w.clock },
  );
  await addToWaitlist(
    db,
    owner,
    {
      clientId: ClientIdSchema.parse(id(w, '{{client:ana}}')),
      serviceId: haircut,
      staffMemberId: StaffMemberIdSchema.parse(id(w, '{{staff:jess}}')),
      windows: window,
    },
    { clock: w.clock },
  );
  for (const [staffId, timeOff] of off) await removeTimeOff(db, owner, staffId, timeOff.id);
  await changeBooking(
    db,
    owner,
    BookingIdSchema.parse(id(w, '{{booking:maria}}')),
    { status: 'cancelled', notifyClient: false },
    { clock: w.clock },
  );
}

async function dueMatch(w: EvalWorld) {
  const due = (await listDueWaitlistMatches(db, w.clock.now(), 100)).filter(
    (m) => m.tenantId === w.tenantId,
  );
  expect(due).toHaveLength(1);
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked just above
  return due[0]!;
}

/** The offer emails queued in the business, opened, once their Undo grace has passed. */
async function offerEmails(w: EvalWorld) {
  const at = new Date(w.clock.now().getTime() + 5 * 60_000);
  const due = (await listDueOutboxMessages(db, at, 100)).filter((m) => m.tenantId === w.tenantId);
  const emails = [];
  for (const message of due) {
    const row = await withTenant(db, w.tenantId, (tx) =>
      findOutboxMessage(tx, OutboxMessageIdSchema.parse(message.messageId)),
    );
    if (row?.type !== 'email' || row.payload === null || row.status !== 'pending') continue;
    emails.push(
      OutboxEmailSchema.parse(
        JSON.parse(openOutboxContent(OUTBOX_KEY, message.messageId, row.payload).toString('utf8')),
      ),
    );
  }
  return emails.filter((email) => email.subject.startsWith('A time opened up'));
}

function tokenOf(text: string) {
  const match = /\/book\/[^/]+\/offer#([A-Za-z0-9_-]{43})/.exec(text);
  if (match?.[1] === undefined) throw new Error('no claim link');
  return OfferTokenSchema.parse(match[1]);
}

/** The feed's `waitlist_match` items after an insights run (S38a), as payloads. */
async function matchItems(w: EvalWorld) {
  await runInsightsFor(db, w.tenantId, {
    clock: w.clock,
    insightsOf: () => ({ enabled: ['waitlist_match'], minGapMinutes: 60 }),
  });
  const items = await withTenant(db, w.tenantId, (tx) => listOpenFeedItems(tx, w.clock.now()));
  return items.filter((item) => item.kind === 'waitlist_match').map((item) => item.payload);
}

const offerProposals = async (w: EvalWorld, actor: Actor) =>
  (await listPendingProposals(db, actor, { clock: w.clock })).filter(
    (p) => p.tool === 'send_waitlist_offers',
  );

describe('AC-W5-1: a cancelled time is offered to the best matches', () => {
  it('at "ask" (the default): one proposal for owners and managers, ranked, nothing sent', async () => {
    const w = await world();
    await cancelWithTwoWaiting(w);
    const result = await runWaitlistMatch(db, await dueMatch(w), optionsFor(w));
    expect(result).toBe('proposed');
    const [proposal] = await offerProposals(w, w.actorFor('owner'));
    expect(proposal).toMatchObject({
      action: 'message.waitlist_offer',
      requestedByUserId: null,
      recordOwnerUserId: null,
      preview: {
        after: {
          date: '2026-11-03',
          time: '15:00',
          staffName: 'Jess',
          serviceName: 'Haircut',
          // Ana asked for Jess, so she ranks first.
          offeredTo: 'Ana R. and Sara K.',
          offers: 2,
        },
        emails: [
          { template: 'waitlist_offer', clientId: id(w, '{{client:ana}}') },
          { template: 'waitlist_offer', clientId: id(w, '{{client:sara}}') },
        ],
      },
    });
    // *Why?* names the ranking.
    const ranks = proposal?.explanation.facts
      .filter((f) => f.kind === 'waitlist_rank')
      .map((f) => f.value as { rank: number; fit: string; clientName: string });
    expect(ranks?.map((r) => [r.rank, r.fit, r.clientName])).toEqual([
      [1, 'asked_for_staff', 'Ana R.'],
      [2, 'anyone', 'Sara K.'],
    ]);
    expect((await offerProposals(w, w.actorFor('manager'))).map((p) => p.id)).toEqual([
      proposal?.id,
    ]);
    expect(await offerProposals(w, w.actorFor('staff'))).toEqual([]);
    expect(await offerEmails(w)).toEqual([]);
    const [match] = await withTenant(db, w.tenantId, (tx) => listWaitlistMatches(tx, 10));
    expect(match).toMatchObject({ status: 'done', outcome: 'proposed' });
    // The feed shows the freed time waiting for an OK (S38a).
    expect(await matchItems(w)).toEqual([
      {
        startsAt: '2026-11-03T20:00:00.000Z',
        endsAt: '2026-11-03T21:00:00.000Z',
        state: 'needs_ok',
        offered: 0,
      },
    ]);

    // Approved by the manager: one email each, with its own claim link; the first claim books.
    if (proposal === undefined) throw new Error('no proposal');
    const approved = await approveToolProposal(
      depsAs(w, 'manager'),
      proposal.id,
      proposal.fingerprint,
    );
    expect(approved.kind).toBe('executed');
    const emails = await offerEmails(w);
    expect(emails.map((e) => e.to).sort()).toEqual(['ana@example.test', 'sara@example.test']);
    const sara = emails.find((e) => e.to === 'sara@example.test');
    if (sara === undefined) throw new Error('no email to Sara');
    expect(sara.text).toContain('Haircut with Jess, Tuesday, November 3 at 3:00 PM');
    const slug = TenantSlugSchema.parse(/\/book\/([^/]+)\/offer#/.exec(sara.text)?.[1]);
    const claimed = await claimWaitlistOffer(db, slug, tokenOf(sara.text), { clock: w.clock });
    expect(claimed.booking).toMatchObject({
      status: 'confirmed',
      startsAt: '2026-11-03T20:00:00.000Z',
    });
    expect(await matchItems(w)).toMatchObject([{ state: 'claimed', offered: 2 }]);
  });

  it('a client whose address went before the approval: the offer is stale, nothing is sent', async () => {
    const w = await world();
    await cancelWithTwoWaiting(w);
    expect(await runWaitlistMatch(db, await dueMatch(w), optionsFor(w))).toBe('proposed');
    const [proposal] = await offerProposals(w, w.actorFor('owner'));
    if (proposal === undefined) throw new Error('no proposal');
    // Ana (rank 1) has no address any more: the emails shown are no longer the ones that would go.
    const ana = ClientIdSchema.parse(id(w, '{{client:ana}}'));
    await withTenant(db, w.tenantId, (tx) =>
      updateClient(tx, ana, { name: 'Ana Ruiz', email: null, phone: null }),
    );
    const approved = await approveToolProposal(
      depsAs(w, 'owner'),
      proposal.id,
      proposal.fingerprint,
    );
    expect(approved.kind).toBe('stale');
    expect(await offerEmails(w)).toEqual([]);
  });

  it('a match runs once: a second job for it is skipped', async () => {
    const w = await world();
    await cancelWithTwoWaiting(w);
    const due = await dueMatch(w);
    expect(await runWaitlistMatch(db, due, optionsFor(w))).toBe('proposed');
    expect(await runWaitlistMatch(db, due, optionsFor(w))).toBe('skipped');
    expect(await offerProposals(w, w.actorFor('owner'))).toHaveLength(1);
  });

  it('at "auto": the offers go at once (after the Undo grace), and Undo takes them back', async () => {
    const w = await world();
    await changeAutonomy(
      db,
      w.actorFor('owner'),
      { levels: { 'message.waitlist_offer': 'auto' } },
      { templateDefaults: {} },
    );
    await cancelWithTwoWaiting(w);
    expect(await runWaitlistMatch(db, await dueMatch(w), optionsFor(w))).toBe('offered');
    expect(await offerProposals(w, w.actorFor('owner'))).toEqual([]);
    expect(await offerEmails(w)).toHaveLength(2);
    expect(await matchItems(w)).toMatchObject([{ state: 'offered', offered: 2 }]);
    const [action] = (await listRecentActions(db, w.actorFor('owner'))).filter(
      (a) => a.tool === 'send_waitlist_offers',
    );
    if (action === undefined) throw new Error('no action');
    const undone = await undoToolAction(depsAs(w, 'owner'), action.id, null);
    expect(undone).toMatchObject({ execution: { status: 'undone' } });
    expect(await offerEmails(w)).toEqual([]);
    // Offers taken back: the feed no longer says they are out (code review).
    expect(await matchItems(w)).toEqual([]);
  });

  it('nobody waiting for that time: no proposal, the match is done', async () => {
    const w = await world();
    await changeBooking(
      db,
      w.actorFor('owner'),
      BookingIdSchema.parse(id(w, '{{booking:maria}}')),
      { status: 'cancelled', notifyClient: false },
      { clock: w.clock },
    );
    expect(await runWaitlistMatch(db, await dueMatch(w), optionsFor(w))).toBe('no_match');
    expect(await offerProposals(w, w.actorFor('owner'))).toEqual([]);
  });
});

describe('S63: the offer waiting for an OK, by text (AC-X-82, AC-X-83)', () => {
  const codeKey = smsCodeKeyFrom(OUTBOX_KEY);

  /** The member's number checked, a second factor, and "Text me cards" on if `on`. */
  async function texting(w: EvalWorld, role: MembershipRole, phone: string, on: boolean) {
    const actor = w.actorFor(role);
    const coded = { codeKey, outboxKey: OUTBOX_KEY, clock: w.clock, drawCode: () => '246810' };
    await startMemberPhoneCheck(db, actor, phone, coded);
    await verifyMemberPhone(db, actor, '246810', coded);
    await db.execute(
      sql`UPDATE users SET two_factor_enabled = true WHERE id = ${actor.context.userId}`,
    );
    if (on) await setMemberCardTexts(db, actor, true, { clock: w.clock });
    return actor;
  }

  async function texts(w: EvalWorld) {
    const due = (
      await listDueOutboxMessages(db, new Date(w.clock.now().getTime() + 24 * 3_600_000), 100)
    ).filter((m) => m.tenantId === w.tenantId);
    const sent = [];
    for (const message of due) {
      const row = await withTenant(db, w.tenantId, (tx) =>
        findOutboxMessage(tx, OutboxMessageIdSchema.parse(message.messageId)),
      );
      if (row?.type !== 'sms' || row.payload === null || row.status !== 'pending') continue;
      sent.push(
        OutboxSmsSchema.parse(
          JSON.parse(
            openOutboxContent(OUTBOX_KEY, message.messageId, row.payload).toString('utf8'),
          ),
        ),
      );
    }
    // Only the cards (the phone checks' codes are the members' own).
    return sent.filter((text) => text.body.includes('Reply Y'));
  }

  it('texts the owner who asked, first names only; their "Y" and code approve that card', async () => {
    const w = await world();
    const owner = await texting(w, 'owner', '+15557770101', true);
    // A manager with a checked number who didn't turn it on gets nothing.
    await texting(w, 'manager', '+15557770102', false);
    await cancelWithTwoWaiting(w);
    expect(await runWaitlistMatch(db, await dueMatch(w), { ...optionsFor(w), texts: true })).toBe(
      'proposed',
    );
    const [proposal] = await offerProposals(w, owner);
    if (proposal === undefined) throw new Error('no proposal');

    const [text, ...others] = await texts(w);
    expect(others).toEqual([]);
    expect(text?.to).toBe('+15557770101');
    // Held for the quiet hours (07:00 in New York): the code works 2 hours from 08:00.
    expect(text?.body).toMatch(
      /^Pepper: Tue 3pm opened with Jess\. Offer it to Ana and Sara\? Reply Y (\d{4}) to OK or N \1 to skip, by 10:00am\.$/,
    );
    const code = /Reply Y (\d{4})/.exec(text?.body ?? '')?.[1] ?? '';

    // Another number with the right code, and the right number with another code: misses.
    const at = w.clock.now();
    expect(
      await claimApprovalText(db, { from: '+15557770102', code, receivedAt: at }, { codeKey }),
    ).toEqual({ kind: 'miss' });
    const wrong = code === '0000' ? '0001' : '0000';
    expect(
      await claimApprovalText(
        db,
        { from: '+15557770101', code: wrong, receivedAt: at },
        { codeKey },
      ),
    ).toEqual({ kind: 'miss' });

    const claim = await claimApprovalText(
      db,
      { from: '+15557770101', code, receivedAt: at },
      { codeKey },
    );
    expect(claim).toMatchObject({
      kind: 'claimed',
      tenantId: w.tenantId,
      context: { tenantId: w.tenantId, userId: owner.context.userId, role: 'owner' },
      proposalId: proposal.id,
      fingerprint: proposal.fingerprint,
    });
    if (claim.kind !== 'claimed') throw new Error('not claimed');
    const approved = await approveToolProposal(
      { ...depsAs(w, 'owner'), actor: { context: claim.context } },
      claim.proposalId,
      claim.fingerprint,
    );
    expect(approved.kind).toBe('executed');
    expect((await offerEmails(w)).map((e) => e.to).sort()).toEqual([
      'ana@example.test',
      'sara@example.test',
    ]);
    // Once.
    expect(
      await claimApprovalText(db, { from: '+15557770101', code, receivedAt: at }, { codeKey }),
    ).toEqual({ kind: 'used' });
  });

  it('texts nothing when the deployment sends no texts', async () => {
    const w = await world();
    await texting(w, 'owner', '+15557770103', true);
    await cancelWithTwoWaiting(w);
    expect(await runWaitlistMatch(db, await dueMatch(w), optionsFor(w))).toBe('proposed');
    expect(await texts(w)).toEqual([]);
  });
});

describe('regulars (S54, AC-W5-3…5): what the waitlist leaves goes to overdue regulars', () => {
  it('each email to its own client: the regular’s with the footer, the value on the action', async () => {
    // Sara and Sarah (no email) are Jess's regulars, a week overdue; Ana waits for Jess.
    const w = await seedEvalWorld(
      db,
      'juniper_feed',
      { now: new Date(NOW), timeZone: 'America/New_York' },
      { facts: [], memoryPaused: false, feed: { optedOut: [], mailingAddress: true } },
    );
    const owner = w.actorFor('owner');
    const haircut = ServiceIdSchema.parse(id(w, '{{service:haircut}}'));
    await updateService(db, owner, haircut, {
      name: 'Haircut',
      durationMinutes: 60,
      bufferAfterMinutes: 10,
      priceFromCents: 6000,
    });
    const jess = StaffMemberIdSchema.parse(id(w, '{{staff:jess}}'));
    const afternoon = { startsAt: '2026-11-03T18:00:00.000Z', endsAt: '2026-11-03T22:00:00.000Z' };
    const offs = await Promise.all(
      ['{{staff:jess}}', '{{staff:marco}}'].map(async (key) => {
        const staffId = StaffMemberIdSchema.parse(id(w, key));
        return [staffId, await addTimeOff(db, owner, staffId, afternoon)] as const;
      }),
    );
    await addToWaitlist(
      db,
      owner,
      {
        clientId: ClientIdSchema.parse(id(w, '{{client:ana}}')),
        serviceId: haircut,
        staffMemberId: jess,
        windows: [{ date: '2026-11-03', start: '13:00', end: '17:00' }],
      },
      { clock: w.clock },
    );
    for (const [staffId, timeOff] of offs) await removeTimeOff(db, owner, staffId, timeOff.id);
    await changeBooking(
      db,
      owner,
      BookingIdSchema.parse(id(w, '{{booking:maria}}')),
      { status: 'cancelled', notifyClient: false },
      { clock: w.clock },
    );
    await runInsightsFor(db, w.tenantId, {
      clock: w.clock,
      insightsOf: () => ({ enabled: ['rebooking_due'], minGapMinutes: 60 }),
    });

    expect(await runWaitlistMatch(db, await dueMatch(w), optionsFor(w))).toBe('proposed');
    const [proposal] = await offerProposals(w, owner);
    if (proposal === undefined) throw new Error('no proposal');
    expect(proposal).toMatchObject({
      preview: {
        summary:
          "Offer Jess's opening Tue 2026-11-03 at 15:00 to Ana R. and Sara K., ~$60; the first to claim it books it.",
        after: { offeredTo: 'Ana R. and Sara K.', valueCents: 6000 },
      },
    });
    // *Why?* says Sara was due back, as a nudge's does.
    expect(proposal.explanation.facts.map((f) => f.kind)).toEqual([
      'slot_was_free',
      'waitlist_rank',
      'rebooking_due',
    ]);

    const approved = await approveToolProposal(
      depsAs(w, 'owner'),
      proposal.id,
      proposal.fingerprint,
    );
    expect(approved.kind).toBe('executed');
    const emails = await offerEmails(w);
    expect(emails.map((e) => e.to).sort()).toEqual(['ana@example.test', 'sara@example.test']);
    const sara = emails.find((e) => e.to === 'sara@example.test');
    const ana = emails.find((e) => e.to === 'ana@example.test');
    if (sara === undefined || ana === undefined) throw new Error('missing an email');
    expect(sara.text).toContain('It has been a while');
    expect(sara.text).toContain('Unsubscribe: https://app.pepper.test/unsubscribe/');
    expect(sara.text).toMatch(/Hi Sara/);
    expect(ana.text).toContain('A time you were waiting for opened up');
    expect(ana.text).not.toContain('Unsubscribe');
    // Each link claims its own client's offer: Sara's books Sara.
    const slug = TenantSlugSchema.parse(/\/book\/([^/]+)\/offer#/.exec(sara.text)?.[1]);
    const claimed = await claimWaitlistOffer(db, slug, tokenOf(sara.text), { clock: w.clock });
    expect(claimed.email.email).toBe('sara@example.test');

    // Activity: the receipt now says who filled it and for how much.
    const [receipt] = (await listRecentActions(db, owner, { limit: 5 })).filter(
      (a) => a.tool === 'send_waitlist_offers',
    );
    if (receipt === undefined) throw new Error('no receipt');
    expect(
      await waitlistFillOf(db, owner, WaitlistMatchIdSchema.parse(receipt.entity.id), {
        clock: w.clock,
      }),
    ).toEqual({ state: 'filled', clientName: 'Sara Kim', priceCents: 6000, offered: 2 });
  });
});
