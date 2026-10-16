import { describe, expect, it, vi } from 'vitest';
import { fetchApiHealth } from './api-health';

const report = {
  service: 'api',
  status: 'ok',
  checks: { database: 'up', redis: 'up' },
  checkedAt: '2026-10-15T14:30:00.000Z',
};

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    ),
  );
}

describe('fetchApiHealth', () => {
  it('returns the report from /health/ready', async () => {
    const fetch = respond(report);

    const health = await fetchApiHealth({ baseUrl: 'http://api:4000', fetch });

    expect(health).toEqual({ reachable: true, report });
    expect(fetch).toHaveBeenCalledWith(
      new URL('http://api:4000/health/ready'),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('returns the report when the api answers 503 with dependencies down', async () => {
    const down = { ...report, status: 'unavailable', checks: { database: 'down', redis: 'up' } };
    expect(await fetchApiHealth({ baseUrl: 'http://api:4000', fetch: respond(down, 503) })).toEqual(
      { reachable: true, report: down },
    );
  });

  it.each([
    ['not JSON', '<html>502 Bad Gateway</html>'],
    ['not a health report', { ok: true }],
    ['another service', { ...report, service: 'worker' }],
  ])('treats a body that is %s as an invalid response', async (_label, body) => {
    expect(await fetchApiHealth({ baseUrl: 'http://api:4000', fetch: respond(body, 502) })).toEqual(
      { reachable: false, reason: 'invalid-response' },
    );
  });

  it('reports a network failure', async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    expect(await fetchApiHealth({ baseUrl: 'http://api:4000', fetch })).toEqual({
      reachable: false,
      reason: 'network',
    });
  });

  it('reports a timeout', async () => {
    const fetch = vi.fn((_url: URL | RequestInfo, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });
    });
    expect(await fetchApiHealth({ baseUrl: 'http://api:4000', fetch, timeoutMs: 10 })).toEqual({
      reachable: false,
      reason: 'timeout',
    });
  });
});
