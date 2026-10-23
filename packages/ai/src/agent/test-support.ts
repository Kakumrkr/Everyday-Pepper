// Integration-test helpers for the agent loop (not built into dist): the loop's dependencies
// on a seeded world, as a member, with the real tools, store and token budget.
import {
  DEFAULT_LLM_TOKEN_LIMITS,
  reserveLlmTokens,
  type Actor,
  type LlmTokenLimits,
} from '@pepper/core';
import type { LlmProvider } from '../provider.js';
import { depsFor, type World } from '../tools/test-support.js';
import { CircuitBreaker } from './breaker.js';
import type { AgentDeps } from './loop.js';
import { memberMemory } from './memory.js';
import { postgresConversationStore } from './store.js';

export function agentDepsFor(
  world: World,
  actor: Actor,
  provider: LlmProvider | null,
  options: {
    limits?: LlmTokenLimits;
    breaker?: CircuitBreaker;
    overrides?: Partial<AgentDeps>;
  } = {},
): AgentDeps {
  const tools = depsFor(world, actor);
  const limits = options.limits ?? DEFAULT_LLM_TOKEN_LIMITS;
  return {
    provider,
    tools,
    memory: memberMemory(tools),
    store: postgresConversationStore(world.db, actor, world.clock),
    budget: {
      reserve: (estimate) =>
        reserveLlmTokens(world.db, world.tenantId, { estimate, limits }, world.clock),
    },
    breaker: options.breaker ?? new CircuitBreaker(world.clock),
    business: {
      name: 'Juniper Hair Studio',
      timeZone: 'America/New_York',
      terminology: null,
      templateFragments: [],
      member: { firstName: 'Ana', role: actor.context.role },
    },
    cacheKey: `biz_${world.tenantId.slice(0, 8)}`,
    safetyId: `member_${actor.context.userId.slice(0, 8)}`,
    ...options.overrides,
  };
}

let clientTurns = 0;

/** A new client turn id (a UUID, like the chat screen sends). */
export function clientTurnId(): string {
  clientTurns += 1;
  return `0199f4b2-7c1e-7a00-8000-${String(clientTurns).padStart(12, '0')}`;
}
