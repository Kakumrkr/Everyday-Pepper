import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import type { TurnTracer } from './tracing.js';

// The loop's spans in OpenTelemetry, after the semantic conventions for generative AI
// (https://opentelemetry.io/docs/specs/semconv/gen-ai/): `chat` spans per model call with the
// model, tokens (cached ones too) and finish reason, `execute_tool` spans per tool call, under
// one `chat.turn` span. Attributes are codes and counts only: no prompt, no completion, no tool
// arguments or answers, no ids of people (D-5, playbook principle 15).

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** The tracer for the loop, from the process's OpenTelemetry provider. */
export function otelTurnTracer(tracer: Tracer = trace.getTracer('pepper.agent')): TurnTracer {
  return {
    turn(attributes) {
      const turn: Span = tracer.startSpan('chat.turn', {
        kind: SpanKind.INTERNAL,
        attributes: { 'pepper.chat.channel': attributes.channel },
      });
      const parent = trace.setSpan(context.active(), turn);
      return {
        modelCall(call) {
          const span = tracer.startSpan(
            'chat',
            {
              kind: SpanKind.CLIENT,
              attributes: {
                'gen_ai.operation.name': 'chat',
                'pepper.llm.route': call.route,
                'pepper.agent.step': call.step,
                'pepper.llm.attempt': call.attempt,
              },
            },
            parent,
          );
          return {
            end({ response }) {
              span.updateName(`chat ${response.model}`);
              span.setAttributes({
                'gen_ai.response.model': response.model,
                'gen_ai.response.finish_reasons': [response.finishReason],
                'gen_ai.usage.input_tokens': response.usage.inputTokens,
                'gen_ai.usage.cache_read.input_tokens': response.usage.cachedInputTokens,
                'gen_ai.usage.output_tokens': response.usage.outputTokens,
                'pepper.llm.tool_calls': response.toolCalls.length,
              });
              span.end();
            },
            fail(code) {
              span.setAttribute('error.type', code);
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.end();
            },
          };
        },
        toolCall(call) {
          const span = tracer.startSpan(
            `execute_tool ${call.tool}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                'gen_ai.operation.name': 'execute_tool',
                'gen_ai.tool.name': call.tool,
                'pepper.agent.step': call.step,
              },
            },
            parent,
          );
          return {
            end(result) {
              span.setAttribute('pepper.tool.status', result.status);
              if (result.code !== null) span.setAttribute('pepper.tool.error_code', result.code);
              span.end();
            },
          };
        },
        error(error) {
          turn.setAttribute('error.type', errorType(error));
          turn.setStatus({ code: SpanStatusCode.ERROR });
        },
        end(result) {
          turn.setAttributes({
            'pepper.turn.stop_reason': result.reason,
            'pepper.turn.steps': result.steps,
            'pepper.turn.untrusted': result.untrusted,
            'gen_ai.usage.input_tokens': result.usage.inputTokens,
            'gen_ai.usage.cache_read.input_tokens': result.usage.cachedInputTokens,
            'gen_ai.usage.output_tokens': result.usage.outputTokens,
          });
          turn.end();
        },
      };
    },
  };
}
