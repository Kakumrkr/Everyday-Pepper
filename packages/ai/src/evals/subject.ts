import {
  getBookingRules,
  getWorkingHours,
  importVisitBook,
  listWaitlist,
  runBriefingFor,
  runInsightsFor,
} from '@pepper/appointments';
import {
  OutboxEpisodeSchema,
  StaffMemberIdSchema,
  UtcDateTimeSchema,
  type BookingId,
  type UtcDateTime,
  type ConversationId,
  type ConversationTurnId,
  type LlmRequest,
  type LlmStreamEvent,
  type MemoryWarningRule,
} from '@pepper/contracts';
import {
  changeFact,
  forgetFact,
  getFeed,
  listFacts,
  listMyEpisodes,
  listPendingProposals,
  listRecentActions,
  memoryOfAction,
  outboxKeyFrom,
  subjectKey,
  type Actor,
} from '@pepper/core';
import {
  MemoryFactIdSchema,
  type ActionExplanation,
  type MemoryFactShown,
} from '@pepper/contracts';
import {
  countOutboxMessagesByKey,
  listWaitingFeedItems,
  storedTextsOf,
  withTenant,
  type Database,
} from '@pepper/db';
import { CircuitBreaker } from '../agent/breaker.js';
import type { BusinessContext } from '../agent/context.js';
import { startTurn, type AgentDeps, type LoopLimits } from '../agent/loop.js';
import { memberMemory } from '../agent/memory.js';
import { postgresConversationStore } from '../agent/store.js';
import { hashEmbedder, type Embedder } from '../embedder.js';
import { isLlmError } from '../errors.js';
import { writeEpisode } from '../memory/episodes.js';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import { runMorningDraftsFor } from '../drafts/morning.js';
import { WRITE_DRAFT_TOOL } from '../drafts/writer.js';
import { SUGGEST_MAPPING_TOOL, suggestImportColumns } from '../imports/mapping-suggester.js';
import { READ_CLIENT_TEXT_TOOL, readClientText } from '../client-texts/reader.js';
import { stageImport } from '@pepper/imports';
import { approveToolProposal, shownPreview, undoToolAction } from '../tools/registry.js';
import type { ToolDeps } from '../tools/tool.js';
import type { EvalCase, EvalTurn } from './case.js';
import { seedEvalWorld, unfillPlaceholders, type EvalWorld } from './world.js';
import { addUsage, emptyUsage, type Transcript } from './transcript.js';

// The eval subject (ADR-0030): each case runs through the real agent loop, in a freshly seeded
// world on Postgres, with the real tools and trust layer, so a case is judged by what the
// business looks like afterwards, not only by what the model said. Only the model is swapped:
// a cassette, a fake, or (S27) the real one.

/** Runs one case: seeds its world, asks `providerFor` for the model, returns what happened. */
export type EvalSubject = (
  evalCase: EvalCase,
  providerFor: (world: EvalWorld) => LlmProvider,
) => Promise<Transcript>;

const EVAL_OUTBOX_KEY = outboxKeyFrom('pepper-eval-runner-outbox-key-not-a-secret');

/** The insights every eval world runs (all four kinds, an hour as the shortest gap). */
export const EVAL_INSIGHTS = {
  enabled: [
    'rebooking_due',
    'schedule_gaps',
    'no_show_pattern',
    'staff_overload',
    'waitlist_match',
  ] as const,
  minGapMinutes: 60,
};

/** Juniper's voice for rebooking emails (the hair salon template's, S36). */
export const EVAL_DRAFTS = {
  voice: 'Warm, upbeat and personal, like a stylist reaching out to a regular.',
  morningHour: 7,
};

/** The hair salon template's booking warnings (Juniper is a salon): color warns about allergies. */
export const EVAL_MEMORY_WARNINGS: readonly MemoryWarningRule[] = [
  { serviceCategories: ['Color'], keys: ['allergy'] },
];

/** The business and member a case's prompt is about (the same in every world of the name). */
export function evalBusinessContext(
  evalCase: Pick<EvalCase, 'timeZone' | 'actor'>,
  firstName = { owner: 'Lena', manager: 'Cara', staff: 'Jess' }[evalCase.actor.role],
): BusinessContext {
  return {
    name: 'Juniper Hair Studio',
    timeZone: evalCase.timeZone,
    terminology: null,
    templateFragments: [],
    visitNoteKeys: ['formula', 'developer', 'processing_time'],
    member: { firstName, role: evalCase.actor.role },
  };
}

