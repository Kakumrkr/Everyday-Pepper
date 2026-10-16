import 'reflect-metadata';
import type { Server } from 'node:http';
import { HealthReportSchema } from '@floty/contracts';
import { ManualClock } from '@floty/core';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';
import { CLOCK, READINESS_CHECKS, SERVICE_NAME, type ReadinessChecks } from './health.tokens.js';

let app: INestApplication | undefined;

async function start(checks: ReadinessChecks): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      { provide: SERVICE_NAME, useValue: 'worker' },
      { provide: READINESS_CHECKS, useValue: checks },
      { provide: CLOCK, useValue: new ManualClock('2026-10-15T14:30:00.000Z') },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health/live', () => {
  it('answers 200 without running dependency checks', async () => {
    const database = vi.fn(() => Promise.resolve());
    const server = (await start({ database })).getHttpServer() as Server;

    const response = await request(server).get('/health/live').expect(200);

    expect(HealthReportSchema.parse(response.body)).toEqual({
      service: 'worker',
      status: 'ok',
      checks: {},
      checkedAt: '2026-10-15T14:30:00.000Z',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(database).not.toHaveBeenCalled();
  });
});

describe('GET /health/ready', () => {
  it('answers 200 when every dependency is up', async () => {
    const server = (
      await start({ database: () => Promise.resolve(), redis: () => Promise.resolve('PONG') })
    ).getHttpServer() as Server;

    const response = await request(server).get('/health/ready').expect(200);

    expect(HealthReportSchema.parse(response.body)).toMatchObject({
      status: 'ok',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('answers 503 with a report that hides the error', async () => {
    const server = (
      await start({
        database: () => Promise.reject(new Error('password authentication failed for "floty"')),
        redis: () => Promise.resolve('PONG'),
      })
    ).getHttpServer() as Server;

    const response = await request(server).get('/health/ready').expect(503);

    expect(HealthReportSchema.parse(response.body)).toMatchObject({
      status: 'unavailable',
      checks: { database: 'down', redis: 'up' },
    });
    expect(response.text).not.toContain('password');
  });
});
