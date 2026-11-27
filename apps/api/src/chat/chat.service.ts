import { createHash } from 'node:crypto';
import {
  budgetedEmbedder,
  CircuitBreaker,
  fallbackFor,
  OpenAiEmbedder,
  memberMemory,
  OpenAiProvider,
  otelTurnTracer,
  postgresConversationStore,
  startTurn,
  type AgentDeps,
  type BusinessContext,
  type Embedder,
  type LlmProvider,
  type OpenAiConfig,
  type ToolDeps,
} from '@pepper/ai';
import {
  isFinalChatEvent,
  type ChatEvent,
  type ChatEventEnvelope,
  type ChatHistoryResponse,
  type ChatStatus,
  type ChatTurnRequest,
  type ToolCallStatus,
  type ToolCard,
  type ConversationId,
  type ConversationsResponse,
  type ConversationTurnId,
} from '@pepper/contracts';
import {
  conversationHistory,
  getTurn,
  listMyConversations,
  llmBudgetState,
  llmTokenLimits,
  reserveLlmTokens,
  STALE_TURN_GRACE_MS,
  turnMessages,
  answerFacts,
  type Actor,
  type Clock,
  type TenantContext,
  type TurnView,
} from '@pepper/core';
import { findCurrentTenant, withTenant, type Database } from '@pepper/db';
import { currentRequestContext, DATABASE } from '@pepper/runtime';
import { getTemplate, templateRuleDefaults } from '@pepper/templates';
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { E2eModel } from './e2e-model.js';
import { TurnEventLog } from './turn-events.js';

export const CHAT_OPTIONS = Symbol('CHAT_OPTIONS');
/** The model behind chat: OpenAI when configured, `null` (AI off) otherwise; tests swap it. */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
export const CHAT_CLOCK = Symbol('CHAT_CLOCK');

export interface ChatOptions {
  openai: OpenAiConfig | null;
  /** The e2e journeys' scripted model (never in production; `loadApiConfig` checks). */
  scripted?: boolean;
  monthlyTokens: number;
  /** For the client emails a write queues (booking links). */
  baseUrl: string;
  outboxKey: Buffer;
  /** Whether this deployment sends texts (S79: an approved waitlist offer by text). */
  texts?: boolean;
}

export function llmProviderFor(
  options: Pick<ChatOptions, 'openai' | 'scripted'>,
): LlmProvider | null {
  if (options.scripted === true) return new E2eModel();
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
  /** Embeds `search_memory` questions (S31); `null` without an embedding model. */
  private readonly embedder: Embedder | null;

  constructor(
    @Inject(DATABASE) database: { db: Database },
    @Inject(CHAT_OPTIONS) private readonly options: ChatOptions,
    @Inject(LLM_PROVIDER) private readonly provider: LlmProvider | null,
    @Inject(CHAT_CLOCK) private readonly clock: Clock,
    private readonly events: TurnEventLog,
  ) {
    this.db = database.db;
    this.breaker = new CircuitBreaker(clock);
    const openai = options.openai;
    this.embedder =
      openai?.embeddingModel === undefined
        ? null
        : new OpenAiEmbedder({
            apiKey: openai.apiKey,
            model: openai.embeddingModel,
            timeoutMs: openai.timeoutMs,
            ...(openai.baseUrl !== undefined && { baseUrl: openai.baseUrl }),
          });
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
    const used = answerFacts();
    for (const message of messages) {
      const factIds = used(message);
      if (message.role === 'assistant' && message.content.trim() !== '') {
        events.push({
          type: 'message.completed',
          messageId: message.id,
          text: message.content,
          factIds,
        });
      }
      // The cards the member saw, so a resumed turn shows its proposals and receipts too (S26:
      // before, a turn read back after its event log expired lost them).
      if (message.role === 'tool' && message.card !== null) {
        events.push(toolFinishedOf(message.toolName ?? 'unknown', message.isError, message.card));
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

  /**
   * What the tools need for the member (approve, undo, the cards' views): the session's member,
   * the template's rule and autonomy defaults, the email settings. Never anything from a body.
   */
  async toolDeps(tenant: TenantContext): Promise<ToolDeps> {
    const actor = actorOf(tenant);
    const { template } = await this.businessOf(actor);
    return this.toolDepsFor(actor, template);
  }

  /** Whether the AI can answer now (`GET /v1/chat/status`); every screen works in all three. */
  async status(tenant: TenantContext): Promise<ChatStatus> {
    if (this.provider === null) return { state: 'off' };
    const budget = await llmBudgetState(
      this.db,
      tenant.tenantId,
      llmTokenLimits(this.options.monthlyTokens),
      this.clock,
    );
    return { state: budget === 'exhausted' ? 'paused' : 'on' };
  }

  private async businessOf(actor: Actor) {
    const tenant = await withTenant(this.db, actor.context.tenantId, findCurrentTenant);
    if (tenant === undefined) throw new Error('The session’s business does not exist');
    const template = tenant.templateId === null ? null : getTemplate(tenant.templateId);
    return { tenant, template };
  }

  private toolDepsFor(actor: Actor, template: ReturnType<typeof getTemplate> | null): ToolDeps {
    return {
      db: this.db,
      actor,
      clock: this.clock,
      templateRuleDefaults,
      autonomy: { templateDefaults: template?.defaultAutonomy ?? {} },
      memoryWarnings: template?.memory.warnings ?? [],
      emails: {
        baseUrl: this.options.baseUrl,
        outboxKey: this.options.outboxKey,
        texts: this.options.texts === true,
      },
      ...(this.embedder !== null && {
        embedder: budgetedEmbedder(this.embedder, (estimate) =>
          reserveLlmTokens(
            this.db,
            actor.context.tenantId,
            { estimate, limits: llmTokenLimits(this.options.monthlyTokens) },
            this.clock,
          ),
        ),
      }),
    };
  }

  private async depsFor(actor: Actor, memberName: string): Promise<AgentDeps> {
    const { tenant, template } = await this.businessOf(actor);
    const business: BusinessContext = {
      name: tenant.name,
      timeZone: tenant.timeZone,
      terminology: template?.terminology ?? null,
      templateFragments: template?.promptFragments ?? [],
      visitNoteKeys: template?.memory.visitNoteKeys ?? [],
      member: { firstName: memberName.trim().split(/\s+/)[0] ?? '', role: actor.context.role },
    };
    const limits = llmTokenLimits(this.options.monthlyTokens);
    const tools = this.toolDepsFor(actor, template);
    return {
      provider: this.provider,
      tools,
      memory: memberMemory(tools),
      // Episodes need an embedding model (ADR-0034); the worker writes them (S31).
      store: postgresConversationStore(this.db, actor, this.clock, {
        ...(this.options.openai?.embeddingModel !== undefined && {
          episodeKey: this.options.outboxKey,
        }),
      }),
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

/** A recorded tool result with a card, as the `tool.finished` event the member saw. */
export function toolFinishedOf(tool: string, isError: boolean, card: ToolCard): ChatEvent {
  const status: ToolCallStatus = isError
    ? 'refused'
    : card.kind !== 'change'
      ? 'answered'
      : card.state === 'proposed'
        ? 'awaiting_approval'
        : 'done';
  return {
    type: 'tool.finished',
    tool,
    status,
    summary: card.kind === 'change' ? (card.summary ?? '') : '',
    // The stable code went to the model with the result; the card is what the member needs.
    code: null,
    card,
  };
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export function actorOf(context: TenantContext): Actor {
  return { context, requestId: currentRequestContext()?.requestId };
}
