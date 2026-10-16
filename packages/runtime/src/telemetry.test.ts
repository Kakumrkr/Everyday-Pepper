import { trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED } from './redact.js';
import {
  scrubSentryEvent,
  shutdownObservability,
  startObservability,
  tracesUrl,
} from './telemetry.js';
import { recordingServer } from '@floty/testing';

const base = { service: 'api', environment: 'test', release: '1.2.3' } as const;

afterEach(async () => {
  await shutdownObservability();
});

describe('startObservability', () => {
  it('turns nothing on without a DSN or an OTLP endpoint', async () => {
    const observability = startObservability(base);

    expect(observability).toMatchObject({ tracing: false, errorReporting: false });
    expect(Sentry.isInitialized()).toBe(false);
    await expect(observability.shutdown()).resolves.toBeUndefined();
  });

  it('returns the running instance when called again', () => {
    expect(startObservability(base)).toBe(
      startObservability({ ...base, sentryDsn: 'https://k@h/1' }),
    );
  });

  it('reports errors to Sentry with personal data scrubbed', async () => {
    const sentry = await recordingServer();
    try {
      const observability = startObservability({
        ...base,
        sentryDsn: `${sentry.url.replace('://', '://publickey@')}/42`,
      });
      expect(observability.errorReporting).toBe(true);

      Sentry.captureException(new Error('no client with email ana@juniper.example.com'));
      await shutdownObservability();

      const envelope = sentry.requests.map((entry) => entry.body).join('\n');
      expect(sentry.requests[0]?.path).toMatch(/^\/api\/42\/envelope\//);
      expect(envelope).toContain('no client with email [email]');
      expect(envelope).toContain('"environment":"test"');
      expect(envelope).toContain('"release":"1.2.3"');
      expect(envelope).not.toContain('juniper');
    } finally {
      await sentry.close();
    }
  });

  it('exports spans over OTLP/HTTP with the service resource', async () => {
    const collector = await recordingServer();
    try {
      const observability = startObservability({ ...base, otlpEndpoint: `${collector.url}/otlp` });
      expect(observability.tracing).toBe(true);

      trace.getTracer('test').startActiveSpan('unit-of-work', (span) => {
        span.end();
      });
      await shutdownObservability();

      expect(collector.requests.map((entry) => entry.path)).toContain('/otlp/v1/traces');
      const exported = collector.requests.map((entry) => entry.body).join('\n');
      expect(exported).toContain('unit-of-work');
      expect(exported).toContain('floty-api');
      expect(exported).toContain('1.2.3');
    } finally {
      await collector.close();
    }
  });
});

describe('scrubSentryEvent', () => {
  it('redacts the whole event', () => {
    expect(
      scrubSentryEvent({
        message: 'call 555-123-4567',
        request: { headers: { authorization: 'Bearer x' } },
        extra: { email: 'a@b.co' },
      }),
    ).toEqual({
      message: 'call [phone]',
      request: { headers: { authorization: REDACTED } },
      extra: { email: REDACTED },
    });
  });
});

describe('tracesUrl', () => {
  it.each([
    ['https://otlp.example.com', 'https://otlp.example.com/v1/traces'],
    ['https://otlp.example.com/', 'https://otlp.example.com/v1/traces'],
    ['https://otlp.example.com/otlp', 'https://otlp.example.com/otlp/v1/traces'],
  ])('%s → %s', (endpoint, expected) => {
    expect(tracesUrl(endpoint)).toBe(expected);
  });
});