/**
 * Watches a provider's answers for the transcript. A failure that is not the provider's own
 * (`LlmError`), such as a cassette with no answer or a stale one, is kept in `failures`: the
 * loop would turn it into a fallback reply, but the run must fail with it.
 */
function observed(
  provider: LlmProvider,
  transcript: Transcript,
  failures: unknown[],
  placeholders: ReadonlyMap<string, string>,
  memberTurn: () => number,
): LlmProvider {
  const sent = (request: LlmRequest) => {
    (transcript.requests ??= []).push({ turn: memberTurn(), text: JSON.stringify(request) });
  };
  const kept = (error: unknown): never => {
    if (isLlmError(error)) {
      (transcript.modelErrors ??= []).push(`${error.code}: ${error.message}`);
    } else {
      failures.push(error);
    }
    throw error;
  };
  const seen = (response: Awaited<ReturnType<LlmProvider['respond']>>, request: LlmRequest) => {
    transcript.usage = addUsage(transcript.usage, response.usage);
    transcript.models.push(response.model);
    // The draft writer's forced answer (S36) is its words, judged by the drafts grader; its
    // refusal is not a reply to the member either.
    // The mapping suggester's forced answer (S56a.2) is judged by the mapping grader, as stored.
    // The client text reader's (S81a) by the reading grader, as the domain would get it.
    if (
      request.tools.some(
        (tool) =>
          tool.name === WRITE_DRAFT_TOOL.name ||
          tool.name === SUGGEST_MAPPING_TOOL.name ||
          tool.name === READ_CLIENT_TEXT_TOOL.name,
      )
    ) {
      return;
    }
    if (response.refusal !== undefined) transcript.replies.push(response.refusal);
    for (const call of response.toolCalls) {
      let parsed: unknown = null;
      let placeheld: unknown = null;
      try {
        parsed = JSON.parse(call.arguments) as unknown;
        placeheld = JSON.parse(unfillPlaceholders(call.arguments, placeholders)) as unknown;
      } catch {
        // Invalid JSON: graded as arguments the schema refuses.
      }
      transcript.toolCalls.push({
        name: call.name,
        arguments: parsed,
        raw: call.arguments,
        placeheld,
      });
    }
  };
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions) {
      sent(request);
      const response = await provider.respond(request, options).catch(kept);
      seen(response, request);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
      sent(request);
      try {
        for await (const event of provider.stream(request, options)) {
          if (event.type === 'done') seen(event.response, request);
          yield event;
        }
      } catch (error) {
        kept(error);
      }
    },
  };
}

/** An embedder whose failures that are not the provider's (a missing recording) fail the run. */
function observedEmbedder(embedder: Embedder, failures: unknown[]): Embedder {
  return {
    model: embedder.model,
    async embed(request, options) {
      try {
        return await embedder.embed(request, options);
      } catch (error) {
        if (!isLlmError(error)) failures.push(error);
        throw error;
      }
    },
  };
}

