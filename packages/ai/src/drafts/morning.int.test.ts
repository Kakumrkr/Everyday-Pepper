import {
  ClientIdSchema,
  OutboxEmailSchema,
  OutboxMessageIdSchema,
  ServiceIdSchema,
  StaffMemberIdSchema,
  PLATFORM_DRAFTS,
  type LlmRequest,
  type MembershipRole,
} from '@pepper/contracts';
import {
  changeFeedSettings,
  DraftRefusedError,
  deliverOutboxMessage,
  getProposal,
  listPendingProposals,
  listRecentActions,
  ManualClock,
  openOutboxContent,
  ProposalNotPendingError,
  saveFact,
  type EmailMessage,
  type Mailer,
} from '@pepper/core';
import {
  findOutboxMessage,
  listDueOutboxMessages,
  listWaitingFeedItems,
  optOutClientEmail,
  withTenant,
  type Database,
} from '@pepper/db';
import { addTimeOff, createBooking } from '@pepper/appointments';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedEvalWorld, type EvalWorld, type WorldSeed } from '../evals/world.js';
import { ScriptedProvider, scriptedResponse } from '../scripted-provider.js';
import { approveToolProposal, dispatchToolCall, reviseNudgeDraft } from '../tools/registry.js';
import { OUTBOX_KEY, startTestDatabase, type TestDatabase } from '../tools/test-support.js';
import type { ToolDeps } from '../tools/tool.js';
import { runMorningDraftsFor, type MorningDraftsOptions } from './morning.js';

// The morning drafts pass end to end (S36, ADR-0040) on Postgres, with the model scripted:
// AC-W4-1 (tomorrow has an hour open and a regular is overdue: at the morning hour a drafted
// email waits under "Needs your OK"), AC-W4-2 (approved, exactly one email reaches the client,
// whatever retries), the edit that re-fingerprints, and every reason no email goes: an opted-out
// client, no mailing address, a time booked meanwhile, words that break a draft rule.

let database: TestDatabase;
let db: Database;

beforeAll(async () => {
  database = await startTestDatabase();
  db = database.app.db;
});

afterAll(async () => {
  await database.stop();
});

// Monday 2 November 2026, 07:30 in New York: tomorrow (Tuesday) Jess works 09:00–17:00 with
// lunch at 12:00 and Maria at 15:00, so 09:00 is open; Sara is a week overdue.
const MORNING = '2026-11-02T12:30:00.000Z';
const BASE_URL = 'https://app.pepper.test';
const BODY =
  'Hi Sara,\n\nIt has been about five weeks since your last haircut with Jess. We would love to see you again; there is an opening below.';

const draftAnswer = (
  words: { subject: string; body: string } = { subject: 'Time for a trim?', body: BODY },
) =>
  scriptedResponse({
    toolCalls: [{ id: 'call_1', name: 'write_draft', arguments: JSON.stringify(words) }],
    usage: { inputTokens: 420, cachedInputTokens: 0, outputTokens: 80 },
  });

const world = (seed: Partial<WorldSeed> = {}, now = MORNING) =>
  seedEvalWorld(
    db,
    'juniper_feed',
    { now: new Date(now), timeZone: 'America/New_York' },
    { facts: [], memoryPaused: false, ...seed },
  );

function optionsFor(
  w: EvalWorld,
  provider: ScriptedProvider,
  reserved: number[] = [],
): MorningDraftsOptions {
  return {
    provider,
    clock: w.clock,
    reserve: (_tenant, estimate) => {
      reserved.push(estimate);
      return Promise.resolve({ state: 'ok', settle: () => Promise.resolve() });
    },
    emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
    draftsOf: () => PLATFORM_DRAFTS,
    insightsOf: () => ({
      enabled: ['rebooking_due', 'schedule_gaps', 'no_show_pattern', 'staff_overload'],
      minGapMinutes: 60,
    }),
  };
}

