import { AsyncLocalStorage } from 'node:async_hooks';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { LoggerService } from '@nestjs/common';
import { pino, type DestinationStream, type Level, type Logger } from 'pino';
import type { ServiceConfig } from './config.js';
import { redact, redactString } from './redact.js';

export type { Logger } from 'pino';

/** Per-request values attached to every log line written while handling the request. */
export interface RequestContext {
  requestId: string;
  /** Set once the request is authenticated (`identifyRequest`). Ids only, never names. */
  userId?: string;
  /** Set once the request's business is resolved from the session (`identifyRequest`). */
  tenantId?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` visible to every log line it writes, sync or async. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContext.run(context, fn);
}

/** The context of the request being handled, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/**
 * Records who the current request acts as, so its later log lines (including the request's
 * own completion line) carry `user_id` and `tenant_id`. A no-op outside a request.
 */
export function identifyRequest(actor: { userId: string; tenantId?: string }): void {
  const context = requestContext.getStore();
  if (!context) return;
  context.userId = actor.userId;
  if (actor.tenantId !== undefined) context.tenantId = actor.tenantId;
}

/** Correlation fields: the request and, when tracing is on, the active trace and span. */
function correlationFields(): Record<string, string> {
  const fields: Record<string, string> = {};
  const context = requestContext.getStore();
  if (context) {
    fields['request_id'] = context.requestId;
    if (context.userId !== undefined) fields['user_id'] = context.userId;
    if (context.tenantId !== undefined) fields['tenant_id'] = context.tenantId;
  }
  const span = trace.getActiveSpan()?.spanContext();
  if (span && isSpanContextValid(span)) {
    fields['trace_id'] = span.traceId;
    fields['span_id'] = span.spanId;
  }
  return fields;
}

/**
 * The process logger: JSON lines with ISO timestamps, `service`/`env`/`release` on every line,
 * request and trace correlation ids, and every message and object passed through `redact`.
 * Writes to stdout unless `destination` is given (tests).
 */
export function createLogger(
  config: Pick<ServiceConfig, 'service' | 'logLevel' | 'environment' | 'release'>,
  destination?: DestinationStream,
): Logger {
  return pino(
    {
      level: config.logLevel,
      base: {
        service: config.service,
        env: config.environment,
        ...(config.release !== undefined && { release: config.release }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      mixin: correlationFields,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object) as Record<string, unknown>,
      },
      // `redact` (in formatters.log) already turned errors into `{ type, message, stack }`.
      serializers: { err: (value: unknown) => value },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((arg: unknown) =>
            typeof arg === 'string' ? redactString(arg) : arg,
          );
          method.apply(this, scrubbed as Parameters<typeof method>);
        },
      },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );
}

/** Routes Nest's own logging (`Logger` from `@nestjs/common`) into the process logger. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.#write('info', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.#write('error', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.#write('warn', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.#write('debug', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.#write('trace', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.#write('fatal', message, params);
  }

  /**
   * Nest passes `(message, context)` or, for errors, `(message, stack, context)`: a trailing
   * string is the context (the class that logged), an earlier one the stack.
   */
  #write(level: Level, message: unknown, params: unknown[]): void {
    const strings = params.filter((param): param is string => typeof param === 'string');
    const context = strings.length > 0 ? strings.at(-1) : undefined;
    const stack = strings.length > 1 ? strings[0] : undefined;
    const fields: Record<string, unknown> = {};
    if (context !== undefined) fields['context'] = context;

    if (message instanceof Error) {
      this.logger[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.logger[level]({ ...fields, data: message });
    } else {
      if (stack !== undefined) fields['stack'] = stack;
      this.logger[level](fields, String(message));
    }
  }
}
