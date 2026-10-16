import { describe, expect, it } from 'vitest';
import { HealthReportSchema } from './health.js';

const valid = {
  service: 'api',
  status: 'ok',
  checks: { database: 'up', redis: 'up' },
  checkedAt: '2026-10-15T14:30:00.000Z',
};

describe('HealthReportSchema', () => {
  it('accepts a report', () => {
    expect(HealthReportSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a report without checks (liveness)', () => {
    expect(HealthReportSchema.safeParse({ ...valid, checks: {} }).success).toBe(true);
  });

  it.each([
    ['an unknown service', { service: 'billing' }],
    ['an unknown status', { status: 'degraded' }],
    ['an unknown check status', { checks: { database: 'slow' } }],
    ['an empty check name', { checks: { '': 'up' } }],
    ['a non-UTC timestamp', { checkedAt: '2026-10-15T10:30:00-04:00' }],
    ['extra fields (no error details leak through)', { error: 'ECONNREFUSED 10.0.0.5:5432' }],
  ])('rejects %s', (_label, patch) => {
    expect(HealthReportSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
