import { describe, expect, it } from 'vitest';
import {
  PILOT_METRIC_KEYS,
  PILOT_METRIC_TARGETS,
  PilotMetricsQuerySchema,
} from './pilot-metrics.js';

describe('pilot metrics (S59.4)', () => {
  it('takes 7 or 30 days, 7 when left out', () => {
    expect(PilotMetricsQuerySchema.parse({})).toEqual({ days: 7 });
    expect(PilotMetricsQuerySchema.parse({ days: '30' })).toEqual({ days: 30 });
    expect(PilotMetricsQuerySchema.safeParse({ days: '14' }).success).toBe(false);
    expect(PilotMetricsQuerySchema.safeParse({ days: '7', tenant: 'x' }).success).toBe(false);
  });

  it('gives every metric a unit and its scorecard target', () => {
    expect(Object.keys(PILOT_METRIC_TARGETS).sort()).toEqual([...PILOT_METRIC_KEYS].sort());
    expect(PILOT_METRIC_TARGETS.first_reply_time.target).toEqual({ kind: 'at_most', value: 240 });
    expect(PILOT_METRIC_TARGETS.fill_rate.target).toBeNull();
  });
});
