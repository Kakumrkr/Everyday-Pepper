import 'reflect-metadata';
import type { Server } from 'node:http';
import {
  Controller,
  Get,
  Module,
  NotFoundException,
  Post,
  Req,
  type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './logger.js';
import { createServiceApp } from './service-app.js';
import { startObservability } from './telemetry.js';
import { memoryDestination } from './test-support.js';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@sentry/node', () => sentry);

@Controller('demo')
class DemoController {
  @Get('ok')
  ok(): { ok: true } {
    return { ok: true };
  }

  @Get('missing')
  missing(): never {
    throw new NotFoundException();
  }

  @Post('raw')
  raw(@Req() request: { rawBody?: Buffer }): { bytes: number } {
    return { bytes: request.rawBody?.byteLength ?? -1 };
  }

  @Get('crash')
  crash(): never {
    throw new Error('lookup failed for ana@juniper.example.com');
  }
}

@Module({})
class DemoModule {}

const config = {
  service: 'api',
  port: 0,
  databaseUrl: 'postgres://u:p@h/db',
  redisUrl: 'redis://h',
  logLevel: 'info',
  environment: 'test',
} as const;

let app: INestApplication | undefined;

async function start() {
  const destination = memoryDestination();
  app = await createServiceApp({ module: DemoModule, controllers: [DemoController] }, config, {
    logger: createLogger(config, destination),
  });
  await app.init();
  return { server: app.getHttpServer() as Server, lines: destination.lines };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  sentry.captureException.mockClear();
});

describe('createServiceApp', () => {
  it('keeps a JSON body’s exact bytes for signed webhooks (S59.3)', async () => {
    const { server } = await start();
    const body = '{"type":"email.received" }';
    const answer = await request(server)
      .post('/demo/raw')
      .type('application/json')
      .send(body)
      .expect(201);
    expect(answer.body).toEqual({ bytes: Buffer.byteLength(body) });
  });

  it('serves with a request id, no X-Powered-By and a request log line', async () => {
    const { server, lines } = await start();

    const response = await request(server).get('/demo/ok').expect(200, { ok: true });

    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['x-powered-by']).toBeUndefined();
    await expect
      .poll(() => lines.find((line) => line['msg'] === 'request completed'))
      .toMatchObject({ request_id: response.headers['x-request-id'], req: { path: '/demo/ok' } });
  });

  it('routes Nest startup logs through the JSON logger', async () => {
    const { lines } = await start();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 'info', context: 'RoutesResolver', service: 'api' }),
    );
  });

  it('answers HttpExceptions as usual without reporting them', async () => {
    const { server } = await start();
    await request(server).get('/demo/missing').expect(404);
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('reports unexpected errors, answers a generic 500 and logs them redacted', async () => {
    const { server, lines } = await start();

    const response = await request(server).get('/demo/crash').expect(500);

    expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    expect(sentry.captureException).toHaveBeenCalledOnce();
    const text = JSON.stringify(lines);
    expect(text).toContain('lookup failed for [email]');
    expect(text).not.toContain('juniper');
    const logged = lines.find((line) => line['context'] === 'ExceptionsHandler');
    expect(logged).toMatchObject({ level: 'error', request_id: response.headers['x-request-id'] });
  });

  it('stops observability when the app shuts down', async () => {
    await start();
    const observability = startObservability(config);
    const shutdown = vi.spyOn(observability, 'shutdown');

    await app?.close();
    app = undefined;

    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('throws instead of exiting when the module cannot be wired', async () => {
    @Controller()
    class Broken {
      constructor(readonly missing: DemoController) {}
    }
    await expect(
      createServiceApp({ module: DemoModule, controllers: [Broken] }, config, {
        logger: createLogger(config, memoryDestination()),
      }),
    ).rejects.toThrow(/can't resolve dependencies/);
  });
});