const depsAs = (w: EvalWorld, role: MembershipRole): ToolDeps => ({
  db,
  actor: w.actorFor(role),
  clock: w.clock,
  autonomy: { templateDefaults: {} },
  emails: { baseUrl: BASE_URL, outboxKey: OUTBOX_KEY },
});

const nudges = async (w: EvalWorld, role: MembershipRole = 'owner') =>
  (await listPendingProposals(db, w.actorFor(role), { clock: w.clock })).filter(
    (proposal) => proposal.tool === 'send_rebooking_nudge',
  );

/** The emails queued in the business, opened. */
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
  return { due, emails };
}

const later = (w: EvalWorld, minutes: number) =>
  new Date(w.clock.now().getTime() + minutes * 60_000);

describe('AC-W4-1: the morning pass drafts a nudge under "Needs your OK"', () => {
  it('at the morning hour, for the overdue regular with an email, with a time tomorrow', async () => {
    const w = await world();
    const provider = new ScriptedProvider([draftAnswer()]);
    const reserved: number[] = [];
    const result = await runMorningDraftsFor(db, w.tenantId, optionsFor(w, provider, reserved));
    expect(result).toEqual({
      outcome: 'ran',
      drafted: 1,
      // No review link in this business, so no review requests (S55.2).
      reviewRequests: 0,
      reviewsRefused: 0,
      refused: 0,
      noTime: 0,
      noBudget: 0,
      failed: 0,
    });
    // Metered: one reservation of at most 1,500 tokens (playbook §2).
    expect(reserved).toEqual([1500]);

    // The model knew the first name, the service and the last visit, never a contact or time.
    const [request] = provider.requests as [LlmRequest];
    const sent = JSON.stringify(request);
    expect(sent).toContain('Sara');
    expect(sent).toContain('Haircut');
    expect(sent).not.toMatch(/Kim|sara@example|09:00|9:00|book\//i);
    expect(request).toMatchObject({ route: 'routine', toolChoice: 'required' });

    const [nudge] = await nudges(w);
    expect(nudge).toMatchObject({
      action: 'message.rebooking_nudge',
      requestedByUserId: null,
      recordOwnerUserId: null,
      preview: {
        draft: { subject: 'Time for a trim?', body: BODY },
        emails: [{ template: 'rebooking_nudge', clientId: w.placeholders.get('{{client:sara}}') }],
        after: { date: '2026-11-03', time: '09:00', staffName: 'Jess', serviceName: 'Haircut' },
      },
    });
    // The manager decides it too; Jess (staff) neither sees nor decides it.
    expect((await nudges(w, 'manager')).map((p) => p.id)).toEqual([nudge?.id]);
    expect(await nudges(w, 'staff')).toEqual([]);
    // The feed item waits on it, and nothing was queued.
    const waiting = await withTenant(db, w.tenantId, (tx) => listWaitingFeedItems(tx));
    expect(waiting).toMatchObject([
      {
        kind: 'rebooking_due',
        status: 'needs_ok',
        actionProposalId: nudge?.id,
        clientId: w.placeholders.get('{{client:sara}}'),
      },
    ]);
    expect((await queuedEmails(w, later(w, 10))).due).toEqual([]);

    // The chat reads it as waiting for an OK, without the words or any contact.
    const read = await dispatchToolCall(
      depsAs(w, 'owner'),
      { turnKey: 'conv.feed.turn.1', step: 1, requestMessageId: null, untrustedContext: false },
      { id: 'c1', name: 'get_feed', arguments: '{"kind":"rebooking_due"}' },
    );
    expect(read.status).toBe('answered');
    if (read.status === 'answered') {
      // Sarah (no email address) stays a suggestion.
      expect(read.data).toMatchObject({
        items: [
          { waitingForOk: true, client: 'Sara K.' },
          { waitingForOk: false, client: 'Sarah P.' },
        ],
      });
      expect(JSON.stringify(read.data)).not.toMatch(/trim|sara@/i);
    }

    // The same morning again: nothing more, and no model call.
    expect(await runMorningDraftsFor(db, w.tenantId, optionsFor(w, provider))).toEqual({
      outcome: 'not_due',
    });
    // The next morning: Sara had a nudge within her interval, so none again.
    w.clock.advanceBy(24 * 60 * 60_000);
    expect(await runMorningDraftsFor(db, w.tenantId, optionsFor(w, provider))).toMatchObject({
      outcome: 'ran',
      drafted: 0,
    });
    expect(provider.remaining).toBe(0);
  });

  it('waits for the morning hour, and drafts nothing without an address, when paused or opted out', async () => {
    const early = await world({}, '2026-11-02T10:00:00.000Z');
    const none = new ScriptedProvider([]);
    expect(await runMorningDraftsFor(db, early.tenantId, optionsFor(early, none))).toEqual({
      outcome: 'waiting',
    });

    const noAddress = await world({ feed: { optedOut: [], mailingAddress: false } });
    expect(await runMorningDraftsFor(db, noAddress.tenantId, optionsFor(noAddress, none))).toEqual({
      outcome: 'no_address',
    });

    const paused = await world();
    await changeFeedSettings(db, paused.actorFor('owner'), { suggestionsPaused: true });
    expect(await runMorningDraftsFor(db, paused.tenantId, optionsFor(paused, none))).toEqual({
      outcome: 'paused',
    });

    const optedOut = await world({ feed: { optedOut: ['{{client:sara}}'], mailingAddress: true } });
    expect(
      await runMorningDraftsFor(db, optedOut.tenantId, optionsFor(optedOut, none)),
    ).toMatchObject({
      outcome: 'ran',
      drafted: 0,
    });
    expect(none.requests).toEqual([]);
  });

  it('refuses words that break a draft rule, the model’s or a sensitive value it could not know', async () => {
    const linked = await world();
    const withLink = new ScriptedProvider([
      draftAnswer({ subject: 'Hi', body: 'Book at https://evil.example now' }),
    ]);
    expect(
      await runMorningDraftsFor(db, linked.tenantId, optionsFor(linked, withLink)),
    ).toMatchObject({
      drafted: 0,
      refused: 1,
    });
    expect(await nudges(linked)).toEqual([]);

    const sensitive = await world({
      facts: [
        {
          name: 'allergy',
          subject: '{{client:sara}}',
          key: 'allergy',
          value: 'PPD dye',
          sensitive: true,
        },
      ],
    });
    const leaking = new ScriptedProvider([
      draftAnswer({ subject: 'Hi Sara', body: 'We remember your PPD dye allergy!' }),
    ]);
    expect(
      await runMorningDraftsFor(db, sensitive.tenantId, optionsFor(sensitive, leaking)),
    ).toMatchObject({
      drafted: 0,
      refused: 1,
    });
    expect(await nudges(sensitive)).toEqual([]);
  });
});

describe('AC-W4-2: approved, exactly one email per recipient', () => {
  it('sends the shown words with the time, link, address and unsubscribe, once whatever retries', async () => {
    const w = await world();
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w, new ScriptedProvider([draftAnswer()])));
    const [nudge] = await nudges(w);
    if (nudge === undefined) throw new Error('no nudge');
    const owner = depsAs(w, 'owner');
    const approved = await approveToolProposal(owner, nudge.id, nudge.fingerprint);
    expect(approved.kind).toBe('executed');
    // A double tap finds the first.
    const again = await approveToolProposal(owner, nudge.id, nudge.fingerprint);
    expect(again).toMatchObject({ kind: 'executed' });
    if (approved.kind !== 'executed' || again.kind !== 'executed') return;
    expect(again.execution.id).toBe(approved.execution.id);

    // Held for the undo-send grace, then one email.
    expect((await queuedEmails(w, later(w, 1))).due).toEqual([]);
    const { due, emails } = await queuedEmails(w, later(w, 3));
    expect(emails).toHaveLength(1);
    const [email] = emails;
    expect(email).toMatchObject({ to: 'sara@example.test', subject: 'Time for a trim?' });
    expect(email?.text).toContain(BODY);
    expect(email?.text).toContain('Jess has an opening on Tuesday, November 3 at 9:00 AM');
    expect(email?.text).toMatch(new RegExp(`${BASE_URL}/book/eval-juniper-feed-`));
    expect(email?.text).toContain('Juniper Hair Studio\n12 Juniper Lane\nPortland, OR 97201');
    expect(email?.text).toMatch(new RegExp(`Unsubscribe: ${BASE_URL}/unsubscribe/[A-Za-z0-9_-]+`));
    expect(email?.unsubscribeUrl).toMatch(new RegExp(`^${BASE_URL}/v1/public/unsubscribe/`));

    // The worker's job runs twice (a duplicate delivery): the client gets one email.
    const sent: EmailMessage[] = [];
    const mailer: Mailer = {
      send: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const clock = new ManualClock(later(w, 3));
    const [message] = due;
    if (message === undefined) throw new Error('no message');
    const results = await Promise.all([
      deliverOutboxMessage(db, message, { key: OUTBOX_KEY, mailer, clock }),
      deliverOutboxMessage(db, message, { key: OUTBOX_KEY, mailer, clock }),
    ]);
    expect(results.sort()).toEqual(['sent', 'skipped']);
    expect(await deliverOutboxMessage(db, message, { key: OUTBOX_KEY, mailer, clock })).toBe(
      'skipped',
    );
    expect(sent).toHaveLength(1);

    // The feed item is done, and the receipt is the AI's on the business's behalf.
    expect(await withTenant(db, w.tenantId, (tx) => listWaitingFeedItems(tx))).toEqual([]);
    const [receipt] = await listRecentActions(db, w.actorFor('owner'));
    expect(receipt).toMatchObject({
      tool: 'send_rebooking_nudge',
      proposalId: nudge.id,
      status: 'done',
    });
  });

  it('an edit re-fingerprints: the old card cannot send, the new words go', async () => {
    const w = await world();
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w, new ScriptedProvider([draftAnswer()])));
    const [nudge] = await nudges(w);
    if (nudge === undefined) throw new Error('no nudge');
    const manager = depsAs(w, 'manager');
    const words = {
      subject: 'See you soon, Sara?',
      body: 'Hi Sara,\n\nJess has a spot for your next haircut.',
    };
    const revised = await reviseNudgeDraft(manager, nudge.id, nudge.fingerprint, words);
    expect(revised.kind).toBe('revised');
    expect(revised.proposal.fingerprint).not.toBe(nudge.fingerprint);
    expect(revised.proposal.preview).toMatchObject({ draft: words });
    // The feed item follows the new proposal.
    expect(
      (await withTenant(db, w.tenantId, (tx) => listWaitingFeedItems(tx)))[0]?.actionProposalId,
    ).toBe(revised.proposal.id);
    await expect(approveToolProposal(manager, nudge.id, nudge.fingerprint)).rejects.toThrow(
      ProposalNotPendingError,
    );
    // Words with a link, a phone number or too many words are refused, and change nothing.
    await expect(
      reviseNudgeDraft(manager, revised.proposal.id, revised.proposal.fingerprint, {
        subject: 'Hi',
        body: 'Call +1 212 555 0143',
      }),
    ).rejects.toThrow(DraftRefusedError);
    // Staff can't edit it (they can't see it).
    await expect(
      reviseNudgeDraft(
        depsAs(w, 'staff'),
        revised.proposal.id,
        revised.proposal.fingerprint,
        words,
      ),
    ).rejects.toThrow();

    expect(
      (await approveToolProposal(manager, revised.proposal.id, revised.proposal.fingerprint)).kind,
    ).toBe('executed');
    const { emails } = await queuedEmails(w, later(w, 3));
    expect(emails.map((email) => email.subject)).toEqual(['See you soon, Sara?']);
    expect(emails[0]?.text).toContain('Jess has a spot for your next haircut.');
    expect(emails[0]?.text).not.toContain('five weeks');
  });

  it('sends nothing when the time was booked meanwhile, or the client opted out', async () => {
    const taken = await world();
    await runMorningDraftsFor(
      db,
      taken.tenantId,
      optionsFor(taken, new ScriptedProvider([draftAnswer()])),
    );
    const [first] = await nudges(taken);
    if (first === undefined) throw new Error('no nudge');
    await createBooking(
      db,
      taken.actorFor('owner'),
      {
        clientId: ClientIdSchema.parse(taken.placeholders.get('{{client:ana}}')),
        serviceId: ServiceIdSchema.parse(taken.placeholders.get('{{service:haircut}}')),
        staffMemberId: StaffMemberIdSchema.parse(taken.placeholders.get('{{staff:jess}}')),
        startsAt: '2026-11-03T14:00:00.000Z',
        notifyClient: false,
      },
      { clock: taken.clock },
    );
    expect(
      (await approveToolProposal(depsAs(taken, 'owner'), first.id, first.fingerprint)).kind,
    ).toBe('refused');
    expect((await getProposal(db, taken.actorFor('owner'), first.id)).status).toBe('superseded');
    expect((await queuedEmails(taken, later(taken, 3))).emails).toEqual([]);
    expect(await withTenant(db, taken.tenantId, (tx) => listWaitingFeedItems(tx))).toEqual([]);
    // Nothing reached Sara, so the next morning looks for a new time, as the refusal said.
    taken.clock.advanceBy(24 * 60 * 60_000);
    await runMorningDraftsFor(
      db,
      taken.tenantId,
      optionsFor(taken, new ScriptedProvider([draftAnswer()])),
    );
    expect(await nudges(taken)).toHaveLength(1);

    const out = await world();
    await runMorningDraftsFor(
      db,
      out.tenantId,
      optionsFor(out, new ScriptedProvider([draftAnswer()])),
    );
    const [second] = await nudges(out);
    if (second === undefined) throw new Error('no nudge');
    await withTenant(db, out.tenantId, (tx) =>
      optOutClientEmail(
        tx,
        ClientIdSchema.parse(out.placeholders.get('{{client:sara}}')),
        out.clock.now(),
      ),
    );
    expect(
      (await approveToolProposal(depsAs(out, 'owner'), second.id, second.fingerprint)).kind,
    ).toBe('refused');
    expect((await queuedEmails(out, later(out, 3))).emails).toEqual([]);
  });
});

