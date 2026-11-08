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

  it('holds the part 2 targets as the scorecard words them (S59.4.2)', () => {
    expect(PILOT_METRIC_TARGETS.weekly_active_owners.target).toEqual({
      kind: 'at_least',
      value: 60,
    });
    expect(PILOT_METRIC_TARGETS.cards_vs_chat.target).toEqual({ kind: 'at_least', value: 70 });
    expect(PILOT_METRIC_TARGETS.ai_approval_rate).toMatchObject({
      target: { kind: 'between', min: 70, max: 90 },
      better: null,
    });
    expect(PILOT_METRIC_TARGETS.ai_correction_rate.target).toEqual({ kind: 'at_most', value: 10 });
    expect(PILOT_METRIC_TARGETS.undo_rate.target).toEqual({ kind: 'below', value: 1 });
    // $3 a business a month, in cents.
    expect(PILOT_METRIC_TARGETS.ai_cost).toMatchObject({
      unit: 'cents',
      target: { kind: 'at_most', value: 300 },
    });
    expect(PILOT_METRIC_TARGETS.rebook_rate).toMatchObject({ target: null, better: 'higher' });
  });

  it('says which way is better for every metric but a range', () => {
    for (const key of PILOT_METRIC_KEYS) {
      const { target, better } = PILOT_METRIC_TARGETS[key];
      if (target?.kind === 'between') expect(better).toBeNull();
      else expect(better).not.toBeNull();
      if (target?.kind === 'at_least') expect(better).toBe('higher');
      if (target?.kind === 'at_most' || target?.kind === 'below') expect(better).toBe('lower');
    }
  });
});
