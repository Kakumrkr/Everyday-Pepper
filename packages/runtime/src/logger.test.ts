import { trace } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  currentRequestContext,
  PinoNestLogger,
  identifyRequest,
  runWithRequestContext,
} from './logger.js';
import { REDACTED } from './redact.js';
import { memoryDestination } from './test-support.js';

const config = { service: 'api', logLevel: 'debug', environment: 'test' } as const;

function setup(overrides: Partial<Parameters<typeof createLogger>[0]> = {}) {
  const destination = memoryDestination();
  return {
    logger: createLogger({ ...config, ...overrides }, destination),
    lines: destination.lines,
  };
}

describe('createLogger', () => {
  it('writes JSON lines with level label, ISO time and service fields', () => {
    const { logger, lines } = setup({ release: '1.2.3' });

    logger.info('hello');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'api',
      env: 'test',
      release: '1.2.3',
      msg: 'hello',
    });
    expect(lines[0]?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('hostname');
  });

  it('respects the level', () => {
    const { logger, lines } = setup({ logLevel: 'warn' });
    logger.info('dropped');
    logger.warn('kept');
    expect(lines.map((line) => line['msg'])).toEqual(['kept']);
  });

  it('redacts messages, format arguments, objects and errors', () => {
    const { logger, lines } = setup();
    const error = new Error('lookup failed for ana@juniper.example.com');

    logger.info(
      { client: { email: 'ana@juniper.example.com', id: 'c1' } },
      'mail ana@juniper.example.com',
    );
    logger.warn('dial %s', 'postgres://pepper:hunter2@db/pepper');
    logger.error(error, 'boom');
    logger.error({ err: error, token: 'abc' }, 'boom again');

    const text = JSON.stringify(lines);
    expect(text).not.toContain('ana@juniper.example.com');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('"abc"');
    expect(lines[0]).toMatchObject({ client: { email: REDACTED, id: 'c1' }, msg: 'mail [email]' });
    expect(lines[1]).toMatchObject({ msg: `dial postgres://${REDACTED}@db/pepper` });
    expect(lines[2]).toMatchObject({
      msg: 'boom',
      err: { type: 'Error', message: 'lookup failed for [email]' },
    });
    expect(lines[3]).toMatchObject({ token: REDACTED, err: { type: 'Error' } });
  });

  it('adds the request id inside a request context only', async () => {
    const { logger, lines } = setup();

    await runWithRequestContext({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      expect(currentRequestContext()).toEqual({ requestId: 'req-1' });
      logger.info('inside');
    });
    logger.info('outside');

    expect(lines[0]).toMatchObject({ request_id: 'req-1', msg: 'inside' });
    expect(lines[1]).not.toHaveProperty('request_id');
  });

  it('adds the user and tenant once the request is identified', async () => {
    const { logger, lines } = setup();
    const userId = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708193';
    const tenantId = '0199f0a4-7c1e-7d2a-9b3c-4d5e6f708192';

    identifyRequest({ userId }); // outside a request: ignored
    await runWithRequestContext({ requestId: 'req-2' }, async () => {
      logger.info('anonymous');
      identifyRequest({ userId });
      await Promise.resolve();
      logger.info('signed in');
      identifyRequest({ userId, tenantId });
      logger.info('in a business');
    });
    logger.info('outside');

    expect(lines[0]).not.toHaveProperty('user_id');
    expect(lines[1]).toMatchObject({ request_id: 'req-2', user_id: userId });
    expect(lines[1]).not.toHaveProperty('tenant_id');
    // UUIDs survive redaction (they are not mistaken for phone numbers).
    expect(lines[2]).toMatchObject({ user_id: userId, tenant_id: tenantId });
    expect(lines[3]).not.toHaveProperty('user_id');
  });

  it('adds trace and span ids while a span is active', () => {
    const provider = new NodeTracerProvider();
    provider.register();
    const { logger, lines } = setup();

    trace.getTracer('test').startActiveSpan('work', (span) => {
      logger.info('traced');
      span.end();
      expect(lines[0]).toMatchObject({
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
      });
    });
    logger.info('untraced');

    expect(lines[1]).not.toHaveProperty('trace_id');
  });
});

describe('PinoNestLogger', () => {
  it('maps Nest levels and reads the context and stack arguments', () => {
    const { logger, lines } = setup({ logLevel: 'trace' });
    const nest = new PinoNestLogger(logger);

    nest.log('started', 'NestApplication');
    nest.warn('slow');
    nest.debug('detail', 'Health');
    nest.verbose('chatty', 'Health');
    nest.error('failed', 'Error: failed\n    at x', 'ExceptionsHandler');
    nest.error('failed without stack', 'ExceptionsHandler');
    nest.fatal('dying');

    expect(lines).toEqual([
      expect.objectContaining({ level: 'info', msg: 'started', context: 'NestApplication' }),
      expect.objectContaining({ level: 'warn', msg: 'slow' }),
      expect.objectContaining({ level: 'debug', msg: 'detail', context: 'Health' }),
      expect.objectContaining({ level: 'trace', msg: 'chatty', context: 'Health' }),
      expect.objectContaining({
        level: 'error',
        msg: 'failed',
        stack: 'Error: failed\n    at x',
        context: 'ExceptionsHandler',
      }),
      expect.objectContaining({
        level: 'error',
        msg: 'failed without stack',
        context: 'ExceptionsHandler',
      }),
      expect.objectContaining({ level: 'fatal', msg: 'dying' }),
    ]);
    expect(lines[5]).not.toHaveProperty('stack');
  });

  it('logs errors and objects as structured, redacted fields', () => {
    const { logger, lines } = setup();
    const nest = new PinoNestLogger(logger);

    nest.error(new Error('no client a@b.co'), 'ClientsService');
    nest.log({ event: 'imported', email: 'a@b.co' }, 'Import');

    expect(lines[0]).toMatchObject({
      level: 'error',
      msg: 'no client [email]',
      context: 'ClientsService',
      err: { type: 'Error', message: 'no client [email]' },
    });
    expect(lines[1]).toMatchObject({
      context: 'Import',
      data: { event: 'imported', email: REDACTED },
    });
  });
});
