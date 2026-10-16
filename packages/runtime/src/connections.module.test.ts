import 'reflect-metadata';
import type { Server } from 'node:http';
import { HealthReportSchema } from '@floty/contracts';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionsModule, readinessChecks } from './connections.module.js';
import { HealthModule } from './health.module.js';

describe('readinessChecks', () => {
  it('probes the database (reachable, RLS applies) and Redis with PING', async () => {
    const database = { ping: vi.fn(() => Promise.resolve()) };
    const redis = { ping: vi.fn(() => Promise.resolve('PONG' as const)) };

    const checks = readinessChecks(database, redis);
    await checks['database']?.();
    await checks['redis']?.();

    expect(Object.keys(checks)).toEqual(['database', 'redis']);
    expect(database.ping).toHaveBeenCalledOnce();
    expect(redis.ping).toHaveBeenCalledOnce();
  });
});

describe('ConnectionsModule', () => {
  // Port 1 on localhost refuses connections: the real clients are wired but nothing answers.
  // The happy path against real Postgres and Redis is the Compose smoke test (e2e/).
  it('wires real clients into readiness and closes them on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConnectionsModule.forRoot({
          databaseUrl: 'postgres://floty:floty@127.0.0.1:1/floty',
          redisUrl: 'redis://127.0.0.1:1',
        }),
        HealthModule.forRoot({ service: 'worker' }),
      ],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.enableShutdownHooks();
    await app.init();

    const response = await request(app.getHttpServer() as Server)
      .get('/health/ready')
      .expect(503);
    expect(HealthReportSchema.parse(response.body)).toMatchObject({
      service: 'worker',
      status: 'unavailable',
      checks: { database: 'down', redis: 'down' },
    });

    await expect(app.close()).resolves.toBeUndefined();
  });
});
