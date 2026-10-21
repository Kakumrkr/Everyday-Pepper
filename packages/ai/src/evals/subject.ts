import type { ConversationId, LlmRequest, LlmStreamEvent } from '@pepper/contracts';
import { listPendingProposals, listRecentActions, outboxKeyFrom, type Actor } from '@pepper/core';
import type { Database } from '@pepper/db';
import { CircuitBreaker } from '../agent/breaker.js';
import type { BusinessContext } from '../agent/context.js';
import { startTurn, type AgentDeps, type LoopLimits } from '../agent/loop.js';
import { postgresConversationStore } from '../agent/store.js';
import { isLlmError } from '../errors.js';
import type { LlmCallOptions, LlmProvider } from '../provider.js';
import type { EvalCase } from './case.js';
import { seedEvalWorld, type EvalWorld } from './world.js';
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
    member: { firstName, role: evalCase.actor.role },
  };
}

/**
 * Watches a provider's answers for the transcript. A failure that is not the provider's own
 * (`LlmError`), such as a cassette with no answer or a stale one, is kept in `failures`: the
 * loop would turn it into a fallback reply, but the run must fail with it.
 */
function observed(provider: LlmProvider, transcript: Transcript, failures: unknown[]): LlmProvider {
  const kept = (error: unknown): never => {
    if (!isLlmError(error)) failures.push(error);
    throw error;
  };
  const seen = (response: Awaited<ReturnType<LlmProvider['respond']>>) => {
    transcript.usage = addUsage(transcript.usage, response.usage);
    transcript.models.push(response.model);
    if (response.refusal !== undefined) transcript.replies.push(response.refusal);
    for (const call of response.toolCalls) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(call.arguments) as unknown;
      } catch {
        // Invalid JSON: graded as arguments the schema refuses.
      }
      transcript.toolCalls.push({ name: call.name, arguments: parsed, raw: call.arguments });
    }
  };
  return {
    async respond(request: LlmRequest, options?: LlmCallOptions) {
      const response = await provider.respond(request, options).catch(kept);
      seen(response);
      return response;
    },
    async *stream(request: LlmRequest, options?: LlmCallOptions): AsyncIterable<LlmStreamEvent> {
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
    const world = await seedEvalWorld(db, evalCase.world, {
      now: new Date(evalCase.now),
      timeZone: evalCase.timeZone,
    });
    const transcript: Transcript = {
      toolCalls: [],
      replies: [],
      actions: { done: [], proposed: [] },
      usage: emptyUsage(),
      models: [],
    };
    const actor: Actor = world.actorFor(evalCase.actor.role);
    const failures: unknown[] = [];
    const deps: AgentDeps = {
      provider: observed(providerFor(world), transcript, failures),
      tools: {
        db,
        actor,
        clock: world.clock,
        autonomy: { templateDefaults: {} },
        emails: { baseUrl: 'http://localhost:3000', outboxKey: EVAL_OUTBOX_KEY },
      },
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
    for (const [index, turn] of evalCase.turns.entries()) {
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
    const owner = world.actorFor('owner');
    transcript.actions = {
      done: (await listRecentActions(db, owner))
        .filter((action) => action.status === 'done')
        .map((action) => action.tool)
        .reverse(),
      proposed: (await listPendingProposals(db, owner)).map((proposal) => proposal.tool),
    };
    return transcript;
  };
}

let turns = 0;

/** A fresh client turn id per turn of every run. */
function clientTurnIdOf(index: number): string {
  turns += 1;
  return `0199f4b2-7c1e-7a00-8000-${(turns * 10 + index).toString(16).padStart(12, '0')}`;
}
