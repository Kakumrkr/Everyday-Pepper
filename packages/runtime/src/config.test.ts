import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DatabaseUrlSchema,
  loadEnv,
  loadServiceConfig,
  PortSchema,
  RedisUrlSchema,
} from './config.js';

const Schema = z.object({
  PORT: PortSchema.default(4000),
  DATABASE_URL: DatabaseUrlSchema,
  REDIS_URL: RedisUrlSchema,
});

const valid = {
  DATABASE_URL: 'postgres://pepper:secret@localhost:5432/pepper',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    expect(loadEnv('test', Schema, valid)).toEqual({ ...valid, PORT: 4000 });
  });

  it('coerces PORT and accepts postgresql:// and rediss://', () => {
    expect(
      loadEnv('test', Schema, {
        PORT: '4010',
        DATABASE_URL: 'postgresql://h/db',
        REDIS_URL: 'rediss://h:6380',
      }),
    ).toMatchObject({ PORT: 4010 });
  });

  it.each([
    ['missing DATABASE_URL', { REDIS_URL: valid.REDIS_URL }, 'DATABASE_URL'],
    ['a non-postgres DATABASE_URL', { ...valid, DATABASE_URL: 'mysql://x@h/db' }, 'DATABASE_URL'],
    ['a non-redis REDIS_URL', { ...valid, REDIS_URL: 'http://localhost:6379' }, 'REDIS_URL'],
    ['an out-of-range PORT', { ...valid, PORT: '70000' }, 'PORT'],
    ['a non-numeric PORT', { ...valid, PORT: 'http' }, 'PORT'],
  ])('rejects %s', (_label, env, variable) => {
    expect(() => loadEnv('test', Schema, env)).toThrow(`Invalid test environment: ${variable}`);
  });

  it('never echoes values in the error', () => {
    let message = '';
    try {
      loadEnv('test', Schema, { ...valid, REDIS_URL: 'http://user:hunter2@h' });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).toBe('Invalid test environment: REDIS_URL');
  });
});

describe('loadServiceConfig', () => {
  it('applies defaults and leaves optional integrations off', () => {
    expect(loadServiceConfig('api', valid, { port: 4000 })).toEqual({
      service: 'api',
      port: 4000,
      databaseUrl: valid.DATABASE_URL,
      redisUrl: valid.REDIS_URL,
      logLevel: 'info',
      environment: 'local',
    });
  });

  it('reads every optional setting', () => {
    expect(
      loadServiceConfig(
        'worker',
        {
          ...valid,
          PORT: '4200',
          LOG_LEVEL: 'debug',
          DEPLOYMENT_ENVIRONMENT: 'pilot',
          RELEASE: '1.2.3+abc123',
          SENTRY_DSN: 'https://key@o1.ingest.sentry.io/2',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.com/otlp',
        },
        { port: 4100 },
      ),
    ).toMatchObject({
      service: 'worker',
      port: 4200,
      logLevel: 'debug',
      environment: 'pilot',
      release: '1.2.3+abc123',
      sentryDsn: 'https://key@o1.ingest.sentry.io/2',
      otlpEndpoint: 'https://otlp.example.com/otlp',
    });
  });

  it('treats empty variables as unset', () => {
    const config = loadServiceConfig(
      'api',
      { ...valid, SENTRY_DSN: '', OTEL_EXPORTER_OTLP_ENDPOINT: '', LOG_LEVEL: '' },
      { port: 4000 },
    );
    expect(config).not.toHaveProperty('sentryDsn');
    expect(config).not.toHaveProperty('otlpEndpoint');
    expect(config.logLevel).toBe('info');
  });

  it.each([
    ['LOG_LEVEL', 'verbose'],
    ['DEPLOYMENT_ENVIRONMENT', 'Prod Env'],
    ['RELEASE', 'has spaces'],
    ['SENTRY_DSN', 'not-a-url'],
    ['OTEL_EXPORTER_OTLP_ENDPOINT', 'grpc://collector:4317'],
  ])('rejects an invalid %s without echoing it', (variable, value) => {
    expect(() => loadServiceConfig('api', { ...valid, [variable]: value }, { port: 4000 })).toThrow(
      new Error(`Invalid api environment: ${variable}`),
    );
  });
});
