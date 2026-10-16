import { HealthReportSchema } from '@floty/contracts';
import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /health/live (web)', () => {
  it('reports the web server as ok without caching', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(HealthReportSchema.parse(await response.json())).toMatchObject({
      service: 'web',
      status: 'ok',
      checks: {},
    });
  });
});
