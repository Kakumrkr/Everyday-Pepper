import 'reflect-metadata';
import type { Server } from 'node:http';
import { HealthReportSchema } from '@pepper/contracts';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AppModule } from './app.module.js';
import { loadApiConfig } from './config.js';

// Port 1 on localhost refuses connections: the real clients are wired but nothing answers.
// The happy path against real Postgres and Redis is covered by the Compose smoke test (e2e/).
const unreachable = loadApiConfig({
  DATABASE_URL: 'postgres://pepper:pepper@127.0.0.1:1/pepper',
  REDIS_URL: 'redis://127.0.0.1:1',
  AUTH_SECRET: 'a-local-test-secret-of-32-characters!',
  AUTH_BASE_URL: 'http://localhost:3000',
  OUTBOX_SECRET: 'a-local-test-outbox-secret-of-32-chars',
});

describe('AppModule', () => {
  it('reports dependencies down, stays live, and shuts down cleanly', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.forRoot(unreachable)],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.enableShutdownHooks();
    await app.init();
    const server = app.getHttpServer() as Server;

    await request(server).get('/health/live').expect(200);
    const response = await request(server).get('/health/ready').expect(503);
    expect(HealthReportSchema.parse(response.body)).toMatchObject({
      service: 'api',
      status: 'unavailable',
      checks: { database: 'down', redis: 'down' },
    });

    await expect(app.close()).resolves.toBeUndefined();
  });
});
