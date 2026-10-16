import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import { runWithRequestContext } from './logger.js';

/** Header carrying the request id in both directions. */
export const REQUEST_ID_HEADER = 'x-request-id';

// Ids from callers are accepted only in a plain shape, so they cannot inject into log lines.
const REQUEST_ID = /^[\w.:-]{1,128}$/;

/** The caller's request id when it is safe to reuse, otherwise a new UUID. */
export function resolveRequestId(header: string | string[] | undefined): string {
  return typeof header === 'string' && REQUEST_ID.test(header) ? header : randomUUID();
}

type Middleware = (
  request: IncomingMessage & { originalUrl?: string },
  response: ServerResponse,
  next: () => void,
) => void;

/**
 * Express middleware: gives every request an id (echoed in `x-request-id`), runs the rest of
 * the request inside its log context, and writes one line when the response finishes or the
 * client goes away. Only method, path (no query string: it can carry personal data), status
 * and duration are logged. Health probes log at debug so they do not drown everything else.
 */
export function requestLogging(logger: Logger): Middleware {
  return (request, response, next) => {
    const requestId = resolveRequestId(request.headers[REQUEST_ID_HEADER]);
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const started = performance.now();
    const path = (request.originalUrl ?? request.url ?? '/').split('?', 1)[0] ?? '/';
    const method = request.method ?? 'GET';

    runWithRequestContext({ requestId }, () => {
      const write = (message: string): void => {
        const status = response.statusCode;
        const level = status >= 500 ? 'error' : path.startsWith('/health/') ? 'debug' : 'info';
        logger[level](
          {
            req: { method, path },
            res: { statusCode: status },
            durationMs: Math.round((performance.now() - started) * 10) / 10,
          },
          message,
        );
      };
      // Bound to this request's context: 'finish' and 'close' fire outside it.
      response.once(
        'finish',
        AsyncLocalStorage.bind(() => {
          write('request completed');
        }),
      );
      response.once(
        'close',
        AsyncLocalStorage.bind(() => {
          if (!response.writableFinished) write('request aborted');
        }),
      );
      next();
    });
  };
}
