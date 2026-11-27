import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_SETTINGS,
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
