import { afterEach, describe, expect, it, vi } from 'vitest';
import * as authRoute from '../../api/auth/[...path]/route';
import * as v1Route from './route';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('forwarding routes', () => {
  it.each([
    ['v1', v1Route],
    ['api/auth', authRoute],
  ])('%s forwards every method to API_INTERNAL_URL read at request time', async (_name, route) => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4000');
    const fetch = vi.fn((url: URL) => Promise.resolve(Response.json({ url: url.href })));
    vi.stubGlobal('fetch', fetch);

    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      expect(route[method]).toBeTypeOf('function');
    }
    const response = await route.GET(new Request('http://localhost:3000/v1/me?x=1'));
    expect(await response.json()).toEqual({ url: 'http://api.internal:4000/v1/me?x=1' });
    expect(route.dynamic).toBe('force-dynamic');
  });
});
