import type {
  ConversationId,
  LlmRequest,
  LlmStreamEvent,
  MemoryWarningRule,
} from '@pepper/contracts';
import {
  changeFact,
  forgetFact,
  listFacts,
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
import { storedTextsOf, withTenant, type Database } from '@pepper/db';
import { CircuitBreaker } from '../agent/breaker.js';
import type { BusinessContext } from '../agent/context.js';
import { startTurn, type AgentDeps, type LoopLimits } from '../agent/loop.js';
import { memberMemory } from '../agent/memory.js';
import { postgresConversationStore } from '../agent/store.js';
import { isLlmError } from '../errors.js';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import { approveToolProposal, undoToolAction } from '../tools/registry.js';
import type { ToolDeps } from '../tools/tool.js';
import type { EvalCase } from './case.js';
import { seedEvalWorld, unfillPlaceholders, type EvalWorld } from './world.js';
import type { EvalTurn } from './case.js';
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
  const seen = (response: Awaited<ReturnType<LlmProvider['respond']>>) => {
    transcript.usage = addUsage(transcript.usage, response.usage);
    transcript.models.push(response.model);
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
      seen(response);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
      sent(request);
      try {
        for await (const event of provider.stream(request, options)) {
          if (event.type === 'done') seen(event.response);
          yield event;
        }
      } catch (error) {
        kept(error);
      }
    },
  };
}

/** The subject on a migrated database (the app's login role). */
export function loopSubject(
  db: Database,
  options: { limits?: Partial<LoopLimits> } = {},
): EvalSubject {
  return async (evalCase, providerFor) => {
    const world = await seedEvalWorld(
      db,
      evalCase.world,
      { now: new Date(evalCase.now), timeZone: evalCase.timeZone },
      evalCase.seed,
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
    const failures: unknown[] = [];
    const tools: ToolDeps = {
      db,
      actor,
      clock: world.clock,
      autonomy: { templateDefaults: {} },
      memoryWarnings: EVAL_MEMORY_WARNINGS,
      emails: { baseUrl: 'http://localhost:3000', outboxKey: EVAL_OUTBOX_KEY },
    };
    const deps: AgentDeps = {
      provider: observed(
        providerFor(world),
        transcript,
        failures,
        world.placeholders,
        () => memberTurn,
      ),
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
    for (const [index, turn] of evalCase.turns.entries()) {
      if (!('user' in turn)) {
        await screenAction({ ...tools, actor: owner }, world, turn);
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
      await started.run((event) => {
        if (event.type === 'message.completed') transcript.replies.push(event.text);
        if (event.type === 'turn.failed') transcript.replies.push(event.fallback.text);
      });
      if (failures.length > 0) throw failures[0];
    }
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
  } else {
    const [latest] = (await listRecentActions(db, owner)).filter(
      (each) => each.tool === action.undo && each.status === 'done',
    );
    if (latest === undefined) throw new Error(`Nothing of ${action.undo} to undo`);
    await undoToolAction(deps, latest.id, 'wrong');
  }
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
