import { describe, expect, it } from 'vitest';
import {
  CONFIRM_CUTOFF_HOURS,
  CONFIRM_HOLDBACK_PERCENT,
  DEFAULT_REMINDER_SETTINGS,
  inHoldbackShare,
  ReminderSettingsPatchSchema,
  ReminderSettingsSchema,
} from './reminders.js';

describe('reminder settings (S62, AC-X-75)', () => {
  it('defaults every field', () => {
    expect(DEFAULT_REMINDER_SETTINGS).toEqual({
      texts: true,
      dayBefore: true,
      sameDay: true,
      sameDayLeadHours: 2,
      askToConfirm: false,
      confirmCutoffHours: 24,
      holdback: false,
    });
    // Settings stored before S78.3 read with the platform's cut-off and no holdback (AC-X-214).
    expect(ReminderSettingsSchema.parse({ askToConfirm: true })).toMatchObject({
      confirmCutoffHours: CONFIRM_CUTOFF_HOURS,
      holdback: false,
    });
    // Settings stored before S78 read with the ask off (AC-X-202).
    expect(
      ReminderSettingsSchema.parse({ texts: true, dayBefore: true, sameDay: true }).askToConfirm,
    ).toBe(false);
    expect(ReminderSettingsSchema.parse({ texts: false })).toEqual({
      ...DEFAULT_REMINDER_SETTINGS,
      texts: false,
    });
  });

  it('takes a lead of 1, 2 or 3 hours only, and no unknown field', () => {
    expect(ReminderSettingsSchema.safeParse({ sameDayLeadHours: 4 }).success).toBe(false);
    expect(ReminderSettingsSchema.safeParse({ sameDayLeadHours: 1.5 }).success).toBe(false);
    expect(ReminderSettingsSchema.safeParse({ weekly: true }).success).toBe(false);
  });

  it('takes a cut-off of 12, 24 or 48 hours only (S78.3, AC-X-217)', () => {
    for (const hours of [12, 24, 48]) {
      expect(ReminderSettingsSchema.parse({ confirmCutoffHours: hours }).confirmCutoffHours).toBe(
        hours,
      );
    }
    for (const hours of [0, 6, 36, 72, 24.5]) {
      expect(ReminderSettingsSchema.safeParse({ confirmCutoffHours: hours }).success).toBe(false);
    }
    expect(ReminderSettingsPatchSchema.parse({ confirmCutoffHours: 12, holdback: true })).toEqual({
      confirmCutoffHours: 12,
      holdback: true,
    });
  });

  it('needs at least one change in a patch', () => {
    expect(ReminderSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(ReminderSettingsPatchSchema.parse({ sameDayLeadHours: 3 })).toEqual({
      sameDayLeadHours: 3,
    });
    expect(ReminderSettingsPatchSchema.parse({ askToConfirm: true })).toEqual({
      askToConfirm: true,
    });
    expect(ReminderSettingsPatchSchema.safeParse({ tenantId: 'x' }).success).toBe(false);
  });
});

/** 1,000 made-up booking ids shaped like the database's (v4 UUIDs), the same on every run. */
function fixtureIds(count: number): string[] {
  let state = 0x2545f491;
  const next = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return Array.from({ length: count }, () => {
    const a = hex(next());
    const b = hex(next());
    const c = hex(next());
    const d = hex(next());
    return `${a}-${b.slice(0, 4)}-4${b.slice(5, 8)}-a${c.slice(1, 4)}-${c.slice(4)}${d}`;
  });
}

describe('the holdback share (S78.3, AC-X-216)', () => {
  const ids = fixtureIds(1000);

  it('holds back about one visit in five', () => {
    const held = ids.filter(inHoldbackShare).length;
    expect(Math.abs(held / 10 - CONFIRM_HOLDBACK_PERCENT)).toBeLessThanOrEqual(3);
  });

  it('always answers the same for the same visit', () => {
    for (const id of ids.slice(0, 50)) expect(inHoldbackShare(id)).toBe(inHoldbackShare(id));
    expect(ids.slice(0, 50).map(inHoldbackShare)).toEqual(ids.slice(0, 50).map(inHoldbackShare));
  });
});
