import {
  CONFIRM_HOLDBACK_PERCENT,
  type ConfirmCutoffHours,
  type ReminderSettings,
  type ReminderSettingsPatch,
  type SameDayLeadHours,
} from '@pepper/contracts';

// The words of "Texts and reminders" (S62.2, AC-X-77, ADR-0065): the More row's summary, each
// switch's hint and the note after a save. The api decides what is sent; these only say it.

export const REMINDER_SETTINGS_PATH = '/v1/reminders/settings';

export const SAME_DAY_LEADS: readonly SameDayLeadHours[] = [1, 2, 3];

export const CONFIRM_CUTOFFS: readonly ConfirmCutoffHours[] = [12, 24, 48];

/** The confirm-by choice's label (S78.3, AC-X-217): "12 hours", "1 day", "2 days". */
export function cutoffLabel(hours: ConfirmCutoffHours): string {
  return hours === 12 ? '12 hours' : hours === 24 ? '1 day' : '2 days';
}

/** "12 hours before", "a day before", "2 days before". */
function cutoffPhrase(hours: ConfirmCutoffHours): string {
  return hours === 24 ? 'a day before' : `${cutoffLabel(hours)} before`;
}

/** The holdback's share in words (S78.3): "1 in 5". */
export const HOLDBACK_SHARE_WORDS = `1 in ${String(Math.round(100 / CONFIRM_HOLDBACK_PERCENT))}`;

/** "1 hour", "2 hours". */
export function leadLabel(hours: SameDayLeadHours): string {
  return hours === 1 ? '1 hour' : `${String(hours)} hours`;
}

/**
 * Whether the same-day text goes: it is a text only, so it waits while texts are off (its own
 * setting is kept for when they come back on).
 */
export function sameDayGoes(settings: ReminderSettings): boolean {
  return settings.texts && settings.sameDay;
}

/** The More row's one line: what a client gets before a visit, as the settings stand. */
export function remindersSummary(settings: ReminderSettings): string {
  const sameDay = sameDayGoes(settings);
  const lead = leadLabel(settings.sameDayLeadHours);
  if (settings.dayBefore && sameDay) return `A reminder the day before and a text ${lead} ahead`;
  if (settings.dayBefore) {
    return settings.texts ? 'A reminder the day before' : 'An email reminder the day before';
  }
  if (sameDay) return `A text ${lead} ahead`;
  return 'No reminders before a visit';
}

/** Under "Texts to clients". */
export function textsHint(settings: ReminderSettings): string {
  return settings.texts
    ? 'Clients who said yes on your booking page get reminders and confirmations by text.'
    : 'No texts go to clients. Replies like STOP still get their answer.';
}

/** Under "The day before". */
export function dayBeforeHint(settings: ReminderSettings): string {
  return settings.texts
    ? 'About 24 hours ahead, never late at night. By text when they said yes, else by email.'
    : 'About 24 hours ahead, by email while texts are off.';
}

/** Under "On the day". */
export function sameDayHint(settings: ReminderSettings): string {
  if (!settings.texts) return 'A text only, so it waits while texts are off.';
  return `A short text ${leadLabel(settings.sameDayLeadHours)} before they come in.`;
}

/** Under "Ask clients to confirm" (S78, AC-X-202). */
export function askToConfirmHint(settings: ReminderSettings): string {
  return settings.askToConfirm
    ? `Clients are asked to confirm by ${cutoffPhrase(settings.confirmCutoffHours)}. Visits likely to be missed are asked 3 days ahead.`
    : 'Off. Clients can still confirm by replying C to a reminder text.';
}

/** Under "Measure what asking does" (S78.3, AC-X-214). */
export function holdbackHint(settings: ReminderSettings): string {
  return settings.holdback
    ? `${HOLDBACK_SHARE_WORDS} visits likely to be missed aren’t asked early and get no release card, so you can see how many no-shows asking saves.`
    : 'Off. Every visit likely to be missed is asked early.';
}

/** The toast after a save, from what changed and the settings it left. */
export function savedNote(patch: ReminderSettingsPatch, next: ReminderSettings): string {
  if (patch.askToConfirm !== undefined) {
    return next.askToConfirm
      ? 'Saved. Clients are asked to confirm their visits.'
      : 'Saved. Clients aren’t asked to confirm.';
  }
  if (patch.confirmCutoffHours !== undefined) {
    return `Saved. Clients are asked to confirm by ${cutoffPhrase(next.confirmCutoffHours)}.`;
  }
  if (patch.holdback !== undefined) {
    return next.holdback
      ? `Saved. ${HOLDBACK_SHARE_WORDS} likely misses aren’t asked early.`
      : 'Saved. Every likely miss is asked early.';
  }
  if (patch.texts !== undefined) {
    return next.texts ? 'Saved. Texts to clients are on.' : 'Saved. No texts go to clients.';
  }
  if (patch.dayBefore !== undefined) {
    return next.dayBefore
      ? 'Saved. Clients get a reminder the day before.'
      : 'Saved. No reminder the day before.';
  }
  if (patch.sameDay !== undefined) {
    return next.sameDay
      ? `Saved. Clients get a text ${leadLabel(next.sameDayLeadHours)} ahead.`
      : 'Saved. No text on the day.';
  }
  return `Saved. The text on the day goes ${leadLabel(next.sameDayLeadHours)} ahead.`;
}

/** The settings with a change applied: what the screen shows while the save is on its way. */
export function withPatch(
  settings: ReminderSettings,
  patch: ReminderSettingsPatch,
): ReminderSettings {
  return {
    texts: patch.texts ?? settings.texts,
    dayBefore: patch.dayBefore ?? settings.dayBefore,
    sameDay: patch.sameDay ?? settings.sameDay,
    sameDayLeadHours: patch.sameDayLeadHours ?? settings.sameDayLeadHours,
    askToConfirm: patch.askToConfirm ?? settings.askToConfirm,
    confirmCutoffHours: patch.confirmCutoffHours ?? settings.confirmCutoffHours,
    holdback: patch.holdback ?? settings.holdback,
  };
}