/** The ids the case's visits get (the reader shows the model labels, never these). */
const evalVisitId = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}` as BookingId;

/**
 * A client's text read as the domain will read it (S81a): once, with the case's visits; the
 * reading's visit as its place in them.
 */
async function readEvalText(
  provider: LlmProvider,
  world: EvalWorld,
  clientText: { text: string; visits: UtcDateTime[] },
): Promise<NonNullable<Transcript['reading']>> {
  const visits = clientText.visits.map((startsAt, index) => ({ id: evalVisitId(index), startsAt }));
  const outcome = await readClientText(
    {
      provider,
      // The run's own cost guard covers real calls; a business budget is not metered.
      reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }),
    },
    world.tenantId,
    {
      text: clientText.text,
      now: UtcDateTimeSchema.parse(world.clock.now().toISOString()),
      timeZone: world.timeZone,
      visits,
    },
  );
  if (outcome.kind !== 'read') {
    return { label: 'refused', visit: null, minutesLate: null, askedFor: null, confidence: null };
  }
  const { reading } = outcome;
  const at = visits.findIndex((visit) => visit.id === reading.visitId);
  return {
    label: reading.intent,
    visit: at === -1 ? null : at + 1,
    minutesLate: reading.minutesLate,
    askedFor: reading.askedFor,
    confidence: reading.confidence,
  };
}

/** How long the episode job waits after a conversation's last turn, and a minute more. */
const EPISODE_WAIT_MS = 31 * 60_000;

/**
 * The subject on a migrated database (the app's login role). `embedder` embeds seeded
 * episodes and `search_memory`'s questions (S31): the hash embedder by default (scripted
 * cassettes), the recorded embeddings for real runs.
 */
export function loopSubject(
  db: Database,
  options: { limits?: Partial<LoopLimits>; embedder?: Embedder } = {},
): EvalSubject {
  return async (evalCase, providerFor) => {
    const failures: unknown[] = [];
    const embedder = observedEmbedder(options.embedder ?? hashEmbedder(), failures);
    const world = await seedEvalWorld(
      db,
      evalCase.world,
      { now: new Date(evalCase.now), timeZone: evalCase.timeZone },
      evalCase.seed,
      { embedder },
    );
    let memberTurn = 0;
    const transcript: Transcript = {
      toolCalls: [],
      replies: [],
      actions: { done: [], proposed: [] },
      usage: emptyUsage(),
      models: [],
    };
    const actor: Actor = world.actorFor(evalCase.actor.role);
    const tools: ToolDeps = {
      db,
      actor,
      clock: world.clock,
      // The platform's defaults, as a new business has them (S56a: a move asks).
      autonomy: { templateDefaults: {} },
      memoryWarnings: EVAL_MEMORY_WARNINGS,
      emails: { baseUrl: 'http://localhost:3000', outboxKey: EVAL_OUTBOX_KEY },
      embedder,
    };
    const provider = observed(
      providerFor(world),
      transcript,
      failures,
      world.placeholders,
      () => memberTurn,
    );
    const deps: AgentDeps = {
      provider,
      tools,
      memory: memberMemory(tools),
      store: postgresConversationStore(db, actor, world.clock),
      // Evals meter nothing against a business: the run's own cost guard covers real calls.
      budget: { reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }) },
      breaker: new CircuitBreaker(world.clock),
      business: evalBusinessContext(evalCase, world.firstNameOf(evalCase.actor.role)),
      cacheKey: `eval_${world.name}`,
      safetyId: `eval_${evalCase.actor.role}`,
      ...(options.limits !== undefined && { limits: options.limits }),
    };
    let conversationId: ConversationId | null = null;
    const owner = world.actorFor('owner');
    // Each conversation's latest turn, for the episode job (S31).
    const latestTurns = new Map<ConversationId, ConversationTurnId>();
    const seededRules = await rulesOf(db, owner, world);
    let rulesBefore = seededRules;
    const changedInTurns: number[] = [];
    for (const [index, turn] of evalCase.turns.entries()) {
      if (!('user' in turn)) {
        if ('writeEpisodes' in turn.action) {
          world.clock.advanceBy(EPISODE_WAIT_MS);
          await writeEpisodes(world, provider, embedder, actor, latestTurns);
          latestTurns.clear();
        } else if ('importFile' in turn.action) {
          // As the import screen does: the file staged, then the suggester asked once.
          const staged = await stageImport(db, owner, Buffer.from(turn.action.importFile), {
            clock: world.clock,
            visits: importVisitBook,
          });
          const { preview } = await suggestImportColumns(
            {
              db,
              provider,
              // The run's own cost guard covers real calls; a business budget is not metered.
              reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }),
            },
            owner,
            staged.batch.id,
          );
          transcript.mapping = Object.fromEntries(
            preview.batch.columns.flatMap(({ column, suggestion }) =>
              suggestion === null ? [] : [[column, suggestion.field]],
            ),
          );
        } else if ('clientText' in turn.action) {
          transcript.reading = await readEvalText(provider, world, turn.action.clientText);
        } else if ('advanceClock' in turn.action) {
          world.clock.advanceBy(turn.action.advanceClock * 60_000);
        } else if ('runInsights' in turn.action) {
          await runInsightsFor(db, world.tenantId, {
            clock: world.clock,
            insightsOf: () => EVAL_INSIGHTS,
          });
        } else if ('morningBriefing' in turn.action) {
          await runBriefingFor(db, world.tenantId, {
            clock: world.clock,
            insightsOf: () => EVAL_INSIGHTS,
            morningHourOf: () => EVAL_DRAFTS.morningHour,
            pushKey: null,
          });
        } else if ('morningDrafts' in turn.action) {
          await runMorningDraftsFor(db, world.tenantId, {
            provider,
            clock: world.clock,
            // The run's own cost guard covers real calls; a business budget is not metered.
            reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }),
            emails: tools.emails,
            draftsOf: () => EVAL_DRAFTS,
            insightsOf: () => EVAL_INSIGHTS,
          });
          const waiting = await listPendingProposals(db, owner, { clock: world.clock });
          // What waits after the latest pass (a second pass the same morning adds nothing).
          transcript.drafts = waiting.flatMap((proposal) => {
            const draft = shownPreview(proposal.preview)?.draft;
            return proposal.tool === 'send_rebooking_nudge' && draft !== undefined ? [draft] : [];
          });
        } else {
          await screenAction({ ...tools, actor: owner }, world, turn);
        }
        if (failures.length > 0) throw failures[0];
        rulesBefore = await rulesOf(db, owner, world);
        continue;
      }
      memberTurn += 1;
      if (turn.conversation === 'new') conversationId = null;
      const started = await startTurn(deps, {
        clientTurnId: clientTurnIdOf(index),
        conversationId,
        message: turn.user,
        channel: 'chat',
      });
      if (started.kind !== 'started') throw new Error(`turn ${String(index + 1)}: ${started.kind}`);
      conversationId = started.turn.conversationId;
      latestTurns.set(conversationId, started.turn.id);
      await started.run((event) => {
        if (event.type === 'message.completed') transcript.replies.push(event.text);
        if (event.type === 'turn.failed') transcript.replies.push(event.fallback.text);
      });
      if (failures.length > 0) throw failures[0];
      // Only an owner's or manager's OK on a screen may change rules or hours, never a turn.
      const rulesAfter = await rulesOf(db, owner, world);
      if (!sameRules(rulesBefore, rulesAfter)) changedInTurns.push(memberTurn);
      rulesBefore = rulesAfter;
    }
    transcript.rules = {
      before: Object.fromEntries(seededRules),
      after: Object.fromEntries(rulesBefore),
      changedInTurns,
    };
    transcript.episodes = (
      await Promise.all(
        (['owner', 'manager', 'staff'] as const).map(async (role) =>
          (await listMyEpisodes(db, world.actorFor(role))).map((episode) => ({
            member: role,
            summary: episode.summary,
          })),
        ),
      )
    ).flat();
    transcript.nudgeEmails = await withTenant(db, world.tenantId, (tx) =>
      countOutboxMessagesByKey(tx, 'nudge.rebooking:'),
    );
    transcript.waitlistOpen = (await listWaitlist(db, owner, {}, { clock: world.clock })).length;
    const feed = await getFeed(db, owner, { clock: world.clock });
    transcript.feed = {
      waiting: (await withTenant(db, world.tenantId, (tx) => listWaitingFeedItems(tx))).length,
      suggestions: feed.suggestions.length,
    };
    const executions = await listRecentActions(db, owner);
    const proposals = await listPendingProposals(db, owner, { clock: world.clock });
    transcript.actions = {
      done: executions
        .filter((action) => action.status === 'done')
        .map((action) => action.tool)
        .reverse(),
      // On the world's clock: on the real one, a proposal for a booking whose time has passed
      // would read as expired once that date is behind us.
      proposed: proposals.map((proposal) => proposal.tool),
    };
    await recordMemory(db, owner, world, transcript, [
      ...executions.map((action) => action.explanation),
      ...proposals.map((proposal) => proposal.explanation),
    ]);
    return transcript;
  };
}

/**
 * The owner does something on a screen between turns (S30): forgets or changes a remembered
 * fact, approves the AI's waiting proposals of a tool, or undoes its latest action of one.
 */
async function screenAction(
  deps: ToolDeps,
  world: EvalWorld,
  turn: Exclude<EvalTurn, { user: string }>,
): Promise<void> {
  const { db, actor: owner } = deps;
  const { action } = turn;
  const fact = (name: string) => MemoryFactIdSchema.parse(world.placeholders.get(name));
  if ('forgetFact' in action) {
    await forgetFact(db, owner, fact(action.forgetFact));
  } else if ('changeFact' in action) {
    await changeFact(
      db,
      owner,
      fact(action.changeFact),
      { value: action.value },
      {
        clock: world.clock,
      },
    );
  } else if ('approve' in action) {
    const waiting = await listPendingProposals(db, owner, { clock: world.clock });
    for (const proposal of waiting.filter((each) => each.tool === action.approve)) {
      await approveToolProposal(deps, proposal.id, proposal.fingerprint);
    }
  } else if ('undo' in action) {
    const [latest] = (await listRecentActions(db, owner)).filter(
      (each) => each.tool === action.undo && each.status === 'done',
    );
    if (latest === undefined) throw new Error(`Nothing of ${action.undo} to undo`);
    await undoToolAction(deps, latest.id, 'wrong');
  }
}

/**
 * The episode job, as the worker runs it (S31): every conversation of the case so far is
 * summarised by the case's model (the same cassette, so its request is fingerprinted too),
 * embedded and stored. Budgets are not metered here: the run's cost guard covers real calls.
 */
async function writeEpisodes(
  world: EvalWorld,
  provider: LlmProvider,
  embedder: Embedder,
  member: Actor,
  latestTurns: ReadonlyMap<ConversationId, ConversationTurnId>,
): Promise<void> {
  for (const [conversationId, turnId] of latestTurns) {
    await writeEpisode(
      {
        db: world.db,
        provider,
        embedder,
        clock: world.clock,
        reserve: () => Promise.resolve({ state: 'ok', settle: () => Promise.resolve() }),
      },
      world.tenantId,
      OutboxEpisodeSchema.parse({ conversationId, userId: member.context.userId, turnId }),
    );
  }
}

/**
 * The booking rules and every staff member's working hours, by kind and scope (S31): a rule's
 * type or `hours_limit`, and `business` or the staff member's placeholder.
 */
async function rulesOf(db: Database, owner: Actor, world: EvalWorld): Promise<Map<string, string>> {
  const placeheld = (text: string) => unfillPlaceholders(text, world.placeholders);
  const entries = new Map<string, string>();
  for (const rule of (await getBookingRules(db, owner)).rules) {
    const scope = rule.staffMemberId === null ? 'business' : placeheld(rule.staffMemberId);
    entries.set(`${rule.type}:${scope}`, JSON.stringify(rule.params));
  }
  for (const staff of ['{{staff:jess}}', '{{staff:marco}}']) {
    const id = StaffMemberIdSchema.parse(world.placeholders.get(staff));
    const hours = await getWorkingHours(db, owner, id);
    entries.set(`hours_limit:${staff}`, JSON.stringify(hours.intervals));
  }
  return entries;
}

function sameRules(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
}

/** What the business remembers and stores afterwards, and what the cards show (S30). */
async function recordMemory(
  db: Database,
  owner: Actor,
  world: EvalWorld,
  transcript: Transcript,
  explanations: readonly ActionExplanation[],
): Promise<void> {
  const bySubject = new Map(
    [...world.placeholders].map(([placeholder, id]) => [id, placeholder] as const),
  );
  const facts = [
    ...(await listFacts(db, owner, { status: 'active', limit: 500 })),
    ...(await listFacts(db, owner, { status: 'proposed', limit: 500 })),
  ];
  transcript.facts = facts.map((fact) => ({
    subject:
      fact.subject.type === 'business'
        ? 'business'
        : (bySubject.get(fact.subject.id) ?? subjectKey(fact.subject)),
    key: fact.key,
    value: fact.value,
    sensitive: fact.sensitive,
    status: fact.status,
  }));
  transcript.stored = await withTenant(db, world.tenantId, (tx) => storedTextsOf(tx));
  const known = (shown: readonly MemoryFactShown[]) =>
    shown.flatMap((fact) => (fact.state === 'known' ? [fact.value] : []));
  const cards = { warnings: [] as string[], lastVisitNotes: [] as string[] };
  for (const explanation of explanations) {
    const { card } = await memoryOfAction(db, owner, explanation, { clock: world.clock });
    cards.warnings.push(...known(card?.warnings ?? []));
    cards.lastVisitNotes.push(...known(card?.lastVisit?.notes ?? []));
  }
  transcript.cards = cards;
}

let turns = 0;

/** A fresh client turn id per turn of every run. */
function clientTurnIdOf(index: number): string {
  turns += 1;
  return `0199f4b2-7c1e-7a00-8000-${(turns * 10 + index).toString(16).padStart(12, '0')}`;
}
