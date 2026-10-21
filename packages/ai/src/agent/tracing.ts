import type { LlmResponse, LlmRoute, ToolErrorCode, TurnStopReason } from '@pepper/contracts';
import type { TurnProgress } from '@pepper/core';

// What the loop reports for observability (ADR-0030, playbook principle 15): a span per turn,
// with a span per model call and tool call under it, holding codes, counts and timings only,
// never a message's content. The app binds it to OpenTelemetry (`otelTurnTracer`); tests and
// evals use `noTracing`.

export interface ModelCallSpan {
  end(result: { response: LlmResponse }): void;
  fail(code: string): void;
}

export interface ToolCallSpan {
  end(result: { status: string; code: ToolErrorCode | null }): void;
}

export interface TurnSpan {
  modelCall(attributes: { route: LlmRoute; step: number; attempt: number }): ModelCallSpan;
  toolCall(attributes: { tool: string; step: number }): ToolCallSpan;
  error(error: unknown): void;
  end(result: {
    reason: TurnStopReason;
    steps: number;
    untrusted: boolean;
    usage: TurnProgress;
  }): void;
}

export interface TurnTracer {
  turn(attributes: { channel: string }): TurnSpan;
}

const nothing = () => undefined;

export const noTracing: TurnTracer = {
  turn: () => ({
    modelCall: () => ({ end: nothing, fail: nothing }),
    toolCall: () => ({ end: nothing }),
    error: nothing,
    end: nothing,
  }),
};
