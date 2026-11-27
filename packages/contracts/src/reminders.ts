import { z } from 'zod';

// Texts and reminders (S62, ADR-0065): what a business sends its clients before a visit, and
// how. Owners and managers set them; the reminder planner and job read them.

/** The same-day text's lead, in hours before the start. */
export const SameDayLeadHoursSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type SameDayLeadHours = z.infer<typeof SameDayLeadHoursSchema>;

/**
 * A business's reminder settings (AC-X-75). `texts`: whether clients who said yes get texts at
 * all (off: reminders by email only, no confirmation or opt-in texts); `dayBefore`: the
 * reminder a day ahead (by text, else email); `sameDay`: a text `sameDayLeadHours` before the
 * start (text only). Stored with every field, so a missing one takes its default.
 */
export const ReminderSettingsSchema = z
  .object({
    texts: z.boolean().default(true),
    dayBefore: z.boolean().default(true),
    sameDay: z.boolean().default(true),
    sameDayLeadHours: SameDayLeadHoursSchema.default(2),
  })
  .strict();
export type ReminderSettings = z.infer<typeof ReminderSettingsSchema>;

/** The defaults: everything on, the same-day text 2 hours ahead. */
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = ReminderSettingsSchema.parse({});

/** Stored settings as read: each missing field at its default, the defaults when unreadable. */
export function reminderSettingsFrom(stored: unknown): ReminderSettings {
  const parsed = ReminderSettingsSchema.safeParse(stored ?? {});
  return parsed.success ? parsed.data : DEFAULT_REMINDER_SETTINGS;
}

/** `PATCH /v1/reminders/settings`: any of the fields, at least one. */
export const ReminderSettingsPatchSchema = z
  .object({
    texts: z.boolean().optional(),
    dayBefore: z.boolean().optional(),
    sameDay: z.boolean().optional(),
    sameDayLeadHours: SameDayLeadHoursSchema.optional(),
  })
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Change at least one setting' });
export type ReminderSettingsPatch = z.infer<typeof ReminderSettingsPatchSchema>;

/** `GET /v1/reminders/settings` (and the PATCH's answer): the settings and who may change them. */
export const ReminderSettingsViewSchema = z
  .object({
    settings: ReminderSettingsSchema,
    canChange: z.boolean(),
  })
  .strict();
export type ReminderSettingsView = z.infer<typeof ReminderSettingsViewSchema>;

/**
 * A booking's reminders: the confirm ask (S78: 72 h ahead, high-band visits only, text or
 * email, when the business asks clients to confirm), the day before (text or email) and the
 * same day (text).
 */
export const ReminderKindSchema = z.enum(['confirm_ask', 'day_before', 'same_day']);
export type ReminderKind = z.infer<typeof ReminderKindSchema>;

/** What a text to a client was about (AC-X-76). */
export const BookingTextKindSchema = z.enum([
  'opt_in',
  'confirmation',
  'confirm_ask',
  'day_before',
  'same_day',
]);
export type BookingTextKind = z.infer<typeof BookingTextKindSchema>;
