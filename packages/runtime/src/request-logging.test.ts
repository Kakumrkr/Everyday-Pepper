import { createServer, type Server } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLogger, currentRequestContext } from './logger.js';
import {
  REQUEST_ID_HEADER,
  requestLogging,
  resolveRequestId,
  withoutSecrets,
} from './request-logging.js';
import { memoryDestination } from './test-support.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function serve(handler: (respond: (status: number) => void) => void): {
  server: Server;
  lines: Record<string, unknown>[];
} {
  const destination = memoryDestination();
  const middleware = requestLogging(
    createLogger({ service: 'api', logLevel: 'debug', environment: 'test' }, destination),
  );
  const server = createServer((req, res) => {
    middleware(req, res, () => {
      handler((status) => {
        res.statusCode = status;
        res.end(currentRequestContext()?.requestId ?? 'none');
      });
    });
  });
  return { server, lines: destination.lines };
}

describe('resolveRequestId', () => {
  it.each(['abc-123', 'trace.span:1', 'a'.repeat(128)])('accepts %j', (id) => {
    expect(resolveRequestId(id)).toBe(id);
  });

  it.each([undefined, '', 'a'.repeat(129), 'x\ninjected', '<script>', ['a', 'b']])(
    'replaces %j with a UUID',
    (id) => {
      expect(resolveRequestId(id)).toMatch(UUID);
    },
  );
});

describe('requestLogging', () => {
  it('assigns an id, exposes it to the handler, echoes it and logs one line without the query', async () => {
    const { server, lines } = serve((respond) => {
      setTimeout(() => {
        respond(201);
      }, 5);
    });

    const response = await request(server)
      .post('/clients?email=ana@juniper.example.com')
      .expect(201);

    const id = response.headers[REQUEST_ID_HEADER];
    expect(id).toMatch(UUID);
    expect(response.text).toBe(id);
    await expect.poll(() => lines.length).toBe(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'request completed',
      request_id: id,
      req: { method: 'POST', path: '/clients' },
      res: { statusCode: 201 },
    });
    expect(lines[0]?.['durationMs']).toEqual(expect.any(Number));
    expect(JSON.stringify(lines)).not.toContain('juniper');
  });

  it('reuses a safe incoming id', async () => {
    const { server } = serve((respond) => {
      respond(200);
    });
    const response = await request(server)
      .get('/x')
      .set(REQUEST_ID_HEADER, 'from-web-1')
      .expect(200);
    expect(response.headers[REQUEST_ID_HEADER]).toBe('from-web-1');
  });

  it('logs health probes at debug and server errors at error', async () => {
    const { server, lines } = serve((respond) => {
      respond(503);
    });
    const ok = serve((respond) => {
      respond(200);
    });

    await request(server).get('/boom').expect(503);
    await request(ok.server).get('/health/ready').expect(200);

    await expect.poll(() => lines.length + ok.lines.length).toBe(2);
    expect(lines[0]).toMatchObject({ level: 'error', res: { statusCode: 503 } });
    expect(ok.lines[0]).toMatchObject({ level: 'debug', req: { path: '/health/ready' } });
  });

  it('logs an aborted request once', async () => {
    let closed!: () => void;
    const done = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const { server, lines } = serve(() => {
      // Never responds; the client gives up.
    });
    server.on('request', (_req, res) => {
      res.on('close', () => {
        setImmediate(closed);
      });
    });

    await expect(request(server).get('/slow').timeout(50)).rejects.toThrow();
    await done;

    expect(lines).toEqual([
      expect.objectContaining({ msg: 'request aborted', req: { method: 'GET', path: '/slow' } }),
    ]);
    server.close();
  });

  it('logs an unsubscribe link without its secret (S36)', () => {
    expect(withoutSecrets('/v1/public/unsubscribe/AbC-123_xyz')).toBe(
      '/v1/public/unsubscribe/:token',
    );
    expect(withoutSecrets('/api/auth/reset-password/rGh4rbjniOmh1w3s')).toBe(
      '/api/auth/reset-password/:token',
    );
    expect(withoutSecrets('/api/auth/reset-password')).toBe('/api/auth/reset-password');
    expect(withoutSecrets('/v1/feed/settings')).toBe('/v1/feed/settings');
  });
});
