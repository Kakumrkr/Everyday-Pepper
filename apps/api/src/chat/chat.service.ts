import { createHash } from 'node:crypto';
import {
  CircuitBreaker,
  fallbackFor,
  OpenAiProvider,
  otelTurnTracer,
  postgresConversationStore,
  startTurn,
  type AgentDeps,
  type BusinessContext,
  type LlmProvider,
} from '@pepper/ai';
import type { OpenAiConfig } from '@pepper/ai/config';
import {
  isFinalChatEvent,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatHistoryResponse,
  type ChatTurnRequest,
  type ConversationId,
  type ConversationsResponse,
  type ConversationTurnId,
} from '@pepper/contracts';
import {
  conversationHistory,
  getTurn,
  listMyConversations,
  llmTokenLimits,
  reserveLlmTokens,
  STALE_TURN_GRACE_MS,
  turnMessages,
  type Actor,
  type Clock,
  type TenantContext,
  type TurnView,
} from '@pepper/core';
import { findCurrentTenant, withTenant, type Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { getTemplate, templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { TurnEventLog } from './turn-events.js';

export const CHAT_OPTIONS = Symbol('CHAT_OPTIONS');
/** The model behind chat: OpenAI when configured, `null` (AI off) otherwise; tests swap it. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const CHAT_CLOCK = Symbol('CHAT_CLOCK');

export interface ChatOptions {
  openai: OpenAiConfig | null;
  monthlyTokens: number;
  /** For the client emails a write queues (booking links). */
  baseUrl: string;
  outboxKey: Buffer;
}

export function llmProviderFor(options: Pick<ChatOptions, 'openai'>): LlmProvider | null {
  return options.openai === null ? null : new OpenAiProvider(options.openai);
}

export type StartResult =
  { kind: 'started' | 'existing'; turnId: ConversationTurnId } | { kind: 'busy' };

/** How often a turn checks for a member's stop request, and a reader for new events. */
const POLL_MS = 200;

/**
 * Chat for a request (ADR-0030): starts a member's turn and runs it in the background, its
 * events going to the turn's log, which every reader (the request that started it, a resumed
 * one, another tab) streams from. The business, the member and their role come from the
 * session only. A turn keeps running when its reader leaves (bounded by the loop's limits);
 * only an explicit stop cancels it.
 */
@Injectable()
export class ChatService implements OnModuleDestroy {
  private readonly db: Database;
  private readonly breaker: CircuitBreaker;
  private readonly running = new Set<Promise<unknown>>();
  private readonly logger = new Logger(ChatService.name);
  private readonly tracer = otelTurnTracer();

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(CHAT_OPTIONS) private readonly options: ChatOptions,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider | null,
    @Inject(CHAT_CLOCK) private readonly clock: Clock,
    private readonly events: TurnEventLog,
  ) {
    this.db = database.db;
    this.breaker = new CircuitBreaker(clock);
  }

  /** Starts the member's turn (or finds the one this client turn id started). */
  async start(
    tenant: TenantContext,
    memberName: string,
    request: ChatTurnRequest,
  ): Promise<StartResult> {
    const actor = actorOf(tenant);
    const deps = await this.depsFor(actor, memberName);
    const started = await startTurn(deps, { ...request, channel: 'chat' });
    if (started.kind === 'busy') return { kind: 'busy' };
    if (started.kind === 'existing') return { kind: 'existing', turnId: started.turn.id };
    const turnId = started.turn.id;
    const controller = new AbortController();
    let seq = 0;
    const watch = setInterval(() => {
      void this.events.cancelRequested(turnId).then(
        (asked) => {
          if (asked) controller.abort();
        },
        () => undefined,
      );
    }, POLL_MS);
    const run = started
      .run(async (event) => {
        seq += 1;
        await this.events.append(turnId, seq, event);
      }, controller.signal)
      .catch((error: unknown) => {
        this.logger.error(`Chat turn failed: ${error instanceof Error ? error.name : 'unknown'}`);
      })
      .finally(() => {
        clearInterval(watch);
        this.running.delete(run);
      });
    this.running.add(run);
    return { kind: 'started', turnId };
  }

  /** The member's own turn (404 for anyone else's). */
  turn(tenant: TenantContext, turnId: ConversationTurnId): Promise<TurnView> {
    return getTurn(this.db, actorOf(tenant), turnId);
  }

  /**
   * The turn's events after `afterSeq`, waiting for new ones until the final event or until
   * `closed()`. When the log has expired (an old turn), the events are rebuilt from the
   * conversation; when its server stopped mid-turn, the stream ends as interrupted.
   */
  async *follow(
    tenant: TenantContext,
    turn: TurnView,
    afterSeq: number,
    closed: () => boolean,
  ): AsyncGenerator<ChatEventEnvelope> {
    let after = afterSeq;
    while (!closed()) {
      const read = await this.events.read(turn.id, after);
      if (read === null) {
        const current = await this.turn(tenant, turn.id);
        if (current.status !== 'running') {
          yield* this.rebuilt(tenant, current, after);
          return;
        }
      } else {
        for (const envelope of read) {
          after = envelope.seq;
          yield envelope;
          if (isFinalChatEvent(envelope.event)) return;
        }
      }
      if (this.clock.now().getTime() > turn.deadlineAt.getTime() + STALE_TURN_GRACE_MS) {
        // The server running it stopped: the next message recovers the turn.
        yield {
          seq: after + 1,
          event: {
            type: 'turn.failed',
            fallback: fallbackFor('interrupted', { message: '', done: [] }),
          },
        };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async cancel(tenant: TenantContext, turnId: ConversationTurnId): Promise<void> {
    const turn = await this.turn(tenant, turnId);
    if (turn.status === 'running') await this.events.requestCancel(turnId);
  }

  async conversations(tenant: TenantContext): Promise<ConversationsResponse> {
    return { conversations: await listMyConversations(this.db, actorOf(tenant)) };
  }

  async history(
    tenant: TenantContext,
    conversationId: ConversationId,
  ): Promise<ChatHistoryResponse> {
    return {
      conversationId,
      items: await conversationHistory(this.db, actorOf(tenant), conversationId),
    };
  }

  /** Lets running turns finish (they are short and bounded) before the process stops. */
  async onModuleDestroy(): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.running]),
      new Promise((resolve) => setTimeout(resolve, 25_000)),
    ]);
  }

  /** A finished turn's events from what the conversation recorded (its log expired). */
  private async *rebuilt(
    tenant: TenantContext,
    turn: TurnView,
    afterSeq: number,
  ): AsyncGenerator<ChatEventEnvelope> {
    const messages = await turnMessages(this.db, actorOf(tenant), turn.id);
    const events: ChatEvent[] = [];
    const request = messages.find((message) => message.role === 'user');
    if (request !== undefined) {
      events.push({
        type: 'turn.started',
        conversationId: turn.conversationId,
        turnId: turn.id,
        requestMessageId: request.id,
      });
    }
    for (const message of messages) {
      if (message.role === 'assistant' && message.content.trim() !== '') {
        events.push({ type: 'message.completed', messageId: message.id, text: message.content });
      }
    }
    const reason = turn.stopReason ?? 'internal';
    events.push(
      reason === 'answered'
        ? { type: 'turn.completed', reason: 'answered' }
        : {
            type: 'turn.failed',
            fallback: fallbackFor(reason, { message: request?.content ?? '', done: [] }),
          },
    );
    for (const [index, event] of events.entries()) {
      if (index + 1 > afterSeq) yield { seq: index + 1, event };
    }
  }

  private async depsFor(actor: Actor, memberName: string): Promise<AgentDeps> {
    const tenant = await withTenant(this.db, actor.context.tenantId, findCurrentTenant);
    if (tenant === undefined) throw new Error('The session’s business does not exist');
    const template = tenant.templateId === null ? null : getTemplate(tenant.templateId);
    const business: BusinessContext = {
      name: tenant.name,
      timeZone: tenant.timeZone,
      terminology: template?.terminology ?? null,
      templateFragments: template?.promptFragments ?? [],
      member: { firstName: memberName.trim().split(/\s+/)[0] ?? '', role: actor.context.role },
    };
    const limits = llmTokenLimits(this.options.monthlyTokens);
    return {
      provider: this.provider,
      tools: {
        db: this.db,
        actor,
        clock: this.clock,
        templateRuleDefaults,
        autonomy: { templateDefaults: template?.defaultAutonomy ?? {} },
        emails: { baseUrl: this.options.baseUrl, outboxKey: this.options.outboxKey },
      },
      store: postgresConversationStore(this.db, actor, this.clock),
      budget: {
        reserve: (estimate) =>
          reserveLlmTokens(this.db, actor.context.tenantId, { estimate, limits }, this.clock),
      },
      breaker: this.breaker,
      business,
      tracer: this.tracer,
      // Hashes, never the ids themselves: the provider needs only something stable.
      cacheKey: `b_${digest(actor.context.tenantId)}`,
      safetyId: `m_${digest(`${actor.context.tenantId}:${actor.context.userId}`)}`,
    };
  }
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
