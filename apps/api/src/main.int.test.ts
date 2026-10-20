import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareDatabase } from '@pepper/db';
import {
  freePort,
  postgresUrlAs,
  recordingServer,
  startPostgres,
  startRedis,
  type TestService,
} from '@pepper/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The built api, started exactly as in the Docker image (`node --import ./dist/instrument.js
// dist/main.js`), against real Postgres and Redis and a fake OTLP collector. Proves the ESM
// instrumentation, log correlation and redaction end to end. Needs `pnpm build` first
// (`pnpm test:integration` does that).
const appDir = fileURLToPath(new URL('..', import.meta.url));

describe('api process: logs and traces', () => {
  let postgres: TestService | undefined;
  let redis: TestService | undefined;
  let collector: Awaited<ReturnType<typeof recordingServer>> | undefined;
  let api: ChildProcess | undefined;
  let baseUrl = '';
  let stdout = '';
  let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

  beforeAll(async () => {
    [postgres, redis, collector] = await Promise.all([
      startPostgres(),
      startRedis(),
      recordingServer(),
    ]);
    // As in Compose: migrate as the owner, run as the services' login role.
    const databaseUrl = postgresUrlAs(postgres.url, 'pepper_service', 'test-password');
    await prepareDatabase(postgres.url, databaseUrl);
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${String(port)}`;
    api = spawn('node', ['--import', './dist/instrument.js', 'dist/main.js'], {
      cwd: appDir,
      env: {
        PATH: process.env['PATH'],
        PORT: String(port),
        DATABASE_URL: databaseUrl,
        REDIS_URL: redis.url,
        AUTH_SECRET: 'an-integration-test-secret-32-chars',
        OUTBOX_SECRET: 'an-integration-test-outbox-secret-32+',
        AUTH_BASE_URL: 'http://localhost:3000',
        LOG_LEVEL: 'debug',
        DEPLOYMENT_ENVIRONMENT: 'ci',
        RELEASE: 'int-test',
        OTEL_EXPORTER_OTLP_ENDPOINT: collector.url,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    api.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const child = api;
    exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
      }),
    );
    await vi.waitFor(
      async () => {
        const response = await fetch(`${baseUrl}/health/ready`);
        if (response.status !== 200) throw new Error(`ready: ${String(response.status)}`);
      },
      { timeout: 30_000, interval: 250 },
    );
  });

  afterAll(async () => {
    api?.kill('SIGKILL');
    await Promise.all([postgres?.stop(), redis?.stop(), collector?.close()]);
  });

  function logLines(): Record<string, unknown>[] {
    return stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it('logs each request as redacted JSON with request and trace ids, and flushes spans on SIGTERM', async () => {
    const response = await fetch(`${baseUrl}/health/ready?email=ana@juniper.example.com`, {
      headers: { 'x-request-id': 'int-test-1' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('int-test-1');
    await expect
      .poll(() => logLines().find((line) => line['request_id'] === 'int-test-1'))
      .toMatchObject({
        level: 'debug',
        msg: 'request completed',
        service: 'api',
        env: 'ci',
        release: 'int-test',
        req: { method: 'GET', path: '/health/ready' },
        res: { statusCode: 200 },
      });
    const traceId = logLines().find((line) => line['request_id'] === 'int-test-1')?.['trace_id'];
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(logLines()).toContainEqual(
      expect.objectContaining({
        context: 'NestApplication',
        msg: 'Nest application successfully started',
      }),
    );

    // Nest runs the shutdown hooks (closing clients, flushing spans), then re-raises the signal.
    api?.kill('SIGTERM');
    expect(await exited).toEqual({ code: null, signal: 'SIGTERM' });

    const exported = collector?.requests.filter((request) => request.path === '/v1/traces') ?? [];
    expect(exported.length).toBeGreaterThan(0);
    const spans = exported.map((request) => request.body).join('\n');
    expect(spans).toContain('pepper-api');
    expect(spans).toContain('"name":"GET /health/ready"'); // http
    expect(spans).toContain('"name":"request handler - /health/ready"'); // express
    expect(spans).toContain('"name":"pg.query:SELECT'); // pg
    expect(spans).toContain('"name":"ping"'); // ioredis
    expect(spans).toContain('"key":"url.query","value":{"stringValue":"[redacted]"}');
    expect(spans).toContain(`"traceId":"${String(traceId)}"`);

    expect(stdout + spans).not.toContain('juniper');
    expect(stdout).not.toContain(postgres?.url ?? 'unset');
  });
});