describe('the writer never sees what it must not write', () => {
  it('a sensitive fact stays out of the request', async () => {
    const w = await world();
    await saveFact(db, w.actorFor('owner'), {
      subject: { type: 'client', id: ClientIdSchema.parse(w.placeholders.get('{{client:sara}}')) },
      key: 'allergy',
      value: 'nickel',
      sensitive: true,
    });
    const provider = new ScriptedProvider([draftAnswer()]);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w, provider));
    expect(JSON.stringify(provider.requests)).not.toContain('nickel');
  });

  it('names the staff member only when the time offered is theirs (S36b code review)', async () => {
    const w = await world();
    // Jess is off tomorrow (Tuesday), so the time offered is Marco's, whom Sara never saw.
    await addTimeOff(
      db,
      w.actorFor('owner'),
      StaffMemberIdSchema.parse(w.placeholders.get('{{staff:jess}}')),
      { startsAt: '2026-11-03T05:00:00.000Z', endsAt: '2026-11-04T05:00:00.000Z' },
    );
    const provider = new ScriptedProvider([draftAnswer()]);
    await runMorningDraftsFor(db, w.tenantId, optionsFor(w, provider));
    const [nudge] = await nudges(w);
    expect(JSON.stringify(nudge)).toContain('Marco');
    const request = JSON.stringify(provider.requests);
    expect(request).not.toContain('Jess');
    expect(request).not.toContain('Marco');
  });
});
