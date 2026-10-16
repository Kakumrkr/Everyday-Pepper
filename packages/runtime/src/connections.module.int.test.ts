import 'reflect-metadata';
import type { Server } from 'node:http';
import { HealthReportSchema } from '@floty/contracts';
import { prepareDatabase } from '@floty/db';
import { postgresUrlAs, startPostgres, startRedis, type TestService } from '@floty/testing';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionsModule } from './connections.module.js';
import { HealthModule } from './health.module.js';

describe('readiness against real Postgres and Redis', () => {
  let postgres: TestService | undefined;
  let redis: TestService | undefined;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    // As in Compose: migrate as the owner, connect as the services' login role.
    const databaseUrl = postgresUrlAs(postgres.url, 'floty_service', 'test-password');
    await prepareDatabase(postgres.url, databaseUrl);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConnectionsModule.forRoot({ databaseUrl, redisUrl: redis.url }),
        HealthModule.forRoot({ service: 'api' }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.enableShutdownHooks();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('answers 200 once the clients have connected', async () => {
    const server = app?.getHttpServer() as Server;
    // The Redis client fails fast while its first connection is still opening.
    await expect.poll(async () => (await request(server).get('/health/ready')).status).toBe(200);

    const response = await request(server).get('/health/ready').expect(200);
    expect(HealthReportSchema.parse(response.body)).toMatchObject({
      service: 'api',
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });
});

describe('readiness connected as a role that bypasses RLS', () => {
  let postgres: TestService | undefined;
  let redis: TestService | undefined;
  let app: INestApplication | undefined;

  beforeAll(async () => {
    [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
    const moduleRef = await Test.createTestingModule({
      imports: [
        // The container's superuser: a misconfigured DATABASE_URL.
        ConnectionsModule.forRoot({ databaseUrl: postgres.url, redisUrl: redis.url }),
        HealthModule.forRoot({ service: 'api' }),
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('reports the database down', async () => {
    const server = app?.getHttpServer() as Server;
    await expect
      .poll(async () => (await request(server).get('/health/ready')).body as unknown)
      .toMatchObject({ checks: { database: 'down', redis: 'up' } });
  });
});
